import { z } from "zod";
import type { ProviderConfig, SummaryDetail } from "../domain/settings";
import { videoSummarySchema, type VideoSummary } from "../domain/summary";
import { SUMMARY_CACHE_STORAGE_KEY, type StorageAreaAdapter } from "./storage";

export const CACHE_ENTRY_LIMIT = 20;
export const CACHE_SIZE_LIMIT_BYTES = 5_000_000;

export type CacheKeyInput = {
  videoId: string;
  captionLanguage: string;
  autoCaption: boolean;
  provider: ProviderConfig;
  outputLanguage: string;
  summaryDetail: SummaryDetail;
  promptVersion: string;
  schemaVersion: number;
};

export type CachedSummary = {
  result: VideoSummary;
  createdAt: string;
};

type CacheEntry = CachedSummary & {
  key: string;
  lastAccessedAt: number;
  serializedBytes: number;
};

type CacheEnvelope = {
  version: 1;
  entries: CacheEntry[];
};

type CacheLimits = {
  maxEntries?: number;
  maxBytes?: number;
};

const cacheEntrySchema = z.object({
  key: z.string().min(1),
  result: videoSummarySchema,
  createdAt: z.string().datetime({ offset: true }),
  lastAccessedAt: z.number().finite().nonnegative(),
  serializedBytes: z.number().int().positive()
}).strict();

const cacheEnvelopeSchema = z.object({
  version: z.literal(1),
  entries: z.array(cacheEntrySchema)
}).strict();

const EMPTY_CACHE: CacheEnvelope = { version: 1, entries: [] };

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function measuredEntry(entry: Omit<CacheEntry, "serializedBytes">): CacheEntry {
  let serializedBytes = 0;
  for (;;) {
    const measured = { ...entry, serializedBytes };
    const next = utf8Bytes(measured);
    if (next === serializedBytes) return measured;
    serializedBytes = next;
  }
}

function hasExactSizes(envelope: CacheEnvelope): boolean {
  const keys = new Set<string>();
  return envelope.entries.every(({ serializedBytes, ...entry }) => {
    if (keys.has(entry.key) || serializedBytes !== measuredEntry(entry).serializedBytes) return false;
    keys.add(entry.key);
    return true;
  });
}

function providerIdentity(provider: ProviderConfig): {
  kind: ProviderConfig["kind"];
  origin: string;
  model: string;
} {
  return {
    kind: provider.kind,
    origin: provider.kind === "custom" ? new URL(provider.baseUrl).origin : "",
    model: provider.model
  };
}

function boundedEntries(
  source: CacheEntry[],
  maxEntries: number,
  maxBytes: number
): CacheEntry[] {
  const entries = [...source];
  const evictionOrder = [...entries].sort((left, right) =>
    left.lastAccessedAt - right.lastAccessedAt || left.key.localeCompare(right.key));
  let bytes = entries.reduce((total, candidate) => total + candidate.serializedBytes, 0);
  while (entries.length > maxEntries || bytes > maxBytes
      || utf8Bytes({ version: 1, entries }) > maxBytes) {
    const evicted = evictionOrder.shift();
    if (evicted === undefined) break;
    const index = entries.findIndex((candidate) => candidate.key === evicted.key);
    if (index >= 0) {
      entries.splice(index, 1);
      bytes -= evicted.serializedBytes;
    }
  }
  return entries;
}

