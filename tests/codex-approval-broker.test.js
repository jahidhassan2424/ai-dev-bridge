const assert = require("node:assert/strict");
const test = require("node:test");
const { ApprovalBroker } = require("../dist/codex-approval-broker.js");

test("default approval handling records and declines without leaving pending work", async () => {
  const broker = new ApprovalBroker("C:/trusted/workspace");
  const decision = await broker.request(7, "item/fileChange/requestApproval", {
    grantRoot: "C:/trusted/workspace",
    reason: "edit requested",
  });
  assert.deepEqual(decision, { decision: "decline" });
  assert.deepEqual(broker.pendingRequests(), []);
  assert.equal(broker.get(7).status, "denied");
  assert.equal(broker.get(7).target, "C:/trusted/workspace");
});

test("pending approval is visible and approve remains disabled", async () => {
  const broker = new ApprovalBroker("C:/trusted/workspace", "test-connection", 1_000, false);
  const decisionPromise = broker.request("request-1", "item/commandExecution/requestApproval", {
    cwd: "C:/trusted/workspace",
    command: ["npm", "test"],
    reason: "run verification",
  });
  assert.deepEqual(broker.pendingRequests()[0], {
    id: "request-1",
    method: "item/commandExecution/requestApproval",
    type: "command-execution",
    target: "C:/trusted/workspace",
    command: "npm test",
    reason: "run verification",
    workspace: "C:/trusted/workspace",
    connectionId: "test-connection",
    submissionId: "unknown",
    timestamp: broker.pendingRequests()[0].timestamp,
    expiresAt: broker.pendingRequests()[0].expiresAt,
    status: "pending",
  });
  assert.deepEqual(broker.approve("request-1"), { decision: "decline" });
  assert.deepEqual(await decisionPromise, { decision: "decline" });
  assert.deepEqual(broker.pendingRequests(), []);
  assert.equal(broker.get("request-1").status, "denied");
});

test("pending approval times out and is declined", async () => {
  const broker = new ApprovalBroker("C:/trusted/workspace", "test-connection", 10, false);
  const decision = await broker.request(9, "item/permissions/requestApproval", { reason: "outside workspace" });
  assert.deepEqual(decision, { decision: "decline" });
  assert.deepEqual(broker.pendingRequests(), []);
  assert.equal(broker.get(9).status, "expired");
});

test("workspace-write approval accepts only an explicit live decision", async () => {
  const broker = new ApprovalBroker("C:/trusted/workspace", "live-connection", 1_000, false, false, true);
  const decision = broker.request("live-1", "item/fileChange/requestApproval", { path: "C:/trusted/workspace/file.txt" });
  assert.equal(broker.get("live-1").status, "pending");
  assert.deepEqual(broker.approve("live-1"), { decision: "accept" });
  assert.deepEqual(await decision, { decision: "accept" });
  assert.equal(broker.get("live-1").status, "approved");
});
