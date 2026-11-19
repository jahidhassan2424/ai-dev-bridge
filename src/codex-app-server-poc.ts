import childProcess = require("node:child_process");
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs = require("node:fs");
import path = require("node:path");
import readline = require("node:readline");

const initializationTimeoutMs = 10_000;
const requestTimeoutMs = 15_000;
const turnTimeoutMs = 60_000;
const shutdownTimeoutMs = 3_000;
const prompt = "Reply with exactly: Codex bridge connected.";
const projectRoot = path.resolve(__dirname, "..");
const threadIdFile = path.join(projectRoot, ".local", "codex-poc-thread-id");

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: any;
  error?: any;
  params?: any;
}

interface ProbeResult {
  binary: string;
  initializeResponse: JsonRpcMessage;
  stderr: string;
}

interface ReadOnlyTurnResult extends ProbeResult {
  threadId: string;
  agentMessage: string;
  completionStatus: string;
  approvalRequests: string[];
}

class ProbeError extends Error {
  constructor(message: string, readonly binary: string, readonly stderr: string) {
    super(message);
    this.name = "CodexAppServerProbeError";
  }
}

function initializeRequest(): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "ai-dev-bridge",
        title: "AI Dev Bridge",
        version: "1.0.0",
      },
    },
  };
}

function initializedNotification(): JsonRpcMessage {
  return { jsonrpc: "2.0", method: "initialized", params: {} };
}

function threadStartRequest(cwd: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "thread/start",
    params: {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      threadSource: "appServer",
    },
  };
}

function turnStartRequest(threadId: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 3,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
  };
}

function encodeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function parseJsonRpcLine(line: string): JsonRpcMessage {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    throw new Error("Codex app-server emitted malformed JSON.");
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new Error("Codex app-server emitted a non-object JSON-RPC message.");
  }
  return message as JsonRpcMessage;
}

function discoverCodexBinary(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnvironment = process.env.CODEX_BIN;
  if (fromEnvironment) return fromEnvironment;

  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const result = childProcess.execFileSync(command, ["codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (result) return result;
  } catch {
    // Fall through to the installed VS Code extension lookup.
  }

  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (userProfile && process.platform === "win32") {
    const extensionRoot = path.join(userProfile, ".vscode", "extensions");
    try {
      const candidates = fs.readdirSync(extensionRoot)
        .filter((name) => name.startsWith("openai.chatgpt-"))
        .sort()
        .reverse()
        .map((name) => path.join(extensionRoot, name, "bin", "windows-x86_64", "codex.exe"))
        .filter((candidate) => fs.existsSync(candidate));
      if (candidates[0]) return candidates[0];
    } catch {
      // Return the PATH name so spawn reports the actionable startup error.
    }
  }
  return "codex";
}

function stderrText(chunks: string[]): string {
  return chunks.join("").trim().slice(-4_000);
}

function persistThreadId(threadId: string, filePath = threadIdFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${threadId}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some filesystems do not support Unix permission bits.
  }
}

function responseResultId(message: JsonRpcMessage): string {
  const id = message.result?.thread?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("thread/start returned no thread ID.");
  return id;
}

function completionStatus(message: JsonRpcMessage): string | undefined {
  if (message.method !== "turn/completed") return undefined;
  return typeof message.params?.turn?.status === "string"
    ? message.params.turn.status
    : typeof message.params?.status === "string" ? message.params.status : undefined;
}

function agentMessageDelta(message: JsonRpcMessage, threadId: string): string | undefined {
  if (message.method !== "item/agentMessage/delta" || message.params?.threadId !== threadId) return undefined;
  return typeof message.params?.delta === "string" ? message.params.delta : undefined;
}

class AppServerSession {
  readonly approvalRequests: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stderrChunks: string[] = [];
  private readonly pending = new Map<number, { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notificationWaiters: Array<{ predicate: (message: JsonRpcMessage) => boolean; resolve: (message: JsonRpcMessage) => void; timer: NodeJS.Timeout }> = [];
  private fatalError: Error | undefined;

  constructor(readonly binary: string) {
    try {
      this.child = childProcess.spawn(binary, ["app-server", "--listen", "stdio://"], {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new ProbeError(`Failed to start Codex binary: ${error instanceof Error ? error.message : String(error)}`, binary, "");
    }

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.stderrChunks.push(chunk));
    const input = readline.createInterface({ input: this.child.stdout });
    input.on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.fail(new Error(`Codex process error: ${error.message}`)));
    this.child.on("close", (code, signal) => {
      if (code !== 0 || signal) this.fail(new Error(`Codex app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"}).`));
    });
  }

  get stderr(): string { return stderrText(this.stderrChunks); }

  request(id: number, method: string, params: unknown, timeoutMs = requestTimeoutMs): Promise<JsonRpcMessage> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} response.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(message: JsonRpcMessage): void {
    this.child.stdin.write(encodeMessage(message));
  }

