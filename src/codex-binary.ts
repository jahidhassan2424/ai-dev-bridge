import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import childProcess = require("node:child_process");

function validExecutable(candidate: string): string | undefined {
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return path.resolve(candidate);
  } catch { /* Candidate is unavailable. */ }
  return undefined;
}

function extensionCandidates(): string[] {
  const roots = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-insiders", "extensions"),
    process.env.VSCODE_EXTENSIONS,
  ].filter((value): value is string => Boolean(value));
  const candidates: Array<{ file: string; sort: string }> = [];
  for (const root of roots) {
    let entries: string[];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (!/^openai\.chatgpt-/i.test(entry)) continue;
      const file = path.join(root, entry, "bin", "windows-x86_64", "codex.exe");
      if (validExecutable(file)) candidates.push({ file, sort: entry });
    }
  }
  return candidates.sort((a, b) => b.sort.localeCompare(a.sort, undefined, { numeric: true })).map((item) => item.file);
}

function discoverCodexBinary(explicit?: string): string {
  const configured = explicit || process.env.CODEX_BIN;
  if (configured) {
    const resolved = validExecutable(path.resolve(configured));
    if (!resolved) throw new Error(`Configured Codex executable was not found or is not a file: ${configured}`);
    return resolved;
  }
  for (const candidate of extensionCandidates()) return candidate;
  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const result = childProcess.execFileSync(command, ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const found = String(result).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    const resolved = found && validExecutable(found);
    if (resolved) return resolved;
  } catch { /* PATH lookup failed. */ }
  throw new Error("Codex executable not found. Install the OpenAI Codex VS Code extension or set CODEX_BIN to codex.exe.");
}

export = { discoverCodexBinary };
