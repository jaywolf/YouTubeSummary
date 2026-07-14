import { z } from "zod";
import { APP_ERROR_CODES, RECOVERY_ACTIONS, type SafeAppError } from "./errors";
import type { CompletedSummaryPayload } from "./summary";
import {
  transcriptPreferenceSchema,
  transcriptSchema,
  videoContextSchema
} from "./video";

const base = { requestId: z.string().min(1), tabId: z.number().int().nonnegative() };

export const appMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("panel/start"),
    ...base,
    expectedVideoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    force: z.boolean()
  }),
  z.object({ type: z.literal("panel/cancel"), ...base }),
  z.object({ type: z.literal("panel/status"), ...base }),
  z.object({
    type: z.literal("options/clear-summaries"),
    requestId: z.string().min(1)
  }),
  z.object({
    type: z.literal("youtube/extract"),
    ...base,
    context: videoContextSchema,
    preference: transcriptPreferenceSchema
  }),
  z.object({ type: z.literal("youtube/cancel-extract"), ...base }),
  z.object({
    type: z.literal("youtube/seek"),
    ...base,
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    seconds: z.number().nonnegative()
  }),
  z.object({ type: z.literal("youtube/navigated"), ...base, videoId: z.string().nullable() })
]);

export type AppMessage = z.infer<typeof appMessageSchema>;

export type JobState =
  | "loading_video"
  | "extracting_transcript"
  | "summarizing"
  | "complete"
  | "error"
  | "canceled"
  | "interrupted";

export type PipelinePhase = "mapping" | "reducing" | "synthesizing";

export type PipelineProgress = {
  phase: PipelinePhase;
  completed: number;
  total: number;
};

export type BackgroundEvent =
  | { type: "job/state"; requestId: string; tabId: number; state: JobState }
  | ({ type: "job/progress"; requestId: string; tabId: number } & PipelineProgress)
  | {
      type: "job/complete";
      requestId: string;
      tabId: number;
      result: CompletedSummaryPayload;
    }
  | { type: "job/error"; requestId: string; tabId: number; error: SafeAppError };

export function parseAppMessage(value: unknown): AppMessage {
  return appMessageSchema.parse(value);
}

const safeAppErrorSchema = z.object({
  code: z.enum(APP_ERROR_CODES),
  retryable: z.boolean(),
  safeMessage: z.string(),
  recoveryAction: z.enum(RECOVERY_ACTIONS),
  retryAfterSeconds: z.number().finite().nonnegative().optional()
}).strict();

export const transcriptResponseSchema = z.union([transcriptSchema, safeAppErrorSchema]);
export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

export function parseTranscriptResponse(value: unknown): TranscriptResponse {
  return transcriptResponseSchema.parse(value);
}
