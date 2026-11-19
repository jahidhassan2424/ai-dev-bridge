import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { LiveConnectionStatus, LiveEventClient } from "./live-events";
import { bridgeProjectRoot, resolveTokenFile } from "./paths";
import { ApprovalRecord, AutomationState, Capture, CodexResult, ProjectContextState, renderCaptures, SubmissionRecord } from "./render";

const activeLiveClients = new Set<LiveEventClient>();

interface CapturesResponse {
  captures: Capture[];
}

interface ApprovalsResponse {
  success: boolean;
  approvals: ApprovalRecord[];
}

interface SubmissionsResponse { success: boolean; submissions: SubmissionRecord[]; }

interface SubmissionResponse {
  success: boolean;
  submissionId?: string;
  status?: string;
  response?: string;
  threadId?: string;
  error?: string;
  elapsedMs?: number;
  latestProgressEvent?: { method?: string; timestamp?: string; type?: string } | null;
  timeoutReason?: "idle" | "max-runtime";
  runAgainRequired?: boolean;
  effectsConfirmationRequired?: boolean;
}

interface ContextImportResponse {
  success: boolean;
  context?: { status: string; path: string; threadId: string; alreadyImported?: boolean };
  error?: string;
}

function readToken(extensionRoot: string): string {
  const configured = process.env.AI_DEV_BRIDGE_TOKEN_FILE
    || vscode.workspace.getConfiguration("aiDevBridge").get<string>("tokenFile");
  const tokenFile = resolveTokenFile(
    configured,
    extensionRoot,
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (!token) throw new Error("The local bridge token file is empty.");
    return token;
  } catch (error) {
    if (error instanceof Error && error.message === "The local bridge token file is empty.") throw error;
    throw new Error(`Bridge token not found at ${tokenFile}. Start the Node bridge or set aiDevBridge.tokenFile.`);
  }
}

function isCapture(value: unknown): value is Capture {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["id", "text", "timestamp", "conversationUrl"].every((key) => typeof candidate[key] === "string");
}

function parseCaptures(value: unknown): Capture[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { captures?: unknown }).captures)) {
    throw new Error("The bridge returned an invalid captures response.");
  }
  const captures = (value as { captures: unknown[] }).captures;
  if (!captures.every(isCapture)) throw new Error("The bridge returned malformed capture data.");
  return captures;
}

async function fetchCaptures(extensionRoot: string): Promise<Capture[]> {
  const serverUrl = vscode.workspace.getConfiguration("aiDevBridge").get<string>("serverUrl")
    || "http://127.0.0.1:3000";
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/vscode/captures`, {
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}` },
  });
  if (response.status === 401) throw new Error("VS Code API authentication failed. Restart the bridge or check the token file.");
  if (!response.ok) throw new Error(`The local bridge returned HTTP ${response.status}.`);
  return parseCaptures(await response.json());
}

function serverUrl(): string {
  return (vscode.workspace.getConfiguration("aiDevBridge").get<string>("serverUrl") || "http://127.0.0.1:3000").replace(/\/$/, "");
}

async function fetchSubmission(extensionRoot: string, submissionId: string): Promise<SubmissionResponse> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/status/${encodeURIComponent(submissionId)}`, {
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}` },
  });
  const body = await response.json() as SubmissionResponse;
  if (!response.ok || body.success !== true) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
  return body;
}

function isApproval(value: unknown): value is ApprovalRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["id", "method", "type", "workspace", "connectionId", "submissionId", "timestamp", "expiresAt", "status"]
    .every((key) => typeof candidate[key] === "string" || (key === "id" && typeof candidate[key] === "number"));
}

async function fetchApprovals(extensionRoot: string): Promise<ApprovalRecord[]> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/approvals`, {
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}` },
  });
  const body = await response.json() as Partial<ApprovalsResponse>;
  if (!response.ok || body.success !== true || !Array.isArray(body.approvals) || !body.approvals.every(isApproval)) {
    throw new Error(body.success === false ? "The bridge rejected approval status access." : `The local bridge returned HTTP ${response.status}.`);
  }
  return body.approvals;
}

