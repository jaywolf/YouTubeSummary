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

async function chooseCustomProvider() {
  await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Provider" }), "custom");
}

async function fillCustomCredential(baseUrl: string) {
  await userEvent.type(screen.getByLabelText("Base URL"), baseUrl);
  await userEvent.type(screen.getByLabelText("Model ID"), "test-model");
  await userEvent.type(screen.getByLabelText("API key"), "synthetic-key");
  await userEvent.click(screen.getByLabelText(/This local BYOK extension stores the key/));
}

describe("options settings", () => {
  it("reveals custom provider fields without pre-filling a key", async () => {
    render(<App settingsRepository={memoryRepository()} permissions={permissions()} />);

    await chooseCustomProvider();

    expect(screen.getByLabelText("Base URL")).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText("Model ID")).toBeInstanceOf(HTMLInputElement);
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
    expect(screen.getByRole("button", { name: "Clear key" })).toBeTruthy();
  });

  it("offers replace and confirmed clear without ever displaying a stored key", async () => {
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
    await userEvent.click(screen.getByRole("button", { name: "Clear key" }));

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
});
