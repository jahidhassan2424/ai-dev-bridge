# AI Dev Bridge VS Code companion

The companion displays captures received by the local bridge and supports an explicit **Send to Codex** action.

## Install for development

1. Start the server from the repository root with `npm run build; npm start`.
2. From this directory, run `npm install` and `npm run build`.
3. Package with `npm run package`, then install the generated `.vsix` from VS Code's **Extensions: Install from VSIX...** command.
4. Run **AI Dev Bridge: Show Captures** from the Command Palette.

The server creates `.local/ai-dev-bridge-vscode.token` on first start. The file is ignored by Git. The extension resolves its default relative to the project root containing `vscode-extension`, so its launch directory does not matter. Set `AI_DEV_BRIDGE_TOKEN_FILE` for the server, or `aiDevBridge.tokenFile` for the extension, to override the path.

The panel uses authenticated local endpoints on `127.0.0.1`. Refresh handles offline and authentication errors; Copy writes only the selected response to the VS Code clipboard.

The **Project context** section uses the currently active trusted workspace. Select read-only or workspace-write, review the workspace, canonical context path, and file size, then confirm **Import Project Context**. The import endpoint resumes the workspace-scoped persistent thread and reports imported, already imported, missing, failed, or uncertain states. The context document is never displayed in logs or executed as a separate task. If resuming the saved thread fails, the bridge reports the failure and does not replace the thread.

Before sending, the extension shows the complete captured text for confirmation and requires a trusted workspace selection. The server accepts only a capture ID (never browser-provided prompt text), validates the workspace against `AI_DEV_BRIDGE_ALLOWED_WORKSPACES`, and runs one persistent read-only Codex session with network access disabled. By default, the allowed workspace is the bridge project root; set `AI_DEV_BRIDGE_ALLOWED_WORKSPACES` to a path-delimited list of trusted workspace roots to allow other projects.

The response panel reports queued, starting, running, completed, failed, and cancelled states, retains submission history, and offers **Retry Failed** only for confirmed failures. Workspace-write is available only for an explicitly selected trusted workspace; read-only remains available. Network access stays disabled and live approvals remain default-deny until explicitly handled in the companion. Codex output is escaped as inert webview text. The extension does not auto-submit captures.
