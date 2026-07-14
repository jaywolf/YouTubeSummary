import { test as base, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockServer, type MockServer } from "./mock-server";

type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  fixturePage: Page;
  server: MockServer;
};

const extensionPath = resolve("dist-test/chrome-mv3");

export const test = base.extend<ExtensionFixtures>({
  server: async ({}, use) => {
    const server = await startMockServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },

  context: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), "ytsummary-playwright-"));
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },

  extensionId: async ({ context }, use) => {
    let worker = context.serviceWorkers().find((candidate) =>
      candidate.url().startsWith("chrome-extension://"));
    worker ??= await context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url().startsWith("chrome-extension://"),
      timeout: 15_000
    });
    const extensionId = new URL(worker.url()).host;
    await use(extensionId);
  },

  fixturePage: async ({ context, server }, use) => {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(server.fixtureUrl());
    await page.locator("#movie_player").waitFor({ state: "attached" });
    await use(page);
  }
});

export { expect } from "@playwright/test";

export async function configureProvider(
  context: BrowserContext,
  extensionId: string,
  fixturePage: Page,
  server: MockServer
): Promise<{ options: Page; permissionBefore: boolean; permissionAfter: boolean }> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const permissionBefore = await options.evaluate(() => chrome.permissions.contains({
    origins: ["http://127.0.0.1/*"]
  }));
  await options.getByRole("combobox", { name: "Provider" }).selectOption("custom");
  await options.getByLabel("Base URL").fill(server.providerBaseUrl);
  await options.getByLabel("Model ID").fill("synthetic-model");
  await options.getByLabel("API key").fill("synthetic-key");
  await options.locator("label.disclosure input[type=checkbox]").check();
  await options.getByRole("button", { name: "Save settings" }).click();
  await options.locator("[role=status], .notice.error").waitFor({ timeout: 10_000 });
  const saveStatus = await options.locator("[role=status], .notice.error").innerText();
  if (!saveStatus.includes("Settings saved")) {
    throw new Error(`Provider settings were not saved: ${saveStatus}`);
  }
  const permissionAfter = await options.evaluate(() => chrome.permissions.contains({
    origins: ["http://127.0.0.1/*"]
  }));
  const stored = await options.evaluate(() => chrome.storage.local.get(null));
  if (!("settings.v1" in stored)) {
    throw new Error(`Options reported success without persisted settings: ${JSON.stringify(stored)}`);
  }
  await fixturePage.bringToFront();
  return { options, permissionBefore, permissionAfter };
}

export async function openPanel(
  context: BrowserContext,
  extensionId: string,
  fixturePage: Page
): Promise<Page> {
  const panel = await context.newPage();
  await fixturePage.bringToFront();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}
