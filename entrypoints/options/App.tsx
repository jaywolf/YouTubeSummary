import { useEffect, useRef, useState, type FormEvent } from "react";
import { AppError } from "../../src/domain/errors";
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
import { createProvider } from "../../src/providers/factory";
import {
  loadModelCatalog,
  type CatalogProvider,
  type ModelCatalogEntry,
  type ModelCatalogLoader
} from "../../src/providers/modelCatalog";

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
  clearSummaries?: () => Promise<void>;
  modelCatalogLoader?: ModelCatalogLoader;
};

type CatalogState = "idle" | "loading" | "ready" | "error";

const browserModelCatalogLoader: ModelCatalogLoader = (provider, apiKey, signal) =>
  loadModelCatalog(provider, apiKey, fetch, signal);

async function clearBrowserSummaries(): Promise<void> {
  const response: unknown = await browser.runtime.sendMessage({
    type: "options/clear-summaries",
    requestId: crypto.randomUUID()
  });
  if (!response || typeof response !== "object"
      || (response as { cleared?: unknown }).cleared !== true) {
    throw new Error("Cache clear was not acknowledged");
  }
}

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

function credentialDestinationMatches(
  form: SettingsForm,
  savedProvider: ProviderConfig | null
): boolean {
  if (savedProvider === null || form.providerKind !== savedProvider.kind) return false;
  if (savedProvider.kind !== "custom") return true;

  try {
    const formOrigin = new URL(validateCustomBaseUrl(form.baseUrl)).origin;
    const savedOrigin = new URL(savedProvider.baseUrl).origin;
    return formOrigin === savedOrigin;
  } catch {
    return false;
  }
}

