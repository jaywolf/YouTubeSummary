function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The request was canceled.", "AbortError");
}

/** Parses the data fields from a UTF-8 server-sent event stream. */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let terminatedByDone = false;

  const onAbort = () => {
    void reader.cancel(abortError(signal)).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortError(signal);
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          if (dataLines.length > 0) {
            const payload = dataLines.join("\n");
            dataLines = [];
            if (payload === "[DONE]") {
              terminatedByDone = true;
              break;
            }
            yield payload;
          }
        } else if (line.startsWith("data:")) {
          const valueStart = line.charAt(5) === " " ? 6 : 5;
          dataLines.push(line.slice(valueStart));
        }

        newline = buffer.indexOf("\n");
      }

      if (terminatedByDone) break;
    }

    if (!terminatedByDone && (buffer.length > 0 || dataLines.length > 0)) {
      throw new Error("SSE stream ended with an unterminated event.");
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (terminatedByDone) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
