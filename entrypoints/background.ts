import { AppError } from "../src/domain/errors";
import {
  parseTranscriptResponse
} from "../src/domain/messages";
import type { Transcript, TranscriptPreference, VideoContext } from "../src/domain/video";
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

  return { context, transcript: response };
}

export async function cancelTranscriptExtraction(tabId: number, requestId: string): Promise<void> {
  await browser.tabs.sendMessage(tabId, {
    type: "youtube/cancel-extract",
    requestId,
    tabId
  });
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });
});
