# YouTube Detailed Summary

YouTube Detailed Summary is a local, bring-your-own-key Manifest V3 extension for Chrome and Brave. Open a captioned standard YouTube watch page, click the extension action, and the side panel creates a structured summary with an overview, key takeaways, chronological sections, and seekable timestamps.

The MVP has no application backend, account, or telemetry. Captions are obtained from YouTube and sent to the provider you configure. Read [Privacy and data handling](docs/privacy.md) before saving an API key.

## Requirements

- Node.js 22 or newer
- pnpm 11 (the repository pins pnpm 11.13.0)
- Google Chrome 114+ or a current Brave release with Chromium extension support

Enable the pinned package manager and install dependencies:

```bash
corepack enable
pnpm install
```

## Develop, build, and load

Start WXT development mode:

```bash
pnpm dev
```

Create a production unpacked build:

```bash
pnpm build
```

The unpacked production extension is written directly to the visible project directory `dist/chrome-mv3`.

### Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository's `dist/chrome-mv3` directory.
5. Pin **YouTube Detailed Summary** if you want its action to remain visible.

### Brave

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository's `dist/chrome-mv3` directory.
5. Pin **YouTube Detailed Summary** if desired.

Rebuild and reload the extension from the browser's extensions page after source changes. See the current, deliberately unclaimed browser test matrix in [Manual verification](docs/manual-verification.md).

## Configure a provider

Open the extension's **Settings** page, select a provider, enter an API key, accept the local-key disclosure, choose a model, then save. For OpenAI and OpenRouter, the model chooser is loaded directly from that provider's authenticated models API; the extension displays a readable name and stores the provider's exact model ID internally. A saved key cannot be revealed or copied from the UI; it can only be replaced or cleared. **Test connection** becomes available after the provider settings are saved.

The extension never ships a static OpenAI or OpenRouter model list. Use **Refresh models** to query the selected provider again. If a valid model is absent from the returned catalog, enable **Use a model not shown** and enter its exact ID as an advanced fallback.

Use a dedicated restricted key with a low spending limit when the provider supports those controls. Extension local storage is not a secret vault.

### OpenAI

Select **OpenAI**, supply an OpenAI API key, accept the disclosure, and choose from the catalog returned by authenticated `GET https://api.openai.com/v1/models`. Summary and connection-test requests use the fixed `https://api.openai.com/v1/responses` endpoint.

### OpenRouter

Select **OpenRouter**, supply an OpenRouter API key, accept the disclosure, and choose from the text-model catalog returned by authenticated `GET https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=response_format&sort=most-popular`. Summary and connection-test requests use the fixed OpenRouter Chat Completions endpoint.

### Custom OpenAI-compatible endpoint

Select **Custom OpenAI-compatible**, then supply:

- a base URL, normally ending in a version prefix such as `https://llm.example/v1`;
- a model ID; and
- an API key.

The extension appends `/chat/completions` to the saved base URL. The URL must use HTTPS and cannot contain credentials, a query string, a fragment, or a wildcard hostname. Plain HTTP is accepted only for `localhost` and `127.0.0.1` development endpoints. Saving requests browser access to the one validated custom origin; denying that prompt prevents the settings from being saved.

## Summary preferences

- **Caption preference:** Leave blank for automatic selection, or enter a preferred caption language code. The selector prefers matching human-authored captions before automatic captions, then browser-language, English, and other available tracks.
- **Output language:** Defaults to `Same as transcript` and is passed to the provider as an output instruction.
- **Summary detail:** Defaults to **Standard**. **Concise** prioritizes the most important points; Standard provides balanced coverage and context; **Detailed** asks for more granular context and explanation. The preference applies the next time a summary is generated.
- **Context limit:** Defaults to a conservative, user-adjustable 128,000 tokens. Valid values are 8,192 through 1,000,000. Set this to a limit your chosen model actually supports. Transcripts that do not fit are summarized in sequential chunks and synthesized into a final result.
- **Cache summaries:** Enabled by default. Completed summaries are reused only when the video, selected captions, provider identity, model, output language, summary detail, prompt version, and schema version match.

The cache holds at most 20 entries and 5,000,000 serialized bytes, evicting older entries as needed. **Regenerate** bypasses a cache read and replaces the matching cached result after successful generation. Turning caching off stops cache reads and writes but does not delete existing entries; use **Clear summaries** in Settings to erase them.

**Clear saved provider** removes the saved provider configuration, including its key, model, and custom base URL, while preserving summary preferences and existing cached summaries. During replacement, **Cancel replacement** discards only the unsaved draft and restores the saved provider. **Reset stored settings** restores all settings defaults and removes the provider, but cached summaries must still be cleared separately.

## Supported flows

- Standard `https://www.youtube.com/watch?v=<videoId>` pages with an 11-character video ID and available human or automatic captions
- Native browser side-panel opening from the extension action
- Automatic summarization when the panel opens, progress for long-video chunking, cancellation, retry, and regeneration
- OpenAI Responses, OpenRouter Chat Completions, and custom OpenAI-compatible Chat Completions providers
- Structured, plain-text rendering; copy to clipboard; and timestamp buttons that seek the active matching video
- YouTube single-page navigation detection, stale-job cancellation, and bounded local summary caching
- Visible transcript parsing as a fallback when no usable player caption track is available in the page snapshot

## Known MVP limitations

- Videos without captions are not transcribed. The extension does not download audio or video and has no speech-to-text service.
- Shorts, mobile YouTube, embedded players, channel/search pages, whole playlists, non-YouTube sites, and live streams without a stable transcript are unsupported.
- Caption discovery relies on YouTube player data and page markup that YouTube may change.
- Native Anthropic, Gemini, and other provider-specific APIs are not implemented; use OpenRouter or a compatible endpoint where appropriate.
- There is no account, cloud sync, shared summary, chat/Q&A, annotation, bookmark, or export workflow beyond copying rendered text.
- Summary accuracy is limited by caption quality and the selected model. Generated text is paraphrased and may inherit caption or model errors.
- This development build is loaded unpacked and is not published to a browser store.
- API keys reside in browser extension storage on the local browser profile, which is not equivalent to a secure credential vault.

## Checks

The package scripts expose the following checks:

```bash
pnpm typecheck
pnpm test
pnpm test:watch
pnpm test:manifest
pnpm test:manifest:test
pnpm build:test
pnpm test:extension
pnpm check
```

`pnpm check` runs type checking, the Vitest suite, and both production and test-mode manifest assertions. Before the first packaged-extension run, install Playwright's matching Chromium binary with `pnpm exec playwright install chromium`. Then run `pnpm test:extension`; that script builds the isolated test package before launching it.

## Privacy

For the exact local and session records, provider transmissions, permission rationale, and clearing instructions, see [Privacy and data handling](docs/privacy.md).
