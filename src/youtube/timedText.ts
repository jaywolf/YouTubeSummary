import type { TranscriptSegment } from "../domain/video";

function parseNonnegativeFinite(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseTimedText(xml: string): TranscriptSegment[] {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror") !== null) return [];

  const segments: TranscriptSegment[] = [];
  for (const element of document.querySelectorAll("text")) {
    const startSeconds = parseNonnegativeFinite(element.getAttribute("start"));
    const durationSeconds = parseNonnegativeFinite(element.getAttribute("dur"));
    if (startSeconds === null || durationSeconds === null) continue;

    segments.push({
      startSeconds,
      durationSeconds,
      text: element.textContent ?? ""
    });
  }

  return segments;
}
