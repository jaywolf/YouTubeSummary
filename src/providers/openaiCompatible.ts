import { AppError } from "../domain/errors";
import type { ProviderConfig } from "../domain/settings";
import {
  isProviderContentFiltered,
  normalizeProviderError,
  providerContentFiltered,
  providerHttpError,
  providerOutputInvalid,
  providerStreamError
} from "./providerErrors";
import { withProviderRetry } from "./retry";
import { parseSse } from "./sse";
import {
  targetSchema,
  type ProviderClient,
  type ProviderDependencies,
  type ProviderEvent,
  type ProviderRequest,
  type TargetSchema
} from "./types";

type CompatibleConfig = Extract<ProviderConfig, { kind: "openrouter" | "custom" }>;
type StructuredTarget = {
  name: string;
  jsonSchema: Record<string, unknown>;
};

function endpoint(config: CompatibleConfig): string {
  return config.kind === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : `${config.baseUrl}/chat/completions`;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function responseFormat(target: StructuredTarget): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: target.name,
      schema: target.jsonSchema,
      strict: true
    }
  };
}

function stripSingleJsonFence(value: string): string {
  const match = value.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match?.[1] ?? value;
}

function validateOutput(raw: string, target: TargetSchema): unknown {
  return target.schema.parse(target.normalize(JSON.parse(stripSingleJsonFence(raw))));
}

function parseNonstreamedEnvelope(
  payload: unknown,
  allowConnectionCap: boolean
): { text: string; capped: boolean } {
  if (isProviderContentFiltered(payload)) throw providerContentFiltered();
  if (payload && typeof payload === "object") {
    const streamError = (payload as { error?: unknown }).error;
    if (streamError !== undefined) throw providerStreamError(streamError);
  }

  const choices = payload && typeof payload === "object"
    ? (payload as { choices?: unknown }).choices
    : undefined;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const finishReason = first && typeof first === "object"
    ? (first as { finish_reason?: unknown }).finish_reason
    : undefined;
  const text = completionText(payload);
  if (text === null) throw providerOutputInvalid();
  if (finishReason === "length") {
    if (allowConnectionCap) return { text, capped: true };
    throw providerOutputInvalid();
  }
  if (finishReason === "content_filter" || finishReason === "refusal") {
    throw providerContentFiltered();
  }
  if (finishReason !== undefined && finishReason !== null && finishReason !== "stop") {
    throw providerOutputInvalid();
  }
  return { text, capped: false };
}

function invalidProtocol(message: string): AppError {
  return new AppError({
    code: "provider_unavailable",
    retryable: true,
    safeMessage: message,
    recoveryAction: "retry"
  });
}

function requireContentType(response: Response, expected: string): void {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes(expected)) {
    throw invalidProtocol("The provider returned an unexpected response format.");
  }
}

function canceledError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Summary generation was canceled.", "AbortError");
}

function completionText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function usageEvent(payload: unknown): ProviderEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const event: { type: "usage"; inputTokens?: number; outputTokens?: number } = { type: "usage" };
  const input = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const output = (usage as { completion_tokens?: unknown }).completion_tokens;
  if (typeof input === "number" && Number.isFinite(input)) event.inputTokens = input;
  if (typeof output === "number" && Number.isFinite(output)) event.outputTokens = output;
  return event.inputTokens === undefined && event.outputTokens === undefined ? null : event;
}

