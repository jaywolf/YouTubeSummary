import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../../src/domain/video";
import { normalizeTranscript } from "../../src/youtube/normalizeTranscript";
import { parseTimedText } from "../../src/youtube/timedText";
import {
  markTranscriptNavigationStart,
  readTranscriptFromPage,
  readVisibleTranscript
} from "../../src/youtube/visibleTranscript";

const TRANSCRIPT_PANEL_TEST_SELECTOR =
  "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']";

function transcriptPanel(rows: string, attributes = "visibility='ENGAGEMENT_PANEL_VISIBILITY_EXPANDED'"): string {
  return `<ytd-engagement-panel-section-list-renderer
    target-id="engagement-panel-searchable-transcript" ${attributes}>${rows}
  </ytd-engagement-panel-section-list-renderer>`;
}

function transcriptRow(timestamp: string, text: string): string {
  return `<ytd-transcript-segment-renderer>
    <span id="segment-timestamp">${timestamp}</span>
    <span id="segment-text">${text}</span>
  </ytd-transcript-segment-renderer>`;
}

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

  it("parses YouTube JSON3 timed text", () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 2_000, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
        { tStartMs: 2_000, dDurationMs: 1_500, segs: [{ utf8: "Second point" }] },
        { tStartMs: 3_500, dDurationMs: 500 }
      ]
    });

    expect(parseTimedText(json3)).toEqual([
      { startSeconds: 0, durationSeconds: 2, text: "Hello world" },
      { startSeconds: 2, durationSeconds: 1.5, text: "Second point" }
    ]);
  });

  it("ignores malformed JSON3 events while retaining valid zero-duration text", () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: -1, dDurationMs: 1_000, segs: [{ utf8: "negative" }] },
        { tStartMs: 0, dDurationMs: -1, segs: [{ utf8: "bad duration" }] },
        { tStartMs: 1_000, segs: [{ utf8: "Valid" }, { bad: true }] },
        { tStartMs: 2_000, dDurationMs: 1_000, segs: "not-an-array" }
      ]
    });

    expect(parseTimedText(json3)).toEqual([
      { startSeconds: 1, durationSeconds: 0, text: "Valid" }
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

  it("reads YouTube's modern transcript view-model rows", () => {
    document.body.innerHTML = readFileSync(
      "tests/fixtures/visible-transcript-modern.html",
      "utf8"
    );

    expect(readVisibleTranscript(document)).toEqual([
      { startSeconds: 0, durationSeconds: 9, text: "Modern first segment" },
      { startSeconds: 9, durationSeconds: 0, text: "Modern second segment" }
    ]);
  });

  it("finds a visible modern transcript inside an unlabelled engagement panel", async () => {
    document.body.innerHTML = readFileSync(
      "tests/fixtures/visible-transcript-modern.html",
      "utf8"
    );

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal,
      { discoveryMs: 20, transcriptMs: 20, quietMs: 5 }
    )).resolves.toEqual([
      { startSeconds: 0, durationSeconds: 9, text: "Modern first segment" },
      { startSeconds: 9, durationSeconds: 0, text: "Modern second segment" }
    ]);
  });

  it("opens YouTube's transcript section when segments are not rendered yet", async () => {
    document.body.innerHTML = `<ytd-video-description-transcript-section-renderer>
      <button type="button">Show transcript</button>
    </ytd-video-description-transcript-section-renderer>`;
    document.querySelector("button")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", transcriptPanel(
        transcriptRow("0:00", "Automatically revealed")
      ));
    });

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal
    )).resolves.toEqual([
      { startSeconds: 0, durationSeconds: 0, text: "Automatically revealed" }
    ]);
  });

  it("expands the description before opening a lazily rendered transcript control", async () => {
    document.body.innerHTML = `<ytd-watch-metadata><div id="description">
      <button id="expand" type="button">More</button>
    </div></ytd-watch-metadata>`;
    document.querySelector("#expand")?.addEventListener("click", () => {
      document.querySelector("#description")?.insertAdjacentHTML("beforeend", `
        <ytd-video-description-transcript-section-renderer>
          <button class="show-transcript" type="button">Show transcript</button>
        </ytd-video-description-transcript-section-renderer>`);
      document.querySelector(".show-transcript")?.addEventListener("click", () => {
        document.body.insertAdjacentHTML("beforeend", transcriptPanel(
          transcriptRow("0:01", "Expanded automatically")
        ));
      });
    });

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal
    )).resolves.toEqual([
      { startSeconds: 1, durationSeconds: 0, text: "Expanded automatically" }
    ]);
  });

  it("waits for incrementally rendered transcript rows to settle", async () => {
    document.body.innerHTML = `<ytd-video-description-transcript-section-renderer>
      <button type="button">Show transcript</button>
    </ytd-video-description-transcript-section-renderer>`;
    document.querySelector("button")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", transcriptPanel(
        transcriptRow("0:00", "First") + transcriptRow("0:02", "Second")
      ));
    });

    const rendered = await readTranscriptFromPage(
      document,
      null,
      new AbortController().signal,
      { transcriptMs: 200, quietMs: 20 }
    );
    expect(document.querySelectorAll("ytd-transcript-segment-renderer")).toHaveLength(2);
    expect(rendered).toEqual([
      { startSeconds: 0, durationSeconds: 2, text: "First" },
      { startSeconds: 2, durationSeconds: 0, text: "Second" }
    ]);
  });

  it("aborts while waiting for a revealed transcript", async () => {
    document.body.innerHTML = `<ytd-video-description-transcript-section-renderer>
      <button type="button">Show transcript</button>
    </ytd-video-description-transcript-section-renderer>`;
    const controller = new AbortController();
    const pending = readTranscriptFromPage(
      document,
      null,
      controller.signal,
      { transcriptMs: 200, quietMs: 20 }
    );
    controller.abort(new DOMException("Canceled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("discovers a transcript control that YouTube renders shortly afterward", async () => {
    document.body.replaceChildren();
    setTimeout(() => {
      document.body.insertAdjacentHTML("beforeend", `<ytd-video-description-transcript-section-renderer>
        <button type="button">Show transcript</button>
      </ytd-video-description-transcript-section-renderer>`);
      document.querySelector("button")?.addEventListener("click", () => {
        document.body.insertAdjacentHTML("beforeend", transcriptPanel(
          transcriptRow("0:03", "Delayed control")
        ));
      });
    }, 10);

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal,
      { discoveryMs: 100, transcriptMs: 100, quietMs: 10 }
    )).resolves.toEqual([
      { startSeconds: 3, durationSeconds: 0, text: "Delayed control" }
    ]);
  });

  it("detects a transcript control revealed only by an attribute change", async () => {
    document.body.innerHTML = `<ytd-watch-metadata><div id="description">
      <button id="expand" type="button">More</button>
      <ytd-video-description-transcript-section-renderer hidden>
        <button class="show-transcript" type="button">Show transcript</button>
      </ytd-video-description-transcript-section-renderer>
    </div></ytd-watch-metadata>`;
    document.querySelector("#expand")?.addEventListener("click", () => {
      document.querySelector("ytd-video-description-transcript-section-renderer")
        ?.removeAttribute("hidden");
    });
    document.querySelector(".show-transcript")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", transcriptPanel(
        transcriptRow("0:04", "Attribute reveal")
      ));
    });

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal,
      { discoveryMs: 100, transcriptMs: 100, quietMs: 10 }
    )).resolves.toEqual([
      { startSeconds: 4, durationSeconds: 0, text: "Attribute reveal" }
    ]);
  });

  it("ignores hidden transcript panels and reads the newly opened active panel", async () => {
    document.body.innerHTML = transcriptPanel(
      transcriptRow("0:00", "Old hidden transcript"),
      "visibility='ENGAGEMENT_PANEL_VISIBILITY_HIDDEN'"
    ) + `<ytd-transcript-renderer style="display: none">
      ${transcriptRow("0:01", "CSS-hidden transcript")}
    </ytd-transcript-renderer>
    <ytd-video-description-transcript-section-renderer>
      <button type="button">Show transcript</button>
    </ytd-video-description-transcript-section-renderer>`;
    document.querySelector("button")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", transcriptPanel(
        transcriptRow("0:02", "Current visible transcript")
      ));
    });

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal,
      { transcriptMs: 100, quietMs: 10 }
    )).resolves.toEqual([
      { startSeconds: 2, durationSeconds: 0, text: "Current visible transcript" }
    ]);
  });

  it("reads YouTube's standalone transcript-renderer layout", async () => {
    document.body.innerHTML = `<ytd-transcript-renderer>
      ${transcriptRow("0:00", "Standalone transcript")}
      ${transcriptRow("0:08", "Second standalone row")}
    </ytd-transcript-renderer>`;

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal
    )).resolves.toEqual([
      { startSeconds: 0, durationSeconds: 8, text: "Standalone transcript" },
      { startSeconds: 8, durationSeconds: 0, text: "Second standalone row" }
    ]);
  });

  it("does not let unrelated page churn reset transcript settling", async () => {
    document.body.innerHTML = `<div id="unrelated"></div>
      <ytd-video-description-transcript-section-renderer>
        <button type="button">Show transcript</button>
      </ytd-video-description-transcript-section-renderer>`;
    document.querySelector("button")?.addEventListener("click", () => {
      document.body.insertAdjacentHTML("beforeend", transcriptPanel(
        transcriptRow("0:00", "Stable transcript")
      ));
      for (let index = 0; index < 6; index += 1) {
        setTimeout(() => {
          const churn = document.createElement("span");
          churn.textContent = String(index);
          document.querySelector("#unrelated")?.append(churn);
        }, index * 5);
      }
    });

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal,
      { transcriptMs: 100, quietMs: 20 }
    )).resolves.toEqual([
      { startSeconds: 0, durationSeconds: 0, text: "Stable transcript" }
    ]);
  });

  it("returns the latest usable rows at the deadline before the quiet period completes", async () => {
    document.body.innerHTML = `<ytd-video-description-transcript-section-renderer>
      <button type="button">Show transcript</button>
    </ytd-video-description-transcript-section-renderer>`;
    document.querySelector("button")?.addEventListener("click", () => {
      setTimeout(() => {
        document.body.insertAdjacentHTML("beforeend", transcriptPanel(
          transcriptRow("0:05", "Late but usable")
        ));
      }, 20);
    });

    await expect(readTranscriptFromPage(
      document,
      null,
      new AbortController().signal,
      { transcriptMs: 150, quietMs: 200 }
    )).resolves.toEqual([
      { startSeconds: 5, durationSeconds: 0, text: "Late but usable" }
    ]);
  });

  it("aborts when navigation leaves the expected watch page", async () => {
    history.replaceState({}, "", "/watch?v=abcdefghijk");
    document.body.innerHTML = `<ytd-watch-flexy video-id="abcdefghijk">
      <ytd-video-description-transcript-section-renderer>
        <button type="button">Show transcript</button>
      </ytd-video-description-transcript-section-renderer>
    </ytd-watch-flexy>`;
    const pending = readTranscriptFromPage(
      document,
      "abcdefghijk",
      new AbortController().signal,
      { transcriptMs: 100, quietMs: 10 }
    );
    history.replaceState({}, "", "/feed/subscriptions");
    document.body.append(document.createElement("span"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refreshes stale transcript rows captured before an SPA navigation", async () => {
    history.replaceState({}, "", "/watch?v=aaaaaaaaaaa");
    document.body.innerHTML = `<ytd-watch-flexy video-id="aaaaaaaaaaa">
      ${transcriptPanel(transcriptRow("0:00", "Video A transcript"))}
      <ytd-video-description-transcript-section-renderer>
        <button type="button">Show transcript</button>
      </ytd-video-description-transcript-section-renderer>
    </ytd-watch-flexy>`;
    markTranscriptNavigationStart(document);
    history.replaceState({}, "", "/watch?v=bbbbbbbbbbb");
    document.querySelector("ytd-watch-flexy")?.setAttribute("video-id", "bbbbbbbbbbb");
    document.querySelector("button")?.addEventListener("click", () => {
      const panel = document.querySelector(TRANSCRIPT_PANEL_TEST_SELECTOR);
      if (panel !== null) panel.innerHTML = transcriptRow("0:07", "Video B transcript");
    });

    await expect(readTranscriptFromPage(
      document,
      "bbbbbbbbbbb",
      new AbortController().signal,
      { transcriptMs: 100, quietMs: 10 }
    )).resolves.toEqual([
      { startSeconds: 7, durationSeconds: 0, text: "Video B transcript" }
    ]);
  });

  it("does not steal focus when the user focuses another control during extraction", async () => {
    document.body.innerHTML = `<button id="original">Original</button>
      <button id="user-choice">User choice</button>
      <ytd-video-description-transcript-section-renderer>
        <button id="transcript-trigger" type="button">Show transcript</button>
      </ytd-video-description-transcript-section-renderer>`;
    const original = document.querySelector<HTMLElement>("#original")!;
    const userChoice = document.querySelector<HTMLElement>("#user-choice")!;
    original.focus();
    document.querySelector("#transcript-trigger")?.addEventListener("click", () => {
      setTimeout(() => userChoice.focus(), 5);
      setTimeout(() => {
        document.body.insertAdjacentHTML("beforeend", transcriptPanel(
          transcriptRow("0:01", "Focus-safe transcript")
        ));
      }, 10);
    });

    await readTranscriptFromPage(
      document,
      null,
      new AbortController().signal,
      { transcriptMs: 100, quietMs: 10 }
    );
    expect(document.activeElement).toBe(userChoice);
  });
});
