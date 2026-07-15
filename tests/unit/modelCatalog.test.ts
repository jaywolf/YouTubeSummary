import { describe, expect, it, vi } from "vitest";
import {
  loadModelCatalog,
  loadModelCatalogWithFetcher,
  type ModelCatalogLoader
} from "../../src/providers/modelCatalog";

const typedLoader: ModelCatalogLoader = loadModelCatalog;
void typedLoader;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("model catalog", () => {
  it("loads, authenticates, sanitizes, and deduplicates OpenAI models", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      data: [
        { id: "  acme-alpha_2  " },
        { id: "acme-alpha_2" },
        { id: "next.model" },
        { id: "bad model" },
        { id: "bad\u0000id" },
        { id: 42 }
      ]
    }));

    await expect(loadModelCatalogWithFetcher("openai", "openai-synthetic-secret", fetcher))
      .resolves.toEqual([
        { id: "acme-alpha_2", label: "Acme Alpha 2" },
        { id: "next.model", label: "Next Model" }
      ]);
    expect(fetcher).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer openai-synthetic-secret"
      }
    });
  });

  it("uses OpenRouter names and its compatible-text catalog endpoint", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => jsonResponse({
      data: [
        { id: "vendor/alpha", name: "  Alpha\nReasoner  " },
        { id: "vendor/beta", name: "\u0000" },
        { id: "vendor/alpha", name: "Duplicate" }
      ]
    }));

    await expect(loadModelCatalogWithFetcher(
      "openrouter",
      "openrouter-synthetic-secret",
      fetcher,
      controller.signal
    )).resolves.toEqual([
      { id: "vendor/alpha", label: "Alpha Reasoner" },
      { id: "vendor/beta", label: "Vendor Beta" }
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=response_format&sort=most-popular",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer openrouter-synthetic-secret"
        },
        signal: controller.signal
      }
    );
  });

  it("returns an empty catalog for a valid empty provider response", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [] }));

    await expect(loadModelCatalogWithFetcher("openai", "synthetic-secret", fetcher)).resolves.toEqual([]);
  });

  it("rejects an empty key before making a provider request", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [] }));

    await expect(loadModelCatalogWithFetcher("openai", "  \n\t ", fetcher)).rejects.toThrow(
      "Models could not be loaded. Check the API key and try again."
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces catalog and display bounds", async () => {
    const data = Array.from({ length: 5_001 }, (_, index) => ({
      id: index === 0 ? "x".repeat(257) : `vendor/model-${index}`,
      name: index === 1 ? "L".repeat(200) : `Model ${index}`
    }));
    const fetcher = vi.fn(async () => jsonResponse({ data }));

    const models = await loadModelCatalogWithFetcher("openrouter", "synthetic-secret", fetcher);
    expect(models).toHaveLength(4_999);
    expect(models[0]).toEqual({
      id: "vendor/model-1",
      label: "L".repeat(160)
    });
    expect(models.some((model) => model.id === "vendor/model-5000")).toBe(false);
  });

  it("keeps generated fallback labels nonempty and within display bounds", async () => {
    const longId = "x".repeat(256);
    const fetcher = vi.fn(async () => jsonResponse({
      data: [{ id: "---" }, { id: longId }]
    }));

    await expect(loadModelCatalogWithFetcher("openai", "synthetic-secret", fetcher))
      .resolves.toEqual([
        { id: "---", label: "---" },
        { id: longId, label: `X${"x".repeat(159)}` }
      ]);
  });

  it("maps provider and payload failures to one safe error without leaking secrets", async () => {
    const secret = "catalog-synthetic-secret";
    const rawProviderBody = "RAW PROVIDER BODY catalog-synthetic-secret";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejected = vi.fn(async () => new Response(rawProviderBody, { status: 401 }));
    const malformed = vi.fn(async () => jsonResponse({ data: "not-an-array", secret }));
    const invalidJson = vi.fn(async () => new Response("not-json " + secret, { status: 200 }));
    const networkFailure = vi.fn(async () => {
      throw new Error("RAW network failure " + secret);
    });

    for (const fetcher of [rejected, malformed, invalidJson, networkFailure]) {
      let thrown: unknown;
      try {
        await loadModelCatalogWithFetcher("openai", secret, fetcher);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        "Models could not be loaded. Check the API key and try again."
      );
      expect(String(thrown)).not.toContain(secret);
      expect(String(thrown)).not.toContain(rawProviderBody);
    }
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("preserves cancellation semantics without forwarding a fetcher error body", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => {
      throw new Error("RAW aborted catalog-synthetic-secret");
    });

    let thrown: unknown;
    try {
      await loadModelCatalogWithFetcher(
        "openrouter",
        "catalog-synthetic-secret",
        fetcher,
        controller.signal
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
    expect(String(thrown)).not.toContain("catalog-synthetic-secret");
    expect(String(thrown)).not.toContain("RAW");
  });

  it("normalizes a fetch AbortError without forwarding its details", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      throw new DOMException("RAW abort detail", "AbortError");
    });

    let thrown: unknown;
    try {
      await loadModelCatalogWithFetcher(
        "openai",
        "catalog-synthetic-secret",
        fetcher,
        controller.signal
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
    expect(String(thrown)).not.toContain("RAW");
    expect(String(thrown)).not.toContain("catalog-synthetic-secret");
  });
});
