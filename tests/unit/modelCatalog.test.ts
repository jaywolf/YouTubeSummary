import { describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../../src/providers/modelCatalog";

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

    await expect(loadModelCatalog("openai", "openai-synthetic-secret", fetcher))
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

    await expect(loadModelCatalog(
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

    await expect(loadModelCatalog("openai", "synthetic-secret", fetcher)).resolves.toEqual([]);
  });

  it("maps provider and payload failures to one safe error without leaking secrets", async () => {
    const secret = "catalog-synthetic-secret";
    const rawProviderBody = "RAW PROVIDER BODY catalog-synthetic-secret";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejected = vi.fn(async () => new Response(rawProviderBody, { status: 401 }));
    const malformed = vi.fn(async () => jsonResponse({ data: "not-an-array", secret }));

    for (const fetcher of [rejected, malformed]) {
      let thrown: unknown;
      try {
        await loadModelCatalog("openai", secret, fetcher);
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
  });

  it("preserves cancellation semantics without forwarding a fetcher error body", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => {
      throw new Error("RAW aborted catalog-synthetic-secret");
    });

    let thrown: unknown;
    try {
      await loadModelCatalog(
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
});
