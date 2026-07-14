import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../../src/domain/video";
import { normalizeTranscript } from "../../src/youtube/normalizeTranscript";
import { parseTimedText } from "../../src/youtube/timedText";
import { readVisibleTranscript } from "../../src/youtube/visibleTranscript";

describe("timed-text parsing and normalization", () => {
  it("parses entities and removes exact adjacent overlap duplicates", () => {
    const xml = readFileSync("tests/fixtures/timed-text.xml", "utf8");

    expect(normalizeTranscript(parseTimedText(xml))).toEqual([
      { startSeconds: 0, durationSeconds: 2, text: "Hello & welcome" },
      { startSeconds: 4.2, durationSeconds: 1.5, text: "Second point" }
    ]);
  });

  it.each([
    ["malformed XML", "<transcript><text></transcript>"],
    ["a parser error document", "<parsererror>bad input</parsererror>"]
  ])("rejects %s", (_label, xml) => {
    expect(parseTimedText(xml)).toEqual([]);
  });

  it("rejects invalid timing attributes while accepting zero duration", () => {
    const xml = `<transcript>
      <text start="-1" dur="1">negative</text>
      <text start="0" dur="NaN">not finite</text>
      <text start="2" dur="0">instant</text>
      <text start="Infinity" dur="1">infinite</text>
    </transcript>`;

    expect(parseTimedText(xml)).toEqual([
      { startSeconds: 2, durationSeconds: 0, text: "instant" }
    ]);
  });

  it("normalizes NFC and whitespace and removes empty text", () => {
    const segments: TranscriptSegment[] = [
      { startSeconds: 0, durationSeconds: 1, text: "  Cafe\u0301\n\tpoint  " },
      { startSeconds: 1, durationSeconds: 1, text: " \n\t " }
    ];

    expect(normalizeTranscript(segments)).toEqual([
      { startSeconds: 0, durationSeconds: 1, text: "Café point" }
    ]);
  });

  it.each([
    {
      boundary: "overlaps",
      secondStart: 1.9,
      expectedCount: 1
    },
    {
      boundary: "touches previousEnd exactly",
      secondStart: 2,
      expectedCount: 1
    },
    {
      boundary: "starts after previousEnd",
      secondStart: 2.000_001,
      expectedCount: 2
    }
  ])("handles an exact adjacent duplicate that $boundary", ({ secondStart, expectedCount }) => {
    const segments: TranscriptSegment[] = [
      { startSeconds: 0, durationSeconds: 2, text: "repeat" },
      { startSeconds: secondStart, durationSeconds: 1, text: "repeat" }
    ];

    expect(normalizeTranscript(segments)).toHaveLength(expectedCount);
  });

  it("retains adjacent overlapping speech when text differs", () => {
    const segments: TranscriptSegment[] = [
      { startSeconds: 0, durationSeconds: 2, text: "first" },
      { startSeconds: 1, durationSeconds: 2, text: "second" }
    ];

    expect(normalizeTranscript(segments)).toEqual(segments);
  });
});

describe("visible transcript parsing", () => {
  it("reads MM:SS timestamps and derives duration from the next start", () => {
    document.body.innerHTML = readFileSync("tests/fixtures/visible-transcript.html", "utf8");

    expect(normalizeTranscript(readVisibleTranscript(document))).toEqual([
      { startSeconds: 0, durationSeconds: 4, text: "Hello & welcome" },
      { startSeconds: 4, durationSeconds: 0, text: "Second point" }
    ]);
  });

  it("reads HH:MM:SS timestamps and ignores malformed segment nodes", () => {
    document.body.innerHTML = `<ytd-transcript-segment-renderer>
      <span class="segment-timestamp">1:02:03</span>
      <span class="segment-text">Long video</span>
    </ytd-transcript-segment-renderer>
    <ytd-transcript-segment-renderer>
      <span class="segment-timestamp">1:99</span>
      <span class="segment-text">Bad timestamp</span>
    </ytd-transcript-segment-renderer>`;

    expect(readVisibleTranscript(document)).toEqual([
      { startSeconds: 3_723, durationSeconds: 0, text: "Long video" }
    ]);
  });
});
