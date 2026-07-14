import { describe, expect, it } from "vitest";
import { parseWatchUrl } from "../../src/domain/video";

describe("YouTube video identity", () => {
  it("accepts only a standard watch URL with an 11-character id", () => {
    expect(parseWatchUrl("https://www.youtube.com/watch?v=abcdefghijk")).toEqual({
      videoId: "abcdefghijk",
      canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk"
    });
  });

  it.each([
    "https://www.youtube.com/shorts/abcdefghijk",
    "https://youtube.com/watch?v=abcdefghijk",
    "http://www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=too-short",
    "https://www.youtube.com/watch?v=abcdefghijkl",
    "not a url"
  ])("rejects unsupported or malformed URL %s", (url) => {
    expect(parseWatchUrl(url)).toBeNull();
  });

  it("canonicalizes an accepted watch URL", () => {
    expect(parseWatchUrl("https://www.youtube.com/watch?list=queue&v=abc_DEF-123&t=5")).toEqual({
      videoId: "abc_DEF-123",
      canonicalUrl: "https://www.youtube.com/watch?v=abc_DEF-123"
    });
  });
});
