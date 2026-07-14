import { useEffect, useState, type FormEvent } from "react";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  validateCustomBaseUrl,
  type ExtensionSettings,
  type ProviderConfig
} from "../../src/domain/settings";
import {
  ensureCustomOriginPermission,
  type PermissionsAdapter
} from "../../src/platform/permissions";
import {
  browserSettingsRepository,
  type SettingsRepository
} from "../../src/platform/storage";

const DISCLOSURE = "This local BYOK extension stores the key on this device. Browser storage is not a secure vault. Use a dedicated restricted key and set provider spending limits.";

const browserPermissionsAdapter: PermissionsAdapter = {
  contains: (details) => browser.permissions.contains(details),
  request: (details) => browser.permissions.request(details)
};

type ProviderKind = ProviderConfig["kind"] | "none";

type SettingsForm = {
  providerKind: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey: string;
  captionLanguage: string;
  outputLanguage: string;
  contextWindowTokens: string;
  cacheEnabled: boolean;
  disclosureAccepted: boolean;
  replacingKey: boolean;
};

type AppProps = {
  settingsRepository?: SettingsRepository;
  permissions?: PermissionsAdapter;
};

function formFromSettings(settings: ExtensionSettings): SettingsForm {
  const provider = settings.provider;
  return {
    providerKind: provider?.kind ?? "none",
    model: provider?.model ?? "",
    baseUrl: provider?.kind === "custom" ? provider.baseUrl : "",
    apiKey: "",
    captionLanguage: settings.captionLanguage ?? "",
    outputLanguage: settings.outputLanguage,
    contextWindowTokens: String(settings.contextWindowTokens),
    cacheEnabled: settings.cacheEnabled,
    disclosureAccepted: false,
    replacingKey: false
  };
}

function customUrlError(baseUrl: string): string | null {
  if (!baseUrl.trim()) return "Enter a provider base URL.";
  try {
    validateCustomBaseUrl(baseUrl);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Enter a valid provider base URL.";
  }
}

type CredentialControlsProps = {
  needsKey: boolean;
  hasSavedKey: boolean;
  apiKey: string;
  disclosureAccepted: boolean;
  onApiKeyChange(value: string): void;
  onDisclosureChange(accepted: boolean): void;
  onReplace(): void;
  onClear(): void;
};

