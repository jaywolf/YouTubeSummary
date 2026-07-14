import type { TranscriptSegment } from "../domain/video";

function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((part) => !/^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  const seconds = numbers.at(-1);
  const minutes = numbers.at(-2);
  if (seconds === undefined || minutes === undefined || seconds >= 60 || minutes >= 60) {
    return null;
  }

  const hours = numbers.length === 3 ? numbers[0] : 0;
  if (hours === undefined) return null;
  return hours * 3_600 + minutes * 60 + seconds;
}

export function readVisibleTranscript(root: ParentNode = document): TranscriptSegment[] {
  const values: Array<{ startSeconds: number; text: string }> = [];

  for (const renderer of root.querySelectorAll(TRANSCRIPT_SEGMENT_SELECTOR)) {
    const modern = renderer.matches("transcript-segment-view-model");
    const timestamp = renderer.querySelector(modern
      ? ".ytwTranscriptSegmentViewModelTimestamp"
      : ".segment-timestamp, [id='segment-timestamp'], [id='segment-time']")?.textContent;
    const text = renderer.querySelector(modern
      ? "span.ytAttributedStringHost[role='text'], .ytAttributedStringHost[role='text'], .yt-core-attributed-string[role='text']"
      : ".segment-text, [id='segment-text']")?.textContent;
    if (timestamp === undefined || text === undefined || timestamp === null || text === null) {
      continue;
    }

    const startSeconds = parseTimestamp(timestamp);
    if (startSeconds === null) continue;
    values.push({ startSeconds, text });
  }

  return values.map((value, index) => {
    const next = values[index + 1];
    return {
      startSeconds: value.startSeconds,
      durationSeconds: next === undefined ? 0 : Math.max(0, next.startSeconds - value.startSeconds),
      text: value.text
    };
  });
}

const TRANSCRIPT_SEGMENT_SELECTOR = [
  "ytd-transcript-segment-renderer",
  "transcript-segment-view-model"
].join(",");

const TRANSCRIPT_TRIGGER_SELECTOR = [
  "ytd-video-description-transcript-section-renderer button",
  "ytd-video-description-transcript-section-renderer [role='button']",
  "ytd-video-description-transcript-section-renderer tp-yt-paper-button",
  "#show-transcript button",
  "button[aria-controls='engagement-panel-searchable-transcript']",
  "[role='button'][aria-controls='engagement-panel-searchable-transcript']"
].join(",");

const DESCRIPTION_EXPAND_SELECTOR = [
  "ytd-watch-metadata ytd-text-inline-expander #expand",
  "ytd-watch-metadata #description #expand",
  "#description-inline-expander #expand",
  "ytd-watch-metadata tp-yt-paper-button#expand"
].join(",");

const TRANSCRIPT_PANEL_SELECTOR = [
  "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']",
  "ytd-transcript-renderer"
].join(",");

type TranscriptReadTimings = {
  discoveryMs?: number;
  transcriptMs?: number;
  quietMs?: number;
};

let navigationTranscriptBaseline: string | null = null;

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function assertVideoIdentity(expectedVideoId: string | null): void {
  if (expectedVideoId === null) return;
  const currentUrl = new URL(location.href);
  const current = currentUrl.pathname === "/watch"
    && /^[A-Za-z0-9_-]{11}$/.test(currentUrl.searchParams.get("v") ?? "")
    ? currentUrl.searchParams.get("v")
    : null;
  const watchRoot = document.querySelector("ytd-watch-flexy[video-id]");
  const renderedVideoId = watchRoot?.getAttribute("video-id") ?? null;
  if (current !== expectedVideoId
      || renderedVideoId !== null && renderedVideoId !== expectedVideoId) {
    throw abortError("The active YouTube video changed during transcript extraction.");
  }
}

function isVisible(value: Element): boolean {
  if (value instanceof HTMLElement && value.hidden) return false;
  if (value.closest("[hidden], [aria-hidden='true']") !== null) return false;
  const visibility = value.getAttribute("visibility")?.toUpperCase() ?? "";
  if (visibility.includes("HIDDEN") || visibility.includes("COLLAPSED")) return false;
  const computed = getComputedStyle(value);
  return computed.display !== "none"
    && computed.visibility !== "hidden"
    && computed.visibility !== "collapse";
}

