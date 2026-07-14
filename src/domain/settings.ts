import { z } from "zod";

export type ProviderConfig =
  | { kind: "openai"; apiKey: string; model: string }
  | { kind: "openrouter"; apiKey: string; model: string }
  | { kind: "custom"; apiKey: string; model: string; baseUrl: string };

export type ExtensionSettings = {
  provider: ProviderConfig | null;
  captionLanguage: string | null;
  outputLanguage: string;
  contextWindowTokens: number;
  cacheEnabled: boolean;
};

export type RedactedProviderConfig =
  | { kind: "openai"; hasApiKey: boolean; model: string }
  | { kind: "openrouter"; hasApiKey: boolean; model: string }
  | { kind: "custom"; hasApiKey: boolean; model: string; baseUrl: string };

export type RedactedSettings = Omit<ExtensionSettings, "provider"> & {
  provider: RedactedProviderConfig | null;
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: null,
  captionLanguage: null,
  outputLanguage: "Same as transcript",
  contextWindowTokens: 128_000,
  cacheEnabled: true
};

function normalizedPath(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

export function validateCustomBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid provider base URL.");
  }

  if (url.username || url.password) {
    throw new Error("Provider URLs cannot contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Provider URLs cannot contain a query or fragment.");
  }

  const isLocalHttp = url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Use HTTPS, except for localhost or 127.0.0.1.");
  }

  return normalizedPath(url);
}

const apiKeySchema = z.string().trim().min(1, "Enter an API key.");
const modelSchema = z.string().trim().min(1, "Enter a model ID.");

const providerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("openai"),
    apiKey: apiKeySchema,
    model: modelSchema
  }),
  z.object({
    kind: z.literal("openrouter"),
    apiKey: apiKeySchema,
    model: modelSchema
  }),
  z.object({
    kind: z.literal("custom"),
    apiKey: apiKeySchema,
    model: modelSchema,
    baseUrl: z.string().transform((value) => validateCustomBaseUrl(value))
  })
]);

export const settingsSchema = z.object({
  provider: providerSchema.nullable().default(null),
  captionLanguage: z.string().trim().min(1).nullable().default(null),
  outputLanguage: z.string().trim().min(1).default(DEFAULT_SETTINGS.outputLanguage),
  contextWindowTokens: z.number().int().min(8_192).max(1_000_000)
    .default(DEFAULT_SETTINGS.contextWindowTokens),
  cacheEnabled: z.boolean().default(DEFAULT_SETTINGS.cacheEnabled)
});

export function parseSettings(value: unknown): ExtensionSettings {
  return settingsSchema.parse(value);
}

export function redactSettings(settings: ExtensionSettings): RedactedSettings {
  const parsed = parseSettings(settings);
  const provider = parsed.provider;
  if (provider === null) return { ...parsed, provider: null };

  if (provider.kind === "custom") {
    return {
      ...parsed,
      provider: {
        kind: provider.kind,
        hasApiKey: provider.apiKey.length > 0,
        model: provider.model,
        baseUrl: provider.baseUrl
      }
    };
  }

  return {
    ...parsed,
    provider: {
      kind: provider.kind,
      hasApiKey: provider.apiKey.length > 0,
      model: provider.model
    }
  };
}
