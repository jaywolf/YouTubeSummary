import {
  configureProvider,
  expect,
  openPanel,
  test
} from "./extension.fixture";

test("extracts captions, renders an uncached summary, seeks, then reopens cached", async ({
  context,
  extensionId,
  fixturePage,
  server
}) => {
  const configured = await configureProvider(context, extensionId, fixturePage, server);
  expect(configured.permissionBefore).toBe(true);
  expect(configured.permissionAfter).toBe(true);

  const panel = await openPanel(context, extensionId, fixturePage);
  await expect(panel.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(panel.getByText("Packaged overview A from synthetic captions.")).toBeVisible();
  await expect(panel.getByText("English fixture captions")).toBeVisible();
  expect(server.requests.filter((request) => request.stream)).toHaveLength(1);

  await fixturePage.bringToFront();
  await panel.getByRole("button", { name: "Jump to 0:42" }).first()
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => fixturePage.evaluate(() => window.fixtureSeekSeconds()))
    .toBe(42);

  await panel.close();
  const requestsBeforeReopen = server.requests.length;
  await fixturePage.evaluate(() => window.navigateFixture("bbbbbbbbbbb"));
  await expect.poll(() => fixturePage.url()).toContain("bbbbbbbbbbb");
  await fixturePage.waitForTimeout(100);
  await fixturePage.evaluate(() => window.navigateFixture("aaaaaaaaaaa"));
  await expect.poll(() => fixturePage.url()).toContain("aaaaaaaaaaa");
  await fixturePage.waitForTimeout(100);
  const cachedPanel = await openPanel(context, extensionId, fixturePage);
  await expect(cachedPanel.getByText(/^Cached /)).toBeVisible();
  await expect(cachedPanel.getByText("Packaged overview A from synthetic captions.")).toBeVisible();
  expect(server.requests).toHaveLength(requestsBeforeReopen);
});

test("cancel aborts a delayed provider request and does not write cache", async ({
  context,
  extensionId,
  fixturePage,
  server
}) => {
  server.mode = "delayed";
  const { options } = await configureProvider(context, extensionId, fixturePage, server);
  const panel = await openPanel(context, extensionId, fixturePage);
  await expect.poll(() => server.requests.length).toBe(1);
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByRole("heading", { name: "Summary canceled" })).toBeVisible();
  await expect.poll(() => server.abortedRequests).toBeGreaterThan(0);
  const cacheEntries = await options.evaluate(async () => {
    const stored = await chrome.storage.local.get("summaryCache.v1");
    const cache = stored["summaryCache.v1"] as { entries?: unknown[] } | undefined;
    return cache?.entries?.length ?? 0;
  });
  expect(cacheEntries).toBe(0);
});

test("navigation cancels stale A work and a reopened panel explicitly starts B", async ({
  context,
  extensionId,
  fixturePage,
  server
}) => {
  server.mode = "delayed";
  await configureProvider(context, extensionId, fixturePage, server);
  const panelA = await openPanel(context, extensionId, fixturePage);
  await expect.poll(() => server.requests.length).toBe(1);

  await fixturePage.evaluate(() => window.navigateFixture("bbbbbbbbbbb"));
  await expect(panelA.getByRole("heading", { name: "Summary canceled" })).toBeVisible();
  await expect.poll(() => server.abortedRequests).toBeGreaterThan(0);
  await panelA.close();

  server.mode = "normal";
  const panelB = await openPanel(context, extensionId, fixturePage);
  await expect(panelB.getByText("Packaged overview B from synthetic captions.")).toBeVisible();
  await expect(panelB.getByText("Packaged overview A from synthetic captions.")).toHaveCount(0);
  expect(server.requests.filter((request) => request.stream)).toHaveLength(2);
});

test("repairs malformed structured output exactly once", async ({
  context,
  extensionId,
  fixturePage,
  server
}) => {
  server.mode = "repair";
  await configureProvider(context, extensionId, fixturePage, server);
  const panel = await openPanel(context, extensionId, fixturePage);

  await expect(panel.getByText("Packaged overview A from synthetic captions.")).toBeVisible();
  expect(server.requests).toHaveLength(2);
  expect(server.requests.filter((request) => request.stream)).toHaveLength(1);
  expect(server.requests.filter((request) => !request.stream)).toHaveLength(1);
});
