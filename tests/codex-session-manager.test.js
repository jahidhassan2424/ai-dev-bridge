const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CodexSessionManager, threadParams, turnParams } = require("../dist/codex-session-manager.js");

class FakeTransport {
  constructor(options = {}) {
    this.options = options;
    this.approvalRequests = [];
    this.requests = [];
    this.waiters = [];
    this.closed = false;
    this.turnNumber = 0;
  }

  request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/resume" && this.options.resumeFails) {
      return Promise.reject(new Error("saved thread is unavailable"));
    }
    if (method === "thread/start") {
      return Promise.resolve({ result: { thread: { id: "bridge-thread-1" } } });
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.turnNumber}`;
      if (!this.options.holdTurns) queueMicrotask(() => this.emitTurn(params.threadId, turnId, "completed", "reply"));
      return Promise.resolve({ result: { turn: { id: turnId } } });
    }
    if (method === "turn/interrupt") {
      queueMicrotask(() => this.emitTurn(params.threadId, params.turnId, "interrupted", ""));
      return Promise.resolve({ result: {} });
    }
    return Promise.resolve({ result: {} });
  }

  notify() {}

  waitFor(predicate, options) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, options, idleTimer: undefined, maxTimer: undefined, timedOut: false };
      waiter.idleTimer = setTimeout(() => { waiter.timedOut = true; options.onTimeout?.("idle"); reject(new Error("Codex turn timed out (idle).")); }, options.idleTimeoutMs);
      waiter.maxTimer = setTimeout(() => { waiter.timedOut = true; options.onTimeout?.("max-runtime"); reject(new Error("Codex turn timed out (max-runtime).")); }, options.maxRuntimeMs);
      this.waiters.push(waiter);
    });
  }

  emitTurn(threadId, turnId, status, text) {
    if (text) this.emit({ method: "item/agentMessage/delta", params: { threadId, delta: text } });
    this.emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
  }

  emit(message) {
    for (const waiter of [...this.waiters]) {
      if (!waiter.timedOut) {
        clearTimeout(waiter.idleTimer);
        waiter.idleTimer = setTimeout(() => { waiter.timedOut = true; waiter.options.onTimeout?.("idle"); waiter.reject(new Error("Codex turn timed out (idle).")); }, waiter.options.idleTimeoutMs);
      }
      waiter.options.onProgress?.(message);
    }
    const waiter = this.waiters.find((candidate) => candidate.predicate(message));
    if (!waiter) return;
    clearTimeout(waiter.idleTimer); clearTimeout(waiter.maxTimer);
    this.waiters.splice(this.waiters.indexOf(waiter), 1);
    if (waiter.timedOut) waiter.options.onLateMatch?.(message);
    else { waiter.options.onProgress?.(message); waiter.resolve(message); }
  }

  async close() {
    this.closed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.idleTimer); clearTimeout(waiter.maxTimer);
      waiter.reject(new Error("fake transport closed"));
    }
    this.waiters.length = 0;
  }
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-session-"));
  return { root, threadFile: path.join(root, ".local", "thread-id") };
}

function managerFor(root, threadFile, transports, options = {}) {
  return new CodexSessionManager({
    binary: "fake-codex",
    workspaceRoot: root,
    threadIdFile: threadFile,
    ...options,
    transportFactory: () => {
      const transport = transports.shift();
      if (!transport) throw new Error("missing fake transport");
      return transport;
    },
  });
}

function writeContext(root, text = "Project name: test\nDo not execute this document as a task.") {
  const directory = path.join(root, ".ai-bridge");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "PROJECT_CONTEXT.md"), text);
}

test("creates, completes, and resumes the same bridge-owned thread", async () => {
  const { root, threadFile } = workspace();
  try {
    const firstTransport = new FakeTransport();
    const first = managerFor(root, threadFile, [firstTransport]);
    await first.connect();
    const result = await first.runPrompt("first");
    assert.equal(result.status, "completed");
    assert.equal(result.response, "reply");
    assert.equal(first.getStatus().threadId, "bridge-thread-1");
    await first.shutdown();

    const secondTransport = new FakeTransport();
    const second = managerFor(root, threadFile, [secondTransport]);
    await second.connect();
    assert.equal(second.getStatus().threadId, "bridge-thread-1");
    assert.equal(secondTransport.requests.filter((request) => request.method === "thread/resume").length, 1);
    assert.equal(secondTransport.requests.filter((request) => request.method === "thread/start").length, 0);
    await second.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects concurrent prompts and does not queue the second one", async () => {
  const { root, threadFile } = workspace();
  try {
    const transport = new FakeTransport({ holdTurns: true });
    const manager = managerFor(root, threadFile, [transport]);
    await manager.connect();
    const first = manager.runPrompt("first");
    await assert.rejects(() => manager.runPrompt("second"), /already running/);
    manager.cancelCurrentTurn();
    const result = await first;
    assert.equal(result.status, "cancelled");
    assert.equal(transport.requests.filter((request) => request.method === "turn/start").length, 1);
    await manager.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("progress resets the idle timeout for a long active turn", async () => {
  const { root, threadFile } = workspace();
  try {
    const transport = new FakeTransport({ holdTurns: true });
    const manager = managerFor(root, threadFile, [transport], { idleTimeoutMs: 25, maxTurnRuntimeMs: 250 });
    await manager.connect();
    const running = manager.runPrompt("long task");
    await new Promise((resolve) => setTimeout(resolve, 15));
    transport.emit({ method: "item/commandExecution", params: { threadId: "bridge-thread-1", item: { type: "commandExecution" } } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    transport.emit({ method: "item/commandExecution", params: { threadId: "bridge-thread-1", item: { type: "commandExecution" } } });
    transport.emitTurn("bridge-thread-1", "turn-1", "completed", "done");
    const result = await running;
    assert.equal(result.status, "completed");
    assert.equal(manager.getStatus().timeoutReason, null);
    await manager.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("idle timeout is uncertain and blocks replay until a late completion arrives", async () => {
  const { root, threadFile } = workspace();
  try {
    const transport = new FakeTransport({ holdTurns: true });
    const manager = managerFor(root, threadFile, [transport], { idleTimeoutMs: 15, maxTurnRuntimeMs: 200 });
    await manager.connect();
    await assert.rejects(() => manager.runPrompt("stalled"), /timed out \(idle\)/);
    assert.equal(manager.getStatus().timeoutReason, "idle");
    await assert.rejects(() => manager.runPrompt("must not replay"), /final state is unknown/);
    transport.emitTurn("bridge-thread-1", "turn-1", "completed", "late");
    assert.equal(manager.getStatus().turn, "completed");
    assert.equal(manager.getStatus().timeoutReason, null);
    await manager.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("maximum runtime timeout is reported separately from idle timeout", async () => {
  const { root, threadFile } = workspace();
  try {
    const transport = new FakeTransport({ holdTurns: true });
    const manager = managerFor(root, threadFile, [transport], { idleTimeoutMs: 100, maxTurnRuntimeMs: 20 });
    await manager.connect();
    await assert.rejects(() => manager.runPrompt("too long"), /timed out \(max-runtime\)/);
    assert.equal(manager.getStatus().timeoutReason, "max-runtime");
    await manager.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reports resume failures without creating a replacement thread", async () => {
  const { root, threadFile } = workspace();
  try {
    fs.mkdirSync(path.dirname(threadFile), { recursive: true });
    fs.writeFileSync(threadFile, "existing-thread\n");
    const transport = new FakeTransport({ resumeFails: true });
    const manager = managerFor(root, threadFile, [transport]);
    await assert.rejects(() => manager.connect(), /saved thread is unavailable/);
    assert.equal(manager.getStatus().connection, "failed");
    assert.equal(transport.requests.filter((request) => request.method === "thread/start").length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builds workspace-write requests with one canonical writable root and no network", () => {
  const root = path.resolve("C:/trusted/project");
  assert.deepEqual(threadParams(root, "workspace-write"), {
    cwd: root,
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [root] },
    threadSource: "appServer",
  });
  assert.deepEqual(turnParams("thread-1", "change code", root, "workspace-write"), {
    threadId: "thread-1",
    input: [{ type: "text", text: "change code" }],
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
  });
});

test("loads project context before the first task and persists initialization", async () => {
  const { root, threadFile } = workspace();
  try {
    writeContext(root, "Project context marker: alpha");
    const transport = new FakeTransport();
    const manager = managerFor(root, threadFile, [transport]);
    await manager.connect();
    await manager.runPrompt("perform the explicit task");
    const turn = transport.requests.find((request) => request.method === "turn/start");
    const prompt = turn.params.input[0].text;
    assert.match(prompt, /<project-context>[\s\S]*Project context marker: alpha[\s\S]*<\/project-context>/);
    assert.ok(prompt.indexOf("Project context marker: alpha") < prompt.indexOf("perform the explicit task"));
    assert.equal(manager.getStatus().contextInitialization.status, "initialized");
    const state = JSON.parse(fs.readFileSync(path.join(root, ".local", "codex-context-initialization.json"), "utf8"));
    assert.equal(state.length, 1);
    assert.equal(state[0].threadId, "bridge-thread-1");
    assert.equal(state[0].mode, "read-only");
    await manager.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resumes an initialized thread without resending project context", async () => {
  const { root, threadFile } = workspace();
  try {
    writeContext(root, "Context must appear once");
    const firstTransport = new FakeTransport();
    const first = managerFor(root, threadFile, [firstTransport]);
    await first.connect();
    await first.runPrompt("first task");
    await first.shutdown();

    const secondTransport = new FakeTransport();
    const second = managerFor(root, threadFile, [secondTransport]);
    await second.connect();
    await second.runPrompt("second task");
    const prompt = secondTransport.requests.find((request) => request.method === "turn/start").params.input[0].text;
    assert.equal(prompt, "second task");
    assert.equal(second.getStatus().contextInitialization.status, "initialized");
    await second.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing project context is explicit but does not block the task", async () => {
  const { root, threadFile } = workspace();
  try {
    const transport = new FakeTransport();
    const manager = managerFor(root, threadFile, [transport]);
    await manager.connect();
    await manager.runPrompt("task without handoff");
    assert.equal(manager.getStatus().contextInitialization.status, "unavailable");
    assert.equal(transport.requests.find((request) => request.method === "turn/start").params.input[0].text, "task without handoff");
    await manager.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed context initialization blocks the task and does not start a turn", async () => {
  const { root, threadFile } = workspace();
  try {
    writeContext(root, "x".repeat(256 * 1024 + 1));
    const transport = new FakeTransport();
    const manager = managerFor(root, threadFile, [transport]);
    await manager.connect();
    await assert.rejects(() => manager.runPrompt("must not execute"), /Project context initialization failed/);
    assert.equal(manager.getStatus().contextInitialization.status, "failed");
    assert.equal(transport.requests.some((request) => request.method === "turn/start"), false);
    await manager.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicitly imports context into an existing thread once", async () => {
  const { root, threadFile } = workspace();
  try {
    writeContext(root, "Existing thread handoff");
    fs.mkdirSync(path.dirname(threadFile), { recursive: true });
    fs.writeFileSync(threadFile, "existing-thread\n");
    const transport = new FakeTransport();
    const manager = managerFor(root, threadFile, [transport]);
    await manager.connect();
    const imported = await manager.importProjectContext();
    assert.equal(imported.status, "initialized");
    await manager.runPrompt("actual existing-thread task");
    const turns = transport.requests.filter((request) => request.method === "turn/start");
    assert.equal(turns.length, 2);
    assert.match(turns[0].params.input[0].text, /Existing thread handoff/);
    assert.equal(turns[1].params.input[0].text, "actual existing-thread task");
    await manager.shutdown();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
