import type { CaptionTrack, VideoContext } from "../domain/video";
import { parseWatchUrl, videoContextSchema } from "../domain/video";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLabel(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  if (typeof value.simpleText === "string") return value.simpleText;
  if (!Array.isArray(value.runs)) return fallback;

  const parts = value.runs.map((run) => isRecord(run) && typeof run.text === "string" ? run.text : null);
  return parts.every((part) => part !== null) ? parts.join("") : fallback;
}

export function readPlayerSnapshotInPage(): unknown {
  try {
    const player = document.querySelector("#movie_player") as Element & {
      getPlayerResponse?: unknown;
    } | null;
    const candidates: unknown[] = [];
    if (player !== null && typeof player.getPlayerResponse === "function") {
      try {
        candidates.push((player.getPlayerResponse as () => unknown)());
      } catch {
        // Fall through to YouTube's serialized initial response.
      }
    }
    const globals = window as typeof window & {
      ytInitialPlayerResponse?: unknown;
      ytplayer?: { config?: { args?: {
        player_response?: unknown;
        raw_player_response?: unknown;
      } } };
    };
    const addConfiguredCandidate = (candidate: unknown) => {
      if (typeof candidate !== "string") {
        candidates.push(candidate);
        return;
      }
      try {
        candidates.push(JSON.parse(candidate));
      } catch {
        // Ignore malformed page-owned data.
      }
    };
    candidates.push(globals.ytInitialPlayerResponse);
    addConfiguredCandidate(globals.ytplayer?.config?.args?.player_response);
    addConfiguredCandidate(globals.ytplayer?.config?.args?.raw_player_response);

    const currentUrl = new URL(location.href);
    const currentVideoId = currentUrl.pathname === "/watch"
      ? currentUrl.searchParams.get("v")
      : null;
    if (currentVideoId === null || !/^[A-Za-z0-9_-]{11}$/.test(currentVideoId)) return null;

    const records = candidates.filter((candidate): candidate is Record<string, unknown> => {
      if (typeof candidate !== "object" || candidate === null) return false;
      const details = (candidate as Record<string, unknown>).videoDetails;
      if (typeof details !== "object" || details === null) return false;
      const videoId = (details as Record<string, unknown>).videoId;
      return videoId === currentVideoId;
    });

    const value = records.find((candidate) => {
      const details = candidate.videoDetails as Record<string, unknown>;
      if (typeof details.title !== "string") return false;
      if (details.author !== undefined && typeof details.author !== "string") return false;
      if (details.lengthSeconds === undefined) return true;
      if (typeof details.lengthSeconds !== "string"
          && typeof details.lengthSeconds !== "number") return false;
      const duration = Number(details.lengthSeconds);
      return Number.isFinite(duration) && duration >= 0;
    });
    if (value === undefined) return null;
    const rawDetails = typeof value.videoDetails === "object" && value.videoDetails !== null
      ? value.videoDetails as Record<string, unknown>
      : {};
    const videoDetails: Record<string, unknown> = {};
    for (const key of ["videoId", "title", "author", "lengthSeconds"] as const) {
      if (typeof rawDetails[key] === "string" || typeof rawDetails[key] === "number") {
        videoDetails[key] = rawDetails[key];
      }
    }

    const captionSource = records.find((candidate) => {
      const captions = candidate.captions;
      if (typeof captions !== "object" || captions === null) return false;
      const renderer = (captions as Record<string, unknown>).playerCaptionsTracklistRenderer;
      if (typeof renderer !== "object" || renderer === null) return false;
      const tracks = (renderer as Record<string, unknown>).captionTracks;
      if (!Array.isArray(tracks)) return false;
      return tracks.some((track) => {
        if (typeof track !== "object" || track === null) return false;
        const source = track as Record<string, unknown>;
        if (typeof source.baseUrl !== "string" || source.baseUrl === ""
            || typeof source.languageCode !== "string" || source.languageCode === "") {
          return false;
        }
        try {
          new URL(source.baseUrl);
          return true;
        } catch {
          return false;
        }
      });
    }) ?? value;
    const rawCaptions = typeof captionSource.captions === "object"
      && captionSource.captions !== null
      ? captionSource.captions as Record<string, unknown>
      : {};
    const rawRenderer = typeof rawCaptions.playerCaptionsTracklistRenderer === "object" &&
      rawCaptions.playerCaptionsTracklistRenderer !== null
      ? rawCaptions.playerCaptionsTracklistRenderer as Record<string, unknown>
      : {};
    const rawTracks = Array.isArray(rawRenderer.captionTracks) ? rawRenderer.captionTracks : [];
    const captionTracks = rawTracks.map((rawTrack) => {
      if (typeof rawTrack !== "object" || rawTrack === null) return {};
      const source = rawTrack as Record<string, unknown>;
      const track: Record<string, unknown> = {};
      for (const key of ["baseUrl", "languageCode", "vssId", "kind"] as const) {
        if (typeof source[key] === "string") track[key] = source[key];
      }

      if (typeof source.name === "object" && source.name !== null) {
        const rawName = source.name as Record<string, unknown>;
        const name: Record<string, unknown> = {};
        if (typeof rawName.simpleText === "string") name.simpleText = rawName.simpleText;
        if (Array.isArray(rawName.runs)) {
          name.runs = rawName.runs.flatMap((run) => {
            if (typeof run !== "object" || run === null) return [];
            const text = (run as Record<string, unknown>).text;
            return typeof text === "string" ? [{ text }] : [];
          });
        }
        track.name = name;
      }
      return track;
    });

    return {
      videoDetails,
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks
        }
      }
    };
  } catch {
    return null;
  }
}