export async function buildCacheKey(input: CacheKeyInput): Promise<string> {
  const provider = providerIdentity(input.provider);
  const canonical = JSON.stringify({
    videoId: input.videoId,
    captionLanguage: input.captionLanguage,
    autoCaption: input.autoCaption,
    providerKind: provider.kind,
    providerOrigin: provider.origin,
    model: provider.model,
    outputLanguage: input.outputLanguage,
    summaryDetail: input.summaryDetail,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class SummaryCache {
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #queue: Promise<void> = Promise.resolve();
  #generation = 0;

  constructor(
    private readonly storage: StorageAreaAdapter,
    private readonly now: () => number = () => Date.now(),
    limits: CacheLimits = {}
  ) {
    this.#maxEntries = limits.maxEntries ?? CACHE_ENTRY_LIMIT;
    this.#maxBytes = limits.maxBytes ?? CACHE_SIZE_LIMIT_BYTES;
  }

  writeToken(): number {
    return this.#generation;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load(): Promise<{ envelope: CacheEnvelope; corrupt: boolean }> {
    const stored = await this.storage.get(SUMMARY_CACHE_STORAGE_KEY);
    if (!(SUMMARY_CACHE_STORAGE_KEY in stored)) {
      return { envelope: structuredClone(EMPTY_CACHE), corrupt: false };
    }
    const parsed = cacheEnvelopeSchema.safeParse(stored[SUMMARY_CACHE_STORAGE_KEY]);
    if (!parsed.success || !hasExactSizes(parsed.data)
        || parsed.data.entries.length > this.#maxEntries
        || parsed.data.entries.reduce((total, entry) => total + entry.serializedBytes, 0)
          > this.#maxBytes
        || utf8Bytes(parsed.data) > this.#maxBytes) {
      return { envelope: structuredClone(EMPTY_CACHE), corrupt: true };
    }
    return { envelope: parsed.data, corrupt: false };
  }

  get(key: string): Promise<CachedSummary | null> {
    return this.#enqueue(async () => {
      const loaded = await this.#load();
      const entry = loaded.envelope.entries.find((candidate) => candidate.key === key);
      if (entry === undefined) {
        if (loaded.corrupt) await this.storage.set({ [SUMMARY_CACHE_STORAGE_KEY]: EMPTY_CACHE });
        return null;
      }

      const touched = measuredEntry({
        key: entry.key,
        result: entry.result,
        createdAt: entry.createdAt,
        lastAccessedAt: this.now()
      });
      const entries = boundedEntries(
        loaded.envelope.entries.map((candidate) => candidate.key === key ? touched : candidate),
        this.#maxEntries,
        this.#maxBytes
      );
      await this.storage.set({
        [SUMMARY_CACHE_STORAGE_KEY]: { version: 1, entries } satisfies CacheEnvelope
      });
      return { result: touched.result, createdAt: touched.createdAt };
    });
  }

  set(
    key: string,
    value: unknown,
    writeToken = this.writeToken(),
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    return this.#enqueue(async () => {
      const loaded = await this.#load();
      const parsed = videoSummarySchema.safeParse(value);
      if (!parsed.success || writeToken !== this.#generation || !isCurrent()) {
        if (loaded.corrupt) await this.storage.set({ [SUMMARY_CACHE_STORAGE_KEY]: EMPTY_CACHE });
        return false;
      }

      const timestamp = this.now();
      const entry = measuredEntry({
        key,
        result: parsed.data,
        createdAt: new Date(timestamp).toISOString(),
        lastAccessedAt: timestamp
      });
      if (entry.serializedBytes > this.#maxBytes
          || utf8Bytes({ version: 1, entries: [entry] }) > this.#maxBytes) {
        if (loaded.corrupt) await this.storage.set({ [SUMMARY_CACHE_STORAGE_KEY]: EMPTY_CACHE });
        return false;
      }

      const candidates = boundedEntries(loaded.envelope.entries
        .filter((candidate) => candidate.key !== key)
        .concat(entry), this.#maxEntries, this.#maxBytes);
      if (writeToken !== this.#generation || !isCurrent()) return false;
      await this.storage.set({
        [SUMMARY_CACHE_STORAGE_KEY]: { version: 1, entries: candidates } satisfies CacheEnvelope
      });
      if (writeToken !== this.#generation || !isCurrent()) {
        const current = await this.#load();
        const retained = current.envelope.entries.filter((candidate) =>
          candidate.key !== entry.key
          || candidate.createdAt !== entry.createdAt
          || candidate.serializedBytes !== entry.serializedBytes);
        if (retained.length !== current.envelope.entries.length) {
          await this.storage.set({
            [SUMMARY_CACHE_STORAGE_KEY]: { version: 1, entries: retained } satisfies CacheEnvelope
          });
        } else if (current.corrupt) {
          await this.storage.set({ [SUMMARY_CACHE_STORAGE_KEY]: EMPTY_CACHE });
        }
        return false;
      }
      return true;
    });
  }

  clear(): Promise<void> {
    this.#generation++;
    return this.#enqueue(async () => {
      await this.storage.set({ [SUMMARY_CACHE_STORAGE_KEY]: EMPTY_CACHE });
    });
  }
}

const browserCacheStorage: StorageAreaAdapter = {
  get: (key) => browser.storage.local.get(key),
  set: (items) => browser.storage.local.set(items)
};

export const browserSummaryCache = new SummaryCache(browserCacheStorage);

export async function clearSummaryCache(cache: SummaryCache = browserSummaryCache): Promise<void> {
  await cache.clear();
}
