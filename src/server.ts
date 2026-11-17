import http = require("node:http");

const host = "127.0.0.1";
const port = 3000;
const extensionOrigin = "chrome-extension://flpkdgbjocacgdlnfhinaeicigegfklb";
const maxRequestBodySize = 1_048_576;

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  body: Record<string, boolean | string>,
  origin?: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...(origin === extensionOrigin
      ? { "Access-Control-Allow-Origin": extensionOrigin, Vary: "Origin" }
      : {}),
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin;

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok" }, origin);
    return;
  }

  if (request.url === "/api/test") {
    if (origin !== extensionOrigin) {
      sendJson(response, 403, { success: false, error: "Forbidden origin" }, origin);
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": extensionOrigin,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      });
      response.end();
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      sendJson(response, 405, { success: false, error: "Method not allowed" }, origin);
      return;
    }

    let body = "";
    let requestTooLarge = false;

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxRequestBodySize) {
        requestTooLarge = true;
        sendJson(response, 413, { success: false, error: "Request body too large" }, origin);
        request.destroy();
      }
    });
    request.on("error", () => {
      if (!response.writableEnded) {
        sendJson(response, 400, { success: false, error: "Invalid request body" }, origin);
      }
    });
    request.on("end", () => {
      if (requestTooLarge) {
        return;
      }

      try {
        const payload: unknown = JSON.parse(body);
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("message" in payload) ||
          typeof payload.message !== "string"
        ) {
          sendJson(response, 400, { success: false, error: "Expected a string message" }, origin);
          return;
        }

        console.log(`Chrome test message: ${payload.message}`);
        sendJson(response, 200, { success: true }, origin);
      } catch {
        sendJson(response, 400, { success: false, error: "Invalid JSON" }, origin);
      }
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" }, origin);
});

server.listen(port, host, () => {
  console.log(`Server listening at http://${host}:${port}`);
});
