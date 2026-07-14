# Privacy and data handling

YouTube Detailed Summary is a local bring-your-own-key browser extension. The MVP has no application backend, user account, analytics, or telemetry. It does not upload data to an extension developer-operated service.

It does communicate with YouTube to obtain captions and with the language-model provider selected in Settings to test the connection and generate summaries. Those services apply their own terms and privacy practices.

## Data stored in the browser

The extension uses `chrome.storage.local`, not `chrome.storage.sync`, for settings, credentials, and completed summaries. It sets local and session storage access to `TRUSTED_CONTEXTS`, preventing the YouTube content script from directly reading those storage areas. This boundary does not turn extension storage into a secure secret vault: a person or malicious program with sufficient access to the browser profile or device may still be able to recover its contents.

### Local settings: `settings.v1`

The complete settings record contains:

- selected provider (`openai`, `openrouter`, or `custom`), or no provider;
- the provider API key;
- the exact provider model ID selected from the authenticated OpenAI/OpenRouter catalog, or entered manually for a custom provider or advanced fallback;
- the validated custom base URL for a custom provider;
- preferred caption language, or automatic selection;
- output-language instruction;
- user-adjustable model context limit, defaulting to 128,000 tokens; and
- whether summary caching is enabled.

Keys are saved only after the user accepts the local-key disclosure. The settings UI does not reveal or copy a saved key.

### Local summary cache: `summaryCache.v1`

When caching is enabled, each completed cache entry contains:

- a SHA-256 cache-key digest derived from video ID, caption language and automatic-caption status, provider kind, custom-provider origin when applicable, model ID, output language, prompt version, and summary schema version;
- the validated structured summary: overview paragraphs, takeaway text and optional start times, chronological section headings/start times/paragraphs, schema version, the fixed caption limitation, and generation time;
- cache creation and last-access times; and
- the entry's serialized-byte measurement.

The cache does not include the API key or raw transcript. It is bounded to 20 entries and 5,000,000 serialized bytes and evicts least-recently accessed entries when necessary.

### Session job state: `activeJobs.v1`

While work is active, `chrome.storage.session` contains a versioned list with at most one job per tab. A job record contains its request ID, tab ID, video ID, lifecycle state, optional mapping/reducing/synthesis progress counters, and start time. It does not contain transcript text, provider credentials, prompts, provider responses, or a completed summary. Session records are used to report interrupted Manifest V3 service-worker work and are cleared as jobs settle or are restored as interrupted.

## Data that is transient

Normalized transcript segments, request prompts, partial provider streams, and in-progress intermediate summaries exist only in memory for the active job. Raw transcripts are not written to extension local or session storage. The extension also does not persist authorization headers, full provider error bodies, page DOM snapshots, or raw model output.

Closing the side panel does not intentionally cancel active work. Browser service-worker suspension can interrupt it; a stored job identity may remain briefly so the panel can report that interruption, but the transcript is not restored from storage.

## Data sent to the selected provider

When OpenAI or OpenRouter is selected, the Settings page sends an authenticated model-catalog request to that provider after the user accepts the local-key disclosure. The request contains the API key in an authorization header but no video metadata, captions, transcript, prompt, or summary. Catalog responses are used in memory to populate the model chooser and are not persisted as a separate model list; only the selected exact model ID is saved with the provider settings.

Summary requests send only to the provider selected in Settings:

- the saved API key in an authorization header;
- the selected exact provider model ID;
- system instructions and the required structured-output schema;
- video title, channel name when available, and video ID;
- caption text with segment start times and durations, either in one request or sequential chunks; and
- the output-language instruction.

For a long video, later requests may send validated intermediate chunk summaries instead of the original transcript chunks. If a provider returns malformed structured output, one repair request may send that provider's invalid output back to the same selected provider. **Test connection** sends only a small synthetic prompt and schema; it does not send video metadata or a transcript.

Transcript text is not sent to any unselected model provider or to an extension developer backend. YouTube receives caption requests needed to obtain its own transcript data.

## BYOK credential risk

Browser extension storage is not a credential vault. Use a dedicated, restricted provider key; set low usage or spending limits where available; monitor usage; and rotate the key immediately if the browser profile or device may have been exposed. Do not reuse a high-privilege production key.

The key is used from a trusted extension context and is not sent to the YouTube page or content script. It is transmitted to the configured provider over HTTPS, except that custom local development endpoints may use `http://localhost` or `http://127.0.0.1`.

## Permission rationale

The production manifest declares these extension and host permissions:

| Permission | Why it exists |
| --- | --- |
| `sidePanel` | Hosts the summary UI and allows the toolbar action to open the native browser side panel. |
| `storage` | Stores local settings, the BYOK credential, the bounded summary cache, and transient session job identity. |
| `scripting` | Executes a minimal main-world function in the active YouTube tab to read and sanitize player caption-track metadata that is unavailable to the isolated content script. |
| `https://www.youtube.com/*` | Runs the YouTube content script on supported pages, reads the active video context, obtains caption data, handles SPA navigation, and seeks the player when a timestamp is selected. |
| `https://api.openai.com/*` | Loads the authenticated model catalog and sends connection tests and summary requests when OpenAI is selected. |
| `https://openrouter.ai/*` | Loads the authenticated compatible-text model catalog and sends connection tests and summary requests when OpenRouter is selected. |

The manifest also declares `https://*/*`, `http://localhost/*`, and `http://127.0.0.1/*` as **optional** host permissions. Declaring the `https://*/*` option is necessary because a user may choose any HTTPS custom-provider host and Chrome requires possible optional origins to be declared in advance.

The extension does not request blanket all-site access at runtime. After validating a custom base URL, runtime code constructs one scheme-and-host match pattern with `customOriginPattern` and asks only for that single origin. HTTPS is required except for the two loopback development hosts. Wildcard hostnames, embedded credentials, query strings, and fragments are rejected. A denied custom-origin request prevents that provider configuration from being saved.

## Clear stored data

Open the extension's **Settings** page:

- **Clear saved key** confirms the action, then removes the entire provider configuration, including provider kind, API key, model ID, and custom base URL. It preserves summary preferences and cached summaries. **Cancel replacement** discards only an unsaved replacement draft and keeps the saved provider.
- **Reset stored settings** removes the provider and restores caption selection, output language, context limit, and cache preference to defaults. It does not clear cached summaries.
- **Clear summaries** replaces the local cache with an empty cache. Turning **Cache summaries** off prevents cache reads and writes but does not erase entries already stored.

Clearing a custom provider does not revoke a host permission already granted to that origin. Revoke it from the browser's extension site-access controls if desired. Removing the extension from the browser removes its extension storage and granted permissions from that browser profile.