function providerFormMatchesSaved(
  form: SettingsForm,
  savedProvider: ProviderConfig | null
): boolean {
  if (savedProvider === null || form.providerKind !== savedProvider.kind) return false;
  if (form.model !== savedProvider.model || form.replacingKey) return false;
  return savedProvider.kind !== "custom" || form.baseUrl === savedProvider.baseUrl;
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
  permissions = browserPermissionsAdapter,
  clearSummaries = clearBrowserSummaries,
  modelCatalogLoader = browserModelCatalogLoader
}: AppProps) {
  const [savedSettings, setSavedSettings] = useState<ExtensionSettings | null>(null);
  const [form, setForm] = useState<SettingsForm>(() => formFromSettings(DEFAULT_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [storageInvalid, setStorageInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [clearingSummaries, setClearingSummaries] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [catalogState, setCatalogState] = useState<CatalogState>("idle");
  const [manualModel, setManualModel] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const connectionAbortRef = useRef<AbortController | null>(null);
  const catalogAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    settingsRepository.load().then((settings) => {
      if (!active) return;
      setSavedSettings(settings);
      setForm(formFromSettings(settings));
      setStorageInvalid(false);
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError("Stored settings are invalid. Clear or repair them before continuing.");
      setStorageInvalid(true);
      setLoading(false);
    });
    return () => {
      active = false;
      connectionAbortRef.current?.abort();
      catalogAbortRef.current?.abort();
    };
  }, [settingsRepository]);

  const savedProvider = savedSettings?.provider ?? null;
  const hasSavedKey = credentialDestinationMatches(form, savedProvider);
  const needsKey = form.providerKind !== "none" && (!hasSavedKey || form.replacingKey);
  const catalogProvider: CatalogProvider | null = form.providerKind === "openai"
    || form.providerKind === "openrouter"
    ? form.providerKind
    : null;
  const catalogCredential = catalogProvider === null
    ? null
    : !needsKey && savedProvider?.kind === catalogProvider
      ? savedProvider.apiKey
      : form.disclosureAccepted && form.apiKey.trim().length > 0
        ? form.apiKey.trim()
        : null;
  const providerRemovalPending = savedProvider !== null && form.providerKind === "none";
  const providerFieldsAreSaved = providerFormMatchesSaved(form, savedProvider);
  const catalogIncludesModel = catalog.some((model) => model.id === form.model);
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
    && !storageInvalid
    && !providerRemovalPending
    && providerIsValid
    && contextIsValid
    && form.outputLanguage.trim().length > 0;

  useEffect(() => {
    catalogAbortRef.current?.abort();
    catalogAbortRef.current = null;

    if (loading || catalogProvider === null || catalogCredential === null) {
      setCatalog([]);
      setCatalogState("idle");
      return;
    }

    const controller = new AbortController();
    catalogAbortRef.current = controller;
    setCatalog([]);
    setCatalogState("loading");
    void modelCatalogLoader(catalogProvider, catalogCredential, controller.signal).then((models) => {
      if (controller.signal.aborted) return;
      setCatalog(models);
      setCatalogState("ready");
    }).catch(() => {
      if (controller.signal.aborted) return;
      setCatalog([]);
      setCatalogState("error");
    }).finally(() => {
      if (catalogAbortRef.current === controller) catalogAbortRef.current = null;
    });

    return () => controller.abort();
  }, [
    catalogCredential,
    catalogProvider,
    catalogRevision,
    loading,
    modelCatalogLoader
  ]);

  function cancelConnectionTest() {
    connectionAbortRef.current?.abort();
    connectionAbortRef.current = null;
    setTestingConnection(false);
    setError(null);
    setStatus(null);
  }

  function selectProvider(providerKind: ProviderKind) {
    cancelConnectionTest();
    setManualModel(false);
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

  function editProviderField(update: Partial<Pick<SettingsForm, "model" | "baseUrl">>) {
    cancelConnectionTest();
    setForm((current) => ({ ...current, ...update }));
  }

  function editCredentialField(
    update: Partial<Pick<SettingsForm, "apiKey" | "disclosureAccepted" | "replacingKey">>
  ) {
    cancelConnectionTest();
    setForm((current) => ({ ...current, ...update }));
  }

  function toggleManualModel(enabled: boolean) {
    cancelConnectionTest();
    setManualModel(enabled);
    if (!enabled && !catalog.some((model) => model.id === form.model)) {
      setForm((current) => ({ ...current, model: "" }));
    }
  }

  function refreshModels() {
    if (catalogProvider === null || catalogCredential === null) return;
    setCatalogRevision((revision) => revision + 1);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    cancelConnectionTest();
    setSaving(true);

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
      setManualModel(false);
      setStatus("Settings saved on this device.");
    } catch {
      setError("Settings could not be saved. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearCredentials() {
    if (!window.confirm("Clear the saved provider key from this device?")) return;
    cancelConnectionTest();
    setSaving(true);
    try {
      const cleared = await settingsRepository.clearCredentials();
      setSavedSettings(cleared);
      setForm(formFromSettings(cleared));
      setManualModel(false);
      setStatus("Provider credentials cleared.");
    } catch {
      setError("Provider credentials could not be cleared.");
    } finally {
      setSaving(false);
    }
  }

  async function handleResetSettings() {
    if (!window.confirm("Reset all stored settings and remove any saved provider key?")) return;
    cancelConnectionTest();
    setSaving(true);
    try {
      const reset = await settingsRepository.reset();
      setSavedSettings(reset);
      setForm(formFromSettings(reset));
      setManualModel(false);
      setStorageInvalid(false);
      setStatus("Stored settings reset.");
    } catch {
      setError("Stored settings could not be reset.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearSummaries() {
    if (!window.confirm("Clear all cached summaries from this device?")) return;
    setClearingSummaries(true);
    setError(null);
    setStatus(null);
    try {
      await clearSummaries();
      setStatus("Cached summaries cleared.");
    } catch {
      setError("Cached summaries could not be cleared.");
    } finally {
      setClearingSummaries(false);
    }
  }

  async function handleTestConnection() {
    if (!providerFieldsAreSaved || savedProvider === null) {
      return;
    }
    cancelConnectionTest();
    const controller = new AbortController();
    connectionAbortRef.current = controller;
    setTestingConnection(true);
    setError(null);
    setStatus(null);
    try {
      await createProvider(savedProvider, fetch).testConnection(controller.signal);
      if (!controller.signal.aborted) setStatus("Connected");
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof AppError
          ? caught.safeMessage
          : "The provider connection could not be tested. Try again.");
      }
    } finally {
      if (connectionAbortRef.current === controller) {
        connectionAbortRef.current = null;
        setTestingConnection(false);
      }
    }
  }

  return (
    <main className="settings-shell">
      <header>
        <p className="eyebrow">YouTube Detailed Summary</p>
        <h1>Summary settings</h1>
        <p className="intro">Connect your own provider and choose how summaries are generated.</p>
      </header>

      {loading ? <p>Loading settings…</p> : storageInvalid ? (
        <section className="settings-card recovery-card" role="alert">
          <h2>Stored settings need attention</h2>
          <p>{error ?? "Stored settings are invalid and cannot be edited safely."}</p>
          <p>Ordinary saving is blocked so existing credential data is not overwritten.</p>
          <button
            type="button"
            className="danger"
            disabled={saving}
            onClick={handleResetSettings}
          >
            {saving ? "Resetting…" : "Reset stored settings"}
          </button>
        </section>
      ) : (
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

            {providerRemovalPending ? (
              <div className="provider-removal" role="note">
                <p>Removing a saved provider requires confirmation and clears its key.</p>
                <button type="button" className="danger" onClick={handleClearCredentials}>
                  Clear saved provider
                </button>
              </div>
            ) : null}

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
                      onChange={(event) => editProviderField({ baseUrl: event.target.value })}
                    />
                    {baseUrlError ? <small id="base-url-error" role="alert">{baseUrlError}</small> : null}
                  </label>
                ) : null}

                {form.providerKind === "custom" ? (
                  <label className="field">
                    <span>Model name or ID</span>
                    <input
                      type="text"
                      aria-label="Model name or ID"
                      value={form.model}
                      onChange={(event) => editProviderField({ model: event.target.value })}
                    />
                  </label>
                ) : (
                  <div className="model-picker">
                    {!manualModel ? (
                      <label className="field">
                        <span>Model</span>
                        <select
                          aria-label="Model"
                          value={form.model}
                          disabled={catalogState === "loading" || catalogCredential === null}
                          onChange={(event) => editProviderField({ model: event.target.value })}
                        >
                          <option value="">Choose a model</option>
                          {form.model && !catalogIncludesModel ? (
                            <option value={form.model}>Current model (not returned)</option>
                          ) : null}
                          {catalog.map((model) => (
                            <option key={model.id} value={model.id}>{model.label}</option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <label className="field">
                        <span>Custom model ID</span>
                        <input
                          type="text"
                          aria-label="Custom model ID"
                          value={form.model}
                          onChange={(event) => editProviderField({ model: event.target.value })}
                        />
                      </label>
                    )}

                    {catalogState === "loading" ? (
                      <small className="model-status" aria-live="polite">Loading models…</small>
                    ) : catalogState === "error" ? (
                      <small className="model-status model-error" role="alert">
                        Models could not be loaded. Check the API key and try again.
                      </small>
                    ) : catalogState === "ready" && catalog.length === 0 ? (
                      <small className="model-status">No compatible text models were returned.</small>
                    ) : catalogCredential === null ? (
                      <small className="model-status">
                        Enter an API key and accept the disclosure to load models.
                      </small>
                    ) : null}

                    <div className="model-actions">
                      <label className="advanced-model-toggle">
                        <input
                          type="checkbox"
                          checked={manualModel}
                          onChange={(event) => toggleManualModel(event.target.checked)}
                        />
                        <span>Use a model not shown</span>
                      </label>
                      <button
                        type="button"
                        className="secondary compact"
                        disabled={catalogState === "loading" || catalogCredential === null}
                        onClick={refreshModels}
                      >
                        Refresh models
                      </button>
                    </div>
                  </div>
                )}

                <CredentialControls
                  needsKey={needsKey}
                  hasSavedKey={hasSavedKey}
                  apiKey={form.apiKey}
                  disclosureAccepted={form.disclosureAccepted}
                  onApiKeyChange={(apiKey) => editCredentialField({
                    apiKey,
                    disclosureAccepted: false
                  })}
                  onDisclosureChange={(disclosureAccepted) => editCredentialField({
                    disclosureAccepted
                  })}
                  onReplace={() => editCredentialField({
                    apiKey: "",
                    disclosureAccepted: false,
                    replacingKey: true
                  })}
                  onClear={handleClearCredentials}
                />

                <div className="test-connection">
                  <button
                    type="button"
                    className="secondary"
                    disabled={testingConnection || !providerFieldsAreSaved}
                    onClick={handleTestConnection}
                  >
                    {testingConnection ? "Testing…" : "Test connection"}
                  </button>
                  <small>{providerFieldsAreSaved
                    ? "Tests the provider and model using the saved key."
                    : "Save provider changes before testing this connection."}</small>
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

            <div className="button-row">
              <button
                type="button"
                className="danger"
                disabled={clearingSummaries}
                onClick={handleClearSummaries}
              >
                {clearingSummaries ? "Clearing…" : "Clear summaries"}
              </button>
            </div>
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
