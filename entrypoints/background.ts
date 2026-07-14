import { SummaryController } from "../src/background/controller";
import { JobRegistry } from "../src/background/jobRegistry";
import { AppError } from "../src/domain/errors";
import {
  parseAppMessage,
  parseTranscriptResponse,
  type BackgroundEvent
} from "../src/domain/messages";
import {
  type Transcript,
  type TranscriptPreference,
  type VideoContext
} from "../src/domain/video";
import { parseExtensionWatchUrl } from "../src/domain/watchIdentity";
import { createProvider } from "../src/providers/factory";
import { browserActiveJobStore, browserSettingsRepository } from "../src/platform/storage";
import { browserSummaryCache } from "../src/platform/cache";
import { runSummaryPipeline } from "../src/summarization/pipeline";
import { readVideoContextFromTab } from "../src/youtube/playerSnapshot";

function transcriptExtractionError(cause: unknown): AppError {
  return new AppError({
    code: "transcript_extraction_failed",
    retryable: true,
    safeMessage: "The transcript could not be extracted.",
    recoveryAction: "retry",
    ...(cause instanceof Error ? { cause } : {})
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function awaitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export async function extractTranscriptWithContext(
  tabId: number,
  requestId: string,
  context: VideoContext,
  preference: TranscriptPreference,
  signal?: AbortSignal
): Promise<Transcript> {
  let response;
  try {
    response = parseTranscriptResponse(await awaitWithAbort(
      browser.tabs.sendMessage(tabId, {
        type: "youtube/extract",
        requestId,
        tabId,
        context,
        preference
      }),
      signal
    ));
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw transcriptExtractionError(error);
  }
  if ("code" in response) {
    const { retryAfterSeconds, ...safeError } = response;
    throw new AppError({
      ...safeError,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
    });
  }
  return response;
}

export async function extractTranscriptFromTab(
  tabId: number,
  requestId: string,
  preference: TranscriptPreference
): Promise<{ context: VideoContext; transcript: Transcript }> {
  let context: VideoContext | null;
  try {
    context = await readVideoContextFromTab(tabId);
  } catch (error) {
    throw transcriptExtractionError(error);
  }
  if (context === null) {
    throw new AppError({
      code: "video_context_unavailable",
      retryable: true,
      safeMessage: "The video context could not be read.",
      recoveryAction: "retry"
    });
  }
  return {
    context,
    transcript: await extractTranscriptWithContext(tabId, requestId, context, preference)
  };
}

export async function cancelTranscriptExtraction(tabId: number, requestId: string): Promise<void> {
  await browser.tabs.sendMessage(tabId, {
    type: "youtube/cancel-extract",
    requestId,
    tabId
  });
}

type PanelPort = {
  name: string;
  postMessage(message: unknown): void;
  onDisconnect: { addListener(listener: () => void): void };
};

export function createPanelEventHub() {
  const ports = new Set<PanelPort>();
  return {
    connect(port: PanelPort) {
      if (port.name !== "summary-panel") return;
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
    },
    emit(event: BackgroundEvent) {
      for (const port of ports) {
        try {
          port.postMessage(event);
        } catch {
          ports.delete(port);
        }
      }
    }
  };
}

type MessageSender = {
  id?: string | undefined;
  url?: string | undefined;
  tab?: { id?: number | undefined; url?: string | undefined } | undefined;
};

type MessageController = Pick<
  SummaryController,
  "start" | "cancel" | "status" | "navigated" | "clearSummaryCache"
>;

export type BackgroundFailureStage = "initialization" | "message";
export type BackgroundFailureReporter = (
  stage: BackgroundFailureStage,
  error: unknown
) => void;

export const reportBackgroundFailure: BackgroundFailureReporter = (stage, _error) => {
  // Never log thrown values: provider errors can contain credentials or response bodies.
  console.error(`[YouTube Summary] Background ${stage} failed.`);
};

export function observeBackgroundReady(
  ready: Promise<unknown>,
  reportFailure: BackgroundFailureReporter = reportBackgroundFailure
): void {
  void ready.catch((error) => reportFailure("initialization", error));
}

function isTrustedYouTubeSender(sender: MessageSender): sender is MessageSender & {
  tab: { id: number; url?: string };
} {
  if (sender.id !== browser.runtime.id || !Number.isInteger(sender.tab?.id)) return false;
  try {
    const url = new URL(sender.tab?.url ?? "");
    if (url.origin === "https://www.youtube.com") return true;
    return import.meta.env.WXT_TEST_MODE === "1"
      && url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port !== "";
  } catch {
    return false;
  }
}

function isTrustedExtensionPageSender(sender: MessageSender): boolean {
  if (sender.id !== browser.runtime.id || sender.tab !== undefined) return false;
  try {
    const url = new URL(sender.url ?? "");
    return url.protocol === "chrome-extension:" && url.host === browser.runtime.id;
  } catch {
    return false;
  }
}

export function createBackgroundMessageListener(
  controller: MessageController,
  ready: Promise<unknown> = Promise.resolve(),
  reportFailure: BackgroundFailureReporter = reportBackgroundFailure
) {
  return (
    value: unknown,
    sender: MessageSender,
    sendResponse: (response?: unknown) => void
  ): true | undefined => {
    let message;
    try {
      message = parseAppMessage(value);
    } catch {
      return undefined;
    }

    if (message.type === "youtube/navigated") {
      if (!isTrustedYouTubeSender(sender)) return undefined;
    } else if (message.type !== "panel/start"
        && message.type !== "panel/cancel"
        && message.type !== "panel/status"
        && message.type !== "options/clear-summaries") {
      return undefined;
    } else if (!isTrustedExtensionPageSender(sender)) {
      return undefined;
    }

    const routeMessage = async (): Promise<unknown> => {
      if (message.type === "youtube/navigated") {
        const identity = parseExtensionWatchUrl(sender.tab!.url ?? "");
        return await controller.navigated(sender.tab!.id!, identity?.videoId ?? null);
      }
      if (message.type === "panel/start") return await controller.start(message);
      if (message.type === "panel/cancel") {
        return await controller.cancel(message.tabId, message.requestId);
      }
      if (message.type === "options/clear-summaries") {
        await controller.clearSummaryCache();
        return { cleared: true };
      }
      return controller.status(message.tabId);
    };
    void ready.then(
      () => {
        void routeMessage().then(
          (result) => sendResponse(result),
          (error) => {
            reportFailure("message", error);
            sendResponse(null);
          }
        );
      },
      () => {
        // Startup failure is reported once by observeBackgroundReady.
        sendResponse(null);
      }
    );
    return true;
  };
}

export default defineBackground(() => {
  const hub = createPanelEventHub();
  const controller = new SummaryController({
    getTab: (tabId) => browser.tabs.get(tabId),
    readVideoContext: (tabId) => readVideoContextFromTab(tabId),
    loadSettings: () => browserSettingsRepository.load(),
    extractTranscript: (tabId, requestId, context, preference, signal) =>
      extractTranscriptWithContext(tabId, requestId, context, preference, signal),
    cancelTranscript: cancelTranscriptExtraction,
    summaryCache: browserSummaryCache,
    createProvider: (config) => createProvider(config),
    runPipeline: runSummaryPipeline,
    emit: (event) => hub.emit(event),
    browserLanguage: () => navigator.language
  }, new JobRegistry(
    () => crypto.randomUUID(),
    () => Date.now(),
    browserActiveJobStore
  ));

  const configurePanel = () => browser.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  });
  browser.runtime.onInstalled.addListener(configurePanel);
  const ready = Promise.all([
    browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    configurePanel()
  ]).then(() => controller.restoreInterruptedJobs());
  observeBackgroundReady(ready);

  // MV3 listeners are registered during initial evaluation; work awaits trusted storage setup.
  browser.runtime.onMessage.addListener(createBackgroundMessageListener(controller, ready));
  browser.runtime.onConnect.addListener((port) => hub.connect(port));
});
