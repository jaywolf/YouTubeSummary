import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => true | undefined;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

async function importBackground() {
  vi.stubGlobal("defineBackground", (callback: unknown) => callback);
  vi.stubGlobal("browser", {
    runtime: { id: "extension-id" },
    storage: { local: {}, session: {} },
    sidePanel: {},
    tabs: {},
    scripting: {}
  });
  return import("../../entrypoints/background");
}

describe("background controller entrypoint", () => {
  it("uses the content-script sender tab as authoritative navigation identity", async () => {
    const module = await importBackground();
    const controller = {
      start: vi.fn(),
      cancel: vi.fn(),
      status: vi.fn(),
      navigated: vi.fn(async () => undefined)
    };
    const listener = module.createBackgroundMessageListener(controller as never);
    const sendResponse = vi.fn();

    const returned = listener({
      type: "youtube/navigated",
      requestId: "navigation",
      tabId: 4,
      videoId: "aaaaaaaaaaa"
    }, {
      id: "extension-id",
      url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
      tab: { id: 91, url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" }
    }, sendResponse);

    expect(returned).toBe(true);
    expect(returned).not.toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(controller.navigated).toHaveBeenCalledOnce());
    expect(controller.navigated).toHaveBeenCalledWith(91, "bbbbbbbbbbb");
    expect(controller.navigated).not.toHaveBeenCalledWith(4, expect.anything());
    expect(controller.navigated).not.toHaveBeenCalledWith(91, "aaaaaaaaaaa");
  });

  it("rejects navigation from a non-YouTube or tabless sender", async () => {
    const module = await importBackground();
    const controller = {
      start: vi.fn(),
      cancel: vi.fn(),
      status: vi.fn(),
      navigated: vi.fn(async () => undefined)
    };
    const listener = module.createBackgroundMessageListener(controller as never);

    expect(listener({
      type: "youtube/navigated",
      requestId: "navigation",
      tabId: 4,
      videoId: null
    }, { id: "extension-id", url: "https://evil.example/", tab: { id: 91 } }, vi.fn()))
      .toBeUndefined();
    expect(controller.navigated).not.toHaveBeenCalled();
  });

  it("trusts authoritative sender.tab.url instead of the non-authoritative sender URL", async () => {
    const module = await importBackground();
    const controller = {
      start: vi.fn(),
      cancel: vi.fn(),
      status: vi.fn(),
      navigated: vi.fn(async () => undefined)
    };
    const listener = module.createBackgroundMessageListener(controller as never);
    const message = {
      type: "youtube/navigated",
      requestId: "navigation",
      tabId: 0,
      videoId: "bbbbbbbbbbb"
    };

    expect(listener(message, {
      id: "extension-id",
      url: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
      tab: { id: 91, url: "https://evil.example/watch?v=bbbbbbbbbbb" }
    }, vi.fn())).toBeUndefined();
    expect(controller.navigated).not.toHaveBeenCalled();

    const sendResponse = vi.fn();
    expect(listener(message, {
      id: "extension-id",
      url: "https://evil.example/isolated-world.js",
      tab: { id: 91, url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" }
    }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(controller.navigated).toHaveBeenCalledWith(91, "bbbbbbbbbbb"));
  });

  it("adapts panel promises with sendResponse and literal true for Chrome 114", async () => {
    const module = await importBackground();
    const snapshot = { requestId: "start", tabId: 4, videoId: "aaaaaaaaaaa", state: "loading_video" };
    const controller = {
      start: vi.fn(async () => snapshot),
      cancel: vi.fn(),
      status: vi.fn(),
      navigated: vi.fn()
    };
    const listener = module.createBackgroundMessageListener(controller as never);
    const sendResponse = vi.fn();

    const returned = listener({ type: "panel/start", requestId: "start", tabId: 4, force: false }, {}, sendResponse);
    expect(returned).toBe(true);
    expect(returned).not.toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(snapshot));
  });

  it("registers synchronously but waits for trusted-storage initialization before handling", async () => {
    const module = await importBackground();
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const controller = {
      start: vi.fn(async () => null),
      cancel: vi.fn(),
      status: vi.fn(),
      navigated: vi.fn()
    };
    const listener = module.createBackgroundMessageListener(controller as never, ready);
    const sendResponse = vi.fn();

    expect(listener({ type: "panel/start", requestId: "start", tabId: 4, force: false }, {}, sendResponse))
      .toBe(true);
    expect(controller.start).not.toHaveBeenCalled();
    markReady();
    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledOnce());
    expect(sendResponse).toHaveBeenCalledWith(null);
  });

  it("gates the first status until lifecycle restoration has installed interruption state", async () => {
    const module = await importBackground();
    let restore!: () => void;
    const interrupted = {
      requestId: "restored",
      tabId: 4,
      videoId: "aaaaaaaaaaa",
      state: "interrupted"
    };
    let restored = false;
    const ready = new Promise<void>((resolve) => {
      restore = () => {
        restored = true;
        resolve();
      };
    });
    const controller = {
      start: vi.fn(),
      cancel: vi.fn(),
      status: vi.fn(() => restored ? interrupted : null),
      navigated: vi.fn(),
      clearSummaryCache: vi.fn()
    };
    const listener = module.createBackgroundMessageListener(controller as never, ready);
    const sendResponse = vi.fn();

    expect(listener({ type: "panel/status", requestId: "status", tabId: 4 }, {}, sendResponse))
      .toBe(true);
    expect(controller.status).not.toHaveBeenCalled();
    restore();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith(interrupted));
    expect(controller.status).toHaveBeenCalledWith(4);
  });

  it("routes cache clearing through the gated background controller", async () => {
    const module = await importBackground();
    const controller = {
      start: vi.fn(),
      cancel: vi.fn(),
      status: vi.fn(),
      navigated: vi.fn(),
      clearSummaryCache: vi.fn(async () => undefined)
    };
    const listener = module.createBackgroundMessageListener(controller as never);
    const sendResponse = vi.fn();

    expect(listener({ type: "options/clear-summaries", requestId: "clear" }, {}, sendResponse))
      .toBe(true);
    await vi.waitFor(() => expect(controller.clearSummaryCache).toHaveBeenCalledOnce());
    expect(sendResponse).toHaveBeenCalledWith({ cleared: true });
  });

  it("broadcasts only through summary-panel ports and removes disconnected ports", async () => {
    const module = await importBackground();
    let disconnect!: () => void;
    const accepted = {
      name: "summary-panel",
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn((listener: () => void) => { disconnect = listener; }) }
    };
    const ignored = {
      name: "other",
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() }
    };
    const hub = module.createPanelEventHub();
    hub.connect(accepted as never);
    hub.connect(ignored as never);

    hub.emit({
      type: "job/progress",
      requestId: "job",
      tabId: 4,
      phase: "mapping",
      completed: 1,
      total: 4
    });
    expect(accepted.postMessage).toHaveBeenCalledOnce();
    expect(accepted.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      phase: "mapping",
      completed: 1,
      total: 4
    }));
    expect(ignored.postMessage).not.toHaveBeenCalled();
    disconnect();
    hub.emit({ type: "job/state", requestId: "job", tabId: 4, state: "complete" });
    expect(accepted.postMessage).toHaveBeenCalledOnce();
  });

  it("removes a panel port when postMessage throws", async () => {
    const module = await importBackground();
    const broken = {
      name: "summary-panel",
      postMessage: vi.fn(() => { throw new Error("disconnected"); }),
      onDisconnect: { addListener: vi.fn() }
    };
    const hub = module.createPanelEventHub();
    hub.connect(broken as never);

    hub.emit({ type: "job/state", requestId: "job", tabId: 4, state: "summarizing" });
    hub.emit({ type: "job/state", requestId: "job", tabId: 4, state: "summarizing" });
    expect(broken.postMessage).toHaveBeenCalledOnce();
  });
});
