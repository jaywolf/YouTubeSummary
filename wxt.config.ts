import { defineConfig } from "wxt";

const testMode = process.env.WXT_TEST_MODE === "1";

export default defineConfig({
  outDir: testMode ? "dist-test" : "dist",
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
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png"
    },
    action: {
      default_title: "Summarize this YouTube video",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png"
      }
    },
    options_ui: { page: "options.html", open_in_tab: true }
  }
});
