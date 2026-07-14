import { SummaryController } from "../src/background/controller";
import { AppError } from "../src/domain/errors";
import {
  parseAppMessage,
  parseTranscriptResponse,
  type BackgroundEvent
} from "../src/domain/messages";
import type { Transcript, TranscriptPreference, VideoContext } from "../src/domain/video";
import { createProvider } from "../src/providers/factory";
import { browserSettingsRepository } from "../src/platform/storage";
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

export async function extractTranscriptWithContext(
  tabId: number,
  requestId: string,
  context: VideoContext,
  preference: TranscriptPreference
): Promise<Transcript> {
  let response;
  try {
    response = parseTranscriptResponse(await browser.tabs.sendMessage(tabId, {
      type: "youtube/extract",
      requestId,
      tabId,
      context,
      preference
    }));
  } catch (error) {
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
    context = await readVideoContextFromTab(
      tabId,
      import.meta.env.WXT_TEST_MODE === "1"
    );
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

type MessageController = Pick<SummaryController, "start" | "cancel" | "status" | "navigated">;

function isTrustedYouTubeSender(sender: MessageSender): sender is MessageSender & {
  tab: { id: number; url?: string };
} {
  if (sender.id !== browser.runtime.id || !Number.isInteger(sender.tab?.id)) return false;
  try {
    return new URL(sender.tab?.url ?? "").origin === "https://www.youtube.com";
  } catch {
    return false;
  }
}

export function createBackgroundMessageListener(
  controller: MessageController,
  ready: Promise<unknown> = Promise.resolve()
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
        && message.type !== "panel/status") {
      return undefined;
    }

    const response: Promise<unknown> = ready.then(async (): Promise<unknown> => {
      if (message.type === "youtube/navigated") {
        return await controller.navigated(sender.tab!.id!, message.videoId);
      }
      if (message.type === "panel/start") return await controller.start(message);
      if (message.type === "panel/cancel") {
        return await controller.cancel(message.tabId, message.requestId);
      }
      return controller.status(message.tabId);
    });
    void response.then(
      (result) => sendResponse(result),
      () => sendResponse(null)
    );
    return true;
  };
}

export default defineBackground(() => {
  const hub = createPanelEventHub();
  const controller = new SummaryController({
    getTab: (tabId) => browser.tabs.get(tabId),
    readVideoContext: (tabId) => readVideoContextFromTab(
      tabId,
      import.meta.env.WXT_TEST_MODE === "1"
    ),
    loadSettings: () => browserSettingsRepository.load(),
    extractTranscript: (tabId, requestId, context, preference) =>
      extractTranscriptWithContext(tabId, requestId, context, preference),
    cancelTranscript: cancelTranscriptExtraction,
    createProvider: (config) => createProvider(config),
    runPipeline: runSummaryPipeline,
    emit: (event) => hub.emit(event),
    browserLanguage: () => navigator.language
  });

  const configurePanel = () => browser.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  });
  browser.runtime.onInstalled.addListener(configurePanel);
  const ready = Promise.all([
    browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    configurePanel()
  ]);
  void ready.catch(() => undefined);

  // MV3 listeners are registered during initial evaluation; work awaits trusted storage setup.
  browser.runtime.onMessage.addListener(createBackgroundMessageListener(controller, ready));
  browser.runtime.onConnect.addListener((port) => hub.connect(port));
});