function CredentialControls({
  needsKey,
  hasSavedKey,
  apiKey,
  disclosureAccepted,
  onApiKeyChange,
  onDisclosureChange,
  onReplace,
  onClear
}: CredentialControlsProps) {
  if (!needsKey) {
    return (
      <div className="credential-status">
        <span aria-label="Credential status">Key saved</span>
        <div className="button-row">
          <button type="button" className="secondary" onClick={onReplace}>Replace key</button>
          <button type="button" className="danger" onClick={onClear}>Clear key</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <label className="field">
        <span>API key</span>
        <input
          type="password"
          aria-label="API key"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
        />
      </label>
      <label className="disclosure">
        <input
          type="checkbox"
          checked={disclosureAccepted}
          onChange={(event) => onDisclosureChange(event.target.checked)}
        />
        <span>{DISCLOSURE}</span>
      </label>
      {hasSavedKey ? (
        <button type="button" className="danger clear-replacement" onClick={onClear}>
          Clear key
        </button>
      ) : null}
    </>
  );
}

export function App({
  settingsRepository = browserSettingsRepository,
  permissions = browserPermissionsAdapter
}: AppProps) {
  const [savedSettings, setSavedSettings] = useState<ExtensionSettings | null>(null);
  const [form, setForm] = useState<SettingsForm>(() => formFromSettings(DEFAULT_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    settingsRepository.load().then((settings) => {
      if (!active) return;
      setSavedSettings(settings);
      setForm(formFromSettings(settings));
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError("Stored settings are invalid. Clear or repair them before continuing.");
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [settingsRepository]);

  const savedProvider = savedSettings?.provider ?? null;
  const hasSavedKey = form.providerKind !== "none"
    && savedProvider?.kind === form.providerKind;
  const needsKey = form.providerKind !== "none" && (!hasSavedKey || form.replacingKey);
  const baseUrlError = form.providerKind === "custom" ? customUrlError(form.baseUrl) : null;
  const contextTokens = Number(form.contextWindowTokens);
  const contextIsValid = Number.isInteger(contextTokens)
    && contextTokens >= 8_192
    && contextTokens <= 1_000_000;
  const providerIsValid = form.providerKind === "none" || (
    form.model.trim().length > 0
    && (form.providerKind !== "custom" || baseUrlError === null)
    && (!needsKey || (form.apiKey.trim().length > 0 && form.disclosureAccepted))
  );
  const canSave = !loading
    && !saving
    && providerIsValid
    && contextIsValid
    && form.outputLanguage.trim().length > 0;

  function selectProvider(providerKind: ProviderKind) {
    setError(null);
    setStatus(null);
    setForm((current) => ({
      ...current,
      providerKind,
      model: savedProvider?.kind === providerKind ? savedProvider.model : "",
      baseUrl: savedProvider?.kind === "custom" && providerKind === "custom"
        ? savedProvider.baseUrl
        : "",
      apiKey: "",
      disclosureAccepted: false,
      replacingKey: false
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setStatus(null);

    try {
      let provider: ProviderConfig | null = null;
      if (form.providerKind !== "none") {
        const apiKey = needsKey ? form.apiKey : savedProvider?.apiKey;
        if (!apiKey) throw new Error("Enter an API key.");
        provider = form.providerKind === "custom"
          ? {
              kind: "custom",
              apiKey,
              model: form.model,
              baseUrl: form.baseUrl
            }
          : { kind: form.providerKind, apiKey, model: form.model };
      }

      const next = parseSettings({
        provider,
        captionLanguage: form.captionLanguage.trim() || null,
        outputLanguage: form.outputLanguage,
        contextWindowTokens: contextTokens,
        cacheEnabled: form.cacheEnabled
      });

      if (next.provider?.kind === "custom") {
        const granted = await ensureCustomOriginPermission(next.provider.baseUrl, permissions);
        if (!granted) {
          setError("Permission for this custom provider origin was denied.");
          return;
        }
      }

      await settingsRepository.save(next);
      setSavedSettings(next);
      setForm(formFromSettings(next));
      setStatus("Settings saved on this device.");
    } catch {
      setError("Settings could not be saved. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearCredentials() {
    if (!window.confirm("Clear the saved provider key from this device?")) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const cleared = await settingsRepository.clearCredentials();
      setSavedSettings(cleared);
      setForm(formFromSettings(cleared));
      setStatus("Provider credentials cleared.");
    } catch {
      setError("Provider credentials could not be cleared.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="settings-shell">
      <header>
        <p className="eyebrow">YouTube Detailed Summary</p>
        <h1>Summary settings</h1>
        <p className="intro">Connect your own provider and choose how summaries are generated.</p>
      </header>

      {loading ? <p>Loading settings…</p> : (
        <form onSubmit={handleSubmit}>
          <section className="settings-card" aria-labelledby="provider-heading">
            <div className="section-heading">
              <div>
                <h2 id="provider-heading">Provider</h2>
                <p>Credentials stay in this browser's local extension storage.</p>
              </div>
              <span className="local-badge">Local BYOK</span>
            </div>

            <label className="field">
              <span>Provider</span>
              <select
                value={form.providerKind}
                onChange={(event) => selectProvider(event.target.value as ProviderKind)}
              >
                <option value="none">Not configured</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom OpenAI-compatible</option>
              </select>
            </label>

            {form.providerKind !== "none" ? (
              <div className="provider-fields">
                {form.providerKind === "custom" ? (
                  <label className="field">
                    <span>Base URL</span>
                    <input
                      type="url"
                      aria-label="Base URL"
                      placeholder="https://llm.example/v1"
                      value={form.baseUrl}
                      aria-describedby={baseUrlError ? "base-url-error" : undefined}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        baseUrl: event.target.value
                      }))}
                    />
                    {baseUrlError ? <small id="base-url-error" role="alert">{baseUrlError}</small> : null}
                  </label>
                ) : null}

                <label className="field">
                  <span>Model ID</span>
                  <input
                    type="text"
                    aria-label="Model ID"
                    value={form.model}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      model: event.target.value
                    }))}
                  />
                </label>

                <CredentialControls
                  needsKey={needsKey}
                  hasSavedKey={hasSavedKey}
                  apiKey={form.apiKey}
                  disclosureAccepted={form.disclosureAccepted}
                  onApiKeyChange={(apiKey) => setForm((current) => ({ ...current, apiKey }))}
                  onDisclosureChange={(disclosureAccepted) => setForm((current) => ({
                    ...current,
                    disclosureAccepted
                  }))}
                  onReplace={() => setForm((current) => ({
                    ...current,
                    apiKey: "",
                    disclosureAccepted: false,
                    replacingKey: true
                  }))}
                  onClear={handleClearCredentials}
                />

                <div className="test-connection">
                  <button type="button" className="secondary" disabled>Test connection</button>
                  <small>Available after provider adapters are installed</small>
                </div>
              </div>
            ) : null}
          </section>

          <section className="settings-card" aria-labelledby="summary-heading">
            <div className="section-heading">
              <div>
                <h2 id="summary-heading">Summary preferences</h2>
                <p>Fine-tune transcript selection, output, and model limits.</p>
              </div>
            </div>

            <div className="field-grid">
              <label className="field">
                <span>Caption preference</span>
                <input
                  type="text"
                  placeholder="Auto"
                  value={form.captionLanguage}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    captionLanguage: event.target.value
                  }))}
                />
              </label>
              <label className="field">
                <span>Output language</span>
                <input
                  type="text"
                  value={form.outputLanguage}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    outputLanguage: event.target.value
                  }))}
                />
              </label>
              <label className="field">
                <span>Context limit</span>
                <input
                  type="number"
                  min="8192"
                  max="1000000"
                  step="1"
                  value={form.contextWindowTokens}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    contextWindowTokens: event.target.value
                  }))}
                />
                {!contextIsValid ? <small role="alert">Use 8,192 to 1,000,000 tokens.</small> : null}
              </label>
            </div>

            <label className="toggle-row">
              <span>
                <strong>Cache summaries</strong>
                <small>Reuse summaries generated with the same settings.</small>
              </span>
              <input
                type="checkbox"
                checked={form.cacheEnabled}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  cacheEnabled: event.target.checked
                }))}
              />
            </label>
          </section>

          {error ? <p className="notice error" role="alert">{error}</p> : null}
          {status ? <p className="notice success" role="status">{status}</p> : null}

          <div className="form-actions">
            <button type="submit" className="primary" disabled={!canSave}>
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
