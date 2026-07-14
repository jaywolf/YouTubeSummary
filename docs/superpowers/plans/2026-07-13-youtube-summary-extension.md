# YouTube Summary Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build an unpacked Manifest V3 extension for Chrome and Brave that summarizes the active captioned YouTube video in a native side panel using a user-selected BYOK LLM provider.

**Architecture:** WXT generates the Manifest V3 package and its background, content-script, side-panel, options, and main-world entrypoints. Browser-independent TypeScript modules handle transcript normalization, provider requests, structured summaries, chunking, cache behavior, and errors; the service worker orchestrates jobs while React renders trusted structured data.

**Tech Stack:** Node.js 22+, pnpm 11.13.0, TypeScript 7.0.2, WXT 0.20.27, React 19.2.7, Zod 4.4.3, Vitest 4.1.10, Testing Library 16.3.2, and Playwright 1.61.1.

**Implementation status (2026-07-14):** The plan has been implemented on `feature/ytsummary-extension`. Its step checkboxes are preserved as the approved execution record rather than live completion claims; current build and manual-browser evidence lives in `README.md` and `docs/manual-verification.md`. The implemented settings UX improves the original plan by loading OpenAI and OpenRouter model IDs from their authenticated APIs instead of shipping or requiring a static/manual ID list.

## Global Constraints

- Target Google Chrome 114+ and current Brave releases that support Chromium Manifest V3 extensions.
- Summarize only standard youtube.com/watch pages with an available caption track or visible transcript.
- Do not download media, transcribe audio, add a backend, add accounts, add telemetry, or publish to a browser store in the MVP.
- Support OpenAI Responses, OpenRouter Chat Completions, and custom OpenAI-compatible Chat Completions endpoints.
- Store BYOK credentials only in chrome.storage.local, never sync them, restrict storage to trusted extension contexts, never reveal saved keys, and never log secrets.
- Persist completed summaries but not transcripts, partial streams, authorization headers, page snapshots, or raw provider bodies.
- Bundle all executable code locally and never render provider-authored HTML.
- Request only youtube.com, api.openai.com, and openrouter.ai as fixed host permissions; request a custom endpoint origin at runtime through optional host permissions.
- Use a user-editable 128,000-token default context window, sequential chunk processing, one automatic retry before streamed output, a 60-second Retry-After ceiling, and one structured-output repair request.
- Bound the summary cache to 20 entries and 5,000,000 serialized bytes without requesting unlimitedStorage.
- Automated tests use fixtures and local mock servers and never require a live provider key.

---

## Planned File Map

### Extension entrypoints

- **entrypoints/background.ts** — service-worker bootstrap, action-to-side-panel behavior, trusted storage access, message routing, and navigation cancellation.
- **entrypoints/youtube.content.ts** — isolated-world YouTube adapter for caption extraction, visible-transcript fallback, navigation notices, and seek commands.
- **entrypoints/sidepanel/index.html**, **main.tsx**, **App.tsx**, **styles.css** — side-panel application and visual states.
- **entrypoints/options/index.html**, **main.tsx**, **App.tsx**, **styles.css** — provider, model, caption, cache, and credential settings.

### Domain and platform modules

- **src/domain/video.ts** — video, caption-track, and transcript types plus URL validation.
- **src/domain/summary.ts** — Zod summary schemas and inferred types.
- **src/domain/settings.ts** — provider settings schemas, defaults, and redacted views.
- **src/domain/messages.ts** — discriminated runtime message and event schemas.
- **src/domain/errors.ts** — stable error codes and user-safe mappings.
- **src/youtube/playerSnapshot.ts** — self-contained main-world snapshot function and trusted-context sanitization.
- **src/youtube/captionSelection.ts** — deterministic caption preference policy.
- **src/youtube/timedText.ts** — timed-text parsing.
- **src/youtube/visibleTranscript.ts** — visible transcript fallback parsing.
- **src/youtube/normalizeTranscript.ts** — Unicode, whitespace, and overlap normalization.
- **src/youtube/extractTranscript.ts** — ordered primary/fallback source coordinator.
- **src/providers/types.ts** — normalized provider interfaces and events.
- **src/providers/openaiResponses.ts** — OpenAI Responses adapter.
- **src/providers/openaiCompatible.ts** — OpenRouter/custom Chat Completions adapter.
- **src/providers/sse.ts** — incremental SSE parser.
- **src/providers/retry.ts** — retry classification and bounded delay.
- **src/providers/providerErrors.ts** — safe provider error normalization.
- **src/providers/factory.ts** — validated provider construction.
- **src/providers/modelCatalog.ts** — authenticated OpenAI/OpenRouter catalog loading, bounded parsing, readable labels, and exact provider IDs.
- **src/summarization/prompts.ts** — prompt constants and transcript delimiters.
- **src/summarization/chunking.ts** — size estimation, segment grouping, and recursive reduce groups.
- **src/summarization/pipeline.ts** — single-pass and map-and-synthesize execution.
- **src/background/jobRegistry.ts** — one cancelable job per tab and stale-result checks.
- **src/background/controller.ts** — complete request orchestration.
- **src/platform/storage.ts** — settings and session-job repositories.
- **src/platform/permissions.ts** — custom-origin validation and optional permission requests.
- **src/platform/cache.ts** — stable cache keys and bounded LRU persistence.

### Tests and documentation

