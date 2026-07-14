import { AppError, toSafeError, type SafeAppError } from "../domain/errors";
import type { BackgroundEvent, JobState } from "../domain/messages";
import type { ExtensionSettings, ProviderConfig } from "../domain/settings";
import { completedSummaryPayloadSchema, type VideoSummary } from "../domain/summary";
import type {
  Transcript,
  TranscriptPreference,
  VideoContext
} from "../domain/video";
import { parseWatchUrl } from "../domain/video";
import type { ProviderClient } from "../providers/types";
import type { SummaryPipelineInput } from "../summarization/pipeline";
import {
  JobRegistry,
  type JobIdentity,
  type JobRecord,
  type JobSnapshot
} from "./jobRegistry";

export type ControllerTab = {
  id?: number | undefined;
  active?: boolean | undefined;
  url?: string | undefined;
};

export type SummaryControllerDependencies = {
  getTab(tabId: number): Promise<ControllerTab>;
  readVideoContext(tabId: number): Promise<VideoContext | null>;
  loadSettings(): Promise<ExtensionSettings>;
  extractTranscript(
    tabId: number,
    requestId: string,
    context: VideoContext,
    preference: TranscriptPreference,
    signal: AbortSignal
  ): Promise<Transcript>;
  cancelTranscript(tabId: number, requestId: string): Promise<void>;
  createProvider(config: ProviderConfig): ProviderClient;
  runPipeline(input: SummaryPipelineInput): Promise<VideoSummary>;
  emit(event: BackgroundEvent): void;
  browserLanguage?: () => string;
  now?: () => number;
};

export type StartSummaryRequest = {
  requestId: string;
  tabId: number;
  force: boolean;
};

type StartReservation = {
  requestId: string;
  token: symbol;
  startedAt: number;
  videoId?: string;
};

function appError(code: SafeAppError["code"], safeMessage: string): AppError {
  const settingsCodes = new Set<SafeAppError["code"]>([
    "configuration_missing",
    "configuration_invalid"
  ]);
  return new AppError({
    code,
    retryable: code !== "unsupported_page",
    safeMessage,
    recoveryAction: settingsCodes.has(code) ? "settings" : code === "unsupported_page" ? "none" : "retry"
  });
}

function internalError(): AppError {
  return new AppError({
    code: "internal_error",
    retryable: true,
    safeMessage: "The summary could not be generated.",
    recoveryAction: "retry"
  });
}

function asAppError(error: unknown): AppError {
  return error instanceof AppError ? error : internalError();
}

function isTerminal(snapshot: JobSnapshot | null): boolean {
  return snapshot !== null && ["complete", "error", "canceled", "interrupted"].includes(snapshot.state);
}

export class SummaryController {
  readonly #registry: JobRegistry;
  readonly #reservations = new Map<number, StartReservation>();
  readonly #preflight = new Map<number, JobSnapshot>();

