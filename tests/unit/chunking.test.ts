import { describe, expect, it } from "vitest";
import type { ChunkSummary } from "../../src/domain/summary";
import type { TranscriptSegment } from "../../src/domain/video";
import {
  CHARACTERS_PER_TOKEN,
  chunkTranscript,
  estimateTokens,
  groupForSynthesis,
  inputBudgetTokens
} from "../../src/summarization/chunking";
import {
  serializeChunkSummaries,
  serializeTranscriptSegments
} from "../../src/summarization/prompts";

function segment(index: number, text = `segment-${index}`): TranscriptSegment {
  return { startSeconds: index * 10, durationSeconds: 2, text };
}

function chunkSummary(index: number, text = `fact-${index}`): ChunkSummary {
  return {
    facts: [{ text, startSeconds: index * 10 }],
    sectionStarts: [{ heading: `section-${index}`, startSeconds: index * 10 }]
  };
}

describe("long-video chunking", () => {
  it("estimates tokens from UTF-8 bytes with the conservative 3.5 ratio", () => {
    expect(CHARACTERS_PER_TOKEN).toBe(3.5);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("é🙂")).toBe(2);
    expect(estimateTokens("🙂🙂")).toBe(3);
  });

  it("reserves 15% context, 2048 prompt tokens, and 4096 output tokens", () => {
    expect(inputBudgetTokens(128_000)).toBe(102_656);
    expect(inputBudgetTokens(8_192)).toBe(819);
    expect(() => inputBudgetTokens(7_000)).toThrow(expect.objectContaining({
      code: "configuration_invalid"
    }));
  });

  it.each([NaN, Infinity, -Infinity, 8_192.5, 8_191, 1_000_001])(
    "rejects invalid context-window value %s",
    (contextWindowTokens) => {
      expect(() => inputBudgetTokens(contextWindowTokens)).toThrow(expect.objectContaining({
        code: "configuration_invalid"
      }));
    }
  );

  it("splits only between segments at the exact serialized boundary", () => {
    const segments = [segment(0), segment(1), segment(2), segment(3)];
    const exactTwoSegmentBudget = estimateTokens(serializeTranscriptSegments(segments.slice(0, 2)));

    const chunks = chunkTranscript(segments, exactTwoSegmentBudget);

    expect(chunks).toEqual([
      [segments[0], segments[1]],
      [segments[1], segments[2]],
      [segments[2], segments[3]]
    ]);
    for (const chunk of chunks) {
      expect(estimateTokens(serializeTranscriptSegments(chunk))).toBeLessThanOrEqual(
        exactTwoSegmentBudget
      );
    }
  });

  it("adaptively trims zero-to-two overlaps so every chunk advances", () => {
    const segments = [
      segment(0, "short"),
      segment(1, "short"),
      segment(2, "x".repeat(160)),
      segment(3, "short")
    ];
    const budget = estimateTokens(serializeTranscriptSegments([segments[2]!]));

    const chunks = chunkTranscript(segments, budget);

    expect(chunks.flat().filter((entry) => entry === segments[2])).toHaveLength(1);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(chunks.at(-1)?.at(-1)).toBe(segments[3]);
    for (let index = 1; index < chunks.length; index++) {
      const previous = chunks[index - 1]!;
      const current = chunks[index]!;
      const repeated = current.filter((entry) => previous.includes(entry));
      expect(repeated.length).toBeLessThanOrEqual(2);
      expect(current.some((entry) => !previous.includes(entry))).toBe(true);
    }
  });

  it("keeps an oversized singleton intact for pipeline preflight", () => {
    const giant = segment(0, "🙂".repeat(10_000));
    expect(chunkTranscript([giant], 1)).toEqual([[giant]]);
  });

  it("groups adjacent validated summaries chronologically within exact data budgets", () => {
    const summaries = [0, 1, 2, 3, 4].map((index) => chunkSummary(index));
    const pairBudget = Math.max(
      estimateTokens(serializeChunkSummaries(summaries.slice(0, 2))),
      estimateTokens(serializeChunkSummaries(summaries.slice(2, 4)))
    );

    const groups = groupForSynthesis(summaries, pairBudget);

    expect(groups).toEqual([
      [summaries[0], summaries[1]],
      [summaries[2], summaries[3]],
      [summaries[4]]
    ]);
    expect(groups.flat()).toEqual(summaries);
    expect(groups.every((group) =>
      estimateTokens(serializeChunkSummaries(group)) <= pairBudget
    )).toBe(true);
  });
});
