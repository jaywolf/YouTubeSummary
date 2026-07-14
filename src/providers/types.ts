import { z, type ZodType } from "zod";
import {
  chunkSummarySchema,
  summaryContentSchema
} from "../domain/summary";

export type ProviderRequest = {
  kind: "final" | "chunk" | "synthesis" | "repair";
  system: string;
  user: string;
  schema: "video-summary" | "chunk-summary";
};

export type ProviderEvent =
  | { type: "connected" }
  | { type: "output-bytes"; count: number }
  | { type: "usage"; inputTokens?: number; outputTokens?: number };

export interface ProviderClient {
  testConnection(signal: AbortSignal): Promise<void>;
  generate(
    request: ProviderRequest,
    onEvent: (event: ProviderEvent) => void,
    signal: AbortSignal
  ): Promise<unknown>;
}

export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type ProviderDependencies = {
  sleep?: Sleep;
};

export type TargetSchema = {
  name: "video_summary" | "chunk_summary";
  schema: ZodType;
  jsonSchema: Record<string, unknown>;
};

export function targetSchema(kind: ProviderRequest["schema"]): TargetSchema {
  const schema = kind === "video-summary" ? summaryContentSchema : chunkSummarySchema;
  return {
    name: kind === "video-summary" ? "video_summary" : "chunk_summary",
    schema,
    jsonSchema: z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>
  };
}
