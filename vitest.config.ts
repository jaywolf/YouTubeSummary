import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/extension/**", "node_modules/**"],
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    coverage: { reporter: ["text", "html"] }
  }
});
