import { AppError, toSafeError } from "../domain/errors";
import {
  parseAppMessage,
  parseTranscriptResponse,
  type AppMessage,
  type TranscriptResponse
} from "../domain/messages";
import type { TranscriptSegment } from "../domain/video";
import {
  extractTranscript,
  type TranscriptDependencies
} from "./extractTranscript";
import { parseExtensionWatchUrl } from "../domain/watchIdentity";
import { readTranscriptFromPage } from "./visibleTranscript";

type ExtractTranscript = typeof extractTranscript;

export type YouTubeContentDependencies = TranscriptDependencies & {
  extract: ExtractTranscript;
  findVideo: () => HTMLVideoElement | null;
};

export type YouTubeMessageHandler = (
  value: unknown
) => Promise<TranscriptResponse | undefined>;

export type ChromeMessageListener = (
  value: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => true | undefined;

function canceledResponse(): TranscriptResponse {
  return {
    code: "request_canceled",
    retryable: false,
    safeMessage: "Transcript extraction was canceled.",
    recoveryAction: "none"
  };
}

function internalResponse(): TranscriptResponse {
  return {
    code: "internal_error",
    retryable: true,
    safeMessage: "The transcript could not be extracted.",
    recoveryAction: "retry"
  };
}

export function createYouTubeMessageHandler(
  dependencies: YouTubeContentDependencies,
  controllers: Map<string, AbortController> = new Map()
): YouTubeMessageHandler {
  const canceledBeforeStart = new Set<string>();
  const rememberCancellation = (requestId: string) => {
    canceledBeforeStart.add(requestId);
    if (canceledBeforeStart.size > 128) {
      const oldest = canceledBeforeStart.values().next().value;
      if (oldest !== undefined) canceledBeforeStart.delete(oldest);
    }
  };

  return async (value) => {
    let message: AppMessage;
    try {
      message = parseAppMessage(value);
    } catch {
      return undefined;
    }

    if (message.type === "youtube/cancel-extract") {
      const active = controllers.get(message.requestId);
      if (active === undefined) rememberCancellation(message.requestId);
      active?.abort();
      controllers.delete(message.requestId);
      return undefined;
    }

    if (message.type === "youtube/seek") {
      if (parseExtensionWatchUrl(location.href)?.videoId !== message.videoId) return undefined;
      const video = dependencies.findVideo();
      if (video !== null) {
        video.currentTime = message.seconds;
        if (import.meta.env.WXT_TEST_MODE === "1") {
          video.dataset.wxtSeekSeconds = String(message.seconds);
        }
      }
      return undefined;
    }

    if (message.type !== "youtube/extract") return undefined;

    if (canceledBeforeStart.delete(message.requestId)) return canceledResponse();

    controllers.get(message.requestId)?.abort();
    const controller = new AbortController();
    controllers.set(message.requestId, controller);

    try {
      const transcript = await dependencies.extract(
        message.context,
        message.preference,
        {
          fetchText: dependencies.fetchText,
          readVisibleSegments: dependencies.readVisibleSegments
        },
        controller.signal
      );
      return parseTranscriptResponse(transcript);
    } catch (error) {
      if (controller.signal.aborted || error instanceof Error && error.name === "AbortError") {
        return parseTranscriptResponse(canceledResponse());
      }
      if (error instanceof AppError) {
        return parseTranscriptResponse(toSafeError(error));
      }
      return parseTranscriptResponse(internalResponse());
    } finally {
      if (controllers.get(message.requestId) === controller) {
        controllers.delete(message.requestId);
      }
    }
  };
}

export function createChromeMessageListener(
  handler: YouTubeMessageHandler
): ChromeMessageListener {
  return (value, _sender, sendResponse) => {
    let message: AppMessage;
    try {
      message = parseAppMessage(value);
    } catch {
      return undefined;
    }

    if (message.type !== "youtube/extract" &&
        message.type !== "youtube/cancel-extract" &&
        message.type !== "youtube/seek") {
      return undefined;
    }

    let response: Promise<TranscriptResponse | undefined>;
    try {
      response = handler(message);
    } catch {
      sendResponse(internalResponse());
      return true;
    }

    void response.then(
      (value) => sendResponse(value),
      () => sendResponse(internalResponse())
    );
    return true;
  };
}

export type NavigationSender = (message: AppMessage) => Promise<unknown>;

export async function sendYouTubeNavigation(
  url: string,
  requestId: string,
  sendMessage: NavigationSender
): Promise<void> {
  const identity = parseExtensionWatchUrl(url);
  await sendMessage({
    type: "youtube/navigated",
    requestId,
    tabId: 0,
    videoId: identity?.videoId ?? null
  });
}

export function createBrowserTranscriptDependencies(): Pick<
  YouTubeContentDependencies,
  "fetchText" | "readVisibleSegments" | "findVideo"
> {
  return {
    async fetchText(url, signal) {
      const captionUrl = new URL(url);
      captionUrl.searchParams.set("fmt", "json3");
      const response = await fetch(captionUrl.href, { signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(`Caption request failed with status ${response.status}`);
      return response.text();
    },
    async readVisibleSegments(expectedVideoId, signal): Promise<TranscriptSegment[]> {
      return readTranscriptFromPage(document, expectedVideoId, signal);
    },
    findVideo: () => document.querySelector("video")
  };
}
