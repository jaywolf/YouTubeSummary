import { AppError } from "../domain/errors";
import type { ChunkSummary } from "../domain/summary";
import type { TranscriptSegment } from "../domain/video";
import {
  serializeChunkSummaries,
  serializeTranscriptSegments
} from "./prompts";

export const CHARACTERS_PER_TOKEN = 3.5;
export const PROMPT_RESERVE_TOKENS = 2_048;
export const OUTPUT_RESERVE_TOKENS = 4_096;
export const CONTEXT_SAFETY_RATIO = 0.85;
export const SEGMENT_OVERLAP_COUNT = 2;
const MIN_CONTEXT_WINDOW_TOKENS = 8_192;
const MAX_CONTEXT_WINDOW_TOKENS = 1_000_000;

export function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / CHARACTERS_PER_TOKEN);
}

export function inputBudgetTokens(contextWindowTokens: number): number {
  if (!Number.isFinite(contextWindowTokens)
      || !Number.isInteger(contextWindowTokens)
      || contextWindowTokens < MIN_CONTEXT_WINDOW_TOKENS
      || contextWindowTokens > MAX_CONTEXT_WINDOW_TOKENS) {
    throw new AppError({
      code: "configuration_invalid",
      retryable: false,
      safeMessage: "The configured model context limit is invalid.",
      recoveryAction: "settings"
    });
  }
  const budget = Math.floor(contextWindowTokens * CONTEXT_SAFETY_RATIO)
    - PROMPT_RESERVE_TOKENS
    - OUTPUT_RESERVE_TOKENS;
  if (budget <= 0) {
    throw new AppError({
      code: "configuration_invalid",
      retryable: false,
      safeMessage: "The configured model context limit is too small for summarization.",
      recoveryAction: "settings"
    });
  }
  return budget;
}

export function chunkTranscript(
  segments: TranscriptSegment[],
  budgetTokens: number
): TranscriptSegment[][] {
  if (segments.length === 0) return [];

  const chunks: TranscriptSegment[][] = [];
  let unseenIndex = 0;
  while (unseenIndex < segments.length) {
    const overlapStart = Math.max(0, unseenIndex - SEGMENT_OVERLAP_COUNT);
    const chunk = segments.slice(overlapStart, unseenIndex);
    const unseen = segments[unseenIndex]!;

    while (chunk.length > 0
      && estimateTokens(serializeTranscriptSegments([...chunk, unseen])) > budgetTokens) {
      chunk.shift();
    }

    chunk.push(unseen);
    unseenIndex++;
    while (unseenIndex < segments.length) {
      const candidate = [...chunk, segments[unseenIndex]!];
      if (estimateTokens(serializeTranscriptSegments(candidate)) > budgetTokens) break;
      chunk.push(segments[unseenIndex]!);
      unseenIndex++;
    }
    chunks.push(chunk);
  }
  return chunks;
}

export function groupForSynthesis(
  summaries: ChunkSummary[],
  budgetTokens: number
): ChunkSummary[][] {
  const groups: ChunkSummary[][] = [];
  for (const summary of summaries) {
    const current = groups.at(-1);
    if (current === undefined) {
      groups.push([summary]);
      continue;
    }
    const candidate = [...current, summary];
    if (estimateTokens(serializeChunkSummaries(candidate)) <= budgetTokens) {
      current.push(summary);
    } else {
      groups.push([summary]);
    }
  }
  return groups;
}
