import {
  createBrowserTranscriptDependencies,
  createYouTubeMessageHandler,
  sendYouTubeNavigation
} from "../src/youtube/contentRuntime";
import { extractTranscript } from "../src/youtube/extractTranscript";

export default defineContentScript({
  matches: ["https://www.youtube.com/*"],
  main() {
    const controllers = new Map<string, AbortController>();
    const browserDependencies = createBrowserTranscriptDependencies();
    const handler = createYouTubeMessageHandler({
      ...browserDependencies,
      extract: extractTranscript
    }, controllers);

    browser.runtime.onMessage.addListener((message) => handler(message));

    document.addEventListener("yt-navigate-finish", () => {
      void sendYouTubeNavigation(
        location.href,
        crypto.randomUUID(),
        (message) => browser.runtime.sendMessage(message)
      ).catch(() => undefined);
    });
  }
});