  waitFor(predicate: (message: JsonRpcMessage) => boolean, timeoutMs: number): Promise<JsonRpcMessage> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for turn/completed.")), timeoutMs);
      this.notificationWaiters.push({ predicate, resolve, timer });
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      this.child.once("close", finish);
      this.child.stdin.end();
      setTimeout(() => { if (!settled) { this.child.kill(); finish(); } }, shutdownTimeoutMs).unref();
    });
  }

  private handleLine(line: string): void {
    try {
      const message = parseJsonRpcLine(line);
      if (typeof message.method === "string" && message.id !== undefined) {
        this.handleServerRequest(message);
        return;
      }
      if (typeof message.id === "number") {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error !== undefined) request.reject(new Error(`Codex ${JSON.stringify(message.error)}`));
        else request.resolve(message);
        return;
      }
      if (typeof message.method === "string") {
        for (const waiter of [...this.notificationWaiters]) {
          if (!waiter.predicate(message)) continue;
          clearTimeout(waiter.timer);
          this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
          waiter.resolve(message);
          break;
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    const method = String(message.method);
    if (method.includes("requestApproval") || method === "item/permissions/requestApproval") {
      this.approvalRequests.push(method);
      console.error(`Approval request surfaced and declined: ${method}`);
      this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } }));
      return;
    }
    this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported server request" } }));
  }

  private fail(error: Error): void {
    this.fatalError ??= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.fatalError);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
    }
    this.notificationWaiters.length = 0;
  }
}

async function runInitialization(binary = discoverCodexBinary()): Promise<ProbeResult> {
  const session = new AppServerSession(binary);
  try {
    const initializeResponse = await session.request(1, "initialize", initializeRequest().params, initializationTimeoutMs);
    session.notify(initializedNotification());
    await session.close();
    return { binary, initializeResponse, stderr: session.stderr };
  } catch (error) {
    await session.close();
    throw new ProbeError(error instanceof Error ? error.message : String(error), binary, session.stderr);
  }
}

async function runReadOnlyTurn(binary = discoverCodexBinary()): Promise<ReadOnlyTurnResult> {
  const session = new AppServerSession(binary);
  try {
    const initializeResponse = await session.request(1, "initialize", initializeRequest().params, initializationTimeoutMs);
    session.notify(initializedNotification());
    const threadResponse = await session.request(2, "thread/start", threadStartRequest(projectRoot).params);
    const threadId = responseResultId(threadResponse);
    persistThreadId(threadId);
    let agentMessage = "";
    const completion = session.waitFor((message) => {
      const delta = agentMessageDelta(message, threadId);
      if (delta !== undefined) agentMessage += delta;
      return completionStatus(message) !== undefined && (message.params?.threadId === threadId || message.params?.turn?.threadId === threadId);
    }, turnTimeoutMs);
    const turnStarted = await session.request(3, "turn/start", turnStartRequest(threadId).params);
    const turnId = turnStarted.result?.turn?.id;
    if (typeof turnId !== "string" || turnId.length === 0) throw new Error("turn/start returned no turn ID.");
    const completed = await completion;
    const status = completionStatus(completed) || "unknown";
    await session.close();
    return { binary, initializeResponse, threadId, agentMessage, completionStatus: status, approvalRequests: session.approvalRequests, stderr: session.stderr };
  } catch (error) {
    await session.close();
    throw new ProbeError(error instanceof Error ? error.message : String(error), binary, session.stderr);
  }
}

function redacted(value: string): string {
  return value.replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]").replace(/(access[_-]?token|refresh[_-]?token)[=:][^\s,]+/gi, "$1=[redacted]");
}

async function main(): Promise<void> {
  const explicit = process.argv.find((argument) => argument.startsWith("--codex-bin="))?.slice("--codex-bin=".length);
  const binary = discoverCodexBinary(explicit);
  console.log(`Codex binary: ${binary}`);
  console.log(`Project root: ${projectRoot}`);
  console.log(`Prompt: ${prompt}`);
  try {
    const result = await runReadOnlyTurn(binary);
    console.log(`Thread ID: ${result.threadId}`);
    console.log(`Thread ID persisted: ${threadIdFile}`);
    console.log(`Agent message: ${result.agentMessage}`);
    console.log(`Completion status: ${result.completionStatus}`);
    console.log(`Read-only turn succeeded: ${result.completionStatus === "completed" ? "yes" : "no"}`);
    if (result.stderr) console.log(`Codex stderr:\n${redacted(result.stderr)}`);
    if (result.completionStatus !== "completed") process.exitCode = 1;
  } catch (error) {
    const probeError = error instanceof ProbeError ? error : new ProbeError(String(error), binary, "");
    console.error("Read-only turn succeeded: no");
    console.error(`Protocol/startup error: ${probeError.message}`);
    if (probeError.stderr) console.error(`Codex stderr:\n${redacted(probeError.stderr)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

export = {
  agentMessageDelta,
  completionStatus,
  discoverCodexBinary,
  encodeMessage,
  initializedNotification,
  initializeRequest,
  parseJsonRpcLine,
  persistThreadId,
  runInitialization,
  runReadOnlyTurn,
  threadStartRequest,
  turnStartRequest,
};
