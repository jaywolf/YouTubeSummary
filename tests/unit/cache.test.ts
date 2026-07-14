import { describe, expect, it } from "vitest";
import { SUMMARY_SCHEMA_VERSION, type VideoSummary } from "../../src/domain/summary";
import type { StorageAreaAdapter } from "../../src/platform/storage";
import {
  CACHE_ENTRY_LIMIT,
  CACHE_SIZE_LIMIT_BYTES,
  SummaryCache,
  buildCacheKey,
  type CacheKeyInput
} from "../../src/platform/cache";

const summary: VideoSummary = {
  schemaVersion: 1,
  overview: ["Résumé 😀"],
  takeaways: [{ text: "Takeaway", startSeconds: 0 }],
  sections: [{ heading: "Start", startSeconds: 0, paragraphs: ["Details"] }],
  limitation: "Generated from captions.",
  generatedAt: "2026-07-14T00:00:00.000Z"
};

function keyInput(overrides: Partial<CacheKeyInput> = {}): CacheKeyInput {
  return {
    videoId: "aaaaaaaaaaa",
    captionLanguage: "en",
    autoCaption: false,
    provider: { kind: "openai", apiKey: "secret-a", model: "gpt-test" },
    outputLanguage: "English",
    promptVersion: "v1",
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    ...overrides
  };
}

class MemoryStorage implements StorageAreaAdapter {
  readonly values: Record<string, unknown> = {};
  active = 0;
  maxActive = 0;

  async get(key: string): Promise<Record<string, unknown>> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active--;
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    Object.assign(this.values, structuredClone(items));
    this.active--;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

class GatedStorage extends MemoryStorage {
  getCalls = 0;
  setCalls = 0;
  gate: ReturnType<typeof deferred> | null = null;
  setStarted: (() => void) | null = null;

  override async get(key: string): Promise<Record<string, unknown>> {
    this.getCalls++;
    return super.get(key);
  }

  override async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls++;
    const gate = this.gate;
    if (gate !== null) {
      this.gate = null;
      this.setStarted?.();
      await gate.promise;
    }
    return super.set(items);
  }
}