  constructor(
    private readonly dependencies: SummaryControllerDependencies,
    registry?: JobRegistry
  ) {
    this.#registry = registry ?? new JobRegistry(
      () => crypto.randomUUID(),
      dependencies.now ?? (() => Date.now())
    );
  }

  status(tabId: number): JobSnapshot | null {
    return this.#preflight.get(tabId) ?? this.#registry.status(tabId);
  }

  #reserve(request: StartSummaryRequest): StartReservation {
    const reservation = {
      requestId: request.requestId,
      token: Symbol(request.requestId),
      startedAt: (this.dependencies.now ?? Date.now)()
    };
    const current = this.#registry.status(request.tabId);
    this.#reservations.set(request.tabId, reservation);
    this.#preflight.delete(request.tabId);
    if (current !== null && !isTerminal(current)) {
      this.#registry.cancel(request.tabId, current.requestId);
      void this.dependencies.cancelTranscript(request.tabId, current.requestId).catch(() => undefined);
    }
    return reservation;
  }

  #isReserved(tabId: number, reservation: StartReservation): boolean {
    return this.#reservations.get(tabId)?.token === reservation.token;
  }

  #preflightFailure(
    request: StartSummaryRequest,
    reservation: StartReservation,
    videoId: string,
    error: AppError
  ): JobSnapshot | null {
    if (!this.#isReserved(request.tabId, reservation)) return this.status(request.tabId);
    const snapshot: JobSnapshot = {
      requestId: request.requestId,
      tabId: request.tabId,
      videoId,
      state: "error",
      progress: null,
      startedAt: reservation.startedAt,
      error: toSafeError(error)
    };
    this.#reservations.delete(request.tabId);
    this.#preflight.set(request.tabId, snapshot);
    this.dependencies.emit({
      type: "job/error",
      requestId: request.requestId,
      tabId: request.tabId,
      error: snapshot.error
    });
    return snapshot;
  }

  #emitState(job: JobIdentity, state: JobState): void {
    this.dependencies.emit({
      type: "job/state",
      requestId: job.requestId,
      tabId: job.tabId,
      state
    });
  }

  #fail(job: JobRecord, error: AppError): JobSnapshot | null {
    if (!this.#registry.fail(job, toSafeError(error))) return this.status(job.tabId);
    const snapshot = this.#registry.status(job.tabId);
    if (snapshot?.state === "error") {
      this.dependencies.emit({
        type: "job/error",
        requestId: job.requestId,
        tabId: job.tabId,
        error: snapshot.error
      });
    }
    return snapshot;
  }

  async start(request: StartSummaryRequest): Promise<JobSnapshot | null> {
    const reservation = this.#reserve(request);
    let identity = parseWatchUrl("");
    let settings: ExtensionSettings;
    let context: VideoContext;

    try {
      const tab = await this.dependencies.getTab(request.tabId);
      if (!this.#isReserved(request.tabId, reservation)) return this.status(request.tabId);
      identity = typeof tab.url === "string" ? parseWatchUrl(tab.url) : null;
      if (tab.id !== request.tabId || tab.active !== true || identity === null) {
        return this.#preflightFailure(
          request,
          reservation,
          "",
          appError("unsupported_page", "Open a standard YouTube video page to create a summary.")
        );
      }
      reservation.videoId = identity.videoId;

      const readContext = await this.dependencies.readVideoContext(request.tabId);
      if (!this.#isReserved(request.tabId, reservation)) return this.status(request.tabId);
      if (readContext === null || readContext.videoId !== identity.videoId) {
        return this.#preflightFailure(
          request,
          reservation,
          identity.videoId,
          appError("video_context_unavailable", "The video context could not be read.")
        );
      }
      context = readContext;

      try {
        settings = await this.dependencies.loadSettings();
      } catch {
        return this.#preflightFailure(
          request,
          reservation,
          identity.videoId,
          appError("configuration_invalid", "The saved provider settings are invalid.")
        );
      }
    } catch {
      if (!this.#isReserved(request.tabId, reservation)) return this.status(request.tabId);
      return this.#preflightFailure(
        request,
        reservation,
        identity?.videoId ?? "",
        appError("video_context_unavailable", "The video context could not be read.")
      );
    }

    if (!this.#isReserved(request.tabId, reservation)) return this.status(request.tabId);
    const job = this.#registry.begin(request.tabId, context.videoId, request.requestId);
    this.#reservations.delete(request.tabId);
    this.#preflight.delete(request.tabId);
    this.#emitState(job, "loading_video");

    try {
      if (settings.provider === null) {
        throw appError("configuration_missing", "Choose a provider, model, and API key in settings.");
      }

      if (!this.#registry.transition(job, "extracting_transcript")) return this.status(request.tabId);
      this.#emitState(job, "extracting_transcript");
      const transcript = await this.dependencies.extractTranscript(
        request.tabId,
        request.requestId,
        context,
        {
          preferredLanguage: settings.captionLanguage,
          browserLanguage: (this.dependencies.browserLanguage ?? (() => "en-US"))()
        },
        job.signal
      );
      if (job.signal.aborted || !this.#registry.isCurrent(job)) return this.status(request.tabId);

      const provider = this.dependencies.createProvider(settings.provider);
      if (!this.#registry.transition(job, "summarizing")) return this.status(request.tabId);
      this.#emitState(job, "summarizing");
      const summary = await this.dependencies.runPipeline({
        transcript,
        video: context,
        settings,
        provider,
        signal: job.signal,
        onProgress: (completed, total) => {
          if (!this.#registry.progress(job, completed, total)) return;
          this.dependencies.emit({
            type: "job/progress",
            requestId: job.requestId,
            tabId: job.tabId,
            completed,
            total
          });
        }
      });
      if (job.signal.aborted || !this.#registry.isCurrent(job)) return this.status(request.tabId);

      const result = completedSummaryPayloadSchema.parse({
        video: {
          videoId: context.videoId,
          title: context.title,
          channel: context.channel
        },
        caption: {
          languageCode: transcript.track.languageCode,
          label: transcript.track.label,
          isAutoGenerated: transcript.track.isAutoGenerated
        },
        summary,
        cache: null
      });
      if (!this.#registry.complete(job, result)) return this.status(request.tabId);
      const snapshot = this.#registry.status(request.tabId);
      if (snapshot?.state !== "complete") return snapshot;
      this.dependencies.emit({
        type: "job/complete",
        requestId: job.requestId,
        tabId: job.tabId,
        result: snapshot.result
      });
      return snapshot;
    } catch (error) {
      if (job.signal.aborted || !this.#registry.isCurrent(job)) return this.status(request.tabId);
      return this.#fail(job, asAppError(error));
    }
  }

  async cancel(tabId: number, requestId: string): Promise<JobSnapshot | null> {
    const reservation = this.#reservations.get(tabId);
    if (reservation?.requestId === requestId) this.#reservations.delete(tabId);
    const current = this.#registry.status(tabId);
    const canceled = this.#registry.cancel(tabId, requestId);
    if (canceled) {
      await this.dependencies.cancelTranscript(tabId, requestId).catch(() => undefined);
      this.#emitState({ requestId, tabId, videoId: current?.videoId ?? "" }, "canceled");
      return this.#registry.status(tabId);
    }
    if (reservation?.requestId === requestId) {
      const snapshot: JobSnapshot = {
        requestId,
        tabId,
        videoId: this.#preflight.get(tabId)?.videoId ?? "",
        state: "canceled",
        progress: null,
        startedAt: reservation.startedAt
      };
      this.#preflight.set(tabId, snapshot);
      this.#emitState(snapshot, "canceled");
      return snapshot;
    }
    return this.status(tabId);
  }

  async navigated(tabId: number, videoId: string | null): Promise<void> {
    const reservation = this.#reservations.get(tabId);
    const current = this.status(tabId);
    if (reservation !== undefined
        && (videoId === null || reservation.videoId !== undefined && reservation.videoId !== videoId)) {
      await this.cancel(tabId, reservation.requestId);
      return;
    }
    if (current !== null && current.videoId !== videoId && !isTerminal(current)) {
      await this.cancel(tabId, current.requestId);
    }
  }
}
