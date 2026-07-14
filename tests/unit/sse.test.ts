import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseSse } from "../../src/providers/sse";

function streamFragments(text: string, sizes: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let sizeIndex = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = sizes[sizeIndex++ % sizes.length] ?? 1;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    }
  });
}

async function collect(stream: ReadableStream<Uint8Array>, signal = new AbortController().signal) {
  const values: string[] = [];
  for await (const value of parseSse(stream, signal)) values.push(value);
  return values;
}

describe("parseSse", () => {
  it("parses fragmented CRLF events, multiline data, comments, and DONE", async () => {
    const source = ": ignored\r\nevent: message\r\ndata: first\r\ndata: second\r\n\r\ndata: [DONE]\r\n\r\n";
    await expect(collect(streamFragments(source, [1, 2, 7, 3])))
      .resolves.toEqual(["first\nsecond"]);
  });

  it("parses both provider fixtures across arbitrary byte boundaries", async () => {
    const fixture = (name: string) => readFile(resolve("tests/fixtures", name), "utf8");
    const openai = await fixture("openai-responses.sse");
    const openrouter = await fixture("openrouter-chat.sse");

    expect(await collect(streamFragments(openai, [2, 1, 13, 5]))).toHaveLength(3);
    expect(await collect(streamFragments(openrouter, [3, 8, 1, 2]))).toHaveLength(2);
  });

  it("reports an explicit DONE terminal without changing emitted payloads", async () => {
    const terminal = vi.fn();
    const values: string[] = [];
    for await (const value of parseSse(
      streamFragments("data: one\n\ndata: [DONE]\n\n", [1, 4, 2]),
      new AbortController().signal,
      terminal
    )) values.push(value);

    expect(values).toEqual(["one"]);
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("rejects a final unterminated nonempty event", async () => {
    await expect(collect(streamFragments("data: unfinished", [4])))
      .rejects.toThrow("unterminated");
  });

  it("propagates AbortError and cancels the reader", async () => {
    const controller = new AbortController();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("data: partial"));
      },
      cancel() {
        canceled = true;
      }
    });

    const reading = collect(stream, controller.signal);
    controller.abort(new DOMException("Canceled", "AbortError"));
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(canceled).toBe(true);
  });
});
