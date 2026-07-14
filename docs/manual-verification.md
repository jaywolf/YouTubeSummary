# Manual browser verification

- **Verification date:** 2026-07-14
- **Overall status:** NOT RUN
- **Tester:** Not recorded
- **Commit:** Not recorded
- **macOS version:** Not recorded
- **Google Chrome exact version:** Not recorded (`chrome://version`)
- **Brave exact version:** Not recorded (`brave://version`)

This file is an evidence template, not a claim that browser testing passed. Every acceptance row remains unchecked and marked **NOT RUN** until a tester records the exact browser version, result, and reproducible evidence. Use `PASS`, `FAIL`, or `BLOCKED` only after performing the check; for failures, link or describe the filed defect without including credentials or raw authorization data.

## Build under test

From the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Load the unpacked production directory:

```text
.output/chrome-mv3
```

In Chrome use `chrome://extensions`; in Brave use `brave://extensions`. Enable Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3`. After rebuilding, click **Reload** for the extension before continuing.

Record the build environment before testing:

| Field | Evidence |
| --- | --- |
| Commit hash | Not recorded |
| `node --version` | Not recorded |
| `pnpm --version` | Not recorded |
| `pnpm typecheck` result | NOT RUN |
| `pnpm test` result | NOT RUN |
| `pnpm build` result | NOT RUN |
| Built manifest path and SHA-256 | Not recorded |

## Test inputs

Use public or explicitly authorized test videos. Do not record transcript content, API keys, authorization headers, or full provider error bodies.

| Input | URL or fixture | Notes |
| --- | --- | --- |
| Human-captioned standard watch video | `https://www.youtube.com/watch?v=iG9CE55wbtY` | Reconfirm that a human caption track is still available immediately before the run. |
| Automatic-caption standard watch video | `https://www.youtube.com/watch?v=Z1wrAhvanRU` | Reconfirm the automatic caption label immediately before the run; record the label, not transcript text. |
| Video with no captions | `https://www.youtube.com/watch?v=aqz-KE-bpKQ` | Reconfirm that captions remain unavailable; expected to show a captions-unavailable recovery state. |
| Long captioned video | `https://www.youtube.com/watch?v=8mAITcNt710` | Reconfirm captions, then lower the configured context enough to force visible mapping progress. |
| SPA navigation video A and video B | Not recorded | Both must be standard watch pages. |
| Dedicated restricted live-provider key | Not recorded | Optional; record only provider/key label, never the value. |
| Local rate-limit mock | Not recorded | Custom endpoint that returns HTTP 429 and a safe retry response. |

## Chrome and Brave acceptance matrix

Evidence can be a screenshot filename, screen recording timestamp, console capture with secrets redacted, or concise observation. Repeat each browser-dependent check in both browsers; do not infer a Brave result from Chrome or vice versa.

| Done | Check | Chrome result | Brave result | Evidence / notes |
| --- | --- | --- | --- | --- |
| - [ ] | **OpenAI model catalog:** enter a dedicated OpenAI key, accept the disclosure, and verify the readable model chooser loads from the authenticated provider API; refresh it and save a selection without exposing the key or requiring a typed model ID. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **OpenRouter model catalog:** enter a dedicated OpenRouter key, accept the disclosure, and verify the readable compatible-text model chooser loads from the authenticated provider API; refresh it and save a selection without exposing the key or requiring a typed model ID. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Advanced model fallback:** enable **Use a model not shown**, verify an exact provider ID can be entered manually, then disable it and verify the API-backed chooser returns. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Human captions:** open the human-captioned watch page, click the action, and verify a complete summary identifies the selected human caption track. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Automatic captions:** summarize the automatic-caption video and verify the panel marks the caption track as automatic. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **No captions:** open the no-caption video and verify the panel reports that captions are unavailable without making a provider summary request. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Long video:** use an appropriate reduced context setting or sufficiently long transcript; verify sequential mapping progress followed by synthesis and a complete summary. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **SPA navigation:** start or complete video A, navigate in-page to video B, and verify A work is canceled/stale and A output never appears for B. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Invalid key:** save a dedicated invalid test key, run **Test connection** or summarize, and verify a safe credential error with a Settings recovery action and no raw provider body. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Rate-limited mock:** configure the validated local custom endpoint to return HTTP 429; verify bounded retry/recovery behavior and a safe rate-limit message. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Cache hit:** generate once, close and reopen the panel on the same video/settings, and verify the cached timestamp is shown and the provider request count does not increase. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Copy:** click **Copy**, verify the button reports **Copied**, and paste into a scratch editor to confirm overview, takeaways, sections, timestamps, and limitation text. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Timestamp seek:** click takeaway and section timestamps and verify the active matching YouTube player seeks to the expected times. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Action opening:** with a supported watch page active, click the real toolbar action and verify the native side panel opens. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Console errors:** inspect the service worker, side panel, options page, and YouTube content-script consoles through the complete flow; record unexpected errors or confirm none. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | **Credential and log inspection:** inspect extension storage, network request destinations, console output, and copied evidence; verify the key stays in local extension storage, is sent only to the selected provider, is absent from session job/cache records and logs, and cannot be revealed in the UI. | NOT RUN | NOT RUN | Not recorded |

## Additional permission and clearing evidence

These checks supplement the required matrix and should be recorded during the same pass.

| Done | Check | Chrome result | Brave result | Evidence / notes |
| --- | --- | --- | --- | --- |
| - [ ] | Save a custom HTTPS provider and verify the browser prompt requests only its single validated origin, not blanket all-site runtime access. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | Deny a custom-origin permission and verify the provider settings are not saved. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | Click **Replace key**, enter a draft, then click **Cancel replacement** and verify the saved provider remains without revealing either key. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | Click **Clear saved key** and verify the provider configuration is removed while preferences and cached summaries remain. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | Click **Clear summaries** and verify the local `summaryCache.v1` envelope has no entries. | NOT RUN | NOT RUN | Not recorded |
| - [ ] | Turn caching off without clearing and verify old cache entries remain stored but are neither read nor updated. | NOT RUN | NOT RUN | Not recorded |

## Final result

- **Chrome:** NOT RUN
- **Brave:** NOT RUN
- **Open defects or blockers:** Not recorded
- **Evidence location:** Not recorded
