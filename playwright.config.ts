import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/extension",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  use: {
    trace: "on-first-retry"
  }
});