async function fetchSubmissions(extensionRoot: string): Promise<SubmissionRecord[]> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/submissions`, { headers: { Authorization: `Bearer ${readToken(extensionRoot)}` } });
  const body = await response.json() as Partial<SubmissionsResponse>;
  if (!response.ok || body.success !== true || !Array.isArray(body.submissions)) throw new Error(body.success === false ? "The bridge rejected submission history access." : `The local bridge returned HTTP ${response.status}.`);
  return body.submissions;
}

async function fetchAutomation(extensionRoot: string): Promise<AutomationState> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/automation`, { headers: { Authorization: `Bearer ${readToken(extensionRoot)}` } });
  const body = await response.json() as { success?: boolean; automation?: AutomationState; error?: string };
  if (!response.ok || body.success !== true || !body.automation) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
  return body.automation;
}

async function retrySubmission(extensionRoot: string, submissionId: string, confirmEffects = false): Promise<string> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/retry`, { method: "POST", headers: { Authorization: `Bearer ${readToken(extensionRoot)}`, "Content-Type": "application/json" }, body: JSON.stringify({ submissionId, confirmEffects }) });
  const body = await response.json() as { success?: boolean; submissionId?: string; error?: string };
  if (!response.ok || body.success !== true || !body.submissionId) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
  return body.submissionId;
}

async function retryAfterConflict(extensionRoot: string, submissionId: string): Promise<string> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/retry-after-conflict`, { method: "POST", headers: { Authorization: `Bearer ${readToken(extensionRoot)}`, "Content-Type": "application/json" }, body: JSON.stringify({ submissionId, confirmConflict: true }) });
  const body = await response.json() as { success?: boolean; submissionId?: string; error?: string };
  if (!response.ok || body.success !== true || !body.submissionId) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
  return body.submissionId;
}

async function decideApproval(extensionRoot: string, approval: ApprovalRecord, decision: "approve" | "deny"): Promise<void> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/approvals/decision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: approval.id, connectionId: approval.connectionId, submissionId: approval.submissionId, decision }),
  });
  const body = await response.json() as { success?: boolean; error?: string };
  if (!response.ok || body.success !== true) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
}

async function simulateApproval(extensionRoot: string, workspace: string): Promise<void> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/approvals/simulate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "command-execution", command: "echo simulated approval", reason: "UI lifecycle test", workspace }),
  });
  const body = await response.json() as { success?: boolean; error?: string };
  if (!response.ok || body.success !== true) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
}

async function submitCapture(extensionRoot: string, captureId: string, workspace: string, sandboxMode: "read-only" | "workspace-write", options: { runAgain?: boolean; confirmEffects?: boolean } = {}): Promise<SubmissionResponse> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/submit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ captureId, workspace, sandboxMode, ...options }),
  });
  const body = await response.json() as SubmissionResponse;
  if (!response.ok || body.success !== true || !body.submissionId) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
  return body;
}

async function cancelSubmission(extensionRoot: string, submissionId: string): Promise<void> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ submissionId }),
  });
  const body = await response.json() as { success?: boolean; error?: string };
  if (!response.ok || body.success !== true) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
}

