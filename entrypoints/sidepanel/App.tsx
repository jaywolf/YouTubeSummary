import { useEffect, useRef, useState } from "react";
import type { JobSnapshot } from "../../src/background/jobRegistry";
import {
  ERROR_PRESENTATIONS,
  getErrorPresentation,
  type SafeAppError
} from "../../src/domain/errors";
import type {
  AppMessage,
  BackgroundEvent,
  JobState,
  PipelineProgress
} from "../../src/domain/messages";
import {
  completedSummaryPayloadSchema,
  type CompletedSummaryPayload
} from "../../src/domain/summary";
import { parseExtensionWatchUrl } from "../../src/domain/watchIdentity";

type PanelTab = {
  id?: number | undefined;
  active?: boolean | undefined;
  url?: string | undefined;
};

export type PanelPort = {
  name: string;
  disconnect(): void;
  onMessage: {
    addListener(listener: (event: BackgroundEvent) => void): void;
    removeListener(listener: (event: BackgroundEvent) => void): void;
  };
};

export type PanelClient = {
  queryActiveTab(): Promise<PanelTab>;
  getTab(tabId: number): Promise<PanelTab>;
  sendRuntimeMessage(message: AppMessage): Promise<unknown>;
  sendTabMessage(tabId: number, message: AppMessage): Promise<unknown>;
  connect(): PanelPort;
  openOptionsPage(): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  createRequestId(): string;
};

const browserClient: PanelClient = {
  async queryActiveTab() {
    return (await browser.tabs.query({ active: true, currentWindow: true }))[0] ?? {};
  },
  getTab: (tabId) => browser.tabs.get(tabId),
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
  sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
  connect: () => browser.runtime.connect({ name: "summary-panel" }),
  openOptionsPage: () => browser.runtime.openOptionsPage(),
  writeClipboard: (text) => navigator.clipboard.writeText(text),
  createRequestId: () => crypto.randomUUID()
};

const ACTIVE_STATES = new Set<JobState>([
  "loading_video",
  "extracting_transcript",
  "summarizing"
]);

function isTerminalEvent(event: BackgroundEvent): boolean {
  return event.type === "job/complete"
    || event.type === "job/error"
    || event.type === "job/state" && ["canceled", "interrupted"].includes(event.state);
}

function isSafeError(value: unknown): value is SafeAppError {
  if (!value || typeof value !== "object") return false;
  const error = value as Partial<SafeAppError>;
  return typeof error.code === "string"
    && error.code in ERROR_PRESENTATIONS
    && typeof error.retryable === "boolean"
    && typeof error.safeMessage === "string"
    && ["retry", "settings", "change_model", "none"].includes(error.recoveryAction ?? "");
}

function parseSnapshot(value: unknown): JobSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.requestId !== "string"
      || !Number.isInteger(source.tabId)
      || typeof source.videoId !== "string"
      || typeof source.state !== "string"
      || typeof source.startedAt !== "number") return null;
  const base = {
    requestId: source.requestId,
    tabId: source.tabId as number,
    videoId: source.videoId,
    progress: source.progress && typeof source.progress === "object"
      && ["mapping", "reducing", "synthesizing"].includes(
        String((source.progress as { phase?: unknown }).phase)
      )
      && Number.isInteger((source.progress as { completed?: unknown }).completed)
      && Number.isInteger((source.progress as { total?: unknown }).total)
      ? {
          phase: (source.progress as { phase: PipelineProgress["phase"] }).phase,
          completed: (source.progress as { completed: number }).completed,
          total: (source.progress as { total: number }).total
        }
      : null,
    startedAt: source.startedAt
  };
  if (source.state === "complete") {
    const result = completedSummaryPayloadSchema.safeParse(source.result);
    return result.success ? { ...base, state: "complete", result: result.data } : null;
  }
  if (source.state === "error") {
    return isSafeError(source.error) ? { ...base, state: "error", error: source.error } : null;
  }
  if (["loading_video", "extracting_transcript", "summarizing", "canceled", "interrupted"]
    .includes(source.state)) {
    return { ...base, state: source.state as Exclude<JobState, "complete" | "error"> };
  }
  return null;
}

