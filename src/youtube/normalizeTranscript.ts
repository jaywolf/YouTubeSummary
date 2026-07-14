import type { TranscriptSegment } from "../domain/video";

function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function normalizeTranscript(segments: TranscriptSegment[]): TranscriptSegment[] {
  const normalized: TranscriptSegment[] = [];

  for (const segment of segments) {
    const text = normalizeText(segment.text);
    if (text === "") continue;

    const previous = normalized.at(-1);
    if (previous !== undefined) {
      const previousEnd = previous.startSeconds + previous.durationSeconds;
      const overlapsOrTouches = segment.startSeconds <= previousEnd;
      if (overlapsOrTouches && text === previous.text) {
        continue;
      }
    }

    normalized.push({
      startSeconds: segment.startSeconds,
      durationSeconds: segment.durationSeconds,
      text
    });
  }

  return normalized;
}
