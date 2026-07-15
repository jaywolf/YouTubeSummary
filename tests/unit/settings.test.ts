import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  redactSettings,
  validateCustomBaseUrl
} from "../../src/domain/settings";
import {
  SETTINGS_STORAGE_KEY,
  clearCredentials,
  loadSettings,
  resetSettings,
  saveSettings,
  type StorageAreaAdapter
} from "../../src/platform/storage";
import {
  customOriginPattern,
  ensureCustomOriginPermission
} from "../../src/platform/permissions";

function memoryStorage(initial: Record<string, unknown> = {}): StorageAreaAdapter & {
  values: Record<string, unknown>;
} {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      return key in values ? { [key]: values[key] } : {};
    },
    async set(items) {
      Object.assign(values, items);
    }
  };
}

describe("provider settings", () => {
  it("accepts OpenAI settings and defaults context to 128000", () => {
    const settings = parseSettings({
      provider: { kind: "openai", apiKey: "sk-test", model: " gpt-test-mini " }
    });

    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      provider: { kind: "openai", apiKey: "sk-test", model: "gpt-test-mini" }
    });
  });

  it("defaults legacy settings to standard detail and accepts every supported level", () => {
    expect(parseSettings({}).summaryDetail).toBe("standard");
    expect(parseSettings({ summaryDetail: "concise" }).summaryDetail).toBe("concise");
    expect(parseSettings({ summaryDetail: "standard" }).summaryDetail).toBe("standard");
    expect(parseSettings({ summaryDetail: "detailed" }).summaryDetail).toBe("detailed");
    expect(() => parseSettings({ summaryDetail: "maximum" })).toThrow();
  });

  it("constrains context limits and requires nonempty credentials", () => {
    expect(() => parseSettings({ contextWindowTokens: 8191 })).toThrow();
    expect(() => parseSettings({ contextWindowTokens: 1_000_001 })).toThrow();
    expect(() => parseSettings({
      provider: { kind: "openrouter", apiKey: "  ", model: "test/model" }
    })).toThrow();
  });

  it("allows HTTPS and local HTTP while rejecting unsafe URL components", () => {
    expect(validateCustomBaseUrl("https://llm.example/v1/")).toBe("https://llm.example/v1");
    expect(validateCustomBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(validateCustomBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    expect(() => validateCustomBaseUrl("http://example.com/v1")).toThrow();
    expect(() => validateCustomBaseUrl("https://user:pass@example.com/v1?q=1")).toThrow();
    expect(() => validateCustomBaseUrl("https://example.com/v1#fragment")).toThrow();
  });

  it.each([
    "https://*/v1",
    "https://*.example.com/v1"
  ])("rejects wildcard hostname %s before a permission pattern can be derived", (baseUrl) => {
    expect(() => validateCustomBaseUrl(baseUrl)).toThrow(/wildcard/i);
    expect(() => customOriginPattern(baseUrl)).toThrow(/wildcard/i);
  });

  it.each([
    "https://@example.com/v1",
    "https://example.com/v1?",
    "https://example.com/v1#"
  ])("rejects a syntactically present empty forbidden component in %s", (baseUrl) => {
    expect(() => validateCustomBaseUrl(baseUrl)).toThrow();
  });

  it("redacts key text without dropping safe provider details", () => {
    const redacted = redactSettings(parseSettings({
      provider: {
        kind: "custom",
        apiKey: "synthetic-secret",
        model: "local-test-model",
        baseUrl: "https://llm.example/v1"
      }
    }));

    expect(redacted.provider).toEqual({
      kind: "custom",
      hasApiKey: true,
      model: "local-test-model",
      baseUrl: "https://llm.example/v1"
    });
    expect(JSON.stringify(redacted)).not.toContain("synthetic-secret");
  });
});

describe("settings storage", () => {
  it("uses defaults only when settings are absent", async () => {
    const storage = memoryStorage();
    await expect(loadSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS);

    storage.values[SETTINGS_STORAGE_KEY] = {
      provider: { kind: "openai", apiKey: "", model: "test-model" }
    };
    await expect(loadSettings(storage)).rejects.toThrow();
  });

  it("validates full settings on save and removes credentials explicitly", async () => {
    const storage = memoryStorage();
    const settings = parseSettings({
      provider: { kind: "openrouter", apiKey: "synthetic-key", model: "test/model" },
      summaryDetail: "detailed"
    });

    await saveSettings(settings, storage);
    await expect(loadSettings(storage)).resolves.toEqual(settings);
    await clearCredentials(storage);
    await expect(loadSettings(storage)).resolves.toEqual({ ...settings, provider: null });
  });

  it("loads a legacy settings record without losing its saved preferences", async () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: {
        provider: { kind: "openai", apiKey: "legacy-synthetic-key", model: "legacy-model" },
        captionLanguage: "fr",
        outputLanguage: "French",
        contextWindowTokens: 256_000,
        cacheEnabled: false
      }
    });

    await expect(loadSettings(storage)).resolves.toEqual({
      provider: { kind: "openai", apiKey: "legacy-synthetic-key", model: "legacy-model" },
      captionLanguage: "fr",
      outputLanguage: "French",
      summaryDetail: "standard",
      contextWindowTokens: 256_000,
      cacheEnabled: false
    });
  });

  it("deliberately resets malformed stored settings to safe defaults", async () => {
    const storage = memoryStorage({
      [SETTINGS_STORAGE_KEY]: {
        provider: { kind: "openai", apiKey: "malformed-synthetic-key", model: "" }
      }
    });

    await expect(resetSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS);
    await expect(loadSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS);
  });
});

describe("custom origin permissions", () => {
  it.each([
    ["http://localhost:11434/v1", "http://localhost/*"],
    ["http://127.0.0.1:8080/v1", "http://127.0.0.1/*"],
    ["https://llm.example:8443/v1", "https://llm.example/*"]
  ])("derives a portless match pattern for %s", (baseUrl, expected) => {
    expect(customOriginPattern(baseUrl)).toBe(expected);
  });

  it("checks before requesting only the exact derived origin", async () => {
    const contains = vi.fn(async () => false);
    const request = vi.fn(async () => true);

    await expect(ensureCustomOriginPermission("https://llm.example:8443/v1", {
      contains,
      request
    })).resolves.toBe(true);

    const requestDetails = { origins: ["https://llm.example/*"] };
    expect(contains).toHaveBeenCalledWith(requestDetails);
    expect(request).toHaveBeenCalledWith(requestDetails);
  });

  it("does not request an origin that is already granted", async () => {
    const contains = vi.fn(async () => true);
    const request = vi.fn(async () => true);

    await expect(ensureCustomOriginPermission("https://llm.example/v1", {
      contains,
      request
    })).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("never checks or requests permission for a wildcard hostname", async () => {
    const contains = vi.fn(async () => false);
    const request = vi.fn(async () => true);

    await expect(ensureCustomOriginPermission("https://*.example.com/v1", {
      contains,
      request
    })).rejects.toThrow(/wildcard/i);
    expect(contains).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
