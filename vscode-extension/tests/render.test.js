const assert = require("node:assert/strict");
const test = require("node:test");
const { renderCaptures } = require("../dist/render.js");

test("renders capture text as inert escaped HTML with a restrictive CSP", () => {
  const html = renderCaptures([{
    id: "id-1",
    text: "<script>alert(1)</script>",
    timestamp: "2026-11-17T12:00:00.000Z",
    conversationUrl: "https://chatgpt.com/c/1?x=<&y=1",
  }], "vscode-webview://test", "nonce123");

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)/);
  assert.match(html, /default-src 'none'; style-src vscode-webview:\/\/test 'nonce-nonce123'; script-src 'nonce-nonce123'/);
  assert.match(html, /data-action="copy"/);
});

test("renders empty capture history", () => {
  assert.match(renderCaptures([], "source", "nonce"), /No captures received yet/);
});

test("renders explicit Send to Codex action and inert result details", () => {
  const html = renderCaptures([{
    id: "id-1",
    text: "captured prompt",
    timestamp: "2026-11-17T12:00:00.000Z",
    conversationUrl: "https://chatgpt.com/c/1",
  }], "source", "nonce", "", "info", {
    status: "completed",
    response: "<untrusted result>",
    threadId: "thread-1",
  });
  assert.match(html, /Send to Codex/);
  assert.match(html, /thread-1/);
  assert.match(html, /&lt;untrusted result&gt;/);
});

test("renders pending controls and terminal approval states as read-only", () => {
  const html = renderCaptures([], "source", "nonce", "", "info", undefined, [
    {
      id: "live-1", method: "item/fileChange/requestApproval", type: "file-change",
      target: "C:/workspace/file.txt", reason: "edit file", workspace: "C:/workspace",
      connectionId: "live-connection", submissionId: "submission-1",
      timestamp: "2026-11-17T12:00:00.000Z", expiresAt: "2026-11-17T12:00:30.000Z", status: "pending",
    },
    {
      id: "sim-1", method: "item/commandExecution/requestApproval", type: "command-execution",
      command: "echo simulated", reason: "test", workspace: "C:/workspace",
      connectionId: "simulation-connection", submissionId: "simulation",
      timestamp: "2026-11-17T12:00:00.000Z", expiresAt: "2026-11-17T12:00:30.000Z", status: "approved",
    },
  ]);
  assert.match(html, /Approvals/);
  assert.match(html, /file-change/);
  assert.match(html, />Approve<\/button>/);
  assert.doesNotMatch(html, /Approve \(simulated\)/);
  assert.doesNotMatch(html, /data-action="deny-approval" data-approval-id="sim-1"/);
  assert.match(html, /Read-only: this request is approved/);
  assert.match(html, /disabled=true/);
  assert.match(html, /default-src 'none'/); // ensures the generated document remains a restrictive webview document
});

test("renders project context import metadata and terminal states without document contents", () => {
  const html = renderCaptures([], "source", "nonce", "", "info", undefined, [], [], {
    status: "importing",
    workspace: "C:/trusted/project",
    mode: "workspace-write",
    path: "C:/trusted/project/.ai-bridge/PROJECT_CONTEXT.md",
    size: 10801,
  });
  assert.match(html, /Project Context/);
  assert.match(html, /Importing/);
  assert.match(html, /10,801 bytes/);
  assert.match(html, /Import Project Context/);
  assert.match(html, /Import Project Context/);
  assert.match(html, /data-action="import-context"/);

  const already = renderCaptures([], "source", "nonce", "", "info", undefined, [], [], { status: "already-imported", workspace: "C:/trusted/project" });
  assert.match(already, /Already imported/);
  assert.match(already, /disabled/);
});

test("uses compact collapsed sections and persists webview preferences", () => {
  const html = renderCaptures([], "source", "nonce", "", "info", undefined, [], [], { status: "idle" }, "reconnecting", { enabled: true, paused: false, workspace: "C:/trusted", conversationUrl: "https://chatgpt.com/c/1", sandboxMode: "workspace-write" });
  assert.match(html, /data-section="captures"/);
  assert.match(html, /data-section="context"/);
  assert.match(html, /data-section="history"/);
  assert.match(html, /localStorage/);
  assert.match(html, /aiDevBridge\.historyFilter/);
  assert.match(html, /Live reconnecting/);
  assert.match(html, /Automation enabled/);
  assert.match(html, /aiDevBridge\.webview\.scroll/);
  assert.match(html, /aiDevBridge\.webview\.details/);
  assert.match(html, /connectionStatus/);
  assert.doesNotMatch(html, /data-section="captures" open/);
});

test("renders bounded history filters and retry/run-again actions", () => {
  const submissions = Array.from({ length: 25 }, (_, index) => ({
    id: `submission-${index}`, captureId: `capture-${index}`, workspace: "C:/trusted/project",
    sandboxMode: "read-only", status: index === 0 ? "failed" : index === 1 ? "completed" : "running",
    error: index === 0 ? "failed safely" : undefined,
  }));
  const captures = submissions.map((submission) => ({ id: submission.captureId, text: `task ${submission.id}`, timestamp: "2026-11-18T00:00:00.000Z", conversationUrl: "https://chatgpt.com/c/1" }));
  const html = renderCaptures(captures, "source", "nonce", "", "info", undefined, [], submissions);
  assert.match(html, /Submission History/);
  assert.match(html, /25 total · showing 20/);
  assert.match(html, /All statuses/);
  assert.match(html, /Retry Failed/);
  assert.match(html, /Run Again/);
});

test("renders explicit conflict recovery beside blocked captures and history", () => {
  const submissions = [{
    id: "blocked-1", captureId: "capture-1", workspace: "C:/trusted/project", sandboxMode: "workspace-write", status: "failed",
    blocked: true, blockedReason: "Codex thread is owned by another active App Server writer.", error: "active writer",
  }];
  const captures = [{ id: "capture-1", text: "recover this task", timestamp: "2026-11-18T00:00:00.000Z", conversationUrl: "https://chatgpt.com/c/1" }];
  const html = renderCaptures(captures, "source", "nonce", "", "info", undefined, [], submissions);
  assert.match(html, /Retry After Conflict/);
  assert.match(html, /data-action="retryAfterConflict"/);
  assert.doesNotMatch(html, /Retry Failed/);
});
