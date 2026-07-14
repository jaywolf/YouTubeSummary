import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../entrypoints/options/App";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  type ExtensionSettings
} from "../../src/domain/settings";
import type { PermissionsAdapter } from "../../src/platform/permissions";
import type { SettingsRepository } from "../../src/platform/storage";
import type {
  ModelCatalogEntry,
  ModelCatalogLoader
} from "../../src/providers/modelCatalog";

vi.mock("../../src/providers/modelCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/providers/modelCatalog")>();
  return {
    ...actual,
    loadModelCatalog: vi.fn(async () => [
      { id: "test-model", label: "Test Model" },
      { id: "saved-model", label: "Saved Model" },
      { id: "changed-model", label: "Changed Model" },
      { id: "dirty-model", label: "Dirty Model" }
    ])
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function memoryRepository(initial: ExtensionSettings = DEFAULT_SETTINGS): SettingsRepository & {
  clear: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  saved: ExtensionSettings[];
} {
  let settings = initial;
  const saved: ExtensionSettings[] = [];
  const clear = vi.fn(async () => {
    settings = { ...settings, provider: null };
    return settings;
  });
  const reset = vi.fn(async () => {
    settings = { ...DEFAULT_SETTINGS };
    return settings;
  });
  return {
    clear,
    saved,
    async load() {
      return settings;
    },
    async save(next) {
      settings = next;
      saved.push(next);
    },
    clearCredentials: clear,
    reset
  };
}

function invalidRepository() {
  const save = vi.fn(async () => undefined);
  const reset = vi.fn(async () => ({ ...DEFAULT_SETTINGS }));
  return {
    load: vi.fn(async (): Promise<ExtensionSettings> => {
      throw new Error("synthetic malformed settings");
    }),
    save,
    clearCredentials: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    reset
  };
}

function permissions(granted = true): PermissionsAdapter & {
  contains: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
} {
  return {
    contains: vi.fn(async () => false),
    request: vi.fn(async () => granted)
  };
}

function catalogLoader(
  result: ModelCatalogEntry[] | Promise<ModelCatalogEntry[]>
): ReturnType<typeof vi.fn<ModelCatalogLoader>> {
  return vi.fn<ModelCatalogLoader>(async () => await result);
}

async function chooseCustomProvider() {
  await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "custom");
}

async function fillCustomCredential(baseUrl: string) {
  await userEvent.type(screen.getByLabelText("Base URL"), baseUrl);
  await userEvent.type(screen.getByLabelText("Model name or ID"), "test-model");
  await userEvent.type(screen.getByLabelText("API key"), "synthetic-key");
  await userEvent.click(screen.getByLabelText(/This local BYOK extension stores the key/));
}

