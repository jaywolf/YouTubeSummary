import { defineConfig } from "wxt";

const testMode = process.env.WXT_TEST_MODE === "1";

export default defineConfig({
  outDir: testMode ? ".output-test" : ".output",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "YouTube Detailed Summary",
    description: "Summarize the active captioned YouTube video in a side panel.",
    minimum_chrome_version: "114",
    permissions: ["sidePanel", "storage", "scripting"],
    host_permissions: [
      "https://www.youtube.com/*",
      "https://api.openai.com/*",
      "https://openrouter.ai/*",
      ...(testMode ? ["http://127.0.0.1/*"] : [])
    ],
    optional_host_permissions: [
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*"
    ],
    action: { default_title: "Summarize this YouTube video" },
    options_ui: { page: "options.html", open_in_tab: true }
  }
});