function transcriptPanels(root: ParentNode, visibleOnly: boolean): Element[] {
  const candidates = [...root.querySelectorAll(TRANSCRIPT_PANEL_SELECTOR)];
  for (const row of root.querySelectorAll("transcript-segment-view-model")) {
    const modernContainer = row.closest([
      "ytd-engagement-panel-section-list-renderer",
      "ytd-transcript-renderer"
    ].join(","))
      // Some view-model layouts omit a transcript-specific outer renderer.
      ?? row.closest("yt-section-list-renderer");
    if (modernContainer !== null) candidates.push(modernContainer);
  }

  return [...new Set(candidates)]
    .filter((panel) => panel.parentElement?.closest(TRANSCRIPT_PANEL_SELECTOR) === null)
    .filter((panel) => !visibleOnly || isVisible(panel));
}

function readCurrentTranscript(root: ParentNode): TranscriptSegment[] {
  return transcriptPanels(root, true).flatMap((panel) => readVisibleTranscript(panel));
}

function transcriptSignature(root: ParentNode, visibleOnly: boolean): string {
  return transcriptPanels(root, visibleOnly)
    .flatMap((panel) => [...panel.querySelectorAll(TRANSCRIPT_SEGMENT_SELECTOR)])
    .map((renderer) => renderer.textContent ?? "")
    .join("\u0000");
}

/** Captures the old transcript DOM before a YouTube SPA navigation starts. */
export function markTranscriptNavigationStart(root: ParentNode = document): void {
  navigationTranscriptBaseline = transcriptSignature(root, true);
}

function clickable(root: ParentNode, selector: string): HTMLElement | null {
  for (const value of root.querySelectorAll(selector)) {
    if (!(value instanceof HTMLElement) || !value.isConnected || !isVisible(value)
        || value.getAttribute("aria-disabled") === "true"
        || "disabled" in value && value.disabled === true) {
      continue;
    }
    return value;
  }
  return null;
}

function waitForValue<T>(
  root: ParentNode,
  signal: AbortSignal,
  timeoutMs: number,
  read: () => T | null,
  expectedVideoId: string | null
): Promise<T | null> {
  signal.throwIfAborted();
  assertVideoIdentity(expectedVideoId);
  const immediate = read();
  if (immediate !== null) return Promise.resolve(immediate);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: T | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const check = () => {
      try {
        assertVideoIdentity(expectedVideoId);
        const value = read();
        if (value !== null) finish(value);
      } catch (error) {
        finish(null, error);
      }
    };
    const aborted = () => finish(null, signal.reason ?? new DOMException("Aborted", "AbortError"));
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => finish(null), timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    observer.observe(root as Node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "aria-disabled", "disabled", "class", "style"]
    });
    if (signal.aborted) return aborted();
    check();
  });
}

function waitForSettledTranscript(
  root: ParentNode,
  signal: AbortSignal,
  expectedVideoId: string | null,
  timeoutMs: number,
  quietMs: number,
  staleSignature: string | null
): Promise<TranscriptSegment[]> {
  signal.throwIfAborted();
  assertVideoIdentity(expectedVideoId);
  return new Promise((resolve, reject) => {
    let settled = false;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let latest: TranscriptSegment[] = [];
    let latestSignature = "";
    let scheduledSignature: string | null = null;
    const finish = (segments: TranscriptSegment[] | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(deadline);
      if (quiet !== null) clearTimeout(quiet);
      signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve(segments ?? []);
    };
    const read = () => {
      try {
        assertVideoIdentity(expectedVideoId);
        const segments = readCurrentTranscript(root);
        if (segments.length === 0) return;
        const signature = transcriptSignature(root, true);
        if (staleSignature !== null && signature === staleSignature) return;
        latest = segments;
        latestSignature = signature;
        if (scheduledSignature === signature) return;
        scheduledSignature = signature;
        if (quiet !== null) clearTimeout(quiet);
        quiet = setTimeout(() => {
          try {
            assertVideoIdentity(expectedVideoId);
            const settledSegments = readCurrentTranscript(root);
            const settledSignature = transcriptSignature(root, true);
            if (settledSegments.length > 0 && settledSignature === latestSignature) {
              finish(settledSegments);
            } else {
              read();
            }
          } catch (error) {
            finish(null, error);
          }
        }, quietMs);
      } catch (error) {
        finish(null, error);
      }
    };
    const aborted = () => finish(null, signal.reason ?? abortError("Transcript extraction was canceled."));
    const observer = new MutationObserver(read);
    const deadline = setTimeout(() => {
      if (latest.length > 0) finish(latest);
      else finish(
        null,
        new Error("YouTube's transcript control did not render usable transcript segments.")
      );
    }, timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    observer.observe(root as Node, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "visibility"]
    });
    if (signal.aborted) return aborted();
    read();
  });
}

