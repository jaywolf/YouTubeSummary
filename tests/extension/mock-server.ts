import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";

export type MockMode = "normal" | "delayed" | "repair";

export type ProviderRequest = {
  body: Record<string, unknown>;
  stream: boolean;
};

export type MockServer = {
  fixtureUrl(videoId?: string): string;
  providerBaseUrl: string;
  requests: ProviderRequest[];
  abortedRequests: number;
  mode: MockMode;
  close(): Promise<void>;
};

const fixturePath = new URL("./fixtures/youtube.html", import.meta.url);

function summaryFor(bodyText: string) {
  const isB = bodyText.includes("Fixture Video B");
  const label = isB ? "B" : "A";
  return {
    overview: [`Packaged overview ${label} from synthetic captions.`],
    takeaways: [{ text: `Packaged takeaway ${label}.`, startSeconds: 42 }],
    sections: [{
      heading: `Fixture section ${label}`,
      startSeconds: 42,
      paragraphs: [`Detailed packaged result ${label}.`]
    }]
  };
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendFragmentedSse(response: ServerResponse, value: unknown): void {
  const serialized = JSON.stringify(value);
  const pivot = Math.max(1, Math.floor(serialized.length / 2));
  const events = [
    { choices: [{ delta: { content: serialized.slice(0, pivot) }, finish_reason: null }] },
    { choices: [{ delta: { content: serialized.slice(pivot) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] }
  ];
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    + "data: [DONE]\n\n";
  const cuts = [7, 19, 41, 83, payload.length];
  let offset = 0;
  for (const cut of cuts) {
    response.write(payload.slice(offset, cut));
    offset = cut;
  }
  response.end();
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMockServer(): Promise<MockServer> {
  const fixture = await readFile(fixturePath, "utf8");
  const state = {
    mode: "normal" as MockMode,
    requests: [] as ProviderRequest[],
    abortedRequests: 0
  };

  const server = createServer(async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method === "GET" && url.pathname === "/watch") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fixture);
      return;
    }
    if (request.method === "GET" && url.pathname === "/captions") {
      const id = url.searchParams.get("v") ?? "aaaaaaaaaaa";
      sendJson(response, {
        events: [
          {
            tStartMs: 0,
            dDurationMs: 15_000,
            segs: [{ utf8: `Synthetic transcript for ${id}.` }]
          },
          {
            tStartMs: 42_000,
            dDurationMs: 20_000,
            segs: [{ utf8: "Packaged extension timestamp checkpoint." }]
          }
        ]
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const text = await requestBody(request);
      const body = JSON.parse(text) as Record<string, unknown>;
      const stream = body.stream === true;
      state.requests.push({ body, stream });

      if (!stream) {
        const isConnection = text.includes("connection_test") || text.includes("Return {\\\"ok\\\":true}");
        const content = isConnection ? JSON.stringify({ ok: true }) : JSON.stringify(summaryFor(text));
        sendJson(response, { choices: [{ message: { content }, finish_reason: "stop" }] });
        return;
      }

      if (state.mode === "delayed") {
        let completed = false;
        let observedAbort = false;
        const observeAbort = () => {
          if (!completed && !observedAbort) {
            observedAbort = true;
            state.abortedRequests++;
          }
        };
        request.once("aborted", observeAbort);
        request.socket.once("close", observeAbort);
        const timer = setTimeout(() => {
          completed = true;
          sendFragmentedSse(response, summaryFor(text));
        }, 30_000);
        response.once("close", () => {
          clearTimeout(timer);
          observeAbort();
        });
        return;
      }

      if (state.mode === "repair") {
        sendFragmentedSse(response, { invalid: true });
        return;
      }
      sendFragmentedSse(response, summaryFor(text));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Mock server did not bind TCP");
  const port = address.port;
  return {
    fixtureUrl: (videoId = "aaaaaaaaaaa") => `http://127.0.0.1:${port}/watch?v=${videoId}`,
    providerBaseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() { return state.requests; },
    get abortedRequests() { return state.abortedRequests; },
    get mode() { return state.mode; },
    set mode(value: MockMode) { state.mode = value; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}
