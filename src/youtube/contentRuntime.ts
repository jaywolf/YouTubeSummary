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
import { parseWatchUrl } from "../domain/video";
import { readVisibleTranscript } from "./visibleTranscript";

type ExtractTranscript = typeof extractTranscript;

export type YouTubeContentDependencies = TranscriptDependencies & {
  extract: ExtractTranscript;
  findVideo: () => HTMLVideoElement | null;
};

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
): (value: unknown) => Promise<TranscriptResponse | undefined> {
  return async (value) => {
    let message: AppMessage;
    try {
      message = parseAppMessage(value);
    } catch {
      return undefined;
    }

    if (message.type === "youtube/cancel-extract") {
      controllers.get(message.requestId)?.abort();
      controllers.delete(message.requestId);
      return undefined;
    }

    if (message.type === "youtube/seek") {
      const video = dependencies.findVideo();
      if (video !== null) video.currentTime = message.seconds;
      return undefined;
    }

    if (message.type !== "youtube/extract") return undefined;

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

export type NavigationSender = (message: AppMessage) => Promise<unknown>;

export async function sendYouTubeNavigation(
  url: string,
  requestId: string,
  sendMessage: NavigationSender
): Promise<void> {
  const identity = parseWatchUrl(url);
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
      const response = await fetch(url, { signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(`Caption request failed with status ${response.status}`);
      return response.text();
    },
    readVisibleSegments(): TranscriptSegment[] {
      return readVisibleTranscript(document);
    },
    findVideo: () => document.querySelector("video")
  };
}
