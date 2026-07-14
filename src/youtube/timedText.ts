import type { TranscriptSegment } from "../domain/video";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNonnegativeFinite(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseJson3(payload: string): TranscriptSegment[] | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.events)) return [];

  const segments: TranscriptSegment[] = [];
  for (const event of value.events) {
    if (!isRecord(event) || typeof event.tStartMs !== "number"
        || !Number.isFinite(event.tStartMs) || event.tStartMs < 0
        || !Array.isArray(event.segs)) {
      continue;
    }
    const durationMs = event.dDurationMs === undefined ? 0 : event.dDurationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      continue;
    }
    const text = event.segs.map((segment) =>
      isRecord(segment) && typeof segment.utf8 === "string" ? segment.utf8 : "").join("");
    if (text === "") continue;
    segments.push({
      startSeconds: event.tStartMs / 1_000,
      durationSeconds: durationMs / 1_000,
      text
    });
  }
  return segments;
}

export function parseTimedText(xml: string): TranscriptSegment[] {
  const json3 = parseJson3(xml);
  if (json3 !== null) return json3;

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
