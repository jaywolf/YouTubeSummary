import { describe, expect, it, vi } from "vitest";
import { JobRegistry } from "../../src/background/jobRegistry";
import { SummaryController, type SummaryControllerDependencies } from "../../src/background/controller";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
import type { StorageAreaAdapter } from "../../src/platform/storage";
import {
  ACTIVE_JOBS_STORAGE_KEY,
  ActiveJobStore
} from "../../src/platform/storage";

class MemoryStorage implements StorageAreaAdapter {
  readonly values: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items));
  }
}

const active = {
  requestId: "active-request",
  tabId: 4,
  videoId: "aaaaaaaaaaa",
  state: "summarizing" as const,
  progress: { phase: "mapping" as const, completed: 1, total: 4 },
  startedAt: 123
};

describe("active job lifecycle persistence", () => {
  it("persists only the allowlisted active snapshot fields", async () => {
    const storage = new MemoryStorage();
    const store = new ActiveJobStore(storage);
    const registry = new JobRegistry(() => "secret-request", () => 123, store);
    const job = registry.begin(4, "aaaaaaaaaaa");
    registry.transition(job, "extracting_transcript");
    registry.progress(job, { phase: "mapping", completed: 1, total: 4 });
    await store.settled();

    expect(storage.values[ACTIVE_JOBS_STORAGE_KEY]).toEqual({
      version: 1,
      jobs: [{
        requestId: "secret-request",
        tabId: 4,
        videoId: "aaaaaaaaaaa",
        state: "extracting_transcript",
        progress: { phase: "mapping", completed: 1, total: 4 },
        startedAt: 123
      }]
    });
    const envelope = storage.values[ACTIVE_JOBS_STORAGE_KEY] as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(Object.keys(envelope.jobs[0]!).sort()).toEqual([
      "progress", "requestId", "startedAt", "state", "tabId", "videoId"
    ]);
    const serialized = JSON.stringify(envelope);
    for (const forbidden of [
      "synthetic-api-key",
      "BEGIN TRANSCRIPT",
      "provider request body",
      "raw provider error",
      "authorization: Bearer"
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("restores valid nonterminal jobs as interrupted and removes all session records", async () => {
    const storage = new MemoryStorage();
    storage.values[ACTIVE_JOBS_STORAGE_KEY] = {
      version: 1,
      jobs: [
        active,
        { ...active, requestId: "terminal", tabId: 5, state: "complete" }
      ]
    };
    const store = new ActiveJobStore(storage);
    const registry = new JobRegistry(undefined, undefined, store);

    await registry.restoreInterruptedJobs();

    expect(registry.status(4)).toEqual({ ...active, state: "interrupted" });
    expect(registry.status(5)).toBeNull();
    expect(storage.values[ACTIVE_JOBS_STORAGE_KEY]).toEqual({ version: 1, jobs: [] });
  });

  it("discards a corrupt envelope instead of exposing or partially restoring it", async () => {
    const storage = new MemoryStorage();
    storage.values[ACTIVE_JOBS_STORAGE_KEY] = {
      version: 1,
      jobs: [{ ...active, apiKey: "must-not-survive" }]
    };
    const store = new ActiveJobStore(storage);
    const registry = new JobRegistry(undefined, undefined, store);

    await registry.restoreInterruptedJobs();

    expect(registry.status(4)).toBeNull();
    expect(storage.values[ACTIVE_JOBS_STORAGE_KEY]).toEqual({ version: 1, jobs: [] });
  });

  it("terminal removal is identity-conditional and cannot delete a replacement", async () => {
    const storage = new MemoryStorage();
    const store = new ActiveJobStore(storage);
    const ids = ["request-a", "request-b"];
    const registry = new JobRegistry(() => ids.shift()!, () => 123, store);
    const jobA = registry.begin(4, "aaaaaaaaaaa");
    registry.progress(jobA, { phase: "mapping", completed: 1, total: 4 });
    registry.cancel(4, "request-a");
    registry.begin(4, "bbbbbbbbbbb");
    await store.settled();

    expect(storage.values[ACTIVE_JOBS_STORAGE_KEY]).toEqual({
      version: 1,
      jobs: [expect.objectContaining({ requestId: "request-b", videoId: "bbbbbbbbbbb" })]
    });
  });

  it("restoration never constructs providers, resumes work, or populates cache", async () => {
    const storage = new MemoryStorage();
    storage.values[ACTIVE_JOBS_STORAGE_KEY] = { version: 1, jobs: [active] };
    const store = new ActiveJobStore(storage);
    const registry = new JobRegistry(undefined, undefined, store);
    const dependencies = {
      getTab: vi.fn(),
      readVideoContext: vi.fn(),
      loadSettings: vi.fn(async () => DEFAULT_SETTINGS),
      extractTranscript: vi.fn(),
      cancelTranscript: vi.fn(),
      summaryCache: {
        get: vi.fn(),
        set: vi.fn(),
        writeToken: vi.fn(() => 0),
        clear: vi.fn(async () => undefined)
      },
      createProvider: vi.fn(),
      runPipeline: vi.fn(),
      emit: vi.fn()
    } satisfies SummaryControllerDependencies;
    const controller = new SummaryController(dependencies, registry);

    await controller.restoreInterruptedJobs();

    expect(controller.status(4)).toMatchObject({ state: "interrupted", requestId: "active-request" });
    expect(dependencies.getTab).not.toHaveBeenCalled();
    expect(dependencies.createProvider).not.toHaveBeenCalled();
    expect(dependencies.summaryCache.set).not.toHaveBeenCalled();
    expect(dependencies.emit).not.toHaveBeenCalled();
  });
});
