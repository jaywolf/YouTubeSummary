import {
  DEFAULT_SETTINGS,
  parseSettings,
  type ExtensionSettings
} from "../domain/settings";
import { z } from "zod";
import type { JobState, PipelineProgress } from "../domain/messages";

export const SETTINGS_STORAGE_KEY = "settings.v1";
export const SUMMARY_CACHE_STORAGE_KEY = "summaryCache.v1";
export const ACTIVE_JOBS_STORAGE_KEY = "activeJobs.v1";

export type StorageAreaAdapter = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type SettingsRepository = {
  load(): Promise<ExtensionSettings>;
  save(settings: ExtensionSettings): Promise<void>;
  clearCredentials(): Promise<ExtensionSettings>;
  reset(): Promise<ExtensionSettings>;
};

export type PersistedJobSnapshot = {
  requestId: string;
  tabId: number;
  videoId: string;
  state: JobState;
  progress: PipelineProgress | null;
  startedAt: number;
};

export type InterruptedJobSnapshot = Omit<PersistedJobSnapshot, "state"> & {
  state: "interrupted";
};

const progressSchema = z.object({
  phase: z.enum(["mapping", "reducing", "synthesizing"]),
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive()
}).strict().refine((progress) => progress.completed <= progress.total);

const persistedJobSchema = z.object({
  requestId: z.string().min(1),
  tabId: z.number().int().nonnegative(),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  state: z.enum([
    "loading_video",
    "extracting_transcript",
    "summarizing",
    "complete",
    "error",
    "canceled",
    "interrupted"
  ]),
  progress: progressSchema.nullable(),
  startedAt: z.number().finite().nonnegative()
}).strict();

const activeJobsEnvelopeSchema = z.object({
  version: z.literal(1),
  jobs: z.array(persistedJobSchema)
}).strict().superRefine((envelope, refinement) => {
  const tabs = new Set<number>();
  for (const [index, job] of envelope.jobs.entries()) {
    if (tabs.has(job.tabId)) {
      refinement.addIssue({
        code: "custom",
        path: ["jobs", index, "tabId"],
        message: "Only one job may be stored per tab"
      });
    }
    tabs.add(job.tabId);
  }
});

const ACTIVE_JOB_STATES = new Set<JobState>([
  "loading_video",
  "extracting_transcript",
  "summarizing"
]);

const EMPTY_ACTIVE_JOBS = { version: 1 as const, jobs: [] };

export class ActiveJobStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StorageAreaAdapter) {}

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #set(items: Record<string, unknown>): Promise<void> {
    try {
      await this.storage.set(items);
    } catch {
      await this.storage.set(items);
    }
  }

  async #load(): Promise<{ jobs: PersistedJobSnapshot[]; corrupt: boolean }> {
    const stored = await this.storage.get(ACTIVE_JOBS_STORAGE_KEY);
    if (!(ACTIVE_JOBS_STORAGE_KEY in stored)) return { jobs: [], corrupt: false };
    const parsed = activeJobsEnvelopeSchema.safeParse(stored[ACTIVE_JOBS_STORAGE_KEY]);
    return parsed.success
      ? { jobs: parsed.data.jobs, corrupt: false }
      : { jobs: [], corrupt: true };
  }

  save(value: PersistedJobSnapshot): Promise<void> {
    return this.#enqueue(async () => {
      const parsed = persistedJobSchema.safeParse(value);
      if (!parsed.success || !ACTIVE_JOB_STATES.has(parsed.data.state)) return;
      const loaded = await this.#load();
      const jobs = loaded.jobs.filter((job) => job.tabId !== parsed.data.tabId);
      jobs.push(parsed.data);
      await this.#set({ [ACTIVE_JOBS_STORAGE_KEY]: { version: 1, jobs } });
    });
  }

  remove(identity: Pick<PersistedJobSnapshot, "requestId" | "tabId" | "videoId">): Promise<void> {
    return this.#enqueue(async () => {
      const loaded = await this.#load();
      const jobs = loaded.jobs.filter((job) =>
        job.tabId !== identity.tabId
        || job.requestId !== identity.requestId
        || job.videoId !== identity.videoId);
      if (loaded.corrupt || jobs.length !== loaded.jobs.length) {
        await this.#set({ [ACTIVE_JOBS_STORAGE_KEY]: { version: 1, jobs } });
      }
    });
  }

  restoreInterruptedJobs(): Promise<InterruptedJobSnapshot[]> {
    return this.#enqueue(async () => {
      const loaded = await this.#load();
      const interrupted = loaded.jobs
        .filter((job) => ACTIVE_JOB_STATES.has(job.state))
        .map((job) => ({ ...job, state: "interrupted" as const }));
      await this.#set({ [ACTIVE_JOBS_STORAGE_KEY]: EMPTY_ACTIVE_JOBS });
      return interrupted;
    });
  }

  async settled(): Promise<void> {
    await this.#queue;
  }
}

const browserSessionStorage: StorageAreaAdapter = {
  get: (key) => browser.storage.session.get(key),
  set: (items) => browser.storage.session.set(items)
};

export const browserActiveJobStore = new ActiveJobStore(browserSessionStorage);

export function restoreInterruptedJobs(
  store: ActiveJobStore = browserActiveJobStore
): Promise<InterruptedJobSnapshot[]> {
  return store.restoreInterruptedJobs();
}

export async function loadSettings(
  storage: StorageAreaAdapter = browser.storage.local
): Promise<ExtensionSettings> {
  const stored = await storage.get(SETTINGS_STORAGE_KEY);
  if (!(SETTINGS_STORAGE_KEY in stored)) return { ...DEFAULT_SETTINGS };
  return parseSettings(stored[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(
  settings: ExtensionSettings,
  storage: StorageAreaAdapter = browser.storage.local
): Promise<void> {
  await storage.set({ [SETTINGS_STORAGE_KEY]: parseSettings(settings) });
}

export async function clearCredentials(
  storage: StorageAreaAdapter = browser.storage.local
): Promise<ExtensionSettings> {
  const settings = await loadSettings(storage);
  const cleared = { ...settings, provider: null };
  await saveSettings(cleared, storage);
  return cleared;
}

export async function resetSettings(
  storage: StorageAreaAdapter = browser.storage.local
): Promise<ExtensionSettings> {
  const reset = { ...DEFAULT_SETTINGS };
  await saveSettings(reset, storage);
  return reset;
}

export const browserSettingsRepository: SettingsRepository = {
  load: () => loadSettings(),
  save: (settings) => saveSettings(settings),
  clearCredentials: () => clearCredentials(),
  reset: () => resetSettings()
};
