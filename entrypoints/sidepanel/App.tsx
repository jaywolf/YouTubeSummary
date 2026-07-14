import { useEffect, useRef, useState } from "react";
import type { JobSnapshot } from "../../src/background/jobRegistry";
import type { SafeAppError } from "../../src/domain/errors";
import type { AppMessage, BackgroundEvent, JobState } from "../../src/domain/messages";
import {
  completedSummaryPayloadSchema,
  type CompletedSummaryPayload
} from "../../src/domain/summary";
import { parseWatchUrl } from "../../src/domain/video";

type PanelTab = { id?: number | undefined; url?: string | undefined };

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

function isSafeError(value: unknown): value is SafeAppError {
  if (!value || typeof value !== "object") return false;
  const error = value as Partial<SafeAppError>;
  return typeof error.code === "string"
    && typeof error.retryable === "boolean"
    && typeof error.safeMessage === "string"
    && typeof error.recoveryAction === "string";
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
      && Number.isInteger((source.progress as { completed?: unknown }).completed)
      && Number.isInteger((source.progress as { total?: unknown }).total)
      ? {
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
  lines.push("", "Detailed breakdown");
  for (const section of result.summary.sections) {
    lines.push("", `${section.heading} [${formatTimestamp(section.startSeconds)}]`, ...section.paragraphs);
  }
  lines.push("", result.summary.limitation);
  return lines.join("\n");
}

function phaseLabel(state: JobState): string {
  if (state === "loading_video") return "Reading the current video";
  if (state === "extracting_transcript") return "Extracting YouTube captions";
  return "Creating your summary";
}

export function App({ client = browserClient }: { client?: PanelClient }) {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [booting, setBooting] = useState(true);
  const [copied, setCopied] = useState(false);
  const initializedRef = useRef(false);
  const mountedRef = useRef(false);
  const tabIdRef = useRef<number | null>(null);
  const videoIdRef = useRef<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const stateVersionRef = useRef(0);

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
      force
    }).catch(() => null));
    if (!mountedRef.current) return;
    if (requestIdRef.current !== requestId || stateVersionRef.current !== requestVersion) return;
    if (response !== null) acceptSnapshot(response, requestVersion);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const port = client.connect();
    const listener = (event: BackgroundEvent) => {
      if (event.tabId !== tabIdRef.current || event.requestId !== requestIdRef.current) return;
      if (event.type === "job/complete") {
        const result = completedSummaryPayloadSchema.safeParse(event.result);
        if (!result.success || result.data.video.videoId !== videoIdRef.current) return;
        stateVersionRef.current++;
        setSnapshot((current) => current === null ? current : {
          ...current,
          state: "complete",
          progress: { completed: 1, total: 1 },
          result: result.data
        });
      } else if (event.type === "job/error") {
        if (!isSafeError(event.error)) return;
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
        if (!Number.isInteger(event.completed) || !Number.isInteger(event.total)
            || event.completed < 0 || event.total < 1 || event.completed > event.total) return;
        stateVersionRef.current++;
        setSnapshot((current) => current === null ? current : {
          ...current,
          progress: { completed: event.completed, total: event.total }
        });
      } else {
        if (!["loading_video", "extracting_transcript", "summarizing", "canceled", "interrupted"]
          .includes(event.state)) return;
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
      const identity = typeof tab.url === "string" ? parseWatchUrl(tab.url) : null;
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
      const current = parseSnapshot(await client.sendRuntimeMessage({
        type: "panel/status",
        requestId: statusRequestId,
        tabId: tabId!
      }).catch(() => null));
      if (!mountedRef.current) return;
      if (stateVersionRef.current !== version) return;
      if (current !== null && acceptSnapshot(current, version)) return;
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
    const identity = typeof tab.url === "string" ? parseWatchUrl(tab.url) : null;
    if (tab.id !== snapshot.tabId || identity?.videoId !== result.video.videoId) return;
    await client.sendTabMessage(snapshot.tabId, {
      type: "youtube/seek",
      requestId: snapshot.requestId,
      tabId: snapshot.tabId,
      seconds
    }).catch(() => undefined);
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
    const settings = snapshot.error.recoveryAction === "settings";
    return (
      <main className="panel-shell panel-centered">
        <div className="brand-mark">YS</div>
        <p className="eyebrow">YouTube Detailed Summary</p>
        <h1>{settings ? "Configuration required" : "Summary unavailable"}</h1>
        <p className="state-message" role="alert">{snapshot.error.safeMessage}</p>
        {settings ? (
          <button className="primary-action" onClick={() => void client.openOptionsPage()}>
            Open settings
          </button>
        ) : snapshot.error.retryable || snapshot.error.code === "provider_output_invalid" ? (
          <button className="primary-action" onClick={() => void start(true)}>Retry</button>
        ) : null}
        <button className="text-action" onClick={() => void client.openOptionsPage()}>Settings</button>
      </main>
    );
  }

  if (ACTIVE_STATES.has(snapshot.state)) {
    return (
      <main className="panel-shell panel-centered">
        <div className="spinner" />
        <p className="eyebrow">YouTube Detailed Summary</p>
        <h1>{phaseLabel(snapshot.state)}</h1>
        <p className="state-message">
          {snapshot.progress && snapshot.progress.total > 1
            ? `Chunk ${snapshot.progress.completed + 1} of ${snapshot.progress.total}`
            : "This can take a moment for detailed videos."}
        </p>
        <button className="secondary-action" onClick={() => void cancel()}>Cancel</button>
      </main>
    );
  }

  if (snapshot.state !== "complete") {
    return (
      <main className="panel-shell panel-centered">
        <p className="eyebrow">YouTube Detailed Summary</p>
        <h1>{snapshot.state === "canceled" ? "Summary canceled" : "Summary interrupted"}</h1>
        <button className="primary-action" onClick={() => void start(true)}>Retry</button>
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
        <button onClick={() => void client.writeClipboard(copyText(result)).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy"}
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
        <h2 id="breakdown-heading">Detailed breakdown</h2>
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