- **tests/fixtures/** — sanitized player, timed-text, visible transcript, and provider stream fixtures.
- **tests/unit/** — browser-independent module tests.
- **tests/components/** — side-panel and options React tests.
- **tests/extension/** — Playwright extension fixture, local YouTube-shaped page, and mock provider.
- **docs/privacy.md** — BYOK risk, stored data, permissions, provider transmission, and clearing data.
- **docs/manual-verification.md** — exact Chrome/Brave release matrix and results template.

---

### Task 1: Bootstrap the typed Manifest V3 extension and contracts

**Files:**
- Modify: **.gitignore**
- Create: **package.json**
- Create: **tsconfig.json**
- Create: **wxt.config.ts**
- Create: **vitest.config.ts**
- Create: **tests/setup.ts**
- Create: **entrypoints/background.ts**
- Create: **entrypoints/sidepanel/index.html**
- Create: **entrypoints/sidepanel/main.tsx**
- Create: **entrypoints/sidepanel/App.tsx**
- Create: **entrypoints/sidepanel/styles.css**
- Create: **entrypoints/options/index.html**
- Create: **entrypoints/options/main.tsx**
- Create: **entrypoints/options/App.tsx**
- Create: **entrypoints/options/styles.css**
- Create: **src/domain/messages.ts**
- Create: **src/domain/errors.ts**
- Test: **tests/unit/messages.test.ts**

**Interfaces:**
- Produces: AppMessage, BackgroundEvent, JobState, parseAppMessage(value: unknown): AppMessage, AppError, and stable AppErrorCode values.
- Produces: sidepanel.html and options.html entrypoints plus a Manifest V3 service worker.

- [ ] **Step 1: Add the toolchain manifest and ignore generated output**

Extend .gitignore without removing its existing entries:

~~~gitignore
.env
.pi/
node_modules/
dist/
dist-test/
.wxt/
coverage/
playwright-report/
test-results/
pnpm-debug.log*
~~~

Create package.json:

~~~json
{
  "name": "youtube-summary-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.13.0",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "postinstall": "wxt prepare",
    "dev": "wxt",
    "build": "wxt build",
    "build:test": "WXT_TEST_MODE=1 wxt build",
    "zip": "wxt zip",
    "typecheck": "wxt prepare && tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:extension": "playwright test",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  },
  "dependencies": {
    "@wxt-dev/module-react": "1.2.2",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@playwright/test": "1.61.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/node": "22.20.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "jsdom": "29.1.1",
    "typescript": "7.0.2",
    "vitest": "4.1.10",
    "wxt": "0.20.27"
  }
}
~~~

Run: **corepack enable && pnpm install**

Expected: pnpm-lock.yaml is created and installation exits 0.

- [ ] **Step 2: Write the failing message-contract test**

~~~ts
import { describe, expect, it } from "vitest";
import { parseAppMessage } from "../../src/domain/messages";

describe("parseAppMessage", () => {
  it("accepts a typed panel request", () => {
    expect(parseAppMessage({
      type: "panel/start",
      requestId: "request-1",
      tabId: 7,
      force: false
    }).type).toBe("panel/start");
  });

  it("rejects a message without a request identifier", () => {
    expect(() => parseAppMessage({ type: "panel/cancel", tabId: 7 })).toThrow();
  });
});
~~~

Run: **pnpm vitest run tests/unit/messages.test.ts**

Expected: FAIL because src/domain/messages.ts does not exist.

- [ ] **Step 3: Add TypeScript, WXT, Vitest, and manifest configuration**

Create tsconfig.json:

~~~json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
~~~

Create wxt.config.ts:

~~~ts
import { defineConfig } from "wxt";

const testMode = process.env.WXT_TEST_MODE === "1";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "YouTube Detailed Summary",
    description: "Summarize the active captioned YouTube video in a side panel.",
    minimum_chrome_version: "114",
    permissions: ["sidePanel", "storage", "scripting"],
    host_permissions: [
      "https://www.youtube.com/*",
      "https://api.openai.com/*",
      "https://openrouter.ai/*",
      ...(testMode ? ["http://127.0.0.1/*"] : [])
    ],
    optional_host_permissions: [
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*"
    ],
    action: { default_title: "Summarize this YouTube video" },
    options_ui: { page: "options.html", open_in_tab: true }
  }
});
~~~

Create vitest.config.ts:

~~~ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    coverage: { reporter: ["text", "html"] }
  }
});
~~~

Create tests/setup.ts:

~~~ts
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());
~~~

- [ ] **Step 4: Implement the first runtime contract**

Create src/domain/messages.ts:

~~~ts
import { z } from "zod";
import type { SafeAppError } from "./errors";

const base = { requestId: z.string().min(1), tabId: z.number().int().nonnegative() };

export const appMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("panel/start"), ...base, force: z.boolean() }),
  z.object({ type: z.literal("panel/cancel"), ...base }),
  z.object({ type: z.literal("panel/status"), ...base }),
  z.object({ type: z.literal("youtube/seek"), ...base, seconds: z.number().nonnegative() }),
  z.object({ type: z.literal("youtube/navigated"), ...base, videoId: z.string().nullable() })
]);

export type AppMessage = z.infer<typeof appMessageSchema>;

export type JobState =
  | "loading_video"
  | "extracting_transcript"
  | "summarizing"
  | "complete"
  | "error"
  | "canceled"
  | "interrupted";

export type BackgroundEvent =
  | { type: "job/state"; requestId: string; tabId: number; state: JobState }
  | { type: "job/progress"; requestId: string; tabId: number; completed: number; total: number }
  | { type: "job/error"; requestId: string; tabId: number; error: SafeAppError };

export function parseAppMessage(value: unknown): AppMessage {
  return appMessageSchema.parse(value);
}
~~~

Create src/domain/errors.ts with this complete stable union:

~~~ts
export type AppErrorCode =
  | "unsupported_page"
  | "video_context_unavailable"
  | "captions_unavailable"
  | "transcript_extraction_failed"
  | "configuration_missing"
  | "configuration_invalid"
  | "custom_permission_denied"
  | "credentials_rejected"
  | "insufficient_credits"
  | "provider_forbidden"
  | "rate_limited"
  | "provider_unavailable"
  | "network_unavailable"
  | "network_timeout"
  | "context_limit_exceeded"
  | "provider_output_invalid"
  | "content_filtered"
  | "request_canceled"
  | "request_interrupted"
  | "internal_error";

export type RecoveryAction = "retry" | "settings" | "change_model" | "none";
export type SafeAppError = {
  code: AppErrorCode;
  retryable: boolean;
  safeMessage: string;
  recoveryAction: RecoveryAction;
  retryAfterSeconds?: number;
};
~~~

The primary recovery mapping is: Retry for video_context_unavailable, transcript_extraction_failed, rate_limited, provider_unavailable, network_unavailable, network_timeout, request_interrupted, and internal_error; Settings for configuration_missing, configuration_invalid, custom_permission_denied, credentials_rejected, insufficient_credits, provider_forbidden, and context_limit_exceeded; Change model for provider_output_invalid; and None for unsupported_page, captions_unavailable, content_filtered, and request_canceled. provider_output_invalid may additionally expose Retry in the panel. AppError contains these safe fields; toSafeError serializes only SafeAppError. The cause remains a non-enumerable Error.cause and is never sent to the UI.

Run: **pnpm vitest run tests/unit/messages.test.ts**

Expected: PASS with 2 tests.

- [ ] **Step 5: Add the background and React entrypoint shells**

Create entrypoints/background.ts:

~~~ts
export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });
});
~~~

Both HTML files use a root div and their matching main.tsx mounts React.StrictMode. Sidepanel App.tsx renders the heading "YouTube Detailed Summary" and "Open a captioned YouTube video to begin." Options App.tsx renders the heading "Summary settings". The CSS sets color-scheme: dark, a system sans-serif UI font, #111 background, #eceae5 text, and a 16px panel padding.

Use this exact main.tsx in both entrypoints, changing only the local App and CSS paths:

~~~tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
~~~

Run: **pnpm typecheck && pnpm build**

Expected: both commands exit 0 and dist/chrome-mv3/manifest.json contains manifest_version 3, side_panel.default_path, options_ui, and minimum_chrome_version 114.

- [ ] **Step 6: Commit the foundation**

Run:

~~~bash
git add .gitignore package.json pnpm-lock.yaml tsconfig.json wxt.config.ts vitest.config.ts tests/setup.ts tests/unit/messages.test.ts entrypoints src/domain/messages.ts src/domain/errors.ts
git commit -m "chore: bootstrap YouTube summary extension"
~~~

Expected: a clean commit containing only the foundation files.

---

### Task 2: Extract and normalize YouTube captions

**Files:**
- Create: **src/domain/video.ts**
- Create: **src/youtube/playerSnapshot.ts**
- Create: **src/youtube/captionSelection.ts**
- Create: **src/youtube/timedText.ts**
- Create: **src/youtube/visibleTranscript.ts**
- Create: **src/youtube/normalizeTranscript.ts**
- Create: **src/youtube/extractTranscript.ts**
- Create: **entrypoints/youtube.content.ts**
- Modify: **src/domain/messages.ts**
- Create: **tests/fixtures/timed-text.xml**
- Create: **tests/fixtures/visible-transcript.html**
- Test: **tests/unit/video.test.ts**
- Test: **tests/unit/captionSelection.test.ts**
- Test: **tests/unit/transcript.test.ts**

**Interfaces:**
- Produces: VideoContext, CaptionTrack, TranscriptSegment, Transcript, TranscriptPreference.
- Produces: parseWatchUrl(url), readPlayerSnapshotInPage(), sanitizePlayerSnapshot(value, testMode), selectCaptionTrack(tracks, preference), parseTimedText(xml), normalizeTranscript(segments), and the canonical extractTranscript(context, preference, dependencies, signal) coordinator.
- Consumes: AppMessage from Task 1.

- [ ] **Step 1: Write failing URL and caption-selection tests**

~~~ts
import { describe, expect, it } from "vitest";
import { parseWatchUrl } from "../../src/domain/video";
import { selectCaptionTrack } from "../../src/youtube/captionSelection";

describe("YouTube video identity", () => {
  it("accepts only a standard watch URL with an 11-character id", () => {
    expect(parseWatchUrl("https://www.youtube.com/watch?v=abcdefghijk")).toEqual({
      videoId: "abcdefghijk",
      canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk"
    });
    expect(parseWatchUrl("https://www.youtube.com/shorts/abcdefghijk")).toBeNull();
    expect(parseWatchUrl("not a url")).toBeNull();
  });
});

describe("caption selection", () => {
  const tracks = [
    { id: "auto-en", languageCode: "en", label: "English auto", isAutoGenerated: true, baseUrl: "https://www.youtube.com/api/timedtext?a=1" },
    { id: "human-es", languageCode: "es", label: "Español", isAutoGenerated: false, baseUrl: "https://www.youtube.com/api/timedtext?a=2" }
  ];

  it("prefers a human track in the configured language", () => {
    expect(selectCaptionTrack(tracks, { preferredLanguage: "es", browserLanguage: "en" })?.id).toBe("human-es");
  });
});
~~~

Split these blocks into tests/unit/video.test.ts and tests/unit/captionSelection.test.ts.

Run: **pnpm vitest run tests/unit/video.test.ts tests/unit/captionSelection.test.ts**

Expected: FAIL because the modules do not exist.

- [ ] **Step 2: Define video and transcript types and deterministic selection**

Create src/domain/video.ts:

~~~ts
export type CaptionTrack = {
  id: string;
  languageCode: string;
  label: string;
  isAutoGenerated: boolean;
  baseUrl: string;
};

export type TranscriptSegment = { startSeconds: number; durationSeconds: number; text: string };
export type Transcript = { track: CaptionTrack; segments: TranscriptSegment[] };
export type TranscriptPreference = { preferredLanguage: string | null; browserLanguage: string };
export type VideoContext = {
  videoId: string;
  canonicalUrl: string;
  title: string;
  channel: string | null;
  durationSeconds: number | null;
  captionTracks: CaptionTrack[];
};

export function parseWatchUrl(value: string): Pick<VideoContext, "videoId" | "canonicalUrl"> | null {
  try {
    const url = new URL(value);
    if (url.origin !== "https://www.youtube.com" || url.pathname !== "/watch") return null;
    const videoId = url.searchParams.get("v");
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    return { videoId, canonicalUrl: "https://www.youtube.com/watch?v=" + videoId };
  } catch {
    return null;
  }
}
~~~

Create captionSelection.ts with this exact ascending priority order:

1. human captions matching the configured preferred language;
2. automatic captions matching the configured preferred language;
3. human captions matching the browser language;
4. automatic captions matching the browser language;
5. any remaining human caption track;
6. any remaining automatic caption track.

When preferredLanguage is null, skip levels 1 and 2. Compare language codes case-insensitively by primary language subtag, so en-US matches en, and preserve the original track order as the final tie-breaker. Add one table-driven test for every level plus the null-preference and stable-tie cases.

Run: **pnpm vitest run tests/unit/video.test.ts tests/unit/captionSelection.test.ts**

Expected: PASS.

- [ ] **Step 3: Write failing timed-text and normalization tests**

tests/fixtures/timed-text.xml:

~~~xml
<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0.0" dur="2.0">Hello &amp; welcome</text>
  <text start="1.8" dur="2.2">Hello &amp; welcome</text>
  <text start="4.2" dur="1.5">Second point</text>
</transcript>
~~~

tests/unit/transcript.test.ts:

~~~ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTimedText } from "../../src/youtube/timedText";
import { normalizeTranscript } from "../../src/youtube/normalizeTranscript";

it("parses entities and removes exact adjacent overlap duplicates", () => {
  const xml = readFileSync("tests/fixtures/timed-text.xml", "utf8");
  expect(normalizeTranscript(parseTimedText(xml))).toEqual([
    { startSeconds: 0, durationSeconds: 2, text: "Hello & welcome" },
    { startSeconds: 4.2, durationSeconds: 1.5, text: "Second point" }
  ]);
});
~~~

Run: **pnpm vitest run tests/unit/transcript.test.ts**

Expected: FAIL because the parser modules do not exist.

- [ ] **Step 4: Implement timed-text, visible DOM, and normalization adapters**

parseTimedText uses DOMParser, accepts only parsererror-free XML, reads text elements, converts finite nonnegative start/dur attributes, and returns TranscriptSegment values. visibleTranscript reads ytd-transcript-segment-renderer nodes, parses timestamp text as MM:SS or HH:MM:SS, and uses the next start time as duration when available. normalizeTranscript applies NFC normalization, collapses whitespace, removes empty segments, and removes only exact adjacent duplicate text whose time ranges overlap or touch.

Use this duplicate rule:

~~~ts
const previousEnd = previous.startSeconds + previous.durationSeconds;
const overlapsOrTouches = segment.startSeconds <= previousEnd;
if (overlapsOrTouches && segment.text === previous.text) continue;
~~~

Add a visible-transcript fixture with 00:00 and 00:04 segments and assert the same normalized content. Add explicit boundary tests proving identical text is removed when the next segment starts exactly at previousEnd but retained when it starts after previousEnd.

Run: **pnpm vitest run tests/unit/transcript.test.ts**

Expected: PASS for timed-text, DOM fallback, malformed XML, empty segments, and repeated non-overlapping speech.

- [ ] **Step 5: Implement the sanitized player snapshot and ordered extraction**

playerSnapshot.ts exports a self-contained readPlayerSnapshotInPage function that reads document.querySelector("#movie_player"), calls getPlayerResponse only when it is a function, and returns a plain object containing videoDetails plus captions.playerCaptionsTracklistRenderer.captionTracks. The background calls it with browser.scripting.executeScript using world MAIN and the active tab ID. sanitizePlayerSnapshot validates the returned unknown object in the background trusted context and maps it into VideoContext. It receives a trusted build-time testMode boolean and accepts caption URLs only through this policy:

~~~ts
export function isAllowedCaptionUrl(url: URL, testMode: boolean): boolean {
  if (url.origin === "https://www.youtube.com") return true;
  return testMode && url.protocol === "http:" && url.hostname === "127.0.0.1";
}
~~~

All callers pass import.meta.env.WXT_TEST_MODE === "1", which WXT replaces at build time and which resolves to false in production; page data can never enable the test path. Add sanitizer tests proving production mode rejects loopback URLs, test mode accepts only http://127.0.0.1 on an arbitrary fixture port, and test mode still rejects localhost, external HTTP, and non-YouTube HTTPS origins.

extractTranscript receives injected dependencies:

~~~ts
export type TranscriptDependencies = {
  fetchText: (url: string, signal: AbortSignal) => Promise<string>;
  readVisibleSegments: () => TranscriptSegment[];
};

export async function extractTranscript(
  context: VideoContext,
  preference: TranscriptPreference,
  dependencies: TranscriptDependencies,
  signal: AbortSignal
): Promise<Transcript>;
~~~

This pure coordinator runs in youtube.content.ts, where DOMParser and the page's same-origin caption fetch are available. It selects a track and fetches timed text first through the injected fetchText adapter, then parses and normalizes it. If snapshot tracks are empty or parsing yields no segments, readVisibleSegments reads the isolated-world DOM fallback. If both sources are empty, throw captions_unavailable; if a source exists but fetch, parsing, or bridge behavior fails, throw transcript_extraction_failed.

After defining the video schemas, extend messages.ts with youtube/extract carrying a validated VideoContext and TranscriptPreference and youtube/cancel-extract carrying the same request identity. The background obtains and sanitizes the main-world snapshot, sends youtube/extract to the content script, and validates the returned Transcript response. youtube.content.ts keeps one AbortController per requestId; youtube/cancel-extract aborts the caption fetch and removes the request. This makes runtime cancellation explicit without trying to serialize AbortSignal.

- [ ] **Step 6: Wire content-script messages and YouTube SPA navigation**

youtube.content.ts matches https://www.youtube.com/*, validates every incoming message with parseAppMessage, handles youtube/extract, youtube/cancel-extract, and youtube/seek, and listens for yt-navigate-finish. Extraction responses are validated plain Transcript values or SafeAppError values. Seek uses the HTMLVideoElement currentTime and play state without forcing playback. The navigation event sends the newly parsed video ID or null to the background. Main-world snapshot access and sanitization remain in the background; caption selection, same-origin timed-text fetch/parsing, visible DOM fallback, and extractTranscript orchestration run in the content script.

Run: **pnpm typecheck && pnpm vitest run tests/unit/video.test.ts tests/unit/captionSelection.test.ts tests/unit/transcript.test.ts**

Expected: all commands PASS.

- [ ] **Step 7: Commit transcript extraction**

Run:

~~~bash
git add entrypoints/youtube.content.ts src/domain/messages.ts src/domain/video.ts src/youtube tests/fixtures tests/unit
git commit -m "feat: extract YouTube captions"
~~~

Expected: commit includes fixtures, unit coverage, and no provider or credential code.

---

### Task 3: Add validated BYOK settings, trusted storage, and permissions

**Files:**
- Create: **src/domain/settings.ts**
- Create: **src/platform/storage.ts**
- Create: **src/platform/permissions.ts**
- Modify: **entrypoints/options/App.tsx**
- Modify: **entrypoints/options/styles.css**
- Modify: **entrypoints/background.ts**
- Test: **tests/unit/settings.test.ts**
- Test: **tests/components/options.test.tsx**

**Interfaces:**
- Produces: ExtensionSettings, ProviderConfig, DEFAULT_SETTINGS, loadSettings(), saveSettings(), clearCredentials(), validateCustomBaseUrl(), and ensureCustomOriginPermission().
- Consumes: browser.storage and browser.permissions behind injected test adapters.

- [ ] **Step 1: Write failing settings and URL-security tests**

~~~ts
import { expect, it } from "vitest";
import { parseSettings, validateCustomBaseUrl } from "../../src/domain/settings";

it("accepts OpenAI settings and defaults context to 128000", () => {
  const settings = parseSettings({
    provider: { kind: "openai", apiKey: "sk-test", model: "test-model" }
  });
  expect(settings.contextWindowTokens).toBe(128000);
});

it("allows HTTPS and local HTTP but rejects credentials, query, and fragments", () => {
  expect(validateCustomBaseUrl("https://llm.example/v1")).toBe("https://llm.example/v1");
  expect(validateCustomBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  expect(() => validateCustomBaseUrl("http://example.com/v1")).toThrow();
  expect(() => validateCustomBaseUrl("https://user:pass@example.com/v1?q=1")).toThrow();
});
~~~

Run: **pnpm vitest run tests/unit/settings.test.ts**

Expected: FAIL because settings.ts does not exist.

- [ ] **Step 2: Implement provider settings schemas and redaction**

Use a Zod discriminated union:

~~~ts
export type ProviderConfig =
  | { kind: "openai"; apiKey: string; model: string }
  | { kind: "openrouter"; apiKey: string; model: string }
  | { kind: "custom"; apiKey: string; model: string; baseUrl: string };

export type ExtensionSettings = {
  provider: ProviderConfig | null;
  captionLanguage: string | null;
  outputLanguage: string;
  contextWindowTokens: number;
  cacheEnabled: boolean;
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: null,
  captionLanguage: null,
  outputLanguage: "Same as transcript",
  contextWindowTokens: 128000,
  cacheEnabled: true
};
~~~

Constrain contextWindowTokens to 8192 through 1,000,000. Trim model IDs, require nonempty keys, normalize base URLs without a trailing slash, and expose redacted settings containing only hasApiKey: boolean rather than key text.

Run: **pnpm vitest run tests/unit/settings.test.ts**

Expected: PASS.

- [ ] **Step 3: Implement storage and permission repositories**

storage.ts uses keys settings.v1, summaryCache.v1, and activeJobs.v1. loadSettings merges stored data through the schema and falls back to DEFAULT_SETTINGS only for absent data, not malformed secrets. saveSettings writes the full validated object. clearCredentials replaces provider with null. No function returns the API key to the content script.

permissions.ts exports:

~~~ts
export function customOriginPattern(baseUrl: string): string {
  const url = new URL(validateCustomBaseUrl(baseUrl));
  if (url.protocol === "http:" && url.hostname === "localhost") return "http://localhost/*";
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") return "http://127.0.0.1/*";
  return url.protocol + "//" + url.hostname + "/*";
}

export async function ensureCustomOriginPermission(
  baseUrl: string,
  permissions: Pick<typeof browser.permissions, "contains" | "request">
): Promise<boolean>;
~~~

Chrome match patterns do not contain ports, so the derived pattern intentionally covers the validated scheme and host across ports. Add unit cases for http://localhost:11434/v1 -> http://localhost/*, http://127.0.0.1:8080/v1 -> http://127.0.0.1/*, and https://llm.example:8443/v1 -> https://llm.example/*. contains runs first; request is called only for the exact derived origin pattern.

- [ ] **Step 4: Write the settings component test**

Render Options App with a memory SettingsRepository and PermissionsAdapter. Assert that selecting Custom reveals base URL, model, and key fields; saving an HTTP non-local URL shows an inline error; saving a valid HTTPS URL asks permission; and a saved key becomes a masked "Key saved" state with Replace and Clear buttons but no reveal control.

Run: **pnpm vitest run tests/components/options.test.tsx**

Expected: FAIL before the options form is implemented.

- [ ] **Step 5: Build the settings UX and credential disclosure**

The form includes provider, model, base URL when custom, caption preference, output language, context limit, and cache toggle. Before first key save, require a checked disclosure:

> This local BYOK extension stores the key on this device. Browser storage is not a secure vault. Use a dedicated restricted key and set provider spending limits.

Disable Save until configuration and disclosure are valid. Never prefill an existing key. Replace requires new entry; Clear calls clearCredentials after confirmation. Add "Test connection" as a disabled button labeled "Available after provider adapters are installed"; Task 4 replaces it with behavior in the same commit that adds adapters.

Run: **pnpm vitest run tests/components/options.test.tsx && pnpm typecheck**

Expected: PASS.

- [ ] **Step 6: Initialize trusted storage on every background startup**

Move both setAccessLevel calls outside onInstalled so updated or restarted workers also enforce trusted access. Keep sidePanel.setPanelBehavior in onInstalled and call it once at startup as an idempotent fallback.

Chrome documents AccessLevel, storage.session, and setAccessLevel for Chrome 102+, so these unconditional calls remain compatible with the Chrome 114 minimum. Preserve the Chrome 114 manual smoke test as the runtime gate.

Run: **pnpm test && pnpm build**

Expected: PASS and the built manifest contains storage plus optional_host_permissions.

- [ ] **Step 7: Commit settings and storage**

Run:

~~~bash
git add src/domain/settings.ts src/platform entrypoints/options entrypoints/background.ts tests/unit/settings.test.ts tests/components/options.test.tsx
git commit -m "feat: add local BYOK settings"
~~~

Expected: commit contains no real API key and no .env file.

---

### Task 4: Implement provider adapters and validated structured summaries

**Files:**
- Create: **src/domain/summary.ts**
- Create: **src/providers/types.ts**
- Create: **src/providers/sse.ts**
- Create: **src/providers/retry.ts**
- Create: **src/providers/providerErrors.ts**
- Create: **src/providers/openaiResponses.ts**
- Create: **src/providers/openaiCompatible.ts**
- Create: **src/providers/factory.ts**
- Create: **src/summarization/prompts.ts**
- Modify: **src/domain/messages.ts**
- Modify: **entrypoints/options/App.tsx**
- Create: **tests/fixtures/openai-responses.sse**
- Create: **tests/fixtures/openrouter-chat.sse**
- Test: **tests/unit/summary.test.ts**
- Test: **tests/unit/sse.test.ts**
- Test: **tests/unit/providers.test.ts**

**Interfaces:**
- Produces: VideoSummary, ChunkSummary, CompletedSummaryPayload, ProviderClient, ProviderRequest, ProviderEvent, createProvider(config, fetch), and buildSummaryPrompt(input).
- Consumes: ProviderConfig and VideoContext.

- [ ] **Step 1: Write failing summary-schema tests**

~~~ts
import { expect, it } from "vitest";
import { videoSummarySchema } from "../../src/domain/summary";

it("accepts escaped HTML-shaped text and rejects control characters", () => {
  const value = {
    schemaVersion: 1,
    overview: ["A grounded overview."],
    takeaways: [{ text: "A key point", startSeconds: 12 }],
    sections: [{ heading: "Opening", startSeconds: 0, paragraphs: ["Details."] }],
    limitation: "Generated from captions.",
    generatedAt: "2026-07-13T12:00:00.000Z"
  };
  expect(videoSummarySchema.parse(value)).toEqual(value);
  expect(videoSummarySchema.parse({
    ...value,
    overview: ["<img onerror=alert(1)>"]
  }).overview[0]).toBe("<img onerror=alert(1)>");
  expect(() => videoSummarySchema.parse({
    ...value,
    overview: ["invalid\u0000text"]
  })).toThrow();
});
~~~

Run: **pnpm vitest run tests/unit/summary.test.ts**

Expected: FAIL because summary.ts does not exist.

- [ ] **Step 2: Define summary, chunk, error, and provider contracts**

summaryContentSchema requires 1 to 4 overview paragraphs, 1 to 12 takeaways, 1 to 30 sections, finite nonnegative timestamps, and plain strings no longer than explicit schema limits. videoSummarySchema extends that content with schemaVersion 1, the fixed caption limitation, and an ISO generatedAt timestamp attached by the pipeline after provider validation. The model never invents the generation time. Strings remain untrusted text; angle brackets are allowed as text because React escapes them, while the schema rejects control characters.

Define and validate the complete UI delivery payload in summary.ts:

~~~ts
export type CompletedSummaryPayload = {
  video: { videoId: string; title: string; channel: string | null };
  caption: { languageCode: string; label: string; isAutoGenerated: boolean };
  summary: VideoSummary;
  cache: { key: string; createdAt: string } | null;
};
~~~

completedSummaryPayloadSchema composes videoSummarySchema and validates every metadata field. After this schema exists, extend BackgroundEvent in messages.ts with `{ type: "job/complete"; requestId; tabId; result: CompletedSummaryPayload }`. Task 5 emits the full validated result and returns the same object from panel/status; the panel never looks up a result by cache key. Before Task 7, cache is always null. On a Task 7 cache hit it identifies the validated cache entry and its creation date.

Provider contracts:

~~~ts
export type ProviderRequest = {
  kind: "final" | "chunk" | "synthesis" | "repair";
  system: string;
  user: string;
  schema: "video-summary" | "chunk-summary";
};

export type ProviderEvent =
  | { type: "connected" }
  | { type: "output-bytes"; count: number }
  | { type: "usage"; inputTokens?: number; outputTokens?: number };

export interface ProviderClient {
  testConnection(signal: AbortSignal): Promise<void>;
  generate(request: ProviderRequest, onEvent: (event: ProviderEvent) => void, signal: AbortSignal): Promise<unknown>;
}
~~~

AppError holds code, retryable, safeMessage, optional retryAfterSeconds, and cause excluded from serialization.

Run: **pnpm vitest run tests/unit/summary.test.ts**

Expected: PASS.

- [ ] **Step 3: Write and implement the incremental SSE parser**

Test fragmented data lines, multiline data, comments, blank-event delimiters, CRLF, [DONE], and AbortError propagation using the two fixtures.

The parser accepts ReadableStream<Uint8Array>, uses TextDecoder streaming mode, joins data lines with newline, ignores comment lines beginning with colon, emits complete event payload strings, and rejects a final unterminated nonempty event.

Run: **pnpm vitest run tests/unit/sse.test.ts**

Expected: PASS for both provider fixture shapes.

- [ ] **Step 4: Implement OpenAI Responses requests**

POST https://api.openai.com/v1/responses with Bearer authorization, model, stream true, store false, instructions, input, and text.format using the JSON schema for the requested result. Parse response.output_text.delta events into a local string buffer, emit only byte-count progress before validation, collect usage from response.completed, parse JSON, and validate through the requested Zod schema.

testConnection sends a bounded request asking for the JSON object {"ok":true} with max_output_tokens 16 and abort support. It must not include a transcript.

- [ ] **Step 5: Implement OpenRouter and custom Chat Completions**

POST to https://openrouter.ai/api/v1/chat/completions for OpenRouter or baseUrl + /chat/completions for custom. Send Bearer authorization, Content-Type application/json, model, system/user messages, stream true, and response_format json_schema for OpenRouter. Omit response_format for custom compatibility and rely on prompt-delimited JSON plus runtime validation.

Parse choices[0].delta.content, error events, usage in the final chunk, and [DONE]. Strip a single leading/final Markdown JSON fence before JSON.parse; do not attempt free-form brace extraction.

- [ ] **Step 6: Add error normalization, bounded retry, and one repair**

Map 401 to credentials_rejected, 402 to insufficient_credits, 403 to provider_forbidden, 408 to network_timeout, 429 to rate_limited, 5xx to provider_unavailable, AbortError to request_canceled, and other network TypeError values to network_unavailable. Redact bearer-like strings and any exact configured key from safe messages.

Retry at most once for initial network failure, 408, 429, or 5xx only when no output bytes were received. Honor Retry-After values from 0 through 60 seconds; values above 60 produce rate_limited without an automatic wait. Inject sleep into tests.

If JSON or schema validation fails, make one nonstreamed repair request containing the invalid output and the target schema. A failed repair throws provider_output_invalid.

Run: **pnpm vitest run tests/unit/providers.test.ts**

Expected: PASS for request shape, auth redaction, stream parsing, cancellation, retry eligibility, retry ceiling, and repair limit.

- [ ] **Step 7: Enable settings connection testing**

Replace the disabled options control with createProvider(settings.provider, fetch).testConnection. Show Testing, Connected, or a mapped safe error. Never log the caught error or response body.

Run: **pnpm test && pnpm typecheck**

Expected: PASS.

- [ ] **Step 8: Commit provider support**

Run:

~~~bash
git add src/domain/messages.ts src/domain/summary.ts src/providers src/summarization/prompts.ts entrypoints/options/App.tsx tests/fixtures tests/unit tests/components
git commit -m "feat: add LLM provider adapters"
~~~

Expected: provider adapters are independently tested with mocked fetch and fixture streams.

---

### Task 5: Orchestrate single-pass summaries and render the side panel

**Files:**
- Create: **src/background/jobRegistry.ts**
- Create: **src/background/controller.ts**
- Create: **src/summarization/pipeline.ts**
- Modify: **entrypoints/background.ts**
- Modify: **entrypoints/sidepanel/App.tsx**
- Modify: **entrypoints/sidepanel/styles.css**
- Test: **tests/unit/jobRegistry.test.ts**
- Test: **tests/unit/controller.test.ts**
- Test: **tests/components/sidepanel.test.tsx**

**Interfaces:**
- Produces: JobSnapshot, JobRegistry, SummaryController.start(), cancel(), status(), and runSummaryPipeline(); reuses JobState from the runtime contract.
- Consumes: transcript extraction messages, storage, provider factory, settings, and summary schemas.

- [ ] **Step 1: Write failing stale-job and cancellation tests**

Create a registry with injected UUID generation. Start job A for tab 4/video A, then job B for tab 4/video B. Assert A.signal.aborted is true, isCurrent(A) is false, and only B can call complete. cancel(tabId) must be idempotent.

Run: **pnpm vitest run tests/unit/jobRegistry.test.ts**

Expected: FAIL before jobRegistry.ts exists.

- [ ] **Step 2: Implement one job per tab**

Reuse the JobState union created in Task 1. Each record holds requestId, tabId, videoId, AbortController, state, progress, startedAt, and a completed result only in the complete state. Define JobSnapshot as a discriminated union: non-complete states never contain result, while `{ state: "complete" }` requires a CompletedSummaryPayload result. complete and fail require matching requestId and videoId. status(tabId) returns the serializable JobSnapshot; it never exposes AbortController.

Run: **pnpm vitest run tests/unit/jobRegistry.test.ts**

Expected: PASS.

- [ ] **Step 3: Implement the single-pass pipeline**

runSummaryPipeline accepts normalized transcript, video metadata, settings, provider, progress callback, and AbortSignal. For this task, if estimated input exceeds the current limit, throw context_limit_exceeded with a safe message that Task 6 replaces with chunking. Otherwise build the final prompt, generate, validate, attach generatedAt, and return VideoSummary.

The controller sequence is:

1. Validate the active tab URL, execute readPlayerSnapshotInPage in MAIN world, and sanitize the returned VideoContext in the background.
2. Load and validate settings.
3. Begin a registry job and emit loading_video.
4. Send the validated context and preference in youtube/extract to the content script and emit extracting_transcript; cancellation also sends youtube/cancel-extract.
5. Create the provider and emit summarizing.
6. Run the pipeline.
7. Recheck registry currentness before returning or storing any result.
8. Construct and validate CompletedSummaryPayload, store it on the current JobSnapshot, and emit job/complete with that same result; otherwise emit a mapped safe error.

- [ ] **Step 4: Write the controller test with fakes**

Assert unsupported pages and missing settings make zero provider calls; caption failures make zero provider calls; cancellation aborts the content-script fetch; and a late job A result cannot overwrite job B. Assert controller.status(tabId).result deep-equals the job/complete event result and invalid completion payloads are rejected before either path exposes them.

Run: **pnpm vitest run tests/unit/controller.test.ts**

Expected: PASS after controller implementation.

- [ ] **Step 5: Route background messages and events**

background.ts validates sender.tab for content-script navigation, validates AppMessage payloads, calls controller methods, and returns serializable snapshots. A panel/status response contains the current JobSnapshot, including the validated CompletedSummaryPayload when complete. Side-panel events use browser.runtime.connect with a named port "summary-panel"; job/complete contains the identical payload. Disconnecting removes the listener but does not cancel the job.

- [ ] **Step 6: Build the side-panel state machine and safe renderer**

On mount, query the active tab, request status, and auto-start when no completed current result exists. Render:

- unsupported page with the required watch-page copy;
- configuration required with Open settings;
- progress with phase label and chunk counts;
- complete with title, channel, caption language, cache date, Copy, Regenerate, Settings, and timestamp buttons;
- safe errors with Retry or Settings based on recovery action.

Summary strings render only as React children. Timestamp controls send youtube/seek and have labels such as "Jump to 12:34". Copy creates plain text from structured fields, never HTML.

- [ ] **Step 7: Test all panel states**

Use fake ports and repositories. Assert auto-start once, no duplicate start under React StrictMode, cancel while active, regenerate sets force true, hostile text renders literally, settings uses browser.runtime.openOptionsPage, copy uses navigator.clipboard.writeText, and timestamp sends the expected seconds.

Run: **pnpm vitest run tests/components/sidepanel.test.tsx && pnpm test && pnpm build**

Expected: PASS.

- [ ] **Step 8: Commit the single-pass experience**

Run:

~~~bash
git add src/background src/summarization/pipeline.ts entrypoints/background.ts entrypoints/sidepanel tests/unit tests/components
git commit -m "feat: summarize videos in the side panel"
~~~

Expected: a configured short transcript completes end-to-end through mocked boundaries.

---

### Task 6: Add bounded map-and-synthesize processing for long videos

**Files:**
- Create: **src/summarization/chunking.ts**
- Modify: **src/summarization/prompts.ts**
- Modify: **src/summarization/pipeline.ts**
- Test: **tests/unit/chunking.test.ts**
- Modify: **tests/unit/controller.test.ts**
- Modify: **tests/components/sidepanel.test.tsx**

**Interfaces:**
- Produces: estimateTokens(text), chunkTranscript(segments, budget), groupForSynthesis(chunks, budget), and deterministic PipelineProgress.
- Consumes: ChunkSummary and ProviderClient from Task 4.

- [ ] **Step 1: Write failing chunk-boundary tests**

Test that:

- estimateTokens uses Math.ceil(UTF-8 bytes / 3.5);
- chunks split only between transcript segments;
- each chunk after the first repeats at most the final two segments from the previous chunk;
- a single oversized segment remains one chunk and produces context_limit_exceeded before a provider call;
- recursive synthesis groups remain chronological and each group stays within budget;
- progress totals equal map calls plus intermediate synthesis calls plus one final synthesis call.

Run: **pnpm vitest run tests/unit/chunking.test.ts**

Expected: FAIL before chunking.ts exists.

- [ ] **Step 2: Implement conservative budgets and transcript chunks**

Use:

~~~ts
export const CHARACTERS_PER_TOKEN = 3.5;
export const PROMPT_RESERVE_TOKENS = 2048;
export const OUTPUT_RESERVE_TOKENS = 4096;
export const CONTEXT_SAFETY_RATIO = 0.85;
export const SEGMENT_OVERLAP_COUNT = 2;

export function inputBudgetTokens(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * CONTEXT_SAFETY_RATIO)
    - PROMPT_RESERVE_TOKENS
    - OUTPUT_RESERVE_TOKENS;
}
~~~

Throw configuration_invalid if the resulting budget is nonpositive. Measure the complete formatted segment line, not raw text alone.

Run: **pnpm vitest run tests/unit/chunking.test.ts**

Expected: boundary tests PASS.

- [ ] **Step 3: Add chunk and synthesis prompts**

Chunk output contains chronological compact facts and candidate section starts grounded in supplied timestamps. Synthesis input contains only validated ChunkSummary values, never raw invalid provider text. Every prompt delimits transcript or intermediate data between explicit BEGIN/END markers and states that text inside those markers is data, not instructions.

- [ ] **Step 4: Upgrade the pipeline**

If the final prompt fits, preserve the one-call path. Otherwise:

1. Build chunks.
2. Generate validated ChunkSummary values sequentially.
3. Emit progress after each validated map result.
4. Group adjacent intermediates while synthesis input exceeds budget.
5. Generate validated reduced ChunkSummary values sequentially.
6. Generate one final VideoSummary.
7. Check AbortSignal before and after every provider call.

No intermediate result is persisted. One chunk failure stops the job and preserves its mapped AppError.

- [ ] **Step 5: Test long-video controller and panel progress**

Use a 100-segment fixture and a small injected context limit to force three map calls and one final synthesis. Assert call order, progress 0/4 through 4/4, cancellation before call three, and no result after navigation.

Run: **pnpm vitest run tests/unit/chunking.test.ts tests/unit/controller.test.ts tests/components/sidepanel.test.tsx**

Expected: PASS.

- [ ] **Step 6: Commit long-video support**

Run:

~~~bash
git add src/summarization tests/unit/chunking.test.ts tests/unit/controller.test.ts tests/components/sidepanel.test.tsx
git commit -m "feat: summarize long captioned videos"
~~~

Expected: single-pass behavior remains passing and long transcripts use deterministic sequential progress.

---

### Task 7: Add cache, lifecycle recovery, navigation invalidation, and complete error UX

**Files:**
- Create: **src/platform/cache.ts**
- Modify: **src/platform/storage.ts**
- Modify: **src/background/controller.ts**
- Modify: **src/background/jobRegistry.ts**
- Modify: **entrypoints/background.ts**
- Modify: **entrypoints/sidepanel/App.tsx**
- Modify: **entrypoints/options/App.tsx**
- Test: **tests/unit/cache.test.ts**
- Test: **tests/unit/lifecycle.test.ts**
- Modify: **tests/unit/controller.test.ts**
- Modify: **tests/components/sidepanel.test.tsx**
- Modify: **tests/components/options.test.tsx**

**Interfaces:**
- Produces: SummaryCache, buildCacheKey(input), restoreInterruptedJobs(), and clearSummaryCache().
- Consumes: completed VideoSummary, caption identity, provider identity, prompt version, and schema version.

- [ ] **Step 1: Write failing cache tests**

Assert the key changes for video, caption language, auto-caption flag, provider kind, custom origin, model, output language, prompt version, and schema version; assert API key changes do not affect it. Insert 21 summaries and assert 20 remain. Insert data beyond 5,000,000 serialized bytes and assert least-recently-used entries are removed. A single entry larger than the budget is not cached.

Run: **pnpm vitest run tests/unit/cache.test.ts**

Expected: FAIL before cache.ts exists.

- [ ] **Step 2: Implement stable cache identity and bounded LRU writes**

Serialize key input with fixed property order and hash it with crypto.subtle SHA-256. Store entries with key, result, createdAt, lastAccessedAt, and serializedBytes. On get, update lastAccessedAt. On set, evict oldest access times until both limits pass, then write once to avoid partially updated state.

Run: **pnpm vitest run tests/unit/cache.test.ts**

Expected: PASS.

- [ ] **Step 3: Integrate cache hits and force regeneration**

The controller builds a cache key after transcript track selection but before the provider call. If cache is enabled and force is false, return the validated cached summary without constructing a provider. Only a current, completed, validated job writes the cache.

Changing settings naturally misses through key identity. Options Clear summaries calls clearSummaryCache and leaves settings unchanged.

- [ ] **Step 4: Persist non-secret active job snapshots in storage.session**

Persist requestId, tabId, videoId, state, progress, and startedAt, but no transcript, prompt, key, or provider body. On worker startup, any snapshot in a nonterminal state becomes interrupted and is exposed to the panel with Retry. A clean completion or cancellation removes its session entry.

Write lifecycle tests that seed a summarizing snapshot, create a new controller, and assert interrupted; terminal snapshots remain terminal; interrupted jobs never populate cache.

Run: **pnpm vitest run tests/unit/lifecycle.test.ts**

Expected: PASS.

- [ ] **Step 5: Cancel on YouTube navigation and reject stale completion**

background.ts accepts youtube/navigated only from a sender whose tab ID matches the message. If the video ID differs from the registry job, cancel it and emit a fresh loading state. A same-video history event does nothing. Test spoofed tab IDs, null IDs, and rapid A-to-B-to-A navigation.

- [ ] **Step 6: Complete safe error recovery controls**

Map every design error code to title, message, retryability, and action. Panel controls are:

- Retry for unavailable video context, transient network, timeout, rate-limit, unavailable provider, lifecycle interruption, internal error, and extraction errors.
- Settings for missing configuration, credential, credit, forbidden, context-limit, or custom-permission errors.
- No retry for unsupported page, no captions, canceled, or content-filtered results.

Provider output invalid offers Retry and Change model. Errors never interpolate raw response bodies.

Run: **pnpm test && pnpm typecheck && pnpm build**

Expected: PASS.

- [ ] **Step 7: Commit cache and lifecycle behavior**

Run:

~~~bash
git add src/platform src/background entrypoints/background.ts entrypoints/sidepanel entrypoints/options tests
git commit -m "feat: cache summaries and recover lifecycle state"
~~~

Expected: complete cached, navigation, interruption, and error behavior is independently tested.

---

### Task 8: Add packaged-extension tests, privacy documentation, and browser verification

**Files:**
- Create: **playwright.config.ts**
- Create: **tests/extension/extension.fixture.ts**
- Create: **tests/extension/summary-flow.spec.ts**
- Create: **tests/extension/fixtures/youtube.html**
- Create: **tests/extension/mock-server.ts**
- Modify: **wxt.config.ts**
- Create: **docs/privacy.md**
- Create: **docs/manual-verification.md**
- Create: **README.md**

**Interfaces:**
- Produces: deterministic WXT_TEST_MODE build and Playwright extension fixture.
- Consumes: built test-mode dist-test/chrome-mv3 package and all completed extension behavior.

- [ ] **Step 1: Configure a persistent Chromium extension fixture**

playwright.config.ts runs tests/extension with one worker, a 60-second timeout, and trace on first retry. The fixture starts the local server on 127.0.0.1 with an ephemeral port, launches chromium.launchPersistentContext with:

~~~ts
[
  "--disable-extensions-except=" + extensionPath,
  "--load-extension=" + extensionPath
]
~~~

Derive the extension ID from the service worker URL. Close the context and server after each test.

- [ ] **Step 2: Add test-only local page matching**

youtube.content.ts defines build-time matches exactly as follows:

~~~ts
const contentMatches = import.meta.env.WXT_TEST_MODE === "1"
  ? ["https://www.youtube.com/*", "http://127.0.0.1/*"]
  : ["https://www.youtube.com/*"];

export default defineContentScript({
  matches: contentMatches,
  main(ctx) {
    registerYouTubeMessageHandlers(ctx);
  }
});
~~~

WXT imports entrypoints at build time to generate content-script manifest entries and exposes WXT_-prefixed environment variables through import.meta.env. The fixture page implements #movie_player.getPlayerResponse(), a video element, title/channel metadata, and a caption base URL served by the mock server. Its loopback caption URL is accepted only by the build-time-gated isAllowedCaptionUrl policy from Task 2. Production builds contain neither the localhost match nor test bridge allowance.

Add a manifest test that runs the production build and immediately asserts no loopback content-script match, fixed host_permissions entry, or test bridge is present; the intentional optional_host_permissions entries for localhost and 127.0.0.1 must remain. Then run the test build and immediately assert the 127.0.0.1 content match, fixed test host permission, and bridge are present. Add a packaged extraction assertion proving the loopback fixture transcript succeeds in test mode. The production sanitizer unit test remains the regression gate that the same URL is rejected when testMode is false.

- [ ] **Step 3: Test the packaged uncached, cached, cancellation, and permission flows**

summary-flow.spec.ts:

1. Build test mode before the suite.
2. Open the fixture page.
3. Seed provider settings through the extension options page, using the local custom endpoint and granting its requested origin.
4. Open sidepanel.html directly because Playwright cannot create a real toolbar user gesture reliably.
5. Assert transcript fetch, sequential provider stream, rendered overview, and timestamp seek.
6. Reopen and assert provider request count is unchanged on a cache hit.
7. Start a delayed request, cancel, and assert the mock observes abort and no cache entry is written.
8. Navigate fixture video A to B and assert A output never appears.

Toolbar action opening remains in the manual browser matrix because chrome.sidePanel.open behavior depends on a real browser user gesture.

Run: **pnpm build:test && pnpm test:extension**

Expected: all packaged-extension tests PASS in bundled Chromium.

- [ ] **Step 4: Write privacy and setup documentation**

README includes requirements, pnpm install, pnpm dev, pnpm build, Chrome and Brave unpacked-load paths, supported pages, provider setup, test commands, and known limitations.

docs/privacy.md states:

- exactly which settings and summaries are stored;
- that raw transcripts are transient;
- that transcript text is sent only to the selected provider;
- that keys are local but browser storage is not a vault;
- why each fixed and optional permission exists;
- that declaring optional https://*/* is required to support a user-chosen HTTPS custom provider, but runtime code requests only the single validated scheme-and-host pattern returned by customOriginPattern and never requests blanket all-site access;
- how to clear keys and summaries;
- that the MVP has no application telemetry or backend.

