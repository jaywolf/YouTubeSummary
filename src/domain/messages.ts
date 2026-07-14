import { z } from "zod";
import type { SafeAppError } from "./errors";

const base = { requestId: z.string().min(1), tabId: z.number().int().nonnegative() };

export const appMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("panel/start"), ...base, force: z.boolean() }),
  z.object({ type: z.literal("panel/cancel"), ...base }),
  z.object({ type: z.literal("panel/status"), ...base }),
  z.object({ type: z.literal("youtube/seek"), ...base, seconds: z.number().nonnegative() }),
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

export type BackgroundEvent =
  | { type: "job/state"; requestId: string; tabId: number; state: JobState }
  | { type: "job/progress"; requestId: string; tabId: number; completed: number; total: number }
  | { type: "job/error"; requestId: string; tabId: number; error: SafeAppError };

export function parseAppMessage(value: unknown): AppMessage {
  return appMessageSchema.parse(value);
}
