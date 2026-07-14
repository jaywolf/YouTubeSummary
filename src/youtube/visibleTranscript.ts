import type { TranscriptSegment } from "../domain/video";

function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((part) => !/^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  const seconds = numbers.at(-1);
  const minutes = numbers.at(-2);
  if (seconds === undefined || minutes === undefined || seconds >= 60 || minutes >= 60) {
    return null;
  }

  const hours = numbers.length === 3 ? numbers[0] : 0;
  if (hours === undefined) return null;
  return hours * 3_600 + minutes * 60 + seconds;
}

export function readVisibleTranscript(root: ParentNode = document): TranscriptSegment[] {
  const values: Array<{ startSeconds: number; text: string }> = [];

  for (const renderer of root.querySelectorAll("ytd-transcript-segment-renderer")) {
    const timestamp = renderer.querySelector(".segment-timestamp")?.textContent;
    const text = renderer.querySelector(".segment-text")?.textContent;
    if (timestamp === undefined || text === undefined || timestamp === null || text === null) {
      continue;
    }

    const startSeconds = parseTimestamp(timestamp);
    if (startSeconds === null) continue;
    values.push({ startSeconds, text });
  }

  return values.map((value, index) => {
    const next = values[index + 1];
    return {
      startSeconds: value.startSeconds,
      durationSeconds: next === undefined ? 0 : Math.max(0, next.startSeconds - value.startSeconds),
      text: value.text
    };
  });
}
