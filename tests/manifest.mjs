import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../.output/chrome-mv3/manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

assert.equal(
  manifest.options_ui?.open_in_tab,
  true,
  "production manifest must open the options page in a tab"
);
