import { AppError, toSafeError } from "../domain/errors";
import type { BackgroundEvent, JobState } from "../domain/messages";
import type { ExtensionSettings, ProviderConfig } from "../domain/settings";
import {
  SUMMARY_SCHEMA_VERSION,
  completedSummaryPayloadSchema,
  type VideoSummary
} from "../domain/summary";
import type {
  Transcript,
  TranscriptPreference,
  VideoContext
} from "../domain/video";
import { parseExtensionWatchUrl } from "../domain/watchIdentity";
import type { ProviderClient } from "../providers/types";
import type { SummaryPipelineInput } from "../summarization/pipeline";
import { PROMPT_VERSION } from "../summarization/prompts";
import { buildCacheKey, type CachedSummary } from "../platform/cache";
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
  summaryCache: {
    get(key: string): Promise<CachedSummary | null>;
    set(
      key: string,
      result: unknown,
      writeToken: number,
      isCurrent: () => boolean
    ): Promise<boolean>;
    writeToken(): number;
    clear(): Promise<void>;
  };
  createProvider(config: ProviderConfig): ProviderClient;
  runPipeline(input: SummaryPipelineInput): Promise<VideoSummary>;
  emit(event: BackgroundEvent): void;
  browserLanguage?: () => string;
  now?: () => number;
};

export type StartSummaryRequest = {
  requestId: string;
  tabId: number;
  expectedVideoId: string;
  force: boolean;
};

type StartReservation = {
  requestId: string;
  token: symbol;
  startedAt: number;
  videoId: string;
};

type ControllerPreflightErrorCode =
  | "unsupported_page"
  | "video_context_unavailable"
  | "configuration_missing"
  | "configuration_invalid";

