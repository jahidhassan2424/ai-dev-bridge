import * as path from "node:path";

export const defaultTokenRelativePath = path.join(".local", "ai-dev-bridge-vscode.token");
const workspaceDefault = "${workspaceFolder}/.local/ai-dev-bridge-vscode.token";

export function bridgeProjectRoot(extensionRoot: string): string {
  return path.resolve(extensionRoot, "..");
}

export function resolveTokenFile(
  configuredPath: string | undefined,
  extensionRoot: string,
  workspaceRoot?: string,
): string {
  const projectRoot = bridgeProjectRoot(extensionRoot);
  const configured = configuredPath?.trim();
  if (!configured || configured === workspaceDefault) {
    return path.join(projectRoot, defaultTokenRelativePath);
  }
  if (configured.includes("${workspaceFolder}")) {
    return configured.replaceAll("${workspaceFolder}", workspaceRoot || projectRoot);
  }
  return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
}
