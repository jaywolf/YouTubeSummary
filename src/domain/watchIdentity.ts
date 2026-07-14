import { parseWatchUrl, type VideoContext } from "./video";

type WatchIdentity = Pick<VideoContext, "videoId" | "canonicalUrl">;

function parseLoopbackWatchUrl(value: string): WatchIdentity | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1"
        || url.port === "" || url.pathname !== "/watch") return null;
    const videoId = url.searchParams.get("v");
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    return {
      videoId,
      canonicalUrl: `${url.origin}/watch?v=${videoId}`
    };
  } catch {
    return null;
  }
}

/** Extension-context identity parser; its loopback branch is erased from production builds. */
export function parseExtensionWatchUrl(value: string): WatchIdentity | null {
  const identity = parseWatchUrl(value);
  if (identity !== null || import.meta.env.WXT_TEST_MODE !== "1") return identity;
  return parseLoopbackWatchUrl(value);
}
