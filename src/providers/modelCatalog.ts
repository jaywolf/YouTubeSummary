export type CatalogProvider = "openai" | "openrouter";

export type ModelCatalogEntry = {
  id: string;
  label: string;
};

export type ModelCatalogLoader = (
  provider: CatalogProvider,
  apiKey: string,
  signal?: AbortSignal
) => Promise<ModelCatalogEntry[]>;

type Fetcher = typeof fetch;

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=response_format&sort=most-popular";
const SAFE_CATALOG_ERROR = "Models could not be loaded. Check the API key and try again.";
const MAX_MODELS = 5_000;

function sanitizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[^\s\u0000-\u001f\u007f-\u009f]{1,256}$/u.test(id) ? id : null;
}

function sanitizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return label.length > 0 ? label.slice(0, 160) : null;
}

function humanizeModelId(id: string): string {
  return id.split(/[-_/.]+/u).filter(Boolean).map((part) => {
    if (/^[a-z]{1,3}\d*$/iu.test(part)) return part.toUpperCase();
    return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
  }).join(" ");
}

function parseCatalog(provider: CatalogProvider, payload: unknown): ModelCatalogEntry[] {
  if (!payload || typeof payload !== "object") throw new Error(SAFE_CATALOG_ERROR);
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error(SAFE_CATALOG_ERROR);

  const seen = new Set<string>();
  const models: ModelCatalogEntry[] = [];
  for (const item of data.slice(0, MAX_MODELS)) {
    if (!item || typeof item !== "object") continue;
    const id = sanitizeId((item as { id?: unknown }).id);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const providerName = provider === "openrouter"
      ? sanitizeLabel((item as { name?: unknown }).name)
      : null;
    const fallbackLabel = sanitizeLabel(humanizeModelId(id)) ?? sanitizeLabel(id);
    if (fallbackLabel === null) continue;
    models.push({ id, label: providerName ?? fallbackLabel });
  }
  return models;
}

export const loadModelCatalog: ModelCatalogLoader = (
  provider,
  apiKey,
  signal
) => loadModelCatalogWithFetcher(provider, apiKey, fetch, signal);

export async function loadModelCatalogWithFetcher(
  provider: CatalogProvider,
  apiKey: string,
  fetcher: Fetcher,
  signal?: AbortSignal
): Promise<ModelCatalogEntry[]> {
  const key = apiKey.trim();
  if (!key) throw new Error(SAFE_CATALOG_ERROR);
  const url = provider === "openai" ? OPENAI_MODELS_URL : OPENROUTER_MODELS_URL;

  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`
      },
      ...(signal ? { signal } : {})
    });
    if (!response.ok) throw new Error(SAFE_CATALOG_ERROR);
    return parseCatalog(provider, await response.json());
  } catch (error) {
    if (signal?.aborted === true
        || (error instanceof DOMException && error.name === "AbortError")) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    throw new Error(SAFE_CATALOG_ERROR);
  }
}
