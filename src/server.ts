import crypto = require("node:crypto");
import fs = require("node:fs");
import http = require("node:http");
import path = require("node:path");
import codexSession = require("./codex-session-manager");
import approvalBroker = require("./codex-approval-broker");
import conversation = require("./conversation");

const host = "127.0.0.1";
const port = 3000;
const extensionOrigin = "chrome-extension://flpkdgbjocacgdlnfhinaeicigegfklb";
const maxRequestBodySize = 1_048_576;
const maxCaptureIdLength = 256;
const maxCaptureTextLength = 900_000;
const maxConversationUrlLength = 2_048;
const maxRecentCaptures = 50;
const maxCodexResponseLength = 900_000;
const bridgeProjectRoot = path.resolve(__dirname, "..");
const defaultVscodeTokenFile = path.join(bridgeProjectRoot, ".local", "ai-dev-bridge-vscode.token");
const defaultChromeTokenFile = path.join(bridgeProjectRoot, ".local", "ai-dev-bridge-chrome.token");
const maxCodexSubmissionIdLength = 128;
const maxWorkspacePathLength = 4_096;
const submissionStateFile = path.join(bridgeProjectRoot, ".local", "codex-submissions.json");
const automationStateFile = path.join(bridgeProjectRoot, ".local", "automation-state.json");

export interface CapturePayload {
  id: string;
  text: string;
  timestamp: string;
  conversationUrl: string;
}

export interface CodexResult {
  submissionId: string;
  threadId: string;
  response: string;
  status: "completed";
  timestamp: string;
  sourceConversationUrl: string;
}

interface CodexSessionLike {
  connect(): Promise<void>;
  runPrompt(prompt: string): Promise<{ threadId: string; response: string; status: string; events?: unknown[]; elapsedMs?: number; latestProgressEvent?: unknown | null; timeoutReason?: "idle" | "max-runtime" }>;
  importProjectContext?(): Promise<{ status: string; path: string; threadId: string; alreadyImported?: boolean }>;
  cancelCurrentTurn(): void;
  shutdown?(): Promise<void>;
  getPendingApprovals?(): unknown[];
  getAllApprovals?(): any[];
  getConnectionId?(): string;
  setApprovalContext?(submissionId: string): void;
  approveApproval?(id: string | number): { decision: "accept" | "decline" };
  denyApproval?(id: string | number): { decision: "decline" };
  getStatus?(): { turnElapsedMs?: number; latestProgressEvent?: unknown | null; timeoutReason?: "idle" | "max-runtime" | null; turn?: string };
}

interface CodexSessionFactoryOptions {
  workspaceRoot: string;
  sandboxMode: "read-only" | "workspace-write";
  allowApprovals: boolean;
}

interface CodexSubmission {
  id: string;
  captureId: string;
  workspace: string;
  sandboxMode: "read-only" | "workspace-write";
  status: "captured" | "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
  response?: string;
  threadId?: string;
  error?: string;
  uncertain?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  executionStarted?: boolean;
  parentSubmissionId?: string;
  events?: unknown[];
  sourceConversationUrl?: string;
  conversationKey?: string;
  elapsedMs?: number;
  latestProgressEvent?: unknown | null;
  timeoutReason?: "idle" | "max-runtime";
  captureSnapshot?: CapturePayload;
  manager?: CodexSessionLike;
}

interface AutomationState {
  enabled: boolean;
  paused: boolean;
  stopped: boolean;
  stoppedReason: "task-completed" | "manual" | null;
  stoppedAt: string | null;
  workspace: string | null;
  conversationUrl: string | null;
  sandboxMode: "read-only" | "workspace-write";
}

function defaultAutomationState(): AutomationState {
  return { enabled: false, paused: false, stopped: false, stoppedReason: null, stoppedAt: null, workspace: null, conversationUrl: null, sandboxMode: "workspace-write" };
}

function writeAutomationState(state: AutomationState, filePath = automationStateFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows may ignore mode bits. */ }
}

function readAutomationState(filePath = automationStateFile): AutomationState {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AutomationState>;
    if (!value || typeof value !== "object" || (value.workspace !== null && typeof value.workspace !== "string") || (value.conversationUrl !== null && typeof value.conversationUrl !== "string")) return defaultAutomationState();
    return { ...defaultAutomationState(), ...value, enabled: value.enabled === true, paused: value.paused === true, stopped: value.stopped === true, stoppedReason: value.stoppedReason === "task-completed" || value.stoppedReason === "manual" ? value.stoppedReason : null, stoppedAt: typeof value.stoppedAt === "string" ? value.stoppedAt : null, sandboxMode: value.sandboxMode === "read-only" ? "read-only" : "workspace-write" };
  } catch { return defaultAutomationState(); }
}

function hasTerminalStopMarker(value: string): boolean {
  let fenced = false;
  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && /^\s*AI_BRIDGE_STOP\s*$/.test(line)) return true;
  }
  return false;
}

