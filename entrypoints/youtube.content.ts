import {
  createBrowserTranscriptDependencies,
  createChromeMessageListener,
  createYouTubeMessageHandler,
  sendYouTubeNavigation
} from "../src/youtube/contentRuntime";
import { extractTranscript } from "../src/youtube/extractTranscript";
import { markTranscriptNavigationStart } from "../src/youtube/visibleTranscript";

const contentMatches = import.meta.env.WXT_TEST_MODE === "1"
  ? ["https://www.youtube.com/*", "http://127.0.0.1/*"]
  : ["https://www.youtube.com/*"];

export default defineContentScript({
  matches: contentMatches,
  main() {
    const controllers = new Map<string, AbortController>();
    const browserDependencies = createBrowserTranscriptDependencies();
    const handler = createYouTubeMessageHandler({
      ...browserDependencies,
      extract: extractTranscript
    }, controllers);

    browser.runtime.onMessage.addListener(createChromeMessageListener(handler));

    document.addEventListener("yt-navigate-start", () => {
      markTranscriptNavigationStart(document);
    });
    document.addEventListener("yt-navigate-finish", () => {
      void sendYouTubeNavigation(
        location.href,
        crypto.randomUUID(),
        (message) => browser.runtime.sendMessage(message)
      ).catch(() => undefined);
    });
  }
});