function unsupportedSnapshot(tabId: number, requestId: string): JobSnapshot {
  return {
    requestId,
    tabId,
    videoId: "",
    state: "error",
    progress: null,
    startedAt: Date.now(),
    error: {
      code: "unsupported_page",
      retryable: false,
      safeMessage: "Open a standard YouTube video page to create a summary.",
      recoveryAction: "none"
    }
  };
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":")
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function copyText(result: CompletedSummaryPayload): string {
  const lines = [result.video.title];
  if (result.video.channel) lines.push(result.video.channel);
  lines.push("", "Overview", ...result.summary.overview, "", "Key takeaways");
  for (const takeaway of result.summary.takeaways) {
    lines.push(`- ${takeaway.startSeconds === undefined ? "" : `[${formatTimestamp(takeaway.startSeconds)}] `}${takeaway.text}`);
  }
  lines.push("", "Video breakdown");
  for (const section of result.summary.sections) {
    lines.push("", `${section.heading} [${formatTimestamp(section.startSeconds)}]`, ...section.paragraphs);
  }
  lines.push("", result.summary.limitation);
  return lines.join("\n");
}

function phaseLabel(state: JobState, progress: PipelineProgress | null): string {
  if (state === "loading_video") return "Reading the current video";
  if (state === "extracting_transcript") return "Reading YouTube transcript";
  if (progress?.phase === "mapping") return "Summarizing caption chunks";
  if (progress?.phase === "reducing") return "Combining chunk summaries";
  return "Creating final summary";
}

function progressLabel(progress: PipelineProgress | null): string {
  if (progress === null) return "This can take a moment for longer videos.";
  if (progress.phase === "mapping") {
    const chunks = Math.max(1, progress.total - 1);
    return `Chunk ${Math.min(progress.completed + 1, chunks)} of ${chunks}`;
  }
  return `Synthesis ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}`;
}

