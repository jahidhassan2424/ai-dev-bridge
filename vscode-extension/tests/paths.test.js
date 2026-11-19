const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { bridgeProjectRoot, resolveTokenFile } = require("../dist/paths.js");

test("default token path uses the bridge project root, not the launch directory", () => {
  const extensionRoot = path.resolve("C:/bridge-project/vscode-extension");
  assert.equal(
    resolveTokenFile(undefined, extensionRoot),
    path.resolve("C:/bridge-project/.local/ai-dev-bridge-vscode.token"),
  );
  assert.equal(bridgeProjectRoot(extensionRoot), path.resolve("C:/bridge-project"));
});

test("token path resolution is stable from unrelated working directories", () => {
  const extensionRoot = path.resolve("C:/bridge-project/vscode-extension");
  const expected = path.resolve("C:/bridge-project/.local/ai-dev-bridge-vscode.token");
  const originalCwd = process.cwd();
  process.chdir(path.parse(originalCwd).root);
  try {
    assert.equal(resolveTokenFile("${workspaceFolder}/.local/ai-dev-bridge-vscode.token", extensionRoot, path.parse(originalCwd).root), expected);
    assert.equal(resolveTokenFile(".local/ai-dev-bridge-vscode.token", extensionRoot), expected);
  } finally {
    process.chdir(originalCwd);
  }
});