/** Reads the rendered transcript, opening YouTube's transcript UI when it is lazy-rendered. */
export async function readTranscriptFromPage(
  root: ParentNode = document,
  expectedVideoId: string | null = null,
  signal: AbortSignal = new AbortController().signal,
  timings: TranscriptReadTimings = {}
): Promise<TranscriptSegment[]> {
  const originalFocus = root instanceof Document
    && root.activeElement instanceof HTMLElement ? root.activeElement : null;
  const clickedControls: HTMLElement[] = [];
  const click = (control: HTMLElement) => {
    clickedControls.push(control);
    control.click();
  };
  const finish = (segments: TranscriptSegment[]) => {
    navigationTranscriptBaseline = null;
    return segments;
  };
  try {
    signal.throwIfAborted();
    assertVideoIdentity(expectedVideoId);
    const currentSignature = transcriptSignature(root, true);
    const staleSignature = navigationTranscriptBaseline;
    let segments = readCurrentTranscript(root);
    if (segments.length > 0
        && (staleSignature === null || currentSignature !== staleSignature)) {
      return finish(segments);
    }

    let trigger = clickable(root, TRANSCRIPT_TRIGGER_SELECTOR);
    let expand = clickable(root, DESCRIPTION_EXPAND_SELECTOR);
    let panelExists = transcriptPanels(root, false).length > 0;
    if (trigger === null && expand === null && !panelExists) {
      const discovered = await waitForValue(
        root,
        signal,
        timings.discoveryMs ?? 3_000,
        () => {
          const delayedTrigger = clickable(root, TRANSCRIPT_TRIGGER_SELECTOR);
          const delayedExpand = clickable(root, DESCRIPTION_EXPAND_SELECTOR);
          const delayedPanel = transcriptPanels(root, false).length > 0;
          return delayedTrigger !== null || delayedExpand !== null || delayedPanel
            ? { trigger: delayedTrigger, expand: delayedExpand, panelExists: delayedPanel }
            : null;
        },
        expectedVideoId
      );
      if (discovered === null) return [];
      ({ trigger, expand, panelExists } = discovered);
    }
    if (trigger === null && expand !== null) {
      signal.throwIfAborted();
      assertVideoIdentity(expectedVideoId);
      click(expand);
      const discovered = await waitForValue(
        root,
        signal,
        timings.discoveryMs ?? 3_000,
        () => {
          const delayedTrigger = clickable(root, TRANSCRIPT_TRIGGER_SELECTOR);
          const delayedPanel = transcriptPanels(root, false).length > 0;
          return delayedTrigger !== null || delayedPanel
            ? { trigger: delayedTrigger, panelExists: delayedPanel }
            : null;
        },
        expectedVideoId
      );
      trigger = discovered?.trigger ?? null;
      panelExists = discovered?.panelExists ?? false;
    }
    if (trigger === null) {
      if (!panelExists) return [];
      return finish(await waitForSettledTranscript(
        root,
        signal,
        expectedVideoId,
        timings.transcriptMs ?? 3_000,
        timings.quietMs ?? 300,
        staleSignature
      ));
    }

    signal.throwIfAborted();
    assertVideoIdentity(expectedVideoId);
    click(trigger);
    return finish(await waitForSettledTranscript(
      root,
      signal,
      expectedVideoId,
      timings.transcriptMs ?? 3_000,
      timings.quietMs ?? 300,
      staleSignature
    ));
  } finally {
    const active = root instanceof Document ? root.activeElement : null;
    const focusStayedNeutral = active === null || active === document.body
      || clickedControls.some((control) => active === control || control.contains(active));
    if (clickedControls.length > 0 && focusStayedNeutral && originalFocus?.isConnected) {
      originalFocus.focus({ preventScroll: true });
    }
  }
}