describe("options settings", () => {
  it("defaults Summary detail to Standard and saves a concise preference", async () => {
    const repository = memoryRepository();
    render(<App settingsRepository={repository} permissions={permissions()} />);

    const detail = await screen.findByRole("combobox", { name: "Summary detail" });
    expect((detail as HTMLSelectElement).value).toBe("standard");
    expect(screen.getByRole("option", { name: "Concise" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Standard (default)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Detailed" })).toBeTruthy();
    expect(screen.getByText(/Balanced coverage and context for most videos/)).toBeTruthy();
    expect(detail.getAttribute("aria-describedby")).toBe("summary-detail-help");

    await userEvent.selectOptions(detail, "concise");
    expect(screen.getByText(/A short overview, the most important takeaways/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(repository.saved.at(-1)?.summaryDetail).toBe("concise");
  });

  it("loads Detailed and does not make provider connection settings dirty", async () => {
    const repository = memoryRepository(parseSettings({
      provider: { kind: "openai", apiKey: "stored-synthetic-key", model: "saved-model" },
      summaryDetail: "detailed"
    }));
    render(<App settingsRepository={repository} permissions={permissions()} />);

    const detail = await screen.findByRole("combobox", { name: "Summary detail" });
    expect((detail as HTMLSelectElement).value).toBe("detailed");
    expect(screen.getByText(/More granular coverage with important context/)).toBeTruthy();
    const testConnection = screen.getByRole("button", { name: "Test connection" });
    expect((testConnection as HTMLButtonElement).disabled).toBe(false);

    await userEvent.selectOptions(detail, "concise");
    expect((testConnection as HTMLButtonElement).disabled).toBe(false);
  });

  it("loads built-in models with a new key only after BYOK disclosure", async () => {
    const repository = memoryRepository();
    const loader = catalogLoader([
      { id: "provider/alpha", label: "Alpha Reasoner" },
      { id: "provider/beta", label: "Beta Fast" }
    ]);
    render(
      <App
        settingsRepository={repository}
        permissions={permissions()}
        modelCatalogLoader={loader}
      />
    );

    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Provider" }),
      "openai"
    );
    expect(screen.queryByLabelText("Model ID")).toBeNull();
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe("");
    await userEvent.type(screen.getByLabelText("API key"), "new-catalog-synthetic-key");
    expect(loader).not.toHaveBeenCalled();

    await userEvent.click(screen.getByLabelText(/This local BYOK extension stores the key/));
    await vi.waitFor(() => expect(loader).toHaveBeenCalledWith(
      "openai",
      "new-catalog-synthetic-key",
      expect.any(AbortSignal)
    ));
    expect(await screen.findByRole("option", { name: "Alpha Reasoner" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Beta Fast" })).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "provider/beta");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(repository.saved.at(-1)?.provider).toEqual({
      kind: "openai",
      apiKey: "new-catalog-synthetic-key",
      model: "provider/beta"
    });
    expect(document.body.textContent).not.toContain("new-catalog-synthetic-key");
  });

  it("loads and refreshes a saved provider catalog without rendering its key", async () => {
    const repository = memoryRepository(parseSettings({
      provider: {
        kind: "openrouter",
        apiKey: "saved-catalog-synthetic-key",
        model: "vendor/current"
      }
    }));
    const loader = catalogLoader([
      { id: "vendor/current", label: "Current Model" },
      { id: "vendor/other", label: "Other Model" }
    ]);
    render(
      <App
        settingsRepository={repository}
        permissions={permissions()}
        modelCatalogLoader={loader}
      />
    );

    const chooser = await screen.findByRole("combobox", { name: "Model" }) as HTMLSelectElement;
    await vi.waitFor(() => expect(loader).toHaveBeenCalledWith(
      "openrouter",
      "saved-catalog-synthetic-key",
      expect.any(AbortSignal)
    ));
    expect(await screen.findByRole("option", { name: "Current Model" })).toBeTruthy();
    expect(chooser.value).toBe("vendor/current");
    expect(document.body.textContent).not.toContain("saved-catalog-synthetic-key");

    await userEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  it("shows safe loading, empty, and catalog error states", async () => {
    let resolveEmpty!: (models: ModelCatalogEntry[]) => void;
    const pending = new Promise<ModelCatalogEntry[]>((resolve) => { resolveEmpty = resolve; });
    const emptyLoader = catalogLoader(pending);
    const first = render(
      <App
        settingsRepository={memoryRepository()}
        permissions={permissions()}
        modelCatalogLoader={emptyLoader}
      />
    );
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "openai");
    await userEvent.type(screen.getByLabelText("API key"), "empty-synthetic-key");
    await userEvent.click(screen.getByLabelText(/This local BYOK extension stores the key/));
    expect(await screen.findByText("Loading models…")).toBeTruthy();
    resolveEmpty([]);
    expect(await screen.findByText("No compatible text models were returned.")).toBeTruthy();
    first.unmount();

    const errorLoader = vi.fn<ModelCatalogLoader>(async () => {
      throw new Error("RAW catalog-error-synthetic-key");
    });
    render(
      <App
        settingsRepository={memoryRepository()}
        permissions={permissions()}
        modelCatalogLoader={errorLoader}
      />
    );
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "openrouter");
    await userEvent.type(screen.getByLabelText("API key"), "catalog-error-synthetic-key");
    await userEvent.click(screen.getByLabelText(/This local BYOK extension stores the key/));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Models could not be loaded. Check the API key and try again."
    );
    expect(document.body.textContent).not.toContain("catalog-error-synthetic-key");
    expect(document.body.textContent).not.toContain("RAW");
  });

  it("offers an explicit manual model fallback for built-in providers", async () => {
    const loader = catalogLoader([]);
    render(
      <App
        settingsRepository={memoryRepository()}
        permissions={permissions()}
        modelCatalogLoader={loader}
      />
    );
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "openai");

    expect(screen.queryByLabelText("Custom model ID")).toBeNull();
    await userEvent.click(screen.getByLabelText("Use a model not shown"));
    expect(screen.getByLabelText("Custom model ID")).toBeInstanceOf(HTMLInputElement);
  });

  it("confirms Clear summaries through the background without changing settings or credentials", async () => {
    const initial = parseSettings({
      provider: { kind: "openai", apiKey: "stored-synthetic-key", model: "test-model" }
    });
    const repository = memoryRepository(initial);
    const clearSummaries = vi.fn(async () => undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <App
        settingsRepository={repository}
        permissions={permissions()}
        clearSummaries={clearSummaries}
      />
    );

    await userEvent.click(await screen.findByRole("button", { name: "Clear summaries" }));

    expect(confirm).toHaveBeenCalledWith("Clear all cached summaries from this device?");
    expect(clearSummaries).toHaveBeenCalledOnce();
    expect(repository.saved).toHaveLength(0);
    expect(repository.clear).not.toHaveBeenCalled();
    expect(repository.reset).not.toHaveBeenCalled();
    expect(await screen.findByText("Cached summaries cleared.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("stored-synthetic-key");
  });

  it("reveals custom provider fields without pre-filling a key", async () => {
    render(<App settingsRepository={memoryRepository()} permissions={permissions()} />);

    await chooseCustomProvider();

    expect(screen.getByLabelText("Base URL")).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText("Model name or ID")).toBeInstanceOf(HTMLInputElement);
    const key = screen.getByLabelText("API key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
  });

  it("shows an inline error and disables save for non-local HTTP", async () => {
    render(<App settingsRepository={memoryRepository()} permissions={permissions()} />);
    await chooseCustomProvider();
    await fillCustomCredential("http://llm.example/v1");

    expect(screen.getByRole("alert").textContent).toContain("HTTPS");
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("requests the exact custom origin and masks the saved key", async () => {
    const repository = memoryRepository();
    const permissionAdapter = permissions();
    render(<App settingsRepository={repository} permissions={permissionAdapter} />);
    await chooseCustomProvider();
    await fillCustomCredential("https://llm.example:8443/v1/");

    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Key saved")).toBeTruthy();
    expect(permissionAdapter.request).toHaveBeenCalledWith({
      origins: ["https://llm.example/*"]
    });
    expect(repository.saved.at(-1)?.provider).toEqual({
      kind: "custom",
      apiKey: "synthetic-key",
      model: "test-model",
      baseUrl: "https://llm.example:8443/v1"
    });
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("button", { name: /reveal/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear saved provider" })).toBeTruthy();
  });

  it("offers replacement cancel and confirmed saved-key clearing without exposing the key", async () => {
    const repository = memoryRepository(parseSettings({
      provider: { kind: "openai", apiKey: "stored-synthetic-key", model: "test-model" }
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App settingsRepository={repository} permissions={permissions()} />);

    expect(await screen.findByText("Key saved")).toBeTruthy();
    expect(document.body.textContent).not.toContain("stored-synthetic-key");
    expect(screen.queryByLabelText("API key")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    await userEvent.type(screen.getByLabelText("API key"), "draft-synthetic-key");
    await userEvent.click(screen.getByRole("button", { name: "Cancel replacement" }));
    expect(await screen.findByText("Key saved")).toBeTruthy();
    expect(repository.clear).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("draft-synthetic-key");

    await userEvent.click(screen.getByRole("button", { name: "Replace key" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear saved provider" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(repository.clear).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(
      (screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement).value
    ).toBe("none"));
  });

  it("blocks ordinary save after malformed storage and requires confirmed reset", async () => {
    const repository = invalidRepository();
    const confirm = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    render(<App settingsRepository={repository} permissions={permissions()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Stored settings");
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(repository.save).not.toHaveBeenCalled();

    const reset = screen.getByRole("button", { name: "Reset stored settings" });
    await userEvent.click(reset);
    expect(repository.reset).not.toHaveBeenCalled();
    await userEvent.click(reset);

    expect(repository.reset).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Save settings" })).toBeTruthy();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("cannot remove a saved provider through ordinary Save", async () => {
    const repository = memoryRepository(parseSettings({
      provider: { kind: "openai", apiKey: "stored-synthetic-key", model: "test-model" }
    }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App settingsRepository={repository} permissions={permissions()} />);

    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Provider" }),
      "none"
    );

    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(repository.saved).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Clear saved provider" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(repository.clear).toHaveBeenCalledOnce();
    expect(repository.saved).toHaveLength(0);
  });

  it("tests a saved provider connection and reports Testing then Connected", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(async () => await new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const repository = memoryRepository(parseSettings({
      provider: { kind: "openai", apiKey: "stored-synthetic-key", model: "test-model" }
    }));
    render(<App settingsRepository={repository} permissions={permissions()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(screen.getByRole("button", { name: "Testing…" })).toBeTruthy();
    resolveFetch(new Response(JSON.stringify({ output_text: "{\"ok\":true}" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();

    await screen.findByRole("option", { name: "Changed Model" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "changed-model");
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText("Save provider changes before testing this connection.")).toBeTruthy();
  });

  it("shows only a mapped safe connection error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("stored-synthetic-key", { status: 401 })));
    const repository = memoryRepository(parseSettings({
      provider: { kind: "openai", apiKey: "stored-synthetic-key", model: "test-model" }
    }));
    render(<App settingsRepository={repository} permissions={permissions()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));

    expect((await screen.findByRole("alert")).textContent).toContain("rejected the saved API key");
    expect(document.body.textContent).not.toContain("stored-synthetic-key");
  });

  it("requires saving a changed model before testing the connection", async () => {
    const repository = memoryRepository(parseSettings({
      provider: { kind: "openai", apiKey: "stored-synthetic-key", model: "saved-model" }
    }));
    render(<App settingsRepository={repository} permissions={permissions()} />);

    const testButton = await screen.findByRole("button", { name: "Test connection" });
    expect((testButton as HTMLButtonElement).disabled).toBe(false);
    await screen.findByRole("option", { name: "Dirty Model" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "dirty-model");

    expect((testButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Save provider changes before testing this connection.")).toBeTruthy();
  });

  it("requires saving a changed custom base URL before testing the connection", async () => {
    const repository = memoryRepository(parseSettings({
      provider: {
        kind: "custom",
        apiKey: "stored-synthetic-key",
        model: "saved-model",
        baseUrl: "https://saved.example/v1"
      }
    }));
    render(<App settingsRepository={repository} permissions={permissions()} />);

    const testButton = await screen.findByRole("button", { name: "Test connection" });
    expect((testButton as HTMLButtonElement).disabled).toBe(false);
    await userEvent.clear(screen.getByLabelText("Base URL"));
    await userEvent.type(screen.getByLabelText("Base URL"), "https://dirty.example/v1");

    expect((testButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Save provider changes before testing this connection.")).toBeTruthy();
  });

  it("requires a new key and renewed disclosure when a saved custom origin changes", async () => {
    const repository = memoryRepository(parseSettings({
      provider: {
        kind: "custom",
        apiKey: "old-origin-synthetic-key",
        model: "saved-model",
        baseUrl: "https://saved.example/v1"
      }
    }));
    const permissionAdapter = permissions();
    render(<App settingsRepository={repository} permissions={permissionAdapter} />);

    expect(await screen.findByText("Key saved")).toBeTruthy();
    await userEvent.clear(screen.getByLabelText("Base URL"));
    await userEvent.type(screen.getByLabelText("Base URL"), "https://new.example/v1");

    expect(screen.queryByText("Key saved")).toBeNull();
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;
    const disclosure = screen.getByLabelText(/This local BYOK extension stores the key/) as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(disclosure.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled)
      .toBe(true);

    await userEvent.type(keyInput, "new-origin-synthetic-key");
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled)
      .toBe(true);
    await userEvent.click(disclosure);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(permissionAdapter.request).toHaveBeenCalledWith({ origins: ["https://new.example/*"] });
    expect(repository.saved.at(-1)?.provider).toEqual({
      kind: "custom",
      apiKey: "new-origin-synthetic-key",
      model: "saved-model",
      baseUrl: "https://new.example/v1"
    });
    expect(repository.saved.at(-1)?.provider).not.toEqual(expect.objectContaining({
      apiKey: "old-origin-synthetic-key"
    }));
    expect(document.body.textContent).not.toContain("old-origin-synthetic-key");
  });

  it.each(["Replace key", "Clear saved provider"])(
    "aborts a pending connection test before %s mutates credentials",
    async (action) => {
      let requestSignal: AbortSignal | null = null;
      const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal as AbortSignal;
          requestSignal.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        }));
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const repository = memoryRepository(parseSettings({
        provider: { kind: "openai", apiKey: "stored-synthetic-key", model: "saved-model" }
      }));
      render(<App settingsRepository={repository} permissions={permissions()} />);

      await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
      expect(screen.getByRole("button", { name: "Testing…" })).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: action }));

      await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
      expect(screen.queryByText("Connected")).toBeNull();
      expect(screen.queryByRole("button", { name: "Testing…" })).toBeNull();
    }
  );
});