describe("summary cache identity", () => {
  it("hashes every fixed identity field and excludes the API key", async () => {
    const baseline = await buildCacheKey(keyInput());
    const mutations: CacheKeyInput[] = [
      keyInput({ videoId: "bbbbbbbbbbb" }),
      keyInput({ captionLanguage: "fr" }),
      keyInput({ autoCaption: true }),
      keyInput({ provider: { kind: "openrouter", apiKey: "secret-a", model: "gpt-test" } }),
      keyInput({ provider: { kind: "openai", apiKey: "secret-a", model: "other-model" } }),
      keyInput({ outputLanguage: "French" }),
      keyInput({ promptVersion: "v2" }),
      keyInput({ schemaVersion: 2 })
    ];

    for (const mutation of mutations) expect(await buildCacheKey(mutation)).not.toBe(baseline);
    expect(await buildCacheKey(keyInput({
      provider: { kind: "openai", apiKey: "different-secret", model: "gpt-test" }
    }))).toBe(baseline);
  });

  it("uses only URL.origin for a custom provider identity", async () => {
    const first = await buildCacheKey(keyInput({
      provider: {
        kind: "custom",
        apiKey: "secret-a",
        model: "custom-model",
        baseUrl: "https://llm.example:8443/v1"
      }
    }));
    const sameOrigin = await buildCacheKey(keyInput({
      provider: {
        kind: "custom",
        apiKey: "secret-b",
        model: "custom-model",
        baseUrl: "https://llm.example:8443/compatible/v2"
      }
    }));
    const otherOrigin = await buildCacheKey(keyInput({
      provider: {
        kind: "custom",
        apiKey: "secret-b",
        model: "custom-model",
        baseUrl: "https://other.example/v1"
      }
    }));

    expect(sameOrigin).toBe(first);
    expect(otherOrigin).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("SummaryCache", () => {
  it("uses the fixed production count and byte limits", () => {
    expect(CACHE_ENTRY_LIMIT).toBe(20);
    expect(CACHE_SIZE_LIMIT_BYTES).toBe(5_000_000);
  });

  it("self-heals a corrupt or internally inconsistent envelope to empty", async () => {
    const storage = new MemoryStorage();
    storage.values["summaryCache.v1"] = {
      version: 1,
      entries: [{
        key: "bad",
        result: summary,
        createdAt: "2026-07-14T00:00:00.000Z",
        lastAccessedAt: 1,
        serializedBytes: 1,
        secret: "must make the strict entry invalid"
      }]
    };
    const cache = new SummaryCache(storage);

    await expect(cache.get("bad")).resolves.toBeNull();
    expect(storage.values["summaryCache.v1"]).toEqual({ version: 1, entries: [] });
  });

  it("stores only validated VideoSummary values and recomputes exact UTF-8 bytes", async () => {
    const storage = new MemoryStorage();
    const cache = new SummaryCache(storage, () => 100);

    await expect(cache.set("valid", summary)).resolves.toBe(true);
    const envelope = storage.values["summaryCache.v1"] as {
      entries: Array<Record<string, unknown>>;
    };
    const entry = envelope.entries[0]!;
    expect(entry.serializedBytes).toBe(
      new TextEncoder().encode(JSON.stringify(entry)).byteLength
    );

    await expect(cache.set("invalid", { ...summary, overview: [] })).resolves.toBe(false);
    expect((storage.values["summaryCache.v1"] as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("replaces an existing key without duplicating it", async () => {
    const storage = new MemoryStorage();
    let now = 1;
    const cache = new SummaryCache(storage, () => now++);
    await cache.set("same", summary);
    await cache.set("same", { ...summary, overview: ["Replacement"] });

    expect((storage.values["summaryCache.v1"] as { entries: unknown[] }).entries).toHaveLength(1);
    await expect(cache.get("same")).resolves.toMatchObject({
      result: { overview: ["Replacement"] },
      createdAt: "1970-01-01T00:00:00.002Z"
    });
  });

  it("keeps at most 20 entries and evicts deterministic LRU ties by key", async () => {
    const storage = new MemoryStorage();
    const cache = new SummaryCache(storage, () => 10);
    for (let index = 20; index >= 0; index--) {
      await cache.set(`key-${String(index).padStart(2, "0")}`, summary);
    }

    const entries = (storage.values["summaryCache.v1"] as {
      entries: Array<{ key: string }>;
    }).entries;
    expect(entries).toHaveLength(CACHE_ENTRY_LIMIT);
    expect(entries.map((entry) => entry.key)).not.toContain("key-00");
    expect(entries.map((entry) => entry.key)).toContain("key-20");
  });

  it("touches hits and evicts by byte budget using actual stored entry sizes", async () => {
    const storage = new MemoryStorage();
    let now = 1;
    const cache = new SummaryCache(storage, () => now++, { maxBytes: 13_000 });
    const large = (label: string) => ({
      ...summary,
      overview: [`${label}${"界".repeat(1_500)}`]
    });
    await cache.set("old", large("old"));
    await cache.set("middle", large("middle"));
    await cache.get("old");
    await cache.set("new", large("new"));

    const envelope = storage.values["summaryCache.v1"] as {
      entries: Array<{ key: string; serializedBytes: number }>;
    };
    expect(envelope.entries.reduce((total, entry) => total + entry.serializedBytes, 0))
      .toBeLessThanOrEqual(13_000);
    expect(envelope.entries.map((entry) => entry.key)).toEqual(expect.arrayContaining(["old", "new"]));
    expect(envelope.entries.map((entry) => entry.key)).not.toContain("middle");
  });

  it("does not cache a single entry larger than 5,000,000 bytes", async () => {
    const storage = new MemoryStorage();
    const cache = new SummaryCache(storage, undefined, { maxBytes: 100 });

    await expect(cache.set("oversize", summary)).resolves.toBe(false);
    expect(storage.values["summaryCache.v1"]).toBeUndefined();
  });

  it("serializes a hit touch with a following set without losing either entry", async () => {
    const storage = new GatedStorage();
    const cache = new SummaryCache(storage);
    await cache.set("one", summary);
    storage.getCalls = 0;
    storage.setCalls = 0;
    const gate = deferred();
    let touchStarted!: () => void;
    const started = new Promise<void>((resolve) => { touchStarted = resolve; });
    storage.gate = gate;
    storage.setStarted = touchStarted;

    const get = cache.get("one");
    await started;
    const set = cache.set("two", summary);
    await Promise.resolve();
    expect(storage.getCalls).toBe(1);
    expect(storage.setCalls).toBe(1);
    gate.resolve();
    await Promise.all([get, set]);

    expect(storage.maxActive).toBe(1);
    expect((storage.values["summaryCache.v1"] as { entries: Array<{ key: string }> }).entries
      .map((entry) => entry.key)).toEqual(["one", "two"]);
  });

  it("queues clear behind a held hit touch without resurrecting the touched entry", async () => {
    const storage = new GatedStorage();
    const cache = new SummaryCache(storage);
    await cache.set("one", summary);
    storage.getCalls = 0;
    storage.setCalls = 0;
    const gate = deferred();
    let touchStarted!: () => void;
    const started = new Promise<void>((resolve) => { touchStarted = resolve; });
    storage.gate = gate;
    storage.setStarted = touchStarted;

    const get = cache.get("one");
    await started;
    const clear = cache.clear();
    await Promise.resolve();
    expect(storage.getCalls).toBe(1);
    expect(storage.setCalls).toBe(1);
    gate.resolve();
    await Promise.all([get, clear]);
    expect(storage.values["summaryCache.v1"]).toEqual({ version: 1, entries: [] });
  });

  it("invalidates pre-clear write tokens without overwriting a newer same-key value", async () => {
    const storage = new MemoryStorage();
    const cache = new SummaryCache(storage);
    const staleToken = cache.writeToken();
    await cache.clear();
    const freshToken = cache.writeToken();
    const newer = { ...summary, overview: ["Newer"] };
    await expect(cache.set("same", newer, freshToken)).resolves.toBe(true);

    await expect(cache.set("same", summary, staleToken)).resolves.toBe(false);
    await expect(cache.get("same")).resolves.toMatchObject({ result: { overview: ["Newer"] } });
  });

  it("conditionally removes only its own commit when ownership changes during storage.set", async () => {
    const storage = new GatedStorage();
    const cache = new SummaryCache(storage);
    const gate = deferred();
    let commitStarted!: () => void;
    const started = new Promise<void>((resolve) => { commitStarted = resolve; });
    storage.gate = gate;
    storage.setStarted = commitStarted;
    let current = true;

    const write = cache.set("stale", summary, cache.writeToken(), () => current);
    await started;
    current = false;
    gate.resolve();

    await expect(write).resolves.toBe(false);
    expect(storage.values["summaryCache.v1"]).toEqual({ version: 1, entries: [] });
  });
});
