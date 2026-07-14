import { describe, expect, it } from "vitest";
import { parseAppMessage } from "../../src/domain/messages";

describe("parseAppMessage", () => {
  it("accepts a typed panel request", () => {
    expect(parseAppMessage({
      type: "panel/start",
      requestId: "request-1",
      tabId: 7,
      force: false
    }).type).toBe("panel/start");
  });

  it("rejects a message without a request identifier", () => {
    expect(() => parseAppMessage({ type: "panel/cancel", tabId: 7 })).toThrow();
  });
});