docs/manual-verification.md includes unchecked rows for exact browser version, human captions, automatic captions, no captions, long video, SPA navigation, invalid key, rate-limited mock, cache hit, copy, timestamp seek, action opening, console errors, and credential/log inspection.

- [ ] **Step 5: Run the full automated gate**

Run:

~~~bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm build:test
pnpm test:extension
git diff --check
~~~

Expected: every command exits 0; production manifest has no localhost content-script match; git diff --check prints nothing.

- [ ] **Step 6: Run and record the manual Chrome/Brave matrix**

Load dist/chrome-mv3 as unpacked in current stable Chrome and Brave on macOS. Record exact versions and PASS/FAIL evidence in docs/manual-verification.md. Use dedicated low-limit test keys only for opt-in live smoke tests; do not record key values or raw authorization errors.

Expected: all acceptance rows pass or a concrete defect is filed and fixed before completion.

- [ ] **Step 7: Commit the verified MVP documentation and tests**

Run:

~~~bash
git add playwright.config.ts tests/extension wxt.config.ts docs README.md
git commit -m "test: verify packaged extension flows"
~~~

Expected: working tree contains no generated output, browser profiles, credentials, or unrelated changes.

---

## Final Review and Handoff Gate

- [ ] Confirm git status --short contains only intentionally untracked user files.
- [ ] Run the full automated gate from Task 8 on the final commit.
- [ ] Inspect the production manifest for minimum Chrome 114, exact fixed hosts, optional custom hosts, side panel, and no localhost test match.
- [ ] Confirm the manual Chrome and Brave matrix records exact versions and results.
- [ ] Run the required scoped Pi multi-review code passes over committed source/config/tests, triage every finding, fix agreed blockers, and rerun until clean.
- [ ] Push the feature branch, create a PR targeting develop, and run Pi multi-review PR with --run-check before declaring merge readiness.