export function createOpenAiCompatibleProvider(
  config: CompatibleConfig,
  fetchImpl: typeof fetch,
  dependencies: ProviderDependencies = {}
): ProviderClient {
  function formatBody(target: StructuredTarget): Record<string, unknown> {
    return config.kind === "openrouter" ? { response_format: responseFormat(target) } : {};
  }

  function userContent(value: string, target: StructuredTarget): string {
    if (config.kind === "openrouter") return value;
    return [
      value,
      "",
      "Required JSON schema (return JSON only):",
      JSON.stringify(target.jsonSchema)
    ].join("\n");
  }

  async function post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw canceledError(signal);
    try {
      const response = await fetchImpl(endpoint(config), {
        method: "POST",
        headers: headers(config.apiKey),
        body: JSON.stringify(body),
        signal
      });
      if (!response.ok) throw providerHttpError(response);
      return response;
    } catch (error) {
      if (signal.aborted) throw normalizeProviderError(canceledError(signal), config.apiKey);
      throw normalizeProviderError(error, config.apiKey);
    }
  }

  async function nonstreamedPayload(
    body: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    const response = await post(body, signal);
    try {
      requireContentType(response, "application/json");
      return await response.json();
    } catch (error) {
      throw normalizeProviderError(error, config.apiKey);
    }
  }

  async function nonstreamedText(
    body: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<string> {
    const payload = await nonstreamedPayload(body, signal);
    return parseNonstreamedEnvelope(payload, false).text;
  }

  async function repair(
    target: TargetSchema,
    invalidOutput: string,
    maxOutputTokens: number,
    signal: AbortSignal
  ): Promise<unknown> {
    try {
      const repaired = await nonstreamedText({
        model: config.model,
        stream: false,
        max_tokens: maxOutputTokens,
        messages: [
          {
            role: "system",
            content: "Repair the supplied model output into valid JSON matching the required schema. Return JSON only."
          },
          {
            role: "user",
            content: [
              "BEGIN INVALID MODEL OUTPUT",
              invalidOutput,
              "END INVALID MODEL OUTPUT",
              `Required schema: ${JSON.stringify(target.jsonSchema)}`
            ].join("\n")
          }
        ],
        ...formatBody(target)
      }, signal);
      return validateOutput(repaired, target);
    } catch (error) {
      const normalized = normalizeProviderError(error, config.apiKey);
      if (normalized.code === "request_canceled") throw normalized;
      throw providerOutputInvalid(error instanceof Error ? error : undefined);
    }
  }

  return {
    async testConnection(signal) {
      const connectionTarget: StructuredTarget = {
        name: "connection_test",
        jsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean", const: true } },
          required: ["ok"],
          additionalProperties: false
        }
      };
      const payload = await nonstreamedPayload({
        model: config.model,
        stream: false,
        max_tokens: 16,
        messages: [
          { role: "system", content: "Return exactly the requested small JSON object." },
          { role: "user", content: "Return {\"ok\":true}." }
        ],
        ...formatBody(connectionTarget)
      }, signal);
      const connection = parseNonstreamedEnvelope(payload, true);
      if (connection.capped) return;
      const raw = connection.text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripSingleJsonFence(raw));
      } catch (error) {
        throw providerOutputInvalid(error instanceof Error ? error : undefined);
      }
      if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
        throw providerOutputInvalid();
      }
    },

    async generate(request, onEvent, signal) {
      const target = targetSchema(request.schema);
      let outputBytes = 0;
      const execute = async (): Promise<string> => {
        const response = await post({
          model: config.model,
          stream: true,
          max_tokens: request.maxOutputTokens,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: userContent(request.user, target) }
          ],
          ...formatBody(target)
        }, signal);
        requireContentType(response, "text/event-stream");
        if (response.body === null) throw invalidProtocol("The provider returned an empty stream.");
        onEvent({ type: "connected" });
        let raw = "";
        let done = false;
        try {
          for await (const data of parseSse(response.body, signal, () => {
            done = true;
          })) {
            const event: unknown = JSON.parse(data);
            if (!event || typeof event !== "object") continue;
            const streamError = (event as { error?: unknown }).error;
            if (streamError !== undefined) {
              throw providerStreamError(streamError);
            }
            const choices = (event as { choices?: unknown }).choices;
            if (Array.isArray(choices)) {
              const first = choices[0];
              const delta = first && typeof first === "object"
                ? (first as { delta?: unknown }).delta
                : undefined;
              const content = delta && typeof delta === "object"
                ? (delta as { content?: unknown }).content
                : undefined;
              const refusal = delta && typeof delta === "object"
                ? (delta as { refusal?: unknown }).refusal
                : undefined;
              if (typeof refusal === "string" && refusal.length > 0) {
                throw providerContentFiltered();
              }
              if (typeof content === "string") {
                raw += content;
                const count = new TextEncoder().encode(content).byteLength;
                outputBytes += count;
                onEvent({ type: "output-bytes", count });
              }
              const finishReason = first && typeof first === "object"
                ? (first as { finish_reason?: unknown }).finish_reason
                : undefined;
              if (finishReason === "length") throw providerOutputInvalid();
              if (finishReason === "content_filter" || finishReason === "refusal") {
                throw providerContentFiltered();
              }
            }
            const normalizedUsage = usageEvent(event);
            if (normalizedUsage) onEvent(normalizedUsage);
          }
          if (!done) throw invalidProtocol("The provider stream ended before [DONE].");
          return raw;
        } catch (error) {
          if (signal.aborted) throw normalizeProviderError(canceledError(signal), config.apiKey);
          throw normalizeProviderError(error, config.apiKey);
        }
      };

      let raw: string;
      try {
        raw = await withProviderRetry(
          execute,
          () => outputBytes,
          signal,
          dependencies.sleep
        );
      } catch (error) {
        throw normalizeProviderError(error, config.apiKey);
      }
      try {
        return validateOutput(raw, target);
      } catch (error) {
        if (request.kind === "repair") {
          throw providerOutputInvalid(error instanceof Error ? error : undefined);
        }
        return await repair(target, raw, request.maxOutputTokens, signal);
      }
    }
  };
}
