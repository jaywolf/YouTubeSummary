import { AppError } from "../domain/errors";
import type { PipelineProgress } from "../domain/messages";
import type { ExtensionSettings } from "../domain/settings";
import {
  SUMMARY_LIMITATION,
  SUMMARY_SCHEMA_VERSION,
  chunkSummarySchema,
  summaryContentSchema,
  videoSummarySchema,
  type ChunkSummary,
  type VideoSummary
} from "../domain/summary";
import type { Transcript, VideoContext } from "../domain/video";
import type { ProviderClient, ProviderRequest } from "../providers/types";
import {
  estimateTokens,
  groupForSynthesis,
  inputBudgetTokens,
  OUTPUT_RESERVE_TOKENS,
  PROMPT_RESERVE_TOKENS,
  chunkTranscript
} from "./chunking";
import {
  buildChunkPrompt,
  buildSummaryPrompt,
  buildSynthesisPrompt,
  serializeChunkSummaries,
  serializePrompt
} from "./prompts";

export type { PipelineProgress } from "../domain/messages";

export type SummaryPipelineInput = {
  transcript: Transcript;
  video: VideoContext;
  settings: ExtensionSettings;
  provider: ProviderClient;
  onProgress(progress: PipelineProgress): void;
  signal: AbortSignal;
  now?: () => Date;
};

function canceled(): AppError {
  return new AppError({
    code: "request_canceled",
    retryable: false,
    safeMessage: "Summary generation was canceled.",
    recoveryAction: "none"
  });
}

function contextLimit(): AppError {
  return new AppError({
    code: "context_limit_exceeded",
    retryable: false,
    safeMessage: "This transcript is too long for the configured model context limit.",
    recoveryAction: "settings"
  });
}

function invalidOutput(cause: Error): AppError {
  return new AppError({
    code: "provider_output_invalid",
    retryable: true,
    safeMessage: "The model returned an invalid summary format.",
    recoveryAction: "change_model",
    cause
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw canceled();
}

function maximumInputTokens(contextWindowTokens: number): number {
  return inputBudgetTokens(contextWindowTokens) + PROMPT_RESERVE_TOKENS;
}

function promptFits(prompt: { system: string; user: string }, maximum: number): boolean {
  return estimateTokens(serializePrompt(prompt)) <= maximum;
}

function assertPromptFits(prompt: { system: string; user: string }, maximum: number): void {
  if (!promptFits(prompt, maximum)) throw contextLimit();
}

async function generate(
  provider: ProviderClient,
  request: Omit<ProviderRequest, "maxOutputTokens">,
  signal: AbortSignal
): Promise<unknown> {
  throwIfAborted(signal);
  try {
    const value = await provider.generate({
      ...request,
      maxOutputTokens: OUTPUT_RESERVE_TOKENS
    }, () => undefined, signal);
    throwIfAborted(signal);
    return value;
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}

function parseChunk(value: unknown): ChunkSummary {
  const parsed = chunkSummarySchema.safeParse(value);
  if (!parsed.success) throw invalidOutput(parsed.error);
  return parsed.data;
}

function parseFinal(value: unknown, now: () => Date): VideoSummary {
  const parsed = summaryContentSchema.safeParse(value);
  if (!parsed.success) throw invalidOutput(parsed.error);
  return videoSummarySchema.parse({
    ...parsed.data,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    limitation: SUMMARY_LIMITATION,
    generatedAt: now().toISOString()
  });
}

export async function runSummaryPipeline({
  transcript,
  video,
  settings,
  provider,
  onProgress,
  signal,
  now = () => new Date()
}: SummaryPipelineInput): Promise<VideoSummary> {
  throwIfAborted(signal);
  const dataBudget = inputBudgetTokens(settings.contextWindowTokens);
  const maximumInput = maximumInputTokens(settings.contextWindowTokens);
  const finalTranscriptPrompt = buildSummaryPrompt({
    video,
    transcript: transcript.segments,
    outputLanguage: settings.outputLanguage
  });

  if (promptFits(finalTranscriptPrompt, maximumInput)) {
    onProgress({ phase: "synthesizing", completed: 0, total: 1 });
    const generated = await generate(provider, {
      kind: "final",
      system: finalTranscriptPrompt.system,
      user: finalTranscriptPrompt.user,
      schema: "video-summary"
    }, signal);
    const summary = parseFinal(generated, now);
    throwIfAborted(signal);
    onProgress({ phase: "synthesizing", completed: 1, total: 1 });
    return summary;
  }

  const chunks = chunkTranscript(transcript.segments, dataBudget);
  if (chunks.length === 0) throw contextLimit();
  const chunkPrompts = chunks.map((chunk) => buildChunkPrompt({
    video,
    transcript: chunk,
    outputLanguage: settings.outputLanguage
  }));
  // Preflight the complete set so an oversized later singleton cannot incur earlier calls.
  for (const prompt of chunkPrompts) assertPromptFits(prompt, maximumInput);

  let completed = 0;
  let total = chunks.length + 1;
  onProgress({ phase: "mapping", completed, total });
  let current: ChunkSummary[] = [];
  for (const prompt of chunkPrompts) {
    const generated = await generate(provider, {
      kind: "chunk",
      system: prompt.system,
      user: prompt.user,
      schema: "chunk-summary"
    }, signal);
    current.push(parseChunk(generated));
    throwIfAborted(signal);
    completed++;
    onProgress({ phase: "mapping", completed, total });
  }

  let finalPrompt = buildSynthesisPrompt({
    video,
    summaries: current,
    outputLanguage: settings.outputLanguage,
    final: true
  });

  while (!promptFits(finalPrompt, maximumInput)) {
    for (const summary of current) {
      if (estimateTokens(serializeChunkSummaries([summary])) > dataBudget) {
        throw contextLimit();
      }
    }
    const groups = groupForSynthesis(current, dataBudget);
    const mergeGroups = groups.filter((group) => group.length > 1);
    if (groups.length >= current.length || mergeGroups.length === 0) throw contextLimit();

    const prompts = mergeGroups.map((group) => buildSynthesisPrompt({
      video,
      summaries: group,
      outputLanguage: settings.outputLanguage,
      final: false
    }));
    for (const prompt of prompts) assertPromptFits(prompt, maximumInput);

    total += mergeGroups.length;
    onProgress({ phase: "reducing", completed, total });
    const next: ChunkSummary[] = [];
    let promptIndex = 0;
    for (const group of groups) {
      if (group.length === 1) {
        next.push(group[0]!);
        continue;
      }
      const prompt = prompts[promptIndex++]!;
      const generated = await generate(provider, {
        kind: "synthesis",
        system: prompt.system,
        user: prompt.user,
        schema: "chunk-summary"
      }, signal);
      next.push(parseChunk(generated));
      throwIfAborted(signal);
      completed++;
      onProgress({ phase: "reducing", completed, total });
    }
    if (next.length >= current.length) throw contextLimit();
    current = next;
    finalPrompt = buildSynthesisPrompt({
      video,
      summaries: current,
      outputLanguage: settings.outputLanguage,
      final: true
    });
  }

  assertPromptFits(finalPrompt, maximumInput);
  onProgress({ phase: "synthesizing", completed, total });
  const generated = await generate(provider, {
    kind: "final",
    system: finalPrompt.system,
    user: finalPrompt.user,
    schema: "video-summary"
  }, signal);
  const summary = parseFinal(generated, now);
  throwIfAborted(signal);
  completed++;
  onProgress({ phase: "synthesizing", completed, total });
  return summary;
}
