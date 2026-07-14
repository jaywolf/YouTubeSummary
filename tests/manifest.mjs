import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mode = process.argv[2] ?? "production";
assert.match(mode, /^(production|test)$/);
const output = mode === "test" ? "dist-test" : "dist";
const manifestUrl = new URL(`../${output}/chrome-mv3/manifest.json`, import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const background = await readFile(new URL(`../${output}/chrome-mv3/background.js`, import.meta.url), "utf8");
const content = await readFile(
  new URL(`../${output}/chrome-mv3/content-scripts/youtube.js`, import.meta.url),
  "utf8"
);

assert.equal(
  manifest.options_ui?.open_in_tab,
  true,
  "production manifest must open the options page in a tab"
);

assert.deepEqual(manifest.optional_host_permissions, [
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
], "optional custom-provider permissions must remain explicit in every build");

const fixedHosts = [
  "https://www.youtube.com/*",
  "https://api.openai.com/*",
  "https://openrouter.ai/*"
];
const matches = manifest.content_scripts?.[0]?.matches;

if (mode === "production") {
  assert.deepEqual(manifest.host_permissions, fixedHosts);
  assert.deepEqual(matches, ["https://www.youtube.com/*"]);
  // These compiled markers are deliberate defense-in-depth canaries for the
  // compile-time test branches. If WXT/minification changes them, update the
  // marker only after confirming the corresponding source branch is still
  // absent from production and present in the isolated test build.
  assert.equal(background.includes("port===``||"), false,
    "production background must not contain the loopback watch adapter");
  assert.equal(background.includes("origin===`https://www.youtube.com`||"), false,
    "production background must not contain the loopback caption bridge");
  assert.equal(content.includes("127.0.0.1"), false,
    "production content script must not contain loopback watch support");
  assert.equal(content.includes("wxtSeekSeconds"), false,
    "production content script must not contain the packaged seek acknowledgement");
} else {
  assert.deepEqual(manifest.host_permissions, [...fixedHosts, "http://127.0.0.1/*"]);
  assert.deepEqual(matches, ["http://127.0.0.1/*", "https://www.youtube.com/*"]);
  assert.equal(background.includes("port===``||"), true,
    "test background must contain the exact loopback watch adapter");
  assert.equal(background.includes("origin===`https://www.youtube.com`||"), true,
    "test background must contain the loopback caption bridge");
  assert.equal(content.includes("127.0.0.1"), true,
    "test content script must contain loopback watch support");
  assert.equal(content.includes("wxtSeekSeconds"), true,
    "test content script must contain the packaged seek acknowledgement");
}