## Specification Coverage

| Approved requirement | Implementing tasks |
| --- | --- |
| Native Chrome/Brave side panel and settings | Tasks 1, 5, and 8 |
| Captioned standard YouTube watch pages only | Tasks 2, 5, and 8 |
| OpenAI, OpenRouter, and custom OpenAI-compatible BYOK | Tasks 3 and 4 |
| Trusted local credentials and least-privilege permissions | Tasks 1, 3, 7, and 8 |
| Detailed structured summary and timestamp seeking | Tasks 4 and 5 |
| Streaming progress, cancellation, and stale-job rejection | Tasks 4, 5, 6, and 7 |
| Long-video map-and-synthesize pipeline | Task 6 |
| Bounded summary cache without transcript persistence | Task 7 |
| Stable safe errors and lifecycle interruption recovery | Tasks 4, 5, and 7 |
| Unit, component, packaged Chromium, and manual Brave verification | Every task, finalized in Task 8 |

## Implementation Notes

- Create a feature branch with the feature/ prefix immediately before Task 1 implementation; do not create a worktree during planning.
- Treat YouTube player and transcript DOM access as unstable adapters. A fixture update should not require changes to provider, pipeline, cache, or React contracts.
- Keep provider response fixtures synthetic and free of real user transcripts.
- Do not weaken structured validation to accommodate a failing model. Surface provider_output_invalid and let the user choose another model.
- Do not add audio transcription, chat, native Anthropic/Gemini adapters, telemetry, cloud sync, or store publication while executing this plan.
