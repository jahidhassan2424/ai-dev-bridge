const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { discoverCodexBinary } = require("../dist/codex-binary.js");

test("explicit Codex override is validated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-bridge-bin-"));
  const file = path.join(root, "codex.exe");
  fs.writeFileSync(file, "placeholder");
  try {
    assert.equal(discoverCodexBinary(file), path.resolve(file));
    assert.throws(() => discoverCodexBinary(path.join(root, "missing.exe")), /not found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