function writeSubmissionState(submissions: Map<string, CodexSubmission>, filePath = submissionStateFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const records = [...submissions.values()].slice(-100).map(({ manager, ...submission }) => submission);
  fs.writeFileSync(filePath, `${JSON.stringify(records)}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows may ignore mode bits. */ }
}

function readSubmissionState(filePath = submissionStateFile): CodexSubmission[] {
  try {
    const records = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(records)) return [];
    return records.filter((record): record is CodexSubmission => record && typeof record.id === "string" && typeof record.captureId === "string" && typeof record.workspace === "string" && (record.sandboxMode === "read-only" || record.sandboxMode === "workspace-write") && ["captured", "queued", "starting", "running", "completed", "failed", "cancelled"].includes(record.status))
      .map((record) => ["captured", "queued", "starting", "running"].includes(record.status) ? { ...record, status: "failed", uncertain: true, error: "Bridge restarted before execution was confirmed; work was not replayed." } : record);
  } catch { return []; }
}

function captureSubmissionKey(capture: CapturePayload): string {
  return `${conversation.normalizeConversationUrl(capture.conversationUrl)?.path || "invalid"}\0${capture.id}`;
}

function validateCapturePayload(payload: unknown): CapturePayload | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > maxCaptureIdLength ||
    typeof candidate.text !== "string" || candidate.text.length === 0 || candidate.text.length > maxCaptureTextLength ||
    typeof candidate.timestamp !== "string" || Number.isNaN(Date.parse(candidate.timestamp)) ||
    typeof candidate.conversationUrl !== "string" || candidate.conversationUrl.length === 0 ||
    candidate.conversationUrl.length > maxConversationUrlLength
  ) return undefined;

  const identity = conversation.normalizeConversationUrl(candidate.conversationUrl);
  if (!identity) return undefined;

  return {
    id: candidate.id,
    text: candidate.text,
    timestamp: candidate.timestamp,
    conversationUrl: identity.url,
  };
}

function createCaptureStore(): {
  add(capture: CapturePayload): boolean;
  latest(): CapturePayload[];
  status(): { count: number; latestId: string | null; latestTimestamp: string | null };
  setCodexResult(result: CodexResult): boolean;
  latestCodexResult(conversationUrl?: string): CodexResult | null;
} {
  const captures: CapturePayload[] = [];
  const ids = new Set<string>();
  let codexResult: CodexResult | null = null;
  return {
    add(capture) {
      if (ids.has(capture.id)) return false;
      ids.add(capture.id);
      captures.unshift(capture);
      if (captures.length > maxRecentCaptures) {
        const removed = captures.pop();
        if (removed) ids.delete(removed.id);
      }
      return true;
    },
    latest: () => [...captures],
    status: () => ({
      count: captures.length,
      latestId: captures[0]?.id || null,
      latestTimestamp: captures[0]?.timestamp || null,
    }),
    setCodexResult(result) {
      if (result.response.length > maxCodexResponseLength) return false;
      codexResult = { ...result };
      return true;
    },
    latestCodexResult: (conversationUrl?: string) => {
      if (!codexResult) return null;
      if (conversationUrl && !conversation.sameConversation(codexResult.sourceConversationUrl, conversationUrl)) return null;
      return { ...codexResult };
    },
  };
}

function sendJson(response: http.ServerResponse, statusCode: number, body: Record<string, unknown>, origin?: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...(origin === extensionOrigin ? { "Access-Control-Allow-Origin": extensionOrigin, Vary: "Origin" } : {}),
  });
  response.end(JSON.stringify(body));
}

function sendCorsOptions(response: http.ServerResponse, methods: string, headers = "Content-Type"): void {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": extensionOrigin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": headers,
    Vary: "Origin",
  });
  response.end();
}

function readChromeToken(filePath = process.env.AI_DEV_BRIDGE_CHROME_TOKEN_FILE || defaultChromeTokenFile): string | null {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(bridgeProjectRoot, filePath);
  try {
    const token = fs.readFileSync(resolved, "utf8").trim();
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

function writeChromeToken(token: string, filePath = process.env.AI_DEV_BRIDGE_CHROME_TOKEN_FILE || defaultChromeTokenFile): void {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(bridgeProjectRoot, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(resolved, 0o600); } catch { /* Some filesystems ignore mode bits. */ }
}

function resolveVscodeTokenFile(filePath = process.env.AI_DEV_BRIDGE_TOKEN_FILE || defaultVscodeTokenFile): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(bridgeProjectRoot, filePath);
}

function allowedWorkspaceRoots(): string[] {
  const configured = process.env.AI_DEV_BRIDGE_ALLOWED_WORKSPACES;
  return (configured ? configured.split(path.delimiter) : [bridgeProjectRoot])
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try { return fs.realpathSync(path.resolve(item)); } catch { return ""; }
    })
    .filter(Boolean);
}

function validateWorkspace(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxWorkspacePathLength || !path.isAbsolute(value)) return undefined;
  const resolved = path.resolve(value);
  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); } catch { return undefined; }
  if (!stat.isDirectory()) return undefined;
  let canonical: string;
  try { canonical = fs.realpathSync(resolved); } catch { return undefined; }
  if (!allowedWorkspaceRoots().some((root) => {
    const relative = path.relative(root, canonical);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  })) return undefined;
  return canonical;
}

function workspaceValidationMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return "Trusted workspace is required.";
  if (!path.isAbsolute(value)) return "Workspace path must be absolute.";
  let stat: fs.Stats;
  try { stat = fs.statSync(path.resolve(value)); } catch { return "Workspace path does not exist."; }
  if (!stat.isDirectory()) return "Workspace path is not a directory.";
  if (!validateWorkspace(value)) return "Workspace is not trusted or allowlisted. Add it to AI_DEV_BRIDGE_ALLOWED_WORKSPACES and restart the bridge.";
  return undefined;
}

function validateCodexSubmission(value: unknown): { captureId: string; workspace: string; sandboxMode: "read-only" | "workspace-write" } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.captureId !== "string" || candidate.captureId.length === 0 || candidate.captureId.length > maxCodexSubmissionIdLength) return undefined;
  const workspace = validateWorkspace(candidate.workspace);
  if (!workspace) return undefined;
  const configuredMode = process.env.AI_DEV_BRIDGE_DEFAULT_SANDBOX === "read-only" ? "read-only" : "workspace-write";
  const sandboxMode = candidate.sandboxMode === "read-only" || candidate.sandboxMode === "workspace-write"
    ? candidate.sandboxMode
    : configuredMode;
  return { captureId: candidate.captureId, workspace, sandboxMode };
}

function loadOrCreateVscodeToken(filePath = process.env.AI_DEV_BRIDGE_TOKEN_FILE || defaultVscodeTokenFile): string {
  filePath = resolveVscodeTokenFile(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Create the token below.
  }

  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(filePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some filesystems do not support Unix permission bits.
  }
  return token;
}

function hasValidVscodeToken(request: http.IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function hasValidBearerToken(request: http.IncomingMessage, expectedToken: string | null): boolean {
  if (!expectedToken) return false;
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function readJson(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxRequestBodySize && !tooLarge) {
        tooLarge = true;
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); }
    });
  });
}

function createServer(
  store = createCaptureStore(),
  vscodeToken = loadOrCreateVscodeToken(),
  sessionFactory: (options: CodexSessionFactoryOptions) => CodexSessionLike = (options) => new codexSession.CodexSessionManager(options),
  chromeTokenFile = process.env.AI_DEV_BRIDGE_CHROME_TOKEN_FILE || defaultChromeTokenFile,
  simulationMode = process.env.AI_DEV_BRIDGE_SIMULATED_APPROVALS === "true",
  stateFile = process.env.AI_DEV_BRIDGE_STATE_FILE || submissionStateFile,
  automationFile = process.env.AI_DEV_BRIDGE_AUTOMATION_STATE_FILE || (stateFile === submissionStateFile ? automationStateFile : `${stateFile}.automation`),
): http.Server {
  let chromeToken = readChromeToken(chromeTokenFile);
  const sessions = new Map<string, CodexSessionLike>();
  const submissions = new Map<string, CodexSubmission>();
  const captureSubmissions = new Map<string, string>();
  const eventClients = new Set<http.ServerResponse>();
  const eventHeartbeats = new Map<http.ServerResponse, NodeJS.Timeout>();
  let nextEventId = 1;
  let activeSubmissionId: string | undefined;
  const automation: AutomationState = readAutomationState(automationFile);
  for (const submission of readSubmissionState(stateFile)) {
    submissions.set(submission.id, submission);
    captureSubmissions.set(`${submission.conversationKey || conversation.normalizeConversationUrl(submission.sourceConversationUrl || "")?.path || "invalid"}\0${submission.captureId}`, submission.id);
    if (submission.status === "completed" && submission.response && submission.threadId) {
      store.setCodexResult({ submissionId: submission.id, threadId: submission.threadId, response: submission.response, status: "completed", timestamp: new Date().toISOString(), sourceConversationUrl: submission.sourceConversationUrl || "https://chatgpt.com/" });
    }
  }
  const simulatedBroker = simulationMode
    ? new approvalBroker.ApprovalBroker(bridgeProjectRoot, "simulation-connection", 30_000, false, true)
    : undefined;
  simulatedBroker?.setSubmissionId("simulation");
  let nextSimulationId = 1;

  const emitEvent = (type: string, metadata: Record<string, unknown> = {}): void => {
    const message = `id: ${nextEventId++}\nevent: bridge\ndata: ${JSON.stringify({ type, timestamp: new Date().toISOString(), ...metadata })}\n\n`;
    for (const client of eventClients) {
      try { client.write(message); } catch { eventClients.delete(client); }
    }
  };

  const automationSnapshot = (): AutomationState & { activeSubmissionId: string | null } => ({ ...automation, activeSubmissionId: activeSubmissionId || null });
  const persistAutomation = (): void => writeAutomationState(automation, automationFile);
  const publishAutomation = (): void => emitEvent("automation.changed", { ...automationSnapshot() });
  const stopAutomation = (reason: "task-completed" | "manual"): void => {
    if (automation.stopped) return;
    automation.enabled = false;
    automation.paused = false;
    automation.stopped = true;
    automation.stoppedReason = reason;
    automation.stoppedAt = new Date().toISOString();
    const active = activeSubmissionId ? submissions.get(activeSubmissionId) : undefined;
    if (active && automation.conversationUrl && active.sourceConversationUrl && conversation.sameConversation(automation.conversationUrl, active.sourceConversationUrl)) {
      active.manager?.cancelCurrentTurn();
    }
  };

  const getSession = (workspace: string, sandboxMode: "read-only" | "workspace-write"): CodexSessionLike => {
    const sessionKey = `${workspace}\0${sandboxMode}`;
    const existing = sessions.get(sessionKey);
    if (existing) return existing;
    const created = sessionFactory({ workspaceRoot: workspace, sandboxMode, allowApprovals: sandboxMode === "workspace-write" });
    sessions.set(sessionKey, created);
    return created;
  };

  const captureForSubmission = (submission: CodexSubmission): CapturePayload | undefined => {
    const inMemory = store.latest().find((capture) => capture.id === submission.captureId);
    if (inMemory && conversation.sameConversation(inMemory.conversationUrl, submission.sourceConversationUrl)) return inMemory;
    const persisted = validateCapturePayload(submission.captureSnapshot);
    return persisted && conversation.sameConversation(persisted.conversationUrl, submission.sourceConversationUrl) ? persisted : undefined;
  };

  const activeBridgeTurn = (): string | undefined => {
    if (activeSubmissionId) return activeSubmissionId;
    const activeSession = [...sessions.values()].find((session) => session.getStatus?.().turn === "running");
    return activeSession ? "bridge-session" : undefined;
  };

  const isActiveWriterConflict = (submission: CodexSubmission | undefined): boolean => Boolean(
    submission?.blocked && /active writer|thread (?:ownership|is owned)/i.test(submission.blockedReason || submission.error || ""),
  );

  const runSubmission = async (submission: CodexSubmission, capture: CapturePayload): Promise<void> => {
    let manager: CodexSessionLike | undefined;
    let progressTimer: NodeJS.Timeout | undefined;
    const approvalStatuses = new Map<string, string>();
    const publishRuntimeState = (): void => {
      if (!manager) return;
      const status = manager.getStatus?.();
      if (status?.turnElapsedMs !== undefined) submission.elapsedMs = status.turnElapsedMs;
      if (status?.latestProgressEvent !== undefined) submission.latestProgressEvent = status.latestProgressEvent;
      emitEvent("submission.progress", { submissionId: submission.id, status: submission.status });
      for (const approval of manager.getAllApprovals?.() || []) {
        const key = String(approval.id);
        const previous = approvalStatuses.get(key);
        if (previous === approval.status) continue;
        approvalStatuses.set(key, approval.status);
        emitEvent(previous === undefined && approval.status === "pending" ? "approval.requested" : "approval.resolved", {
          requestId: key,
          submissionId: submission.id,
          status: approval.status,
        });
      }
    };
    try {
      submission.status = "starting";
      writeSubmissionState(submissions, stateFile);
      emitEvent("submission.started", { submissionId: submission.id, status: submission.status });
      manager = getSession(submission.workspace, submission.sandboxMode);
      submission.manager = manager;
      await manager.connect();
      submission.executionStarted = true;
      submission.status = "running";
      writeSubmissionState(submissions, stateFile);
      emitEvent("submission.started", { submissionId: submission.id, status: submission.status });
      manager.setApprovalContext?.(submission.id);
      progressTimer = setInterval(publishRuntimeState, 750);
      const result = await manager.runPrompt(capture.text);
      submission.threadId = result.threadId;
      if (result.events) submission.events = result.events;
      if (result.elapsedMs !== undefined) submission.elapsedMs = result.elapsedMs;
      if (result.latestProgressEvent !== undefined) submission.latestProgressEvent = result.latestProgressEvent;
      if (result.timeoutReason) submission.timeoutReason = result.timeoutReason;
      if (result.status === "completed") {
        submission.status = "completed";
        submission.response = result.response;
        const stored = store.setCodexResult({
          submissionId: submission.id,
          threadId: result.threadId,
          response: result.response,
          status: "completed",
          timestamp: new Date().toISOString(),
          sourceConversationUrl: capture.conversationUrl,
        });
        if (!stored) submission.error = "Codex response exceeded the local result size limit and was not stored.";
      } else if (result.status === "cancelled" || result.status === "interrupted") {
        submission.status = "cancelled";
        submission.error = "Codex turn was cancelled.";
      } else {
        submission.status = "failed";
        submission.error = `Codex turn ended with status ${result.status}.`;
      }
    } catch (error) {
      submission.status = "failed";
      if (error instanceof Error && /spawn .*ENOENT/i.test(error.message)) submission.executionStarted = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/active writer|already has an active writer/i.test(errorMessage)) {
        submission.blocked = true;
        submission.blockedReason = "Codex thread is owned by another active App Server writer. Reconcile the other session before retrying.";
        submission.error = submission.blockedReason;
      }
      const diagnostics = manager?.getStatus?.();
      if (diagnostics?.timeoutReason) {
        submission.uncertain = true;
        submission.timeoutReason = diagnostics.timeoutReason;
        if (diagnostics.turnElapsedMs !== undefined) submission.elapsedMs = diagnostics.turnElapsedMs;
        if (diagnostics.latestProgressEvent !== undefined) submission.latestProgressEvent = diagnostics.latestProgressEvent;
        submission.error = `Codex turn timed out (${diagnostics.timeoutReason}); final state is unknown. No retry was started.`;
      } else if (!submission.blocked) {
        submission.error = errorMessage || "Codex execution failed.";
      }
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      publishRuntimeState();
      if (activeSubmissionId === submission.id) activeSubmissionId = undefined;
      writeSubmissionState(submissions, stateFile);
      emitEvent(submission.uncertain ? "submission.uncertain" : `submission.${submission.status}`, {
        submissionId: submission.id,
        status: submission.status,
      });
      console.log("Codex submission", {
        id: submission.id,
        captureId: submission.captureId,
        status: submission.status,
        threadId: submission.threadId || null,
      });
    }
  };

  const startSubmission = (capture: CapturePayload, workspace: string, sandboxMode: "read-only" | "workspace-write", parentSubmissionId?: string, allowExisting = false): CodexSubmission | undefined => {
    if ((!allowExisting && captureSubmissions.has(captureSubmissionKey(capture))) || activeSubmissionId) return undefined;
    const submission: CodexSubmission = {
      id: crypto.randomBytes(16).toString("hex"), captureId: capture.id, workspace, sandboxMode, status: "queued", sourceConversationUrl: capture.conversationUrl, captureSnapshot: { ...capture },
    };
    const conversationKey = conversation.normalizeConversationUrl(capture.conversationUrl)?.path;
    if (conversationKey) submission.conversationKey = conversationKey;
    if (parentSubmissionId) submission.parentSubmissionId = parentSubmissionId;
    submissions.set(submission.id, submission);
    captureSubmissions.set(captureSubmissionKey(capture), submission.id);
    activeSubmissionId = submission.id;
    writeSubmissionState(submissions, stateFile);
    emitEvent("submission.queued", { submissionId: submission.id, status: submission.status });
    void runSubmission(submission, capture);
    return submission;
  };

  const conversationMatches = (configured: string | null, incoming: string): boolean => {
    if (!configured) return true;
    return conversation.sameConversation(configured, incoming);
  };

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" }, origin);
      return;
    }

    const requestPath = request.url?.split("?")[0];
    if (requestPath === "/api/codex/pair" || requestPath === "/api/codex/latest" || requestPath === "/api/codex/control" || requestPath === "/api/codex/approvals" || requestPath === "/api/codex/approval-decision") {
      if (requestPath === "/api/codex/pair") {
        if (origin !== extensionOrigin) {
          sendJson(response, 403, { success: false, error: "Forbidden origin" }, origin);
          return;
        }
        if (request.method === "OPTIONS") {
          sendCorsOptions(response, "GET, POST, OPTIONS", "Content-Type, Authorization");
          return;
        }
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST, OPTIONS");
          sendJson(response, 405, { success: false, error: "Method not allowed" }, origin);
          return;
        }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          if (typeof payload !== "object" || payload === null || (payload as Record<string, unknown>).confirm !== true) {
            sendJson(response, 400, { success: false, error: "Explicit pairing confirmation required" }, origin);
            return;
          }
          chromeToken = crypto.randomBytes(32).toString("hex");
          writeChromeToken(chromeToken, chromeTokenFile);
          sendJson(response, 200, { success: true, paired: true, token: chromeToken }, origin);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Pairing failed";
          sendJson(response, message === "Request body too large" ? 413 : 500, { success: false, error: message }, origin);
        }
        return;
      }

      if (origin && origin !== extensionOrigin) {
        sendJson(response, 403, { success: false, error: "Forbidden origin" }, origin);
        return;
      }
      if (request.method === "OPTIONS") {
        if (origin !== extensionOrigin) {
          sendJson(response, 403, { success: false, error: "Forbidden origin" }, origin);
          return;
        }
        const methods = request.url === "/api/codex/control" || request.url === "/api/codex/approval-decision" ? "GET, POST, OPTIONS" : "GET, OPTIONS";
        sendCorsOptions(response, methods, "Content-Type, Authorization");
        return;
      }

      if (!hasValidBearerToken(request, chromeToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { success: false, error: chromeToken ? "Invalid pairing token" : "Chrome pairing required" }, origin);
        return;
      }
      if (requestPath === "/api/codex/approvals") {
        if (request.method !== "GET") { response.setHeader("Allow", "GET, OPTIONS"); sendJson(response, 405, { success: false, error: "Method not allowed" }, origin); return; }
        const approvals = [...sessions.values()].flatMap((session) => session.getAllApprovals?.() || []);
        sendJson(response, 200, { success: true, approvals }, origin);
        return;
      }
      if (requestPath === "/api/codex/approval-decision") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST, OPTIONS"); sendJson(response, 405, { success: false, error: "Method not allowed" }, origin); return; }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const requestId = typeof payload.requestId === "string" || typeof payload.requestId === "number" ? payload.requestId : undefined;
          const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
          const submissionId = typeof payload.submissionId === "string" ? payload.submissionId : "";
          const decision = payload.decision === "approve" || payload.decision === "deny" ? payload.decision : undefined;
          const session = [...sessions.values()].find((candidate) => candidate.getConnectionId?.() === connectionId);
          const record = session?.getAllApprovals?.().find((candidate) => String(candidate.id) === String(requestId));
          if (requestId === undefined || !session || !record || record.connectionId !== connectionId || record.submissionId !== submissionId || record.status !== "pending" || !decision) { sendJson(response, 409, { success: false, error: "Approval is stale, invalid, or bound to another submission" }, origin); return; }
          const result = decision === "approve" ? session.approveApproval?.(requestId) : session.denyApproval?.(requestId);
          if (!result || (decision === "approve" && result.decision !== "accept")) { sendJson(response, 409, { success: false, error: "Approval was declined or disabled" }, origin); return; }
          emitEvent("approval.resolved", { requestId: String(requestId), submissionId, status: decision === "approve" ? "approved" : "denied" });
          sendJson(response, 200, { success: true, decision: decision === "approve" ? "approved" : "denied" }, origin);
        } catch (error) { sendJson(response, 400, { success: false, error: error instanceof Error ? error.message : "Invalid approval decision" }, origin); }
        return;
      }
      if (requestPath === "/api/codex/control") {
        if (request.method === "GET") {
          sendJson(response, 200, { success: true, state: automationSnapshot() }, origin);
          return;
        }
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST, OPTIONS");
          sendJson(response, 405, { success: false, error: "Method not allowed" }, origin);
          return;
        }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const command = payload.command;
          if (command === "enable") {
            const workspaceError = workspaceValidationMessage(payload.workspace);
            if (workspaceError) { sendJson(response, 400, { success: false, error: workspaceError }, origin); return; }
            const workspace = validateWorkspace(payload.workspace);
            if (!workspace) { sendJson(response, 400, { success: false, error: "Workspace validation changed; retry after checking the trusted workspace." }, origin); return; }
            const identity = conversation.normalizeConversationUrl(payload.conversationUrl);
            if (!identity) { sendJson(response, 400, { success: false, error: "A valid ChatGPT conversation URL is required (standard /c/<id> or custom GPT /g/<gpt>/c/<id>)." }, origin); return; }
            const candidateUrl = identity.url;
            automation.enabled = true;
            automation.paused = false;
            automation.stopped = false;
            automation.stoppedReason = null;
            automation.stoppedAt = null;
            automation.workspace = workspace;
            automation.conversationUrl = candidateUrl;
            automation.sandboxMode = payload.sandboxMode === "read-only" ? "read-only" : "workspace-write";
          } else if (command === "disable") automation.enabled = false;
          else if (command === "pause") { if (!automation.stopped) automation.paused = true; }
          else if (command === "resume") { if (automation.stopped) { sendJson(response, 409, { success: false, error: "Automation was stopped. Enable a new automation session explicitly." }, origin); return; } automation.paused = false; }
          else if (command === "stop") {
            stopAutomation("manual");
          } else if (command === "terminal-stop") {
            const terminalCapture = validateCapturePayload(payload.capture);
            if (!terminalCapture || !hasTerminalStopMarker(terminalCapture.text) || !conversationMatches(automation.conversationUrl, terminalCapture.conversationUrl)) {
              sendJson(response, 400, { success: false, error: "Invalid terminal automation signal" }, origin);
              return;
            }
            const duplicate = !store.add(terminalCapture);
            if (!duplicate) emitEvent("capture.created", { captureId: terminalCapture.id, terminal: true });
            stopAutomation("task-completed");
          } else {
            sendJson(response, 400, { success: false, error: "Unknown control command" }, origin);
            return;
          }
          persistAutomation();
          publishAutomation();
          sendJson(response, 200, { success: true, state: automationSnapshot() }, origin);
        } catch (error) {
          sendJson(response, 400, { success: false, error: error instanceof Error ? error.message : "Invalid control request" }, origin);
        }
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        sendJson(response, 405, { success: false, error: "Method not allowed" }, origin);
        return;
      }
      const conversationUrl = new URL(request.url || "/", "http://127.0.0.1").searchParams.get("conversationUrl") || undefined;
      if (conversationUrl && !conversation.normalizeConversationUrl(conversationUrl)) { sendJson(response, 400, { success: false, error: "Invalid conversation URL" }, origin); return; }
      const result = store.latestCodexResult(conversationUrl);
      sendJson(response, 200, result ? { result } : { result: null }, origin);
      return;
    }

    if (request.url === "/api/vscode/captures") {
      if (!hasValidVscodeToken(request, vscodeToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      sendJson(response, 200, { captures: store.latest() });
      return;
    }

    if (request.url === "/api/vscode/events" || request.url === "/api/vscode/codex/submit" || request.url === "/api/vscode/codex/cancel" || request.url === "/api/vscode/codex/retry" || request.url === "/api/vscode/codex/retry-after-conflict" || request.url === "/api/vscode/codex/submissions" || request.url === "/api/vscode/codex/approvals" || request.url === "/api/vscode/codex/approvals/decision" || request.url === "/api/vscode/codex/approvals/simulate" || request.url === "/api/vscode/codex/automation" || request.url === "/api/vscode/codex/control" || request.url === "/api/vscode/codex/import-context" || request.url?.startsWith("/api/vscode/codex/status/")) {
      if (request.headers.origin) {
        sendJson(response, 403, { success: false, error: "Browser-origin requests are not allowed" });
        return;
      }
      if (!hasValidVscodeToken(request, vscodeToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { success: false, error: "Authentication required" });
        return;
      }

      if (request.url === "/api/vscode/events") {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          sendJson(response, 405, { success: false, error: "Method not allowed" });
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
        });
        response.flushHeaders();
        response.write(`retry: 2000\nevent: bridge\ndata: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
        eventClients.add(response);
        const heartbeat = setInterval(() => {
          try { response.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* close cleanup removes the client */ }
        }, 15_000);
        eventHeartbeats.set(response, heartbeat);
        const cleanup = () => {
          clearInterval(heartbeat);
          eventHeartbeats.delete(response);
          eventClients.delete(response);
        };
        request.once("aborted", cleanup);
        response.once("close", cleanup);
        return;
      }

      if (request.url === "/api/vscode/codex/submit") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { success: false, error: "Method not allowed" });
          return;
        }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const submissionInput = validateCodexSubmission(payload);
          if (!submissionInput) {
            sendJson(response, 400, { success: false, error: "Invalid capture ID or untrusted workspace" });
            return;
          }
          const capture = store.latest().find((item) => item.id === submissionInput.captureId);
          if (!capture) {
            sendJson(response, 404, { success: false, error: "Capture not found" });
            return;
          }
          const priorSubmissionId = captureSubmissions.get(captureSubmissionKey(capture));
          if (priorSubmissionId) {
            const prior = submissions.get(priorSubmissionId);
            if (prior && ["queued", "starting", "running"].includes(prior.status)) {
              sendJson(response, 409, { success: false, error: "A Codex execution is already active for this capture.", submissionId: prior.id, status: prior.status, retryAvailable: false });
              return;
            }
            if (prior?.blocked) {
              sendJson(response, 409, { success: false, error: prior.blockedReason || "Codex thread ownership is blocked by another active writer; reconcile that session before retrying.", submissionId: prior.id, status: prior.status, retryAvailable: false });
              return;
            }
            if (prior?.uncertain) {
              sendJson(response, 409, { success: false, error: "The previous execution is uncertain and must be reconciled before replay.", submissionId: prior.id, status: prior.status, retryAvailable: false });
              return;
            }
            if (prior?.status === "completed" && payload.runAgain !== true) {
              sendJson(response, 409, { success: false, error: "This capture completed previously. Confirm Run Again to start another Codex attempt.", submissionId: prior.id, status: prior.status, runAgainRequired: true });
              return;
            }
            if (prior && ["failed", "cancelled"].includes(prior.status) && prior.executionStarted && payload.confirmEffects !== true) {
              sendJson(response, 409, { success: false, error: "Codex execution began before failing or being cancelled. Confirm that prior effects may remain before retrying.", submissionId: prior.id, status: prior.status, effectsConfirmationRequired: true });
              return;
            }
            if (prior) {
              const retry = startSubmission(capture, submissionInput.workspace, submissionInput.sandboxMode, prior.id, true);
              if (!retry) { sendJson(response, 409, { success: false, error: "A Codex turn is already running", submissionId: activeSubmissionId }); return; }
              sendJson(response, 202, { success: true, submissionId: retry.id, status: retry.status, parentSubmissionId: prior.id, retry: true });
              return;
            }
          }
          if (activeSubmissionId) {
            sendJson(response, 409, { success: false, error: "A Codex turn is already running", submissionId: activeSubmissionId });
            return;
          }
          const submission = startSubmission(capture, submissionInput.workspace, submissionInput.sandboxMode);
          if (!submission) {
            sendJson(response, 409, { success: false, error: "A Codex turn is already running or this capture was submitted" });
            return;
          }
          sendJson(response, 202, { success: true, submissionId: submission.id, status: submission.status, sandboxMode: submission.sandboxMode });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          sendJson(response, message === "Request body too large" ? 413 : 400, { success: false, error: message });
        }
        return;
      }

      if (request.url === "/api/vscode/codex/import-context") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); sendJson(response, 405, { success: false, error: "Method not allowed" }); return; }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const workspace = validateWorkspace(payload.workspace);
          const sandboxMode = payload.sandboxMode === "read-only" ? "read-only" : "workspace-write";
          if (!workspace) { sendJson(response, 400, { success: false, error: "A trusted workspace is required" }); return; }
          if (activeSubmissionId) { sendJson(response, 409, { success: false, error: "A Codex turn is already running", submissionId: activeSubmissionId }); return; }
          const session = getSession(workspace, sandboxMode);
          await session.connect();
          if (!session.importProjectContext) { sendJson(response, 501, { success: false, error: "This Codex session does not support explicit project context import" }); return; }
          const result = await session.importProjectContext();
          sendJson(response, 200, { success: true, context: result });
        } catch (error) {
          sendJson(response, 409, { success: false, error: error instanceof Error ? error.message : "Project context import failed" });
        }
        return;
      }

      if (request.url === "/api/vscode/codex/submissions") {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); sendJson(response, 405, { success: false, error: "Method not allowed" }); return; }
        sendJson(response, 200, { success: true, submissions: [...submissions.values()].map(({ manager, captureSnapshot, ...submission }) => submission) });
        return;
      }

      if (request.url === "/api/vscode/codex/retry") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); sendJson(response, 405, { success: false, error: "Method not allowed" }); return; }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const priorId = typeof payload.submissionId === "string" ? payload.submissionId : "";
          const prior = submissions.get(priorId);
          if (!prior || prior.status !== "failed" || prior.uncertain || prior.blocked) {
            sendJson(response, 409, { success: false, error: prior?.uncertain ? "Execution is uncertain after restart and cannot be retried automatically." : "Only confirmed failed submissions can be retried." });
            return;
          }
          if (prior.executionStarted && payload.confirmEffects !== true) {
            sendJson(response, 409, { success: false, error: "Execution began before failing. Confirm that prior effects may remain before retrying.", effectsConfirmationRequired: true, submissionId: prior.id });
            return;
          }
          if (activeSubmissionId) { sendJson(response, 409, { success: false, error: "A Codex turn is already running", submissionId: activeSubmissionId }); return; }
          const capture = captureForSubmission(prior);
          if (!capture) { sendJson(response, 409, { success: false, error: "Original capture is no longer available or does not match." }); return; }
          const retry = startSubmission(capture, prior.workspace, prior.sandboxMode, prior.id, true);
          if (!retry) { sendJson(response, 409, { success: false, error: "Unable to start retry." }); return; }
          sendJson(response, 202, { success: true, submissionId: retry.id, status: retry.status, parentSubmissionId: prior.id });
        } catch (error) { sendJson(response, 400, { success: false, error: error instanceof Error ? error.message : "Invalid retry request" }); }
        return;
      }

      if (request.url === "/api/vscode/codex/retry-after-conflict") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); sendJson(response, 405, { success: false, error: "Method not allowed" }); return; }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const priorId = typeof payload.submissionId === "string" ? payload.submissionId : "";
          const prior = submissions.get(priorId);
          if (payload.confirmConflict !== true) { sendJson(response, 400, { success: false, error: "Explicit conflict-retry confirmation is required" }); return; }
          if (!prior || prior.status !== "failed" || prior.uncertain || !isActiveWriterConflict(prior)) {
            sendJson(response, 409, { success: false, error: "Only a confirmed active-writer-blocked submission can use conflict recovery." });
            return;
          }
          const active = activeBridgeTurn();
          if (active) { sendJson(response, 409, { success: false, error: "A bridge Codex turn is still active; conflict recovery was not started.", submissionId: active }); return; }
          const workspace = validateWorkspace(prior.workspace);
          if (!workspace || workspace !== prior.workspace) { sendJson(response, 409, { success: false, error: "The original workspace is no longer trusted or canonical; conflict recovery was not started." }); return; }
          const capture = captureForSubmission(prior);
          if (!capture) { sendJson(response, 409, { success: false, error: "Original capture is no longer available or does not match." }); return; }
          const retry = startSubmission(capture, prior.workspace, prior.sandboxMode, prior.id, true);
          if (!retry) { sendJson(response, 409, { success: false, error: "A bridge Codex turn is already running; conflict recovery was not started.", submissionId: activeBridgeTurn() }); return; }
          sendJson(response, 202, { success: true, submissionId: retry.id, status: retry.status, parentSubmissionId: prior.id, retry: "after-conflict" });
        } catch (error) { sendJson(response, 400, { success: false, error: error instanceof Error ? error.message : "Invalid conflict recovery request" }); }
        return;
      }

      if (request.url === "/api/vscode/codex/automation") {
        if (request.method === "GET") {
          sendJson(response, 200, { success: true, automation: automationSnapshot() });
          return;
        }
        if (request.method !== "POST") { response.setHeader("Allow", "GET, POST"); sendJson(response, 405, { success: false, error: "Method not allowed" }); return; }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          if (typeof payload.enabled !== "boolean") { sendJson(response, 400, { success: false, error: "enabled is required" }); return; }
          if (payload.enabled) {
            const workspaceError = workspaceValidationMessage(payload.workspace);
            if (workspaceError) { sendJson(response, 400, { success: false, error: workspaceError }); return; }
            const workspace = validateWorkspace(payload.workspace);
            if (!workspace) { sendJson(response, 400, { success: false, error: "Workspace validation changed; retry after checking the trusted workspace." }); return; }
            const identity = conversation.normalizeConversationUrl(payload.conversationUrl);
            if (!identity) { sendJson(response, 400, { success: false, error: "A valid ChatGPT conversation URL is required (standard /c/<id> or custom GPT /g/<gpt>/c/<id>)." }); return; }
            const conversationUrl = identity.url;
            automation.workspace = workspace;
            automation.conversationUrl = conversationUrl;
            automation.sandboxMode = payload.sandboxMode === "read-only" ? "read-only" : "workspace-write";
            automation.enabled = true;
            automation.paused = false;
            automation.stopped = false;
            automation.stoppedReason = null;
            automation.stoppedAt = null;
          } else automation.enabled = false;
          persistAutomation();
          publishAutomation();
          sendJson(response, 200, { success: true, automation: automationSnapshot() });
        } catch (error) { sendJson(response, 400, { success: false, error: error instanceof Error ? error.message : "Invalid automation request" }); }
        return;
      }

      if (request.url === "/api/vscode/codex/control") {
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); sendJson(response, 405, { success: false, error: "Method not allowed" }); return; }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const command = payload.command;
          if (command === "pause") { if (!automation.stopped) automation.paused = true; }
          else if (command === "resume") { if (automation.stopped) { sendJson(response, 409, { success: false, error: "Automation was stopped. Enable a new automation session explicitly." }); return; } automation.paused = false; }
          else if (command === "stop") { stopAutomation("manual"); }
          else { sendJson(response, 400, { success: false, error: "Unknown control command" }); return; }
          persistAutomation();
          publishAutomation();
          sendJson(response, 200, { success: true, state: automationSnapshot() });
        } catch (error) { sendJson(response, 400, { success: false, error: error instanceof Error ? error.message : "Invalid control request" }); }
        return;
      }

      if (request.url === "/api/vscode/codex/cancel") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { success: false, error: "Method not allowed" });
          return;
        }
        try {
          const payload = await readJson(request);
          const candidate = payload as Record<string, unknown>;
          const submissionId = typeof candidate?.submissionId === "string" ? candidate.submissionId : "";
          const submission = submissions.get(submissionId);
          if (!submission) {
            sendJson(response, 404, { success: false, error: "Submission not found" });
            return;
          }
          if (submission.status !== "running") {
            sendJson(response, 409, { success: false, error: "Submission is no longer running", status: submission.status });
            return;
          }
          submission.manager?.cancelCurrentTurn();
          sendJson(response, 200, { success: true, status: "cancelling" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          sendJson(response, message === "Request body too large" ? 413 : 400, { success: false, error: message });
        }
        return;
      }

      if (request.url === "/api/vscode/codex/approvals") {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          sendJson(response, 405, { success: false, error: "Method not allowed" });
          return;
        }
        const approvals = [
          ...sessions.values(),
        ].flatMap((session) => session.getAllApprovals?.() || []);
        if (simulatedBroker) approvals.push(...simulatedBroker.allRequests());
        sendJson(response, 200, { success: true, approvals });
        return;
      }

      if (request.url === "/api/vscode/codex/approvals/simulate") {
        if (!simulatedBroker) {
          sendJson(response, 404, { success: false, error: "Simulated approvals are disabled" });
          return;
        }
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { success: false, error: "Method not allowed" });
          return;
        }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const workspace = validateWorkspace(payload.workspace);
          const type = payload.type === "file-change" || payload.type === "command-execution" ? payload.type : undefined;
          if (!workspace || !type) {
            sendJson(response, 400, { success: false, error: "Valid trusted workspace and approval type required" });
            return;
          }
          const id = `simulation-${nextSimulationId++}`;
          const method = type === "file-change" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
          void simulatedBroker.request(id, method, {
            grantRoot: typeof payload.target === "string" ? payload.target : workspace,
            cwd: workspace,
            command: typeof payload.command === "string" ? payload.command : undefined,
            reason: typeof payload.reason === "string" ? payload.reason : "Simulated approval request",
          }, workspace);
          emitEvent("approval.requested", { requestId: id, submissionId: "simulation", status: "pending" });
          sendJson(response, 201, { success: true, requestId: id, connectionId: "simulation-connection", submissionId: "simulation" });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          sendJson(response, message === "Request body too large" ? 413 : 400, { success: false, error: message });
        }
        return;
      }

      if (request.url === "/api/vscode/codex/approvals/decision") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { success: false, error: "Method not allowed" });
          return;
        }
        try {
          const payload = await readJson(request) as Record<string, unknown>;
          const requestId = typeof payload.requestId === "string" || typeof payload.requestId === "number" ? payload.requestId : undefined;
          const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
          const submissionId = typeof payload.submissionId === "string" ? payload.submissionId : "";
          const decision = payload.decision === "deny" || payload.decision === "approve" ? payload.decision : undefined;
          if (requestId === undefined || !connectionId || !submissionId || !decision) {
            sendJson(response, 400, { success: false, error: "Request ID, connection, submission, and decision are required" });
            return;
          }

          if (simulatedBroker && connectionId === "simulation-connection") {
            const record = simulatedBroker.get(requestId);
            if (!record || record.submissionId !== submissionId || record.status !== "pending") {
              sendJson(response, 409, { success: false, error: "Approval is stale, resolved, or bound to another submission" });
              return;
            }
            const result = decision === "approve" ? simulatedBroker.approve(requestId) : simulatedBroker.deny(requestId);
            emitEvent("approval.resolved", { requestId: String(requestId), submissionId, status: result.decision === "accept" ? "approved" : "denied" });
            sendJson(response, 200, { success: true, decision: result.decision === "accept" ? "approved" : "denied", simulated: true });
            return;
          }

          const session = [...sessions.values()].find((candidate) => candidate.getConnectionId?.() === connectionId);
          const record = session?.getAllApprovals?.().find((candidate) => String(candidate.id) === String(requestId));
          if (!session || !record || record.connectionId !== connectionId || record.submissionId !== submissionId || record.status !== "pending") {
            sendJson(response, 409, { success: false, error: "Approval is stale, resolved, or bound to another submission" });
            return;
          }
          if (decision === "approve") {
            const result = session.approveApproval?.(requestId);
            if (!result || result.decision !== "accept") {
              sendJson(response, 409, { success: false, error: "Live approval was declined or is disabled" });
              return;
            }
            emitEvent("approval.resolved", { requestId: String(requestId), submissionId, status: "approved" });
            sendJson(response, 200, { success: true, decision: "approved", simulated: false });
            return;
            return;
          }
          session.denyApproval?.(requestId);
          emitEvent("approval.resolved", { requestId: String(requestId), submissionId, status: "denied" });
          sendJson(response, 200, { success: true, decision: "denied", simulated: false });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid request";
          sendJson(response, message === "Request body too large" ? 413 : 400, { success: false, error: message });
        }
        return;
      }

      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { success: false, error: "Method not allowed" });
        return;
      }
      const submissionId = request.url.slice("/api/vscode/codex/status/".length);
      if (!submissionId || submissionId.length > maxCodexSubmissionIdLength) {
        sendJson(response, 400, { success: false, error: "Invalid submission ID" });
        return;
      }
      const submission = submissions.get(submissionId);
      if (!submission) {
        sendJson(response, 404, { success: false, error: "Submission not found" });
        return;
      }
      sendJson(response, 200, {
        success: true,
        submissionId: submission.id,
        captureId: submission.captureId,
        status: submission.status,
        ...(submission.response !== undefined ? { response: submission.response } : {}),
        ...(submission.threadId ? { threadId: submission.threadId } : {}),
        ...(submission.events ? { events: submission.events } : {}),
        ...(submission.error ? { error: submission.error } : {}),
        ...(submission.blocked ? { blocked: true, blockedReason: submission.blockedReason } : {}),
        ...(submission.uncertain ? { uncertain: true } : {}),
        ...(submission.manager?.getStatus ? {
          elapsedMs: submission.manager.getStatus().turnElapsedMs,
          latestProgressEvent: submission.manager.getStatus().latestProgressEvent,
          timeoutReason: submission.manager.getStatus().timeoutReason,
        } : {}),
      });
      return;
    }

    if (request.url === "/api/test" || request.url === "/api/captures") {
      if (origin !== extensionOrigin) {
        sendJson(response, 403, { success: false, error: "Forbidden origin" }, origin);
        return;
      }
      if (request.method === "OPTIONS") {
        sendCorsOptions(response, "POST, OPTIONS");
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST, OPTIONS");
        sendJson(response, 405, { success: false, error: "Method not allowed" }, origin);
        return;
      }

      try {
        const payload = await readJson(request);
        if (request.url === "/api/test") {
          if (typeof payload !== "object" || payload === null || !("message" in payload) || typeof payload.message !== "string") {
            sendJson(response, 400, { success: false, error: "Expected a string message" }, origin);
            return;
          }
          sendJson(response, 200, { success: true }, origin);
          return;
        }
        const capture = validateCapturePayload(payload);
        if (!capture) {
          sendJson(response, 400, { success: false, error: "Invalid capture payload" }, origin);
          return;
        }
        const terminalStop = hasTerminalStopMarker(capture.text) && conversationMatches(automation.conversationUrl, capture.conversationUrl);
        const duplicate = !store.add(capture);
        if (!duplicate) emitEvent("capture.created", { captureId: capture.id });
        console.log("Capture received", {
          id: capture.id,
          characters: capture.text.length,
          timestamp: capture.timestamp,
          duplicate,
        });
        let automationSubmission: CodexSubmission | undefined;
        let automationDecision: string;
        if (terminalStop) {
          stopAutomation("task-completed");
          persistAutomation();
          publishAutomation();
          automationDecision = "stopped_task_completed";
        } else if (duplicate) automationDecision = "duplicate";
        else if (automation.stopped) automationDecision = "stopped";
        else if (!automation.enabled) automationDecision = "disabled";
        else if (automation.paused) automationDecision = "paused";
        else if (!automation.workspace) automationDecision = "workspace_missing";
        else if (!conversationMatches(automation.conversationUrl, capture.conversationUrl)) automationDecision = "conversation_mismatch";
        else automationDecision = "eligible";
        if (automationDecision === "eligible" && !automation.stopped) {
          const workspace = automation.workspace;
          if (workspace) automationSubmission = startSubmission(capture, workspace, automation.sandboxMode);
          if (!automationSubmission) automationDecision = activeSubmissionId ? "concurrent_submission" : "duplicate_submission";
        }
        console.log("Capture automation decision", { captureId: capture.id, decision: automationSubmission ? "queued" : "skipped", reason: automationSubmission ? "eligible" : automationDecision, automationEnabled: automation.enabled, paused: automation.paused, stopped: automation.stopped, workspaceConfigured: Boolean(automation.workspace), conversationConfigured: Boolean(automation.conversationUrl) });
        sendJson(response, 200, automationSubmission
          ? { success: true, duplicate, submissionId: automationSubmission.id, status: automationSubmission.status, sandboxMode: automationSubmission.sandboxMode, automation: { decision: "queued", reason: "eligible" } }
          : { success: true, duplicate, automation: { decision: "skipped", reason: automationDecision } }, origin);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid request";
        sendJson(response, message === "Request body too large" ? 413 : 400, { success: false, error: message }, origin);
      }
      return;
    }

    if (request.url === "/api/captures/latest") {
      if (origin !== extensionOrigin) {
        sendJson(response, 403, { success: false, error: "Forbidden origin" }, origin);
        return;
      }
      if (request.method === "OPTIONS") {
        sendCorsOptions(response, "GET, OPTIONS");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        sendJson(response, 405, { success: false, error: "Method not allowed" }, origin);
        return;
      }
      sendJson(response, 200, { captures: store.latest() }, origin);
      return;
    }

    if (request.url === "/api/captures/status") {
      if (origin !== extensionOrigin) {
        sendJson(response, 403, { success: false, error: "Forbidden origin" }, origin);
        return;
      }
      if (request.method === "OPTIONS") {
        sendCorsOptions(response, "GET, OPTIONS");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET, OPTIONS");
        sendJson(response, 405, { success: false, error: "Method not allowed" }, origin);
        return;
      }
      sendJson(response, 200, store.status(), origin);
      return;
    }
    sendJson(response, 404, { error: "Not found" }, origin);
  });
  server.on("close", () => {
    for (const heartbeat of eventHeartbeats.values()) clearInterval(heartbeat);
    eventHeartbeats.clear();
    for (const client of eventClients) client.end();
    eventClients.clear();
    for (const session of sessions.values()) void session.shutdown?.();
  });
  return server;
}

if (require.main === module) {
  const server = createServer();
  const close = () => { server.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.listen(port, host, () => console.log(`Server listening at http://${host}:${port}`));
}

export = { createCaptureStore, createServer, resolveVscodeTokenFile, validateCapturePayload, validateWorkspace };
