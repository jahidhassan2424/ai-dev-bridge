const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { validateWorkspace } = require("../dist/server.js");

test("canonical workspace validation rejects missing paths and symlink escapes", { concurrency: false }, (t) => {
  const original = process.env.AI_DEV_BRIDGE_ALLOWED_WORKSPACES;
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-allowed-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-outside-"));
  const linkPath = path.join(allowedRoot, "linked-outside");
  try {
    process.env.AI_DEV_BRIDGE_ALLOWED_WORKSPACES = allowedRoot;
    assert.equal(validateWorkspace(allowedRoot), fs.realpathSync(allowedRoot));
    assert.equal(validateWorkspace(path.join(allowedRoot, "missing")), undefined);
    try {
      fs.symlinkSync(outsideRoot, linkPath, "junction");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("directory symlinks are unavailable on this Windows host");
        return;
      }
      throw error;
    }
    assert.equal(validateWorkspace(linkPath), undefined);
  } finally {
    if (original === undefined) delete process.env.AI_DEV_BRIDGE_ALLOWED_WORKSPACES;
    else process.env.AI_DEV_BRIDGE_ALLOWED_WORKSPACES = original;
    fs.rmSync(allowedRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});