async function controlAutomation(extensionRoot: string, command: "pause" | "resume" | "stop"): Promise<void> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/control`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const body = await response.json() as { success?: boolean; error?: string };
  if (!response.ok || body.success !== true) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
}

function currentTrustedWorkspace(): string | undefined {
  if (!vscode.workspace.isTrusted) return undefined;
  const activeDocument = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeDocument ? vscode.workspace.getWorkspaceFolder(activeDocument) : undefined;
  return (activeFolder || vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
}

function projectContextFile(workspace: string): { path: string; size?: number } {
  const root = fs.realpathSync(workspace);
  const candidate = path.resolve(root, ".ai-bridge", "PROJECT_CONTEXT.md");
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Project context path is outside the workspace.");
  if (!fs.existsSync(candidate)) return { path: candidate };
  const resolved = fs.realpathSync(candidate);
  const resolvedRelative = path.relative(root, resolved);
  if (resolvedRelative === ".." || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) throw new Error("Project context file resolves outside the workspace.");
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error("Project context path is not a file.");
  return { path: resolved, size: stat.size };
}

async function importProjectContext(extensionRoot: string, workspace: string, sandboxMode: "read-only" | "workspace-write"): Promise<ContextImportResponse> {
  const response = await fetch(`${serverUrl()}/api/vscode/codex/import-context`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readToken(extensionRoot)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ workspace, sandboxMode }),
  });
  const body = await response.json() as ContextImportResponse;
  if (!response.ok || body.success !== true) throw new Error(body.error || `The local bridge returned HTTP ${response.status}.`);
  return body;
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand("aiDevBridge.showCaptures", () => {
    const panel = vscode.window.createWebviewPanel(
      "aiDevBridgeCaptures",
      "AI Dev Bridge Captures",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const panelNonce = nonce();
    const extensionRoot = context.extensionUri.fsPath;
    let captures: Capture[] = [];
    let codexResult: CodexResult | undefined;
    let approvals: ApprovalRecord[] = [];
    let submissions: SubmissionRecord[] = [];
    let projectContext: ProjectContextState = { status: "idle" };
    let automation: AutomationState | undefined;
    let contextImportInProgress = false;
    let approvalDecisionInProgress = false;
    let liveStatus: LiveConnectionStatus = "connecting";
    let disposed = false;
    let reconcileTimer: NodeJS.Timeout | undefined;
    let reconcileRunning = false;
    let reconcilePending = false;

    const renderPanel = (notice = "", noticeKind = "info") => {
      panel.webview.html = renderCaptures(captures, panel.webview.cspSource, panelNonce, notice, noticeKind, codexResult, approvals, submissions, projectContext, liveStatus, automation);
    };

    const update = async (notice = "", noticeKind = "info") => {
      try {
        [captures, approvals, submissions, automation] = await Promise.all([fetchCaptures(extensionRoot), fetchApprovals(extensionRoot), fetchSubmissions(extensionRoot), fetchAutomation(extensionRoot)]);
        const latestSubmission = submissions.at(-1);
        if (latestSubmission) {
          codexResult = {
            status: latestSubmission.status === "completed" ? "completed" : latestSubmission.status === "cancelled" ? "cancelled" : latestSubmission.status === "failed" ? "failed" : "running",
            submissionId: latestSubmission.id,
            response: latestSubmission.response,
            threadId: latestSubmission.threadId,
            error: latestSubmission.error,
          };
        }
        renderPanel(notice, noticeKind);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to reach the local bridge.";
        renderPanel(message, "error");
      }
    };

    const scheduleReconcile = (delay = 100): void => {
      if (disposed) return;
      if (contextImportInProgress || approvalDecisionInProgress || reconcileRunning) {
        reconcilePending = true;
        return;
      }
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(async () => {
        reconcileTimer = undefined;
        if (disposed) return;
        reconcileRunning = true;
        try { await update(); }
        finally {
          reconcileRunning = false;
          if (reconcilePending) {
            reconcilePending = false;
            scheduleReconcile(100);
          }
        }
      }, delay);
    };

    const liveEvents = new LiveEventClient({
      url: `${serverUrl()}/api/vscode/events`,
      token: () => readToken(extensionRoot),
      onStatus: (status, retryInMs) => {
        liveStatus = status;
        panel.title = status === "connected" ? "AI Dev Bridge Captures · Live" : `AI Dev Bridge Captures · ${status}`;
        void panel.webview.postMessage({ type: "connectionStatus", status, retryInMs });
      },
      onConnected: () => scheduleReconcile(0),
      onEvent: (event) => scheduleReconcile(event.data.type === "submission.progress" ? 500 : 75),
    });
    activeLiveClients.add(liveEvents);

    const showCodexResult = (result: CodexResult, notice = "") => {
      codexResult = result;
      renderPanel(notice, result.status === "failed" || result.status === "cancelled" ? "error" : "info");
    };

    const refreshApprovals = async () => {
      try {
        approvals = await fetchApprovals(extensionRoot);
        submissions = await fetchSubmissions(extensionRoot);
        renderPanel("Approvals refreshed.", "info");
      } catch (error) {
        panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Unable to load approvals." });
      }
    };

    const watchSubmission = async (submissionId: string) => {
      if (liveStatus === "connected") {
        scheduleReconcile(0);
        return;
      }
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const status = await fetchSubmission(extensionRoot, submissionId);
        submissions = await fetchSubmissions(extensionRoot).catch(() => submissions);
        if (status.success) {
          submissions = submissions.map((item) => item.id === submissionId ? {
            ...item,
            elapsedMs: status.elapsedMs,
            latestProgressEvent: status.latestProgressEvent,
            timeoutReason: status.timeoutReason,
          } : item);
        }
        if (status.status === "running" || status.status === "starting" || status.status === "queued") continue;
        showCodexResult({ status: status.status === "cancelled" ? "cancelled" : status.status === "completed" ? "completed" : "failed", response: status.response, threadId: status.threadId, error: status.error });
        return;
      }
    };

    const executeCapture = async (capture: Capture, workspace: string, sandboxMode: "read-only" | "workspace-write", options: { runAgain?: boolean; confirmEffects?: boolean } = {}) => {
      try {
        const accepted = await submitCapture(extensionRoot, capture.id, workspace, sandboxMode, options);
        if (!accepted.submissionId) throw new Error("The bridge did not return a submission ID.");
        showCodexResult({ status: "running", submissionId: accepted.submissionId }, "Codex turn running…");
        await watchSubmission(accepted.submissionId);
      } catch (error) {
        showCodexResult({ status: "failed", error: error instanceof Error ? error.message : "Codex submission failed." });
      }
    };

    const recoverActiveWriterConflict = async (record: SubmissionRecord) => {
      if (record.status !== "failed" || record.uncertain || !record.blocked) {
        panel.webview.postMessage({ type: "notice", kind: "error", message: "Only a confirmed active-writer conflict can be retried this way." });
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        "Retry after the Codex active-writer conflict?",
        { modal: true, detail: `The bridge will reuse the same persistent thread and workspace. It will not reset or replace the thread.\n\n${record.blockedReason || record.error || record.id}` },
        "Retry After Conflict",
      );
      if (confirmation !== "Retry After Conflict") return;
      try {
        const retryId = await retryAfterConflict(extensionRoot, record.id);
        showCodexResult({ status: "running", submissionId: retryId }, "Conflict recovery queued on the existing Codex thread.");
        void watchSubmission(retryId);
      } catch (error) {
        panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Conflict recovery failed; the submission remains blocked." });
      }
    };

    panel.webview.onDidReceiveMessage(async (message: { type?: string; id?: string; submissionId?: string; requestId?: string; connectionId?: string; decision?: "approve" | "deny"; command?: "pause" | "resume" | "stop" }) => {
      if (message.type === "refresh") {
        await update();
        return;
      }
      if (message.type === "refreshApprovals") {
        await refreshApprovals();
        return;
      }
      if (message.type === "refreshSubmissions") {
        try { submissions = await fetchSubmissions(extensionRoot); renderPanel("Submission history refreshed.", "info"); }
        catch (error) { panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Unable to load submission history." }); }
        return;
      }
      if (message.type === "retrySubmission" && message.submissionId) {
        const record = submissions.find((item) => item.id === message.submissionId);
        if (record?.blocked) { await recoverActiveWriterConflict(record); return; }
        if (!record || record.status !== "failed" || record.uncertain) { panel.webview.postMessage({ type: "notice", kind: "error", message: "Only a confirmed failed submission can be retried." }); return; }
        const confirmation = await vscode.window.showWarningMessage("Retry this failed Codex submission?", { modal: true, detail: record.error || record.id }, "Retry Failed");
        if (confirmation !== "Retry Failed") return;
        try { const retryId = await retrySubmission(extensionRoot, record.id); showCodexResult({ status: "running", submissionId: retryId }, "Retry queued."); void watchSubmission(retryId); }
        catch (error) { panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Retry failed." }); }
        return;
      }
      if (message.type === "retryAfterConflict" && message.submissionId) {
        const record = submissions.find((item) => item.id === message.submissionId);
        if (!record) { panel.webview.postMessage({ type: "notice", kind: "error", message: "The blocked submission is no longer available." }); return; }
        await recoverActiveWriterConflict(record);
        return;
      }
      if (message.type === "automationControl" && message.command) {
        try {
          await controlAutomation(extensionRoot, message.command);
          panel.webview.postMessage({ type: "notice", kind: "info", message: `Automation ${message.command} requested.` });
        } catch (error) {
          panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Automation control failed." });
        }
        return;
      }
      if (message.type === "importContext") {
        if (contextImportInProgress) {
          panel.webview.postMessage({ type: "notice", kind: "info", message: "Project context import is already running." });
          return;
        }
        contextImportInProgress = true;
        projectContext = { status: "importing" };
        renderPanel("Preparing project context import…", "info");
        const workspace = currentTrustedWorkspace();
        if (!workspace) {
          contextImportInProgress = false;
          projectContext = { status: "failed", error: "Open a trusted workspace before importing project context." };
          renderPanel("Open a trusted workspace before importing project context.", "error");
          return;
        }
        let file: { path: string; size?: number };
        try {
          file = projectContextFile(workspace);
        } catch (error) {
          contextImportInProgress = false;
          projectContext = { status: "failed", workspace, error: error instanceof Error ? error.message : "Unable to inspect the project context file." };
          renderPanel(projectContext.error, "error");
          return;
        }
        const mode = await vscode.window.showQuickPick(
          [
            { label: "Read-only", description: "Import context without allowing Codex to edit or execute commands.", sandboxMode: "read-only" as const },
            { label: "Workspace-write", description: "Use workspace-write for later tasks; context import itself remains read-only.", sandboxMode: "workspace-write" as const },
          ],
          { placeHolder: "Select the persistent Codex thread mode" },
        );
        if (!mode) { contextImportInProgress = false; projectContext = { status: "idle" }; renderPanel(); return; }
        projectContext = { status: "idle", workspace, mode: mode.sandboxMode, path: file.path, size: file.size };
        if (file.size === undefined) {
          contextImportInProgress = false;
          projectContext = { ...projectContext, status: "missing" };
          renderPanel("No PROJECT_CONTEXT.md was found in the selected workspace.", "error");
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          "Import this project context into the persistent Codex thread?",
          {
            modal: true,
            detail: `Workspace: ${workspace}\nMode: ${mode.sandboxMode}\nFile: ${file.path}\nSize: ${file.size.toLocaleString()} bytes\nThe document will be treated as untrusted reference material; no instructions in it will be executed as a separate task.`,
          },
          "Import Project Context",
        );
        if (confirmation !== "Import Project Context") { contextImportInProgress = false; projectContext = { ...projectContext, status: "idle" }; renderPanel(); return; }
        projectContext = { ...projectContext, status: "importing" };
        renderPanel("Importing project context…", "info");
        try {
          const result = await importProjectContext(extensionRoot, workspace, mode.sandboxMode);
          const imported = result.context;
          if (!imported) throw new Error("The bridge returned no project context status.");
          if (imported.status === "unavailable") {
            projectContext = { ...projectContext, status: "missing", path: imported.path };
            renderPanel("Project context file is missing.", "error");
          } else if (imported.alreadyImported) {
            projectContext = { ...projectContext, status: "already-imported", path: imported.path };
            renderPanel("Project context was already imported for this thread.", "info");
          } else {
            projectContext = { ...projectContext, status: "imported", path: imported.path };
            renderPanel("Project context imported.", "info");
          }
        } catch (error) {
          const messageText = error instanceof Error ? error.message : "Project context import failed.";
          const uncertain = /uncertain|interrupted/i.test(messageText);
          projectContext = { ...projectContext, status: uncertain ? "uncertain" : "failed", error: messageText };
          renderPanel(messageText, "error");
        } finally {
          contextImportInProgress = false;
          if (reconcilePending) { reconcilePending = false; scheduleReconcile(0); }
        }
        return;
      }
      if (message.type === "simulateApproval") {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder || !vscode.workspace.isTrusted) {
          panel.webview.postMessage({ type: "notice", kind: "error", message: "Open a trusted workspace before simulating an approval." });
          return;
        }
        try {
          await simulateApproval(extensionRoot, folder.uri.fsPath);
          await refreshApprovals();
        } catch (error) {
          panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Simulation is disabled." });
        }
        return;
      }
      if (message.type === "approvalDecision" && message.requestId !== undefined && message.connectionId && message.submissionId && (message.decision === "approve" || message.decision === "deny")) {
        if (approvalDecisionInProgress) {
          panel.webview.postMessage({ type: "notice", kind: "info", message: "An approval decision is already in progress." });
          return;
        }
        const approval = approvals.find((item) => String(item.id) === String(message.requestId) && item.connectionId === message.connectionId && item.submissionId === message.submissionId);
        if (!approval) {
          panel.webview.postMessage({ type: "notice", kind: "error", message: "Approval is stale or no longer available." });
          return;
        }
        approvalDecisionInProgress = true;
        try {
          const confirmed = await vscode.window.showWarningMessage(
            `${message.decision === "approve" ? "Approve" : "Deny"} ${approval.type} request ${String(approval.id)}?`,
            { modal: true, detail: approval.command || approval.target || approval.reason || "No request details supplied." },
            message.decision === "approve" ? "Approve" : "Deny",
          );
          if (!confirmed) return;
          await decideApproval(extensionRoot, approval, message.decision);
          await refreshApprovals();
        } catch (error) {
          panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Approval decision failed." });
        } finally {
          approvalDecisionInProgress = false;
          if (reconcilePending) { reconcilePending = false; scheduleReconcile(0); }
        }
        return;
      }
      if (message.type === "copy") {
        const capture = captures.find((item) => item.id === message.id);
        if (!capture) {
          panel.webview.postMessage({ type: "notice", kind: "error", message: "Capture is no longer available." });
          return;
        }
        await vscode.env.clipboard.writeText(capture.text);
        panel.webview.postMessage({ type: "notice", kind: "info", message: "Response copied to the clipboard." });
        return;
      }
      if (message.type === "send") {
        const capture = captures.find((item) => item.id === message.id);
        if (!capture) {
          panel.webview.postMessage({ type: "notice", kind: "error", message: "Capture is no longer available." });
          return;
        }
        if (!vscode.workspace.isTrusted) {
          showCodexResult({ status: "failed", error: "The current VS Code workspace is not trusted." });
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          "Send this captured response to Codex?",
          { modal: true, detail: capture.text },
          "Send",
        );
        if (confirmation !== "Send") return;
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) {
          showCodexResult({ status: "failed", error: "Open and select a trusted workspace before sending to Codex." });
          return;
        }
        const selected = await vscode.window.showQuickPick(
          folders.flatMap((folder) => [
            { label: `${folder.name} (workspace-write)`, description: `${folder.uri.fsPath} — Codex may edit and run local commands`, workspace: folder.uri.fsPath, sandboxMode: "workspace-write" as const },
            { label: `${folder.name} (read-only)`, description: `${folder.uri.fsPath} — Codex cannot edit or execute commands`, workspace: folder.uri.fsPath, sandboxMode: "read-only" as const },
          ]),
          { placeHolder: "Select the trusted workspace and execution mode" },
        );
        if (!selected) return;
        if (selected.sandboxMode === "workspace-write") {
          const writeConfirmation = await vscode.window.showWarningMessage(
            "Allow Codex to edit files and run local development commands in this trusted workspace?",
            { modal: true, detail: selected.workspace },
            "Enable workspace-write",
          );
          if (writeConfirmation !== "Enable workspace-write") return;
        }
        const prior = submissions
          .filter((item) => item.captureId === capture.id)
          .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
        if (prior?.blocked) {
          await recoverActiveWriterConflict(prior);
          return;
        }
        if (prior?.status === "failed" && !prior.uncertain) {
          let confirmEffects = false;
          if (prior.executionStarted) {
            const confirmation = await vscode.window.showWarningMessage(
              "Codex began execution before failing. Prior file or command effects may remain; retry anyway?",
              { modal: true, detail: prior.error || prior.id },
              "Retry With Effects Warning",
            );
            if (confirmation !== "Retry With Effects Warning") return;
            confirmEffects = true;
          }
          try { const retryId = await retrySubmission(extensionRoot, prior.id, confirmEffects); showCodexResult({ status: "running", submissionId: retryId }, "Retry queued."); void watchSubmission(retryId); }
          catch (error) { panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Retry failed." }); }
          return;
        }
        const runAgain = prior?.status === "completed";
        if (runAgain) {
          const confirmation = await vscode.window.showWarningMessage("This capture completed previously. Run the Codex task again?", { modal: true, detail: "This may repeat edits or commands.", }, "Run Again");
          if (confirmation !== "Run Again") return;
        }
        void executeCapture(capture, selected.workspace, selected.sandboxMode, { runAgain });
        return;
      }
      if (message.type === "cancel" && message.submissionId) {
        try {
          await cancelSubmission(extensionRoot, message.submissionId);
          panel.webview.postMessage({ type: "notice", kind: "info", message: "Cancellation requested." });
        } catch (error) {
          panel.webview.postMessage({ type: "notice", kind: "error", message: error instanceof Error ? error.message : "Unable to cancel Codex turn." });
        }
      }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
      disposed = true;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      liveEvents.stop();
      activeLiveClients.delete(liveEvents);
    }, null, context.subscriptions);
    void update();
    liveEvents.start();
  });
  context.subscriptions.push(command);
}

export function deactivate(): void {
  for (const client of activeLiveClients) client.stop();
  activeLiveClients.clear();
}
