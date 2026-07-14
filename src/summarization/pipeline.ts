import { AppError } from "../domain/errors";
import type { ExtensionSettings } from "../domain/settings";
import {
  SUMMARY_LIMITATION,
  SUMMARY_SCHEMA_VERSION,
  summaryContentSchema,
  videoSummarySchema,
  type VideoSummary
} from "../domain/summary";
import type { Transcript, VideoContext } from "../domain/video";
import type { ProviderClient } from "../providers/types";
import { buildSummaryPrompt } from "./prompts";

const OUTPUT_RESERVE_TOKENS = 4_096;
const CONSERVATIVE_CHARACTERS_PER_TOKEN = 4;

export type SummaryPipelineInput = {
  transcript: Transcript;
  video: VideoContext;
  settings: ExtensionSettings;
  provider: ProviderClient;
  onProgress(completed: number, total: number): void;
  signal: AbortSignal;
  now?: () => Date;
};

function canceled(): AppError {
  return new AppError({
    code: "request_canceled",
    retryable: false,
    safeMessage: "Summary generation was canceled.",
    recoveryAction: "none"
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw canceled();
}

function estimatedTokens(system: string, user: string): number {
  const bytes = new TextEncoder().encode(`${system}\n${user}`).byteLength;
  return Math.ceil(bytes / CONSERVATIVE_CHARACTERS_PER_TOKEN) + OUTPUT_RESERVE_TOKENS;
}

export async function runSummaryPipeline({
  transcript,
  video,
  settings,
  provider,
  onProgress,
  signal,
  now = () => new Date()
}: SummaryPipelineInput): Promise<VideoSummary> {
  throwIfAborted(signal);
  const prompt = buildSummaryPrompt({
    video,
    transcript: transcript.segments,
    outputLanguage: settings.outputLanguage
  });
  if (estimatedTokens(prompt.system, prompt.user) > settings.contextWindowTokens) {
    throw new AppError({
      code: "context_limit_exceeded",
      retryable: false,
      safeMessage: "This transcript is too long for the configured model context limit.",
      recoveryAction: "settings"
    });
  }

  onProgress(0, 1);
  const generated = await provider.generate({
    kind: "final",
    system: prompt.system,
    user: prompt.user,
    schema: "video-summary"
  }, () => undefined, signal);
  throwIfAborted(signal);

  const parsedContent = summaryContentSchema.safeParse(generated);
  if (!parsedContent.success) {
    throw new AppError({
      code: "provider_output_invalid",
      retryable: true,
      safeMessage: "The model returned an invalid summary format.",
      recoveryAction: "change_model",
      cause: parsedContent.error
    });
  }
  const content = parsedContent.data;
  const summary = videoSummarySchema.parse({
    ...content,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    limitation: SUMMARY_LIMITATION,
    generatedAt: now().toISOString()
  });
  throwIfAborted(signal);
  onProgress(1, 1);
  return summary;
}
