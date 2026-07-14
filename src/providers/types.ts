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
  normalize(value: unknown): unknown;
};

function nullableSchema(value: unknown): unknown {
  if (value && typeof value === "object") {
    const anyOf = (value as { anyOf?: unknown }).anyOf;
    if (Array.isArray(anyOf) && anyOf.some((entry) =>
      entry && typeof entry === "object" && (entry as { type?: unknown }).type === "null")) {
      return value;
    }
  }
  return { anyOf: [value, { type: "null" }] };
}

function strictProviderJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictProviderJsonSchema);
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key !== "$schema" && key !== "properties" && key !== "required") {
      result[key] = strictProviderJsonSchema(entry);
    }
  }

  if (source.properties && typeof source.properties === "object") {
    const originalRequired = new Set(Array.isArray(source.required) ? source.required : []);
    const properties: Record<string, unknown> = {};
    for (const [key, propertySchema] of Object.entries(
      source.properties as Record<string, unknown>
    )) {
      const strict = strictProviderJsonSchema(propertySchema);
      properties[key] = originalRequired.has(key) ? strict : nullableSchema(strict);
    }
    result.properties = properties;
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

function normalizeVideoSummary(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.takeaways)) return value;
  return {
    ...source,
    takeaways: source.takeaways.map((takeaway) => {
      if (!takeaway || typeof takeaway !== "object" || Array.isArray(takeaway)) return takeaway;
      const record = { ...(takeaway as Record<string, unknown>) };
      if (record.startSeconds === null) delete record.startSeconds;
      return record;
    })
  };
}

export function targetSchema(kind: ProviderRequest["schema"]): TargetSchema {
  const schema = kind === "video-summary" ? summaryContentSchema : chunkSummarySchema;
  return {
    name: kind === "video-summary" ? "video_summary" : "chunk_summary",
    schema,
    jsonSchema: strictProviderJsonSchema(
      z.toJSONSchema(schema, { target: "draft-7" })
    ) as Record<string, unknown>,
    normalize: kind === "video-summary" ? normalizeVideoSummary : (value) => value
  };
}
