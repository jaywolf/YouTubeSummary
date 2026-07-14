import {
  DEFAULT_SETTINGS,
  parseSettings,
  type ExtensionSettings
} from "../domain/settings";

export const SETTINGS_STORAGE_KEY = "settings.v1";
export const SUMMARY_CACHE_STORAGE_KEY = "summaryCache.v1";
export const ACTIVE_JOBS_STORAGE_KEY = "activeJobs.v1";

export type StorageAreaAdapter = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type SettingsRepository = {
  load(): Promise<ExtensionSettings>;
  save(settings: ExtensionSettings): Promise<void>;
  clearCredentials(): Promise<ExtensionSettings>;
  reset(): Promise<ExtensionSettings>;
};

export async function loadSettings(
  storage: StorageAreaAdapter = browser.storage.local
): Promise<ExtensionSettings> {
  const stored = await storage.get(SETTINGS_STORAGE_KEY);
  if (!(SETTINGS_STORAGE_KEY in stored)) return { ...DEFAULT_SETTINGS };
  return parseSettings(stored[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(
  settings: ExtensionSettings,
  storage: StorageAreaAdapter = browser.storage.local
): Promise<void> {
  await storage.set({ [SETTINGS_STORAGE_KEY]: parseSettings(settings) });
}

export async function clearCredentials(
  storage: StorageAreaAdapter = browser.storage.local
): Promise<ExtensionSettings> {
  const settings = await loadSettings(storage);
  const cleared = { ...settings, provider: null };
  await saveSettings(cleared, storage);
  return cleared;
}

export async function resetSettings(
  storage: StorageAreaAdapter = browser.storage.local
): Promise<ExtensionSettings> {
  const reset = { ...DEFAULT_SETTINGS };
  await saveSettings(reset, storage);
  return reset;
}

export const browserSettingsRepository: SettingsRepository = {
  load: () => loadSettings(),
  save: (settings) => saveSettings(settings),
  clearCredentials: () => clearCredentials(),
  reset: () => resetSettings()
};
