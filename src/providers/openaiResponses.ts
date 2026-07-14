import { AppError } from "../domain/errors";
import type { ProviderConfig } from "../domain/settings";
import {
  isProviderContentFiltered,
  normalizeProviderError,
  providerContentFiltered,
  providerHttpError,
  providerIncomplete,
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

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

type OpenAiConfig = Extract<ProviderConfig, { kind: "openai" }>;

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function structuredFormat(target: TargetSchema): Record<string, unknown> {
  return {
    type: "json_schema",
    name: target.name,
    schema: target.jsonSchema,
    strict: true
  };
}

function usageEvent(input: unknown, output: unknown): ProviderEvent | null {
  const event: { type: "usage"; inputTokens?: number; outputTokens?: number } = { type: "usage" };
  if (typeof input === "number" && Number.isFinite(input)) event.inputTokens = input;
  if (typeof output === "number" && Number.isFinite(output)) event.outputTokens = output;
  return event.inputTokens === undefined && event.outputTokens === undefined ? null : event;
}

function outputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const direct = (payload as { output_text?: unknown }).output_text;
  if (typeof direct === "string") return direct;
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join("") : null;
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

function validateOutput(raw: string, target: TargetSchema): unknown {
  return target.schema.parse(target.normalize(JSON.parse(raw)));
}

function inspectNonstreamedEnvelope(payload: unknown, allowConnectionCap: boolean): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (isProviderContentFiltered(payload)) throw providerContentFiltered();

  const status = (payload as { status?: unknown }).status;
  if (status === "failed" || (payload as { error?: unknown }).error !== undefined) {
    throw providerStreamError(payload);
  }
  if (status === "incomplete") {
    const details = (payload as { incomplete_details?: unknown }).incomplete_details;
    const reason = details && typeof details === "object"
      ? (details as { reason?: unknown }).reason
      : undefined;
    if (allowConnectionCap && reason === "max_output_tokens") return true;
    throw providerIncomplete(reason);
  }
  if (status !== undefined && status !== "completed") {
    throw invalidProtocol("The provider returned an invalid response status.");
  }
  return false;
}

export function createOpenAiResponsesProvider(
  config: OpenAiConfig,
  fetchImpl: typeof fetch,
  dependencies: ProviderDependencies = {}
): ProviderClient {
  async function post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw canceledError(signal);
    try {
      const response = await fetchImpl(OPENAI_RESPONSES_URL, {
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
    inspectNonstreamedEnvelope(payload, false);
    const text = outputText(payload);
    if (text === null) throw invalidProtocol("The provider returned an unreadable response.");
    return text;
  }

  async function repair(
    target: TargetSchema,
    invalidOutput: string,
    signal: AbortSignal
  ): Promise<unknown> {
    try {
      const repaired = await nonstreamedText({
        model: config.model,
        stream: false,
        store: false,
        instructions: "Repair the supplied model output into valid JSON matching the required schema. Return JSON only.",
        input: [
          "BEGIN INVALID MODEL OUTPUT",
          invalidOutput,
          "END INVALID MODEL OUTPUT",
          `Required schema: ${JSON.stringify(target.jsonSchema)}`
        ].join("\n"),
        text: { format: structuredFormat(target) }
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
      const connectionSchema = {
        type: "object",
        properties: { ok: { type: "boolean", const: true } },
        required: ["ok"],
        additionalProperties: false
      };
      const payload = await nonstreamedPayload({
        model: config.model,
        stream: false,
        store: false,
        max_output_tokens: 16,
        instructions: "Return exactly the requested small JSON object.",
        input: "Return {\"ok\":true}.",
        text: {
          format: {
            type: "json_schema",
            name: "connection_test",
            schema: connectionSchema,
            strict: true
          }
        }
      }, signal);
      if (inspectNonstreamedEnvelope(payload, true)) return;
      const raw = outputText(payload);
      if (raw === null) throw providerOutputInvalid();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
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
          store: false,
          instructions: request.system,
          input: request.user,
          text: { format: structuredFormat(target) }
        }, signal);
        requireContentType(response, "text/event-stream");
        if (response.body === null) throw invalidProtocol("The provider returned an empty stream.");
        onEvent({ type: "connected" });
        let raw = "";
        let completed = false;
        try {
          for await (const data of parseSse(response.body, signal)) {
            if (completed) {
              throw invalidProtocol("The provider sent output after response.completed.");
            }
            const event: unknown = JSON.parse(data);
            if (!event || typeof event !== "object") continue;
            const type = (event as { type?: unknown }).type;
            if (type === "response.output_text.delta") {
              const delta = (event as { delta?: unknown }).delta;
              if (typeof delta !== "string") continue;
              raw += delta;
              const count = new TextEncoder().encode(delta).byteLength;
              outputBytes += count;
              onEvent({ type: "output-bytes", count });
            } else if (type === "response.completed") {
              const responsePayload = (event as { response?: unknown }).response;
              if (isProviderContentFiltered(responsePayload)) {
                throw providerContentFiltered();
              }
              if (responsePayload && typeof responsePayload === "object") {
                const status = (responsePayload as { status?: unknown }).status;
                if (status !== undefined && status !== "completed") {
                  const details = (responsePayload as { incomplete_details?: unknown })
                    .incomplete_details;
                  const reason = details && typeof details === "object"
                    ? (details as { reason?: unknown }).reason
                    : undefined;
                  throw providerIncomplete(reason);
                }
              }
              completed = true;
              const usage = responsePayload && typeof responsePayload === "object"
                ? (responsePayload as { usage?: unknown }).usage
                : undefined;
              if (usage && typeof usage === "object") {
                const normalized = usageEvent(
                  (usage as { input_tokens?: unknown }).input_tokens,
                  (usage as { output_tokens?: unknown }).output_tokens
                );
                if (normalized) onEvent(normalized);
              }
            } else if (type === "response.incomplete") {
              const responsePayload = (event as { response?: unknown }).response;
              const details = responsePayload && typeof responsePayload === "object"
                ? (responsePayload as { incomplete_details?: unknown }).incomplete_details
                : undefined;
              const reason = details && typeof details === "object"
                ? (details as { reason?: unknown }).reason
                : undefined;
              throw providerIncomplete(reason);
            } else if (type === "response.refusal.delta" || type === "response.refusal.done") {
              throw providerContentFiltered();
            } else if (type === "error" || type === "response.failed") {
              throw providerStreamError(event);
            }
          }
          if (!completed) {
            throw invalidProtocol("The provider stream ended before completion.");
          }
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
        return await repair(target, raw, signal);
      }
    }
  };
}