export function App({ client = browserClient }: { client?: PanelClient }) {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [booting, setBooting] = useState(true);
  const [copiedRequestId, setCopiedRequestId] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const mountedRef = useRef(false);
  const tabIdRef = useRef<number | null>(null);
  const videoIdRef = useRef<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const stateVersionRef = useRef(0);
  const statusPendingRef = useRef(false);
  const pendingTerminalEventsRef = useRef<BackgroundEvent[]>([]);
  const copyAttemptRef = useRef(0);

  function acceptSnapshot(candidate: JobSnapshot, expectedVersion?: number): boolean {
    if (!mountedRef.current) return false;
    if (expectedVersion !== undefined && stateVersionRef.current !== expectedVersion) return false;
    if (candidate.tabId !== tabIdRef.current || candidate.videoId !== videoIdRef.current) return false;
    if (candidate.state === "complete" && candidate.result.video.videoId !== videoIdRef.current) return false;
    requestIdRef.current = candidate.requestId;
    stateVersionRef.current++;
    setSnapshot(candidate);
    setBooting(false);
    return true;
  }

  async function start(force: boolean) {
    const tabId = tabIdRef.current;
    const videoId = videoIdRef.current;
    if (tabId === null || videoId === null) return;
    const requestId = client.createRequestId();
    copyAttemptRef.current++;
    setCopiedRequestId(null);
    requestIdRef.current = requestId;
    stateVersionRef.current++;
    const requestVersion = stateVersionRef.current;
    setSnapshot({
      requestId,
      tabId,
      videoId,
      state: "loading_video",
      progress: null,
      startedAt: Date.now()
    });
    setBooting(false);
    const response = parseSnapshot(await client.sendRuntimeMessage({
      type: "panel/start",
      requestId,
      tabId,
      expectedVideoId: videoId,
      force
    }).catch(() => null));
    if (!mountedRef.current) return;
    if (requestIdRef.current !== requestId || stateVersionRef.current !== requestVersion) return;
    if (response !== null) {
      acceptSnapshot(response, requestVersion);
    } else {
      acceptSnapshot({
        requestId,
        tabId,
        videoId,
        state: "interrupted",
        progress: null,
        startedAt: Date.now()
      }, requestVersion);
    }
  }

  function applyEvent(event: BackgroundEvent): boolean {
    if (event.tabId !== tabIdRef.current || event.requestId !== requestIdRef.current) return false;
    if (event.type === "job/complete") {
      const result = completedSummaryPayloadSchema.safeParse(event.result);
      if (!result.success || result.data.video.videoId !== videoIdRef.current) return false;
      stateVersionRef.current++;
      setSnapshot((current) => current === null ? current : {
        ...current,
        state: "complete",
        progress: current.progress,
        result: result.data
      });
    } else if (event.type === "job/error") {
      if (!isSafeError(event.error)) return false;
      stateVersionRef.current++;
      setSnapshot((current) => current === null ? current : {
        requestId: current.requestId,
        tabId: current.tabId,
        videoId: current.videoId,
        state: "error",
        progress: current.progress,
        startedAt: current.startedAt,
        error: event.error
      });
    } else if (event.type === "job/progress") {
      if (!["mapping", "reducing", "synthesizing"].includes(event.phase)
          || !Number.isInteger(event.completed) || !Number.isInteger(event.total)
          || event.completed < 0 || event.total < 1 || event.completed > event.total) return false;
      stateVersionRef.current++;
      setSnapshot((current) => current === null ? current : {
        ...current,
        progress: {
          phase: event.phase,
          completed: event.completed,
          total: event.total
        }
      });
    } else {
      if (!["loading_video", "extracting_transcript", "summarizing", "canceled", "interrupted"]
        .includes(event.state)) return false;
      stateVersionRef.current++;
      setSnapshot((current) => current === null ? current : {
        requestId: current.requestId,
        tabId: current.tabId,
        videoId: current.videoId,
        state: event.state as Exclude<JobState, "complete" | "error">,
        progress: current.progress,
        startedAt: current.startedAt
      });
    }
    return true;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const port = client.connect();
    const listener = (event: BackgroundEvent) => {
      if (event.tabId !== tabIdRef.current) return;
      if (requestIdRef.current === null && statusPendingRef.current && isTerminalEvent(event)) {
        if (event.type === "job/complete") {
          const parsed = completedSummaryPayloadSchema.safeParse(event.result);
          if (!parsed.success || parsed.data.video.videoId !== videoIdRef.current) return;
        }
        const pending = pendingTerminalEventsRef.current;
        pending.push(event);
        if (pending.length > 16) pending.shift();
        return;
      }
      applyEvent(event);
    };
    port.onMessage.addListener(listener);
    return () => {
      port.onMessage.removeListener(listener);
      port.disconnect();
    };
  }, [client]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void (async () => {
      const tab: PanelTab = await client.queryActiveTab().catch(() => ({}));
      if (!mountedRef.current) return;
      const tabId = tab.id;
      const identity = typeof tab.url === "string" ? parseExtensionWatchUrl(tab.url) : null;
      if (!Number.isInteger(tabId) || identity === null) {
        const requestId = client.createRequestId();
        setSnapshot(unsupportedSnapshot(typeof tabId === "number" ? tabId : 0, requestId));
        setBooting(false);
        return;
      }
      tabIdRef.current = tabId!;
      videoIdRef.current = identity.videoId;
      const statusRequestId = client.createRequestId();
      const version = stateVersionRef.current;
      statusPendingRef.current = true;
      const current = parseSnapshot(await client.sendRuntimeMessage({
        type: "panel/status",
        requestId: statusRequestId,
        tabId: tabId!
      }).catch(() => null));
      statusPendingRef.current = false;
      if (!mountedRef.current) return;
      if (stateVersionRef.current !== version) return;
      if (current !== null && acceptSnapshot(current, version)) {
        const pending = pendingTerminalEventsRef.current;
        pendingTerminalEventsRef.current = [];
        for (const event of pending) applyEvent(event);
        return;
      }
      pendingTerminalEventsRef.current = [];
      await start(false);
    })();
  }, [client]);

  async function cancel() {
    if (snapshot === null || !ACTIVE_STATES.has(snapshot.state)) return;
    const requestId = snapshot.requestId;
    const version = stateVersionRef.current;
    const response = parseSnapshot(await client.sendRuntimeMessage({
      type: "panel/cancel",
      requestId,
      tabId: snapshot.tabId
    }).catch(() => null));
    if (requestIdRef.current === requestId && response !== null) acceptSnapshot(response, version);
  }

  async function seek(result: CompletedSummaryPayload, seconds: number) {
    if (snapshot?.state !== "complete" || result.video.videoId !== snapshot.videoId) return;
    const tab: PanelTab = await client.getTab(snapshot.tabId).catch(() => ({}));
    const identity = typeof tab.url === "string" ? parseExtensionWatchUrl(tab.url) : null;
    if (tab.id !== snapshot.tabId || tab.active !== true
        || identity?.videoId !== result.video.videoId) return;
    await client.sendTabMessage(snapshot.tabId, {
      type: "youtube/seek",
      requestId: snapshot.requestId,
      tabId: snapshot.tabId,
      videoId: result.video.videoId,
      seconds
    }).catch(() => undefined);
  }

  async function copyResult(result: CompletedSummaryPayload, requestId: string) {
    const attempt = ++copyAttemptRef.current;
    setCopiedRequestId(null);
    try {
      await client.writeClipboard(copyText(result));
      if (mountedRef.current && copyAttemptRef.current === attempt
          && requestIdRef.current === requestId) {
        setCopiedRequestId(requestId);
      }
    } catch {
      if (mountedRef.current && copyAttemptRef.current === attempt
          && requestIdRef.current === requestId) {
        setCopiedRequestId(null);
      }
    }
  }

  if (booting || snapshot === null) {
    return (
      <main className="panel-shell panel-centered" aria-busy="true">
        <div className="spinner" />
        <h1>Reading this video</h1>
        <p>Checking the active YouTube page…</p>
      </main>
    );
  }

  if (snapshot.state === "error") {
    const presentation = getErrorPresentation(snapshot.error);
    return (
      <main className="panel-shell panel-centered">
        <div className="brand-mark">YS</div>
        <p className="eyebrow">YouTube Detailed Summary</p>
        <h1>{presentation.title}</h1>
        <p className="state-message" role="alert">{presentation.message}</p>
        {presentation.actions.includes("retry") ? (
          <button className="primary-action" onClick={() => void start(true)}>Retry</button>
        ) : null}
        {presentation.actions.includes("settings") ? (
          <button className="primary-action" onClick={() => void client.openOptionsPage()}>
            Open settings
          </button>
        ) : null}
        {presentation.actions.includes("change_model") ? (
          <button className="text-action" onClick={() => void client.openOptionsPage()}>
            Change model
          </button>
        ) : null}
      </main>
    );
  }

  if (ACTIVE_STATES.has(snapshot.state)) {
    return (
      <main className="panel-shell panel-centered">
        <div className="spinner" />
        <p className="eyebrow">YouTube Detailed Summary</p>
        <h1>{phaseLabel(snapshot.state, snapshot.progress)}</h1>
        <p className="state-message" aria-live="polite">{progressLabel(snapshot.progress)}</p>
        <button className="secondary-action" onClick={() => void cancel()}>Cancel</button>
      </main>
    );
  }

  if (snapshot.state !== "complete") {
    const interrupted = snapshot.state === "interrupted";
    return (
      <main className="panel-shell panel-centered">
        <p className="eyebrow">YouTube Detailed Summary</p>
        <h1>{snapshot.state === "canceled" ? "Summary canceled" : "Summary interrupted"}</h1>
        {interrupted ? (
          <button className="primary-action" onClick={() => void start(true)}>Retry</button>
        ) : null}
      </main>
    );
  }

  const result = snapshot.result;
  return (
    <main className="panel-shell summary-view">
      <header className="summary-header">
        <div>
          <p className="eyebrow">YouTube Detailed Summary</p>
          <h1>{result.video.title}</h1>
          <p className="video-meta">
            {result.video.channel ? `${result.video.channel} · ` : ""}
            {result.caption.label}{result.caption.isAutoGenerated ? " (automatic)" : ""}
          </p>
        </div>
        <button className="icon-action" aria-label="Settings" onClick={() => void client.openOptionsPage()}>⚙</button>
      </header>

      <div className="summary-actions">
        <button onClick={() => void copyResult(result, snapshot.requestId)}>
          {copiedRequestId === snapshot.requestId ? "Copied" : "Copy"}
        </button>
        <button onClick={() => void start(true)}>Regenerate</button>
        <button onClick={() => void client.openOptionsPage()}>Settings</button>
      </div>

      <section className="summary-section overview" aria-labelledby="overview-heading">
        <h2 id="overview-heading">Overview</h2>
        {result.summary.overview.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      </section>

      <section className="summary-section" aria-labelledby="takeaways-heading">
        <h2 id="takeaways-heading">Key takeaways</h2>
        <ul className="takeaway-list">
          {result.summary.takeaways.map((takeaway, index) => (
            <li key={index}>
              {takeaway.startSeconds === undefined ? null : (
                <button
                  className="timestamp"
                  aria-label={`Jump to ${formatTimestamp(takeaway.startSeconds)}`}
                  onClick={() => void seek(result, takeaway.startSeconds!)}
                >{formatTimestamp(takeaway.startSeconds)}</button>
              )}
              <span>{takeaway.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="summary-section" aria-labelledby="breakdown-heading">
        <h2 id="breakdown-heading">Video breakdown</h2>
        {result.summary.sections.map((section, index) => (
          <article className="topic" key={index}>
            <div className="topic-heading">
              <h3>{section.heading}</h3>
              <button
                className="timestamp"
                aria-label={`Jump to ${formatTimestamp(section.startSeconds)}`}
                onClick={() => void seek(result, section.startSeconds)}
              >{formatTimestamp(section.startSeconds)}</button>
            </div>
            {section.paragraphs.map((paragraph, paragraphIndex) => (
              <p key={paragraphIndex}>{paragraph}</p>
            ))}
          </article>
        ))}
      </section>

      <footer>
        <p>{result.summary.limitation}</p>
        <p>{result.cache ? `Cached ${new Date(result.cache.createdAt).toLocaleString()}` : `Generated ${new Date(result.summary.generatedAt).toLocaleString()}`}</p>
      </footer>
    </main>
  );
}