export function isAllowedCaptionUrl(url: URL, testMode: boolean): boolean {
  if (url.origin === "https://www.youtube.com") return true;
  return testMode && url.protocol === "http:" && url.hostname === "127.0.0.1";
}

function sanitizeCaptionTrack(
  value: unknown,
  allowCaptionUrl: (url: URL) => boolean
): CaptionTrack | null {
  if (!isRecord(value) || typeof value.baseUrl !== "string" ||
      typeof value.languageCode !== "string" || value.languageCode === "") {
    return null;
  }

  let captionUrl: URL;
  try {
    captionUrl = new URL(value.baseUrl);
  } catch {
    return null;
  }
  if (!allowCaptionUrl(captionUrl)) return null;

  const id = typeof value.vssId === "string" && value.vssId !== ""
    ? value.vssId
    : value.languageCode;
  return {
    id,
    languageCode: value.languageCode,
    label: readLabel(value.name, value.languageCode),
    isAutoGenerated: value.kind === "asr",
    baseUrl: captionUrl.href
  };
}

function sanitizePlayerSnapshotWithPolicy(
  value: unknown,
  allowCaptionUrl: (url: URL) => boolean
): VideoContext | null {
  if (!isRecord(value) || !isRecord(value.videoDetails)) return null;

  const details = value.videoDetails;
  if (typeof details.videoId !== "string" || typeof details.title !== "string") return null;
  const identity = parseWatchUrl(`https://www.youtube.com/watch?v=${details.videoId}`);
  if (identity === null) return null;

  let durationSeconds: number | null = null;
  if (details.lengthSeconds !== undefined) {
    if (typeof details.lengthSeconds !== "string" && typeof details.lengthSeconds !== "number") {
      return null;
    }
    durationSeconds = Number(details.lengthSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  }

  if (details.author !== undefined && typeof details.author !== "string") return null;

  const captions = isRecord(value.captions) ? value.captions : null;
  const renderer = captions !== null && isRecord(captions.playerCaptionsTracklistRenderer)
    ? captions.playerCaptionsTracklistRenderer
    : null;
  const rawTracks = renderer !== null && Array.isArray(renderer.captionTracks)
    ? renderer.captionTracks
    : [];
  const captionTracks = rawTracks
    .map((track) => sanitizeCaptionTrack(track, allowCaptionUrl))
    .filter((track): track is CaptionTrack => track !== null);

  const context = {
    ...identity,
    title: details.title,
    channel: typeof details.author === "string" ? details.author : null,
    durationSeconds,
    captionTracks
  };

  const result = videoContextSchema.safeParse(context);
  return result.success ? result.data : null;
}

/** Unit-test seam for the strict production sanitizer and its compile-time test policy. */
export function sanitizePlayerSnapshot(value: unknown, testMode: boolean): VideoContext | null {
  return sanitizePlayerSnapshotWithPolicy(value, (url) => isAllowedCaptionUrl(url, testMode));
}

function sanitizeBuildPlayerSnapshot(value: unknown): VideoContext | null {
  return sanitizePlayerSnapshotWithPolicy(value, (url) => {
    if (url.origin === "https://www.youtube.com") return true;
    return import.meta.env.WXT_TEST_MODE === "1"
      && url.protocol === "http:"
      && url.hostname === "127.0.0.1";
  });
}

export async function readVideoContextFromTab(
  tabId: number
): Promise<VideoContext | null> {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: readPlayerSnapshotInPage
  });
  return sanitizeBuildPlayerSnapshot(results[0]?.result);
}
