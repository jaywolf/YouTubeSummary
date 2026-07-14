import { afterEach, describe, expect, it, vi } from "vitest";

type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => true | undefined;

describe("YouTube content-script entrypoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    document.body.replaceChildren();
  });

  it("registers the synchronous sendResponse adapter instead of returning a Promise", async () => {
    let registeredListener: RuntimeListener | undefined;
    vi.stubGlobal("defineContentScript", (config: unknown) => config);
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeListener) => {
            registeredListener = listener;
          })
        },
        sendMessage: vi.fn(async () => undefined)
      }
    });

    const entrypoint = await import("../../entrypoints/youtube.content");
    const definition = entrypoint.default as unknown as { main: () => void };
    definition.main();
    expect(registeredListener).toBeTypeOf("function");

    const sendResponse = vi.fn();
    const returned = registeredListener?.({
      type: "youtube/extract",
      requestId: "extract-1",
      tabId: 7,
      context: {
        videoId: "abcdefghijk",
        canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
        title: "Video",
        channel: null,
        durationSeconds: 10,
        captionTracks: []
      },
      preference: { preferredLanguage: null, browserLanguage: "en-US" }
    }, {}, sendResponse);

    expect(returned).toBe(true);
    expect(returned).not.toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledOnce());
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      code: "captions_unavailable"
    }));
  });

  it("does not keep the channel open for invalid input", async () => {
    let registeredListener: RuntimeListener | undefined;
    vi.stubGlobal("defineContentScript", (config: unknown) => config);
    vi.stubGlobal("browser", {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeListener) => {
            registeredListener = listener;
          })
        },
        sendMessage: vi.fn(async () => undefined)
      }
    });

    const entrypoint = await import("../../entrypoints/youtube.content");
    (entrypoint.default as unknown as { main: () => void }).main();
    const sendResponse = vi.fn();

    expect(registeredListener?.({ type: "youtube/extract" }, {}, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
