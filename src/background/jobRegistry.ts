import type { SafeAppError } from "../domain/errors";
import type { JobState } from "../domain/messages";
import {
  completedSummaryPayloadSchema,
  type CompletedSummaryPayload
} from "../domain/summary";

export type JobIdentity = {
  requestId: string;
  tabId: number;
  videoId: string;
};

export type JobProgress = { completed: number; total: number };

type SnapshotBase = JobIdentity & {
  progress: JobProgress | null;
  startedAt: number;
};

type ActiveState = Exclude<JobState, "complete" | "error">;

export type JobSnapshot =
  | (SnapshotBase & { state: ActiveState })
  | (SnapshotBase & { state: "error"; error: SafeAppError })
  | (SnapshotBase & { state: "complete"; result: CompletedSummaryPayload });

export type JobRecord = JobIdentity & {
  controller: AbortController;
  readonly signal: AbortSignal;
};

type MutableJob = JobIdentity & {
  controller: AbortController;
  state: JobState;
  progress: JobProgress | null;
  startedAt: number;
  error?: SafeAppError;
  result?: CompletedSummaryPayload;
};

function isTerminalState(state: JobState): boolean {
  return ["complete", "error", "canceled", "interrupted"].includes(state);
}

function sameIdentity(job: JobIdentity, candidate: JobIdentity): boolean {
  return job.requestId === candidate.requestId
    && job.tabId === candidate.tabId
    && job.videoId === candidate.videoId;
}

function publicRecord(job: MutableJob): JobRecord {
  return {
    requestId: job.requestId,
    tabId: job.tabId,
    videoId: job.videoId,
    controller: job.controller,
    signal: job.controller.signal
  };
}

function snapshot(job: MutableJob): JobSnapshot {
  const base: SnapshotBase = {
    requestId: job.requestId,
    tabId: job.tabId,
    videoId: job.videoId,
    progress: job.progress === null ? null : { ...job.progress },
    startedAt: job.startedAt
  };
  if (job.state === "complete") {
    if (job.result === undefined) throw new Error("A complete job requires a result");
    return { ...base, state: "complete", result: job.result };
  }
  if (job.state === "error") {
    if (job.error === undefined) throw new Error("An error job requires a safe error");
    return { ...base, state: "error", error: { ...job.error } };
  }
  return { ...base, state: job.state };
}

export class JobRegistry {
  readonly #jobs = new Map<number, MutableJob>();

  constructor(
    private readonly createRequestId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now()
  ) {}

  begin(tabId: number, videoId: string, requestId = this.createRequestId()): JobRecord {
    const previous = this.#jobs.get(tabId);
    if (previous !== undefined) previous.controller.abort();

    const controller = new AbortController();
    const job: MutableJob = {
      requestId,
      tabId,
      videoId,
      controller,
      state: "loading_video",
      progress: null,
      startedAt: this.now()
    };
    this.#jobs.set(tabId, job);
    return publicRecord(job);
  }

  isCurrent(candidate: JobIdentity): boolean {
    const current = this.#jobs.get(candidate.tabId);
    return current !== undefined && sameIdentity(current, candidate);
  }

  transition(candidate: JobIdentity, state: ActiveState): boolean {
    const current = this.#jobs.get(candidate.tabId);
    if (current === undefined || !sameIdentity(current, candidate)
        || current.controller.signal.aborted || isTerminalState(current.state)) {
      return false;
    }
    current.state = state;
    delete current.error;
    delete current.result;
    return true;
  }

  progress(candidate: JobIdentity, completed: number, total: number): boolean {
    const current = this.#jobs.get(candidate.tabId);
    if (current === undefined || !sameIdentity(current, candidate)
        || current.controller.signal.aborted || isTerminalState(current.state)) {
      return false;
    }
    if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1 || completed > total) {
      throw new Error("Invalid job progress");
    }
    current.progress = { completed, total };
    return true;
  }

  complete(candidate: JobIdentity, value: unknown): boolean {
    const current = this.#jobs.get(candidate.tabId);
    if (current === undefined || !sameIdentity(current, candidate)
        || current.controller.signal.aborted || isTerminalState(current.state)) {
      return false;
    }
    const result = completedSummaryPayloadSchema.parse(value);
    if (result.video.videoId !== current.videoId) {
      throw new Error("Completion video does not match the current job");
    }
    current.result = result;
    current.state = "complete";
    delete current.error;
    return true;
  }

  fail(candidate: JobIdentity, error: SafeAppError): boolean {
    const current = this.#jobs.get(candidate.tabId);
    if (current === undefined || !sameIdentity(current, candidate)
        || current.controller.signal.aborted || isTerminalState(current.state)) {
      return false;
    }
    current.error = { ...error };
    current.state = "error";
    delete current.result;
    return true;
  }

  cancel(tabId: number, requestId?: string): boolean {
    const current = this.#jobs.get(tabId);
    if (current === undefined || (requestId !== undefined && current.requestId !== requestId)) {
      return false;
    }
    if (isTerminalState(current.state) || current.controller.signal.aborted) return false;
    current.controller.abort();
    current.state = "canceled";
    delete current.error;
    delete current.result;
    return true;
  }

  status(tabId: number): JobSnapshot | null {
    const job = this.#jobs.get(tabId);
    return job === undefined ? null : snapshot(job);
  }
}