function appError(code: ControllerPreflightErrorCode, safeMessage: string): AppError {
  const settingsCodes = new Set<ControllerPreflightErrorCode>([
    "configuration_missing",
    "configuration_invalid"
  ]);
  const recoveryAction = settingsCodes.has(code)
    ? "settings"
    : code === "unsupported_page"
      ? "none"
      : "retry";
  return new AppError({
    code,
    retryable: recoveryAction === "retry",
    safeMessage,
    recoveryAction
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

  async restoreInterruptedJobs(): Promise<void> {
    await this.#registry.restoreInterruptedJobs();
  }

  async clearSummaryCache(): Promise<void> {
    await this.dependencies.summaryCache.clear();
  }

  #reserve(request: StartSummaryRequest): StartReservation {
    const reservation = {
      requestId: request.requestId,
      token: Symbol(request.requestId),
      startedAt: (this.dependencies.now ?? Date.now)(),
      videoId: request.expectedVideoId
    };
    const current = this.#registry.status(request.tabId);
    this.#reservations.set(request.tabId, reservation);
    this.#preflight.delete(request.tabId);
    if (current !== null && !isTerminal(current)) {
      if (this.#registry.cancel(request.tabId, current.requestId)) {
        this.#emitState(current, "canceled");
      }
      void this.dependencies.cancelTranscript(request.tabId, current.requestId).catch(() => undefined);
    }
    return reservation;
  }

  #isReserved(tabId: number, reservation: StartReservation): boolean {
    return this.#reservations.get(tabId)?.token === reservation.token;
  }

  #ownsCompleted(job: JobIdentity): boolean {
    return !this.#reservations.has(job.tabId) && this.#registry.isComplete(job);
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

  #preflightCanceled(
    request: StartSummaryRequest,
    reservation: StartReservation
  ): JobSnapshot | null {
    if (!this.#isReserved(request.tabId, reservation)) return this.status(request.tabId);
    const snapshot: JobSnapshot = {
      requestId: request.requestId,
      tabId: request.tabId,
      videoId: request.expectedVideoId,
      state: "canceled",
      progress: null,
      startedAt: reservation.startedAt
    };
    this.#reservations.delete(request.tabId);
    this.#preflight.set(request.tabId, snapshot);
    this.#emitState(snapshot, "canceled");
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

  async #fail(job: JobRecord, error: AppError): Promise<JobSnapshot | null> {
    if (!this.#registry.fail(job, toSafeError(error))) return this.status(job.tabId);
    await this.#registry.settled();
    const snapshot = this.#registry.status(job.tabId);
    if (snapshot?.state === "error" && snapshot.requestId === job.requestId) {
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
    let identity = parseExtensionWatchUrl("");
    let settings: ExtensionSettings;
    let context: VideoContext;

    try {
      const tab = await this.dependencies.getTab(request.tabId);
      if (!this.#isReserved(request.tabId, reservation)) return this.status(request.tabId);
      identity = typeof tab.url === "string" ? parseExtensionWatchUrl(tab.url) : null;
      if (tab.id !== request.tabId || tab.active !== true || identity === null) {
        return this.#preflightFailure(
          request,
          reservation,
          "",
          appError("unsupported_page", "Open a standard YouTube video page to create a summary.")
        );
      }
      if (identity.videoId !== request.expectedVideoId) {
        return this.#preflightCanceled(request, reservation);
      }

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
    const providerConfig = settings.provider;
    if (providerConfig === null) {
      return this.#preflightFailure(
        request,
        reservation,
        identity.videoId,
        appError("configuration_missing", "Choose a provider, model, and API key in settings.")
      );
    }
    const job = this.#registry.begin(request.tabId, context.videoId, request.requestId);
    this.#reservations.delete(request.tabId);
    this.#preflight.delete(request.tabId);
    this.#emitState(job, "loading_video");

    try {
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

      let cacheKey: string | null = null;
      let cacheWriteToken: number | null = null;
      if (settings.cacheEnabled) {
        cacheKey = await buildCacheKey({
          videoId: context.videoId,
          captionLanguage: transcript.track.languageCode,
          autoCaption: transcript.track.isAutoGenerated,
          provider: providerConfig,
          outputLanguage: settings.outputLanguage,
          promptVersion: PROMPT_VERSION,
          schemaVersion: SUMMARY_SCHEMA_VERSION
        });
        if (job.signal.aborted || !this.#registry.isCurrent(job)) return this.status(request.tabId);
        cacheWriteToken = this.dependencies.summaryCache.writeToken();
        if (!request.force) {
          const cached = await this.dependencies.summaryCache.get(cacheKey).catch(() => null);
          if (job.signal.aborted || !this.#registry.isCurrent(job)) return this.status(request.tabId);
          if (cached !== null) {
            const cachedResult = completedSummaryPayloadSchema.parse({
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
              summary: cached.result,
              cache: { key: cacheKey, createdAt: cached.createdAt }
            });
            if (!this.#registry.complete(job, cachedResult)) return this.status(request.tabId);
            await this.#registry.settled();
            if (!this.#ownsCompleted(job)) return this.status(request.tabId);
            const snapshot = this.#registry.status(request.tabId);
            if (snapshot?.state !== "complete" || snapshot.requestId !== job.requestId) return snapshot;
            this.dependencies.emit({
              type: "job/complete",
              requestId: job.requestId,
              tabId: job.tabId,
              result: snapshot.result
            });
            return snapshot;
          }
        }
      }

      const provider = this.dependencies.createProvider(providerConfig);
      if (!this.#registry.transition(job, "summarizing")) return this.status(request.tabId);
      this.#emitState(job, "summarizing");
      const summary = await this.dependencies.runPipeline({
        transcript,
        video: context,
        settings,
        provider,
        signal: job.signal,
        onProgress: (progress) => {
          if (!this.#registry.progress(job, progress)) return;
          this.dependencies.emit({
            type: "job/progress",
            requestId: job.requestId,
            tabId: job.tabId,
            ...progress
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
      await this.#registry.settled();
      if (!this.#ownsCompleted(job)) return this.status(request.tabId);
      if (cacheKey !== null && cacheWriteToken !== null) {
        try {
          await this.dependencies.summaryCache.set(
            cacheKey,
            result.summary,
            cacheWriteToken,
            () => this.#ownsCompleted(job)
          );
        } catch {
          // A validated completion remains usable when the optional cache is unavailable.
        }
        if (!this.#ownsCompleted(job)) return this.status(request.tabId);
      }
      const snapshot = this.#registry.status(request.tabId);
      if (snapshot?.state !== "complete" || snapshot.requestId !== job.requestId) return snapshot;
      this.dependencies.emit({
        type: "job/complete",
        requestId: job.requestId,
        tabId: job.tabId,
        result: snapshot.result
      });
      return snapshot;
    } catch (error) {
      if (job.signal.aborted || !this.#registry.isCurrent(job)) return this.status(request.tabId);
      return await this.#fail(job, asAppError(error));
    }
  }

  async cancel(tabId: number, requestId: string): Promise<JobSnapshot | null> {
    const reservation = this.#reservations.get(tabId);
    if (reservation?.requestId === requestId) this.#reservations.delete(tabId);
    const current = this.#registry.status(tabId);
    const canceled = this.#registry.cancel(tabId, requestId);
    if (canceled) {
      await this.dependencies.cancelTranscript(tabId, requestId).catch(() => undefined);
      await this.#registry.settled();
      const snapshot = this.#registry.status(tabId);
      if (snapshot?.requestId === requestId && snapshot.state === "canceled") {
        this.#emitState({ requestId, tabId, videoId: current?.videoId ?? "" }, "canceled");
      }
      return snapshot;
    }
    if (reservation?.requestId === requestId) {
      const snapshot: JobSnapshot = {
        requestId,
        tabId,
        videoId: reservation.videoId,
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
    let changed = false;
    if (reservation !== undefined
        && (videoId === null || reservation.videoId !== videoId)) {
      await this.cancel(tabId, reservation.requestId);
      this.#preflight.delete(tabId);
      changed = true;
    }

    const visible = this.status(tabId);
    if (visible !== null && visible.videoId !== videoId) {
      if (!isTerminal(visible)) await this.cancel(tabId, visible.requestId);
      this.#preflight.delete(tabId);
      changed = true;
    }

    const registered = this.#registry.status(tabId);
    if (registered !== null && registered.videoId !== videoId) {
      if (!isTerminal(registered)) await this.cancel(tabId, registered.requestId);
      this.#registry.invalidate(tabId, registered.requestId);
      changed = true;
    }

    if (changed) await this.#registry.settled();
  }
}
