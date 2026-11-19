const assert = require("node:assert/strict");
const test = require("node:test");
const { LiveEventClient, SseParser, reconnectDelay } = require("../dist/live-events.js");

test("parses SSE frames, ignores malformed data, and supports split chunks", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("id: 1\nevent: bridge\ndata: {\"type\":\"capture.created\"}"), []);
  assert.deepEqual(parser.push("\n\n: heartbeat\n\ndata: not-json\n\n"), [{
    id: "1", event: "bridge", data: { type: "capture.created" },
  }]);
});

test("uses bounded exponential reconnect delays", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 20].map(reconnectDelay), [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
});

test("authenticates in the extension host, reconnects, and suppresses duplicate event IDs", async () => {
  let calls = 0;
  const requests = [];
  const events = [];
  const statuses = [];
  const encoder = new TextEncoder();
  const fetchImpl = async (url, init) => {
    calls += 1;
    requests.push({ url, authorization: init.headers.Authorization });
    const stream = new ReadableStream({
      start(controller) {
        const id = calls === 1 ? "event-1" : "event-2";
        controller.enqueue(encoder.encode(`id: ${id}\nevent: bridge\ndata: {"type":"submission.progress"}\n\n`));
        if (calls === 1) {
          controller.enqueue(encoder.encode(`id: ${id}\nevent: bridge\ndata: {"type":"submission.progress"}\n\n`));
          controller.close();
        }
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const client = new LiveEventClient({
    url: "http://127.0.0.1:3000/api/vscode/events",
    token: () => "host-only-token",
    fetchImpl,
    onEvent: (event) => events.push(event.id),
    onStatus: (status) => statuses.push(status),
    onConnected: () => undefined,
  });
  client.start();
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  client.stop();
  assert.equal(calls, 2);
  assert.deepEqual(events, ["event-1", "event-2"]);
  assert.equal(requests.every((request) => request.authorization === "Bearer host-only-token"), true);
  assert.equal(statuses.includes("offline"), true);
  assert.equal(statuses.filter((status) => status === "connected").length, 2);
});
