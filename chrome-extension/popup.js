const bridgeUrl = "http://127.0.0.1:3000";
const sendTestButton = document.querySelector("#send-test");
const checkConnectionButton = document.querySelector("#check-connection");
const bridgeStatus = document.querySelector("#bridge-status");
const bridgeStatusText = document.querySelector("#bridge-status-text");
const bridgeFeedback = document.querySelector("#bridge-feedback");
const captureEnabled = document.querySelector("#capture-enabled");
const captureStatus = document.querySelector("#capture-status");
const autoForwardEnabled = document.querySelector("#auto-forward-enabled");
const forwardingStatus = document.querySelector("#forwarding-status");
const autoSubmitEnabled = document.querySelector("#auto-submit-enabled");
const autoSubmitStatus = document.querySelector("#auto-submit-status");
const automationStatus = document.querySelector("#automation-status");
const automationWorkspace = document.querySelector("#automation-workspace");
const conversationUrlInput = document.querySelector("#conversation-url");
const useCurrentTabButton = document.querySelector("#use-current-tab");
const enableAutomationButton = document.querySelector("#enable-automation");
const pauseAutomationButton = document.querySelector("#pause-automation");
const resumeAutomationButton = document.querySelector("#resume-automation");
const stopAutomationButton = document.querySelector("#stop-automation");
const captureMetadata = document.querySelector("#capture-metadata");
const capturedResponse = document.querySelector("#captured-response");
const codexResultMetadata = document.querySelector("#codex-result-metadata");
const codexResultStatus = document.querySelector("#codex-result-status");
const codexPairingStatus = document.querySelector("#codex-pairing-status");
const codexResultResponse = document.querySelector("#codex-result-response");
const pairCodexButton = document.querySelector("#pair-codex");
const refreshCodexResultButton = document.querySelector("#refresh-codex-result");
const copyCodexResultButton = document.querySelector("#copy-codex-result");
const codexResultFeedback = document.querySelector("#codex-result-feedback");
const approvalsStatus = document.querySelector("#approvals-status");
const approvalsList = document.querySelector("#approvals-list");
const refreshApprovalsButton = document.querySelector("#refresh-approvals");

if (
  !sendTestButton ||
  !checkConnectionButton ||
  !bridgeStatus ||
  !bridgeStatusText ||
  !bridgeFeedback ||
  !captureEnabled ||
  !autoForwardEnabled ||
  !autoSubmitEnabled ||
  !autoSubmitStatus ||
  !automationStatus ||
  !automationWorkspace ||
  !conversationUrlInput ||
  !useCurrentTabButton ||
  !enableAutomationButton ||
  !pauseAutomationButton ||
  !resumeAutomationButton ||
  !stopAutomationButton ||
  !forwardingStatus ||
  !captureStatus ||
  !captureMetadata ||
  !capturedResponse ||
  !codexResultMetadata ||
  !codexResultStatus ||
  !codexPairingStatus ||
  !codexResultResponse ||
  !pairCodexButton ||
  !refreshCodexResultButton ||
  !copyCodexResultButton ||
  !codexResultFeedback
  || !approvalsStatus || !approvalsList || !refreshApprovalsButton
) {
  throw new Error("Popup UI is missing required elements.");
}

function displayApprovals(approvals) {
  const pending = Array.isArray(approvals) ? approvals.filter((item) => item?.status === "pending") : [];
  approvalsStatus.textContent = pending.length ? `${pending.length} pending request${pending.length === 1 ? "" : "s"}. Review before approving.` : "No pending approvals.";
  approvalsList.replaceChildren();
  if (!pending.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "No pending approvals."; approvalsList.append(empty); return; }
  for (const approval of pending) {
    const card = document.createElement("div");
    card.className = "approval-summary";
    const detail = approval.command || approval.target || approval.reason || "No details supplied";
    card.textContent = `${approval.type} ${approval.id}: ${detail} (${approval.workspace})`;
    const approve = document.createElement("button"); approve.className = "button button-primary"; approve.textContent = "Approve";
    const deny = document.createElement("button"); deny.className = "button button-secondary"; deny.textContent = "Deny";
    const decide = async (decision) => {
      if (!window.confirm(`${decision === "approve" ? "Approve" : "Deny"} this ${approval.type} request?\n\n${detail}`)) return;
      approve.disabled = true; deny.disabled = true;
      try {
        const response = await fetch(`${bridgeUrl}/api/codex/approval-decision`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${codexPairingToken}` }, body: JSON.stringify({ requestId: approval.id, connectionId: approval.connectionId, submissionId: approval.submissionId, decision }) });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success !== true) throw new Error(body.error || `Bridge returned ${response.status}`);
        await refreshApprovals();
      } catch (error) { approvalsStatus.textContent = error instanceof Error ? error.message : "Approval decision failed."; approve.disabled = false; deny.disabled = false; }
    };
    approve.addEventListener("click", () => void decide("approve")); deny.addEventListener("click", () => void decide("deny"));
    card.append(document.createElement("br"), approve, deny); approvalsList.append(card);
  }
}

async function refreshApprovals() {
  if (!codexPairingToken) { displayApprovals([]); return; }
  const response = await fetch(`${bridgeUrl}/api/codex/approvals`, { headers: { Authorization: `Bearer ${codexPairingToken}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) throw new Error(body.error || `Bridge returned ${response.status}`);
  displayApprovals(body.approvals);
}

let latestCodexResponse = "";
let codexPairingToken = "";

function displayAutoSubmitStatus(state, enabled) {
  if (!enabled) {
    autoSubmitStatus.textContent = "Disabled. Reports require Automation Mode and pairing.";
    autoSubmitStatus.dataset.state = "idle";
    return;
  }
  const labels = { ready: "A completed Codex report is ready for automatic delivery.", submitting: "Submitting a completed Codex report...", submitted: "Latest completed report confirmed in ChatGPT.", error: "Automatic report delivery failed; manual review is required." };
  const uncertain = state?.status === "uncertain"
    ? state.attempted === true
      ? "Report submission was attempted but not confirmed; manual review is required."
      : "Report was not submitted; manual review is required."
    : undefined;
  autoSubmitStatus.textContent = uncertain || labels[state?.status] || "Enabled. Waiting for a completed Codex report.";
  autoSubmitStatus.dataset.state = state?.status === "uncertain" || state?.status === "error" ? "error" : state?.status === "submitted" ? "success" : "pending";
}

async function refreshAutoSubmitDeliveryStatus() {
  if (!autoSubmitEnabled.checked) return;
  const conversation = globalThis.AiDevBridgeConversation.normalizeConversationUrl(conversationUrlInput.value.trim());
  if (!conversation) return;
  try {
    const state = await chrome.runtime.sendMessage({ type: "getCodexResultForConversation", conversationUrl: conversation.url });
    displayAutoSubmitStatus(state, true);
  } catch {
    displayAutoSubmitStatus({ status: "error" }, true);
  }
}

function displayAutomationState(state) {
  if (state?.stopped) {
    automationStatus.textContent = state.stoppedReason === "task-completed" ? "Stopped: task completed." : "Stopped by user. Enable a new automation session to continue.";
    automationStatus.dataset.state = "idle";
    autoForwardEnabled.checked = false;
    autoSubmitEnabled.checked = false;
    void chrome.storage.local.set({ autoForwardEnabled: false, autoSubmitCodexResultsEnabled: false });
    if (state.workspace) automationWorkspace.value = state.workspace;
    if (state.conversationUrl) conversationUrlInput.value = state.conversationUrl;
    return;
  }
  if (!state?.enabled) {
    automationStatus.textContent = "Disabled. Enable only for the active ChatGPT conversation.";
    automationStatus.dataset.state = "idle";
    return;
  }
  automationStatus.textContent = state.paused ? "Paused." : `Enabled for ${state.workspace || "selected workspace"}.`;
  automationStatus.dataset.state = state.paused ? "pending" : "success";
  if (state.workspace) automationWorkspace.value = state.workspace;
  if (state.conversationUrl) conversationUrlInput.value = state.conversationUrl;
}

async function automationControl(command, extra = {}) {
  if (!codexPairingToken) {
    displayAutomationState(null);
    return;
  }
  const response = await fetch(`${bridgeUrl}/api/codex/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${codexPairingToken}` },
    body: JSON.stringify({ command, ...extra }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) throw new Error(body.error || `Bridge returned ${response.status}`);
  displayAutomationState(body.state);
  return body.state;
}

async function refreshAutomationState() {
  if (!codexPairingToken) return;
  const response = await fetch(`${bridgeUrl}/api/codex/control`, { headers: { Authorization: `Bearer ${codexPairingToken}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) throw new Error(body.error || `Bridge returned ${response.status}`);
  displayAutomationState(body.state);
}

function setBridgeStatus(state, message) {
  bridgeStatus.dataset.state = state;
  bridgeStatusText.textContent = message;
}

function setBridgeFeedback(state, message = "") {
  bridgeFeedback.dataset.state = state;
  bridgeFeedback.textContent = message || "\u00a0";
}

function displayCapture(capture) {
  if (!capture || typeof capture.text !== "string" || typeof capture.capturedAt !== "string") {
    captureMetadata.textContent = "No response captured yet.";
    capturedResponse.replaceChildren();
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "Captured ChatGPT responses will appear here.";
    capturedResponse.append(emptyState);
    return;
  }

  const capturedAt = new Date(capture.capturedAt);
  const timestamp = Number.isNaN(capturedAt.getTime()) ? "Unknown time" : capturedAt.toLocaleString();
  captureMetadata.textContent = `${timestamp} - ${capture.text.length} characters`;
  capturedResponse.textContent = capture.text;
}

function setCodexResultFeedback(state, message = "") {
  codexResultFeedback.dataset.state = state;
  codexResultFeedback.textContent = message || "\u00a0";
}

function displayPairingState() {
  const paired = Boolean(codexPairingToken);
  codexPairingStatus.textContent = paired ? "Chrome access is paired with this local bridge." : "Chrome access is not paired.";
  codexPairingStatus.dataset.state = paired ? "success" : "pending";
  pairCodexButton.textContent = paired ? "Re-pair with Bridge" : "Pair with Bridge";
}

function displayCodexResult(result) {
  if (!result || result.status !== "completed" || typeof result.response !== "string" || typeof result.timestamp !== "string") {
    latestCodexResponse = "";
    codexResultStatus.textContent = "NONE";
    codexResultStatus.dataset.state = "idle";
    codexResultMetadata.textContent = "No completed Codex result yet.";
    codexResultResponse.replaceChildren();
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "Completed Codex responses will appear here.";
    codexResultResponse.append(emptyState);
    copyCodexResultButton.disabled = true;
    return;
  }

  if (result.response.length > 900000) {
    latestCodexResponse = "";
    codexResultStatus.textContent = "ERROR";
    codexResultMetadata.textContent = "Codex result is too large to display.";
    codexResultResponse.replaceChildren();
    copyCodexResultButton.disabled = true;
    return;
  }

  latestCodexResponse = result.response;
  const completedAt = new Date(result.timestamp);
  const timestamp = Number.isNaN(completedAt.getTime()) ? "Unknown time" : completedAt.toLocaleString();
  codexResultStatus.textContent = "COMPLETED";
  codexResultStatus.dataset.state = "success";
  codexResultMetadata.textContent = `${timestamp} - ${result.response.length} characters`;
  codexResultResponse.textContent = result.response;
  copyCodexResultButton.disabled = false;
}

async function refreshCodexResult() {
  if (!codexPairingToken) {
    displayCodexResult(null);
    setCodexResultFeedback("error", "Pair Chrome with the local bridge first.");
    return;
  }
  refreshCodexResultButton.disabled = true;
  setCodexResultFeedback("idle", "Refreshing Codex result...");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const conversationFilter = globalThis.AiDevBridgeConversation.normalizeConversationUrl(conversationUrlInput.value.trim());
    const resultUrl = conversationFilter ? `${bridgeUrl}/api/codex/latest?conversationUrl=${encodeURIComponent(conversationFilter.url)}` : `${bridgeUrl}/api/codex/latest`;
    const response = await fetch(resultUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${codexPairingToken}`,
      },
      signal: controller.signal,
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("The bridge returned an invalid Codex result.");
    }
    if (response.status === 401) throw new Error("Chrome pairing is missing or invalid. Pair again.");
    if (response.status === 403) throw new Error("Chrome extension origin was rejected.");
    if (!response.ok) throw new Error(result.error || `Bridge returned ${response.status}`);
    displayCodexResult(result.result);
    setCodexResultFeedback("success", result.result ? "Latest completed Codex result loaded." : "No completed Codex result yet.");
  } catch (error) {
    displayCodexResult(null);
    const message = error?.name === "AbortError"
      ? "Bridge request timed out."
      : error instanceof TypeError
        ? "Bridge offline or unreachable."
      : error instanceof Error ? error.message : "Could not load Codex result.";
    setCodexResultFeedback("error", message);
  } finally {
    clearTimeout(timeout);
    refreshCodexResultButton.disabled = false;
  }
}

async function checkConnection() {
  checkConnectionButton.disabled = true;
  setBridgeStatus("checking", "Checking connection...");
  setBridgeFeedback("idle");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);

  try {
    const response = await fetch(`${bridgeUrl}/health`, { signal: controller.signal });
    const result = await response.json();
    if (!response.ok || result.status !== "ok") {
      throw new Error("Unexpected health response");
    }

    setBridgeStatus("online", "Bridge online at 127.0.0.1:3000");
    setBridgeFeedback("success", "Connection verified.");
  } catch {
    setBridgeStatus("offline", "Bridge offline or unreachable");
    setBridgeFeedback("error", "Start the local server, then try again.");
  } finally {
    clearTimeout(timeout);
    checkConnectionButton.disabled = false;
  }
}

async function initializePopup() {
  const { captureEnabled: enabled = false, autoForwardEnabled: forwarding = false, autoSubmitCodexResultsEnabled: autoSubmit = false, codexDeliveryStatus: deliveryStatus, latestCapturedResponse, forwardingStatus: status, codexPairingToken: token = "", selectedConversationUrl = "", automationWorkspace: savedWorkspace = "" } = await chrome.storage.local.get([
    "captureEnabled",
    "autoForwardEnabled",
    "autoSubmitCodexResultsEnabled",
    "codexDeliveryStatus",
    "latestCapturedResponse",
    "forwardingStatus",
    "codexPairingToken",
    "selectedConversationUrl",
    "automationWorkspace",
  ]);
  codexPairingToken = typeof token === "string" ? token : "";
  captureEnabled.checked = enabled;
  captureStatus.textContent = enabled ? "Capture is active on ChatGPT." : "Capture is disabled.";
  displayCapture(latestCapturedResponse);
  displayPairingState();
  conversationUrlInput.value = selectedConversationUrl || "";
  automationWorkspace.value = savedWorkspace || "";
  autoForwardEnabled.checked = forwarding;
  displayForwardingStatus(status, forwarding);
  autoSubmitEnabled.checked = autoSubmit;
  displayAutoSubmitStatus(deliveryStatus, autoSubmit);
  await Promise.all([checkConnection(), refreshCodexResult(), refreshAutoSubmitDeliveryStatus(), refreshAutomationState().catch((error) => displayAutomationState({ enabled: false, error })), refreshApprovals().catch((error) => { approvalsStatus.textContent = error instanceof Error ? error.message : "Could not load approvals."; })]);
}

function displayForwardingStatus(status, enabled) {
  if (!enabled) {
    forwardingStatus.textContent = "Auto-forward is disabled.";
    forwardingStatus.dataset.state = "idle";
    return;
  }
  forwardingStatus.textContent = status?.message || "Auto-forward is enabled.";
  forwardingStatus.dataset.state = status?.state || "idle";
}

captureEnabled.addEventListener("change", async () => {
  captureEnabled.disabled = true;
  try {
    await chrome.storage.local.set({ captureEnabled: captureEnabled.checked });
    captureStatus.textContent = captureEnabled.checked
      ? "Capture is active on ChatGPT."
      : "Capture is disabled.";
  } catch {
    captureEnabled.checked = !captureEnabled.checked;
    captureStatus.textContent = "Could not update capture setting.";
  } finally {
    captureEnabled.disabled = false;
  }
});

autoForwardEnabled.addEventListener("change", async () => {
  autoForwardEnabled.disabled = true;
  try {
    await chrome.storage.local.set({ autoForwardEnabled: autoForwardEnabled.checked });
    displayForwardingStatus(undefined, autoForwardEnabled.checked);
  } catch {
    autoForwardEnabled.checked = !autoForwardEnabled.checked;
    displayForwardingStatus(undefined, autoForwardEnabled.checked);
  } finally {
    autoForwardEnabled.disabled = false;
  }
});

autoSubmitEnabled.addEventListener("change", async () => {
  autoSubmitEnabled.disabled = true;
  try {
    await chrome.storage.local.set({ autoSubmitCodexResultsEnabled: autoSubmitEnabled.checked });
    displayAutoSubmitStatus(undefined, autoSubmitEnabled.checked);
    if (autoSubmitEnabled.checked) await refreshAutoSubmitDeliveryStatus();
  } catch {
    autoSubmitEnabled.checked = !autoSubmitEnabled.checked;
    displayAutoSubmitStatus(undefined, autoSubmitEnabled.checked);
  } finally {
    autoSubmitEnabled.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.captureEnabled) {
    const enabled = changes.captureEnabled.newValue === true;
    captureEnabled.checked = enabled;
    captureStatus.textContent = enabled ? "Capture is active on ChatGPT." : "Capture is disabled.";
  }

  if (changes.latestCapturedResponse) {
    displayCapture(changes.latestCapturedResponse.newValue);
  }

  if (changes.autoForwardEnabled) {
    const enabled = changes.autoForwardEnabled.newValue === true;
    autoForwardEnabled.checked = enabled;
    displayForwardingStatus(undefined, enabled);
  }

  if (changes.autoSubmitCodexResultsEnabled) {
    const enabled = changes.autoSubmitCodexResultsEnabled.newValue === true;
    autoSubmitEnabled.checked = enabled;
    displayAutoSubmitStatus(undefined, enabled);
  }

  if (changes.codexDeliveryStatus) displayAutoSubmitStatus(changes.codexDeliveryStatus.newValue, autoSubmitEnabled.checked);

  if (changes.forwardingStatus) {
    displayForwardingStatus(changes.forwardingStatus.newValue, autoForwardEnabled.checked);
  }
});

checkConnectionButton.addEventListener("click", () => {
  void checkConnection();
});

refreshCodexResultButton.addEventListener("click", () => {
  void refreshCodexResult();
});

copyCodexResultButton.addEventListener("click", async () => {
  if (!latestCodexResponse) return;
  copyCodexResultButton.disabled = true;
  try {
    await navigator.clipboard.writeText(latestCodexResponse);
    setCodexResultFeedback("success", "Codex result copied to the clipboard.");
  } catch {
    setCodexResultFeedback("error", "Could not copy the Codex result.");
  } finally {
    copyCodexResultButton.disabled = false;
  }
});

pairCodexButton.addEventListener("click", async () => {
  if (!window.confirm("Pair this Chrome extension with the local AI Dev Bridge?")) return;
  pairCodexButton.disabled = true;
  setCodexResultFeedback("idle", "Pairing with the local bridge...");
  try {
    const response = await fetch(`${bridgeUrl}/api/codex/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const result = await response.json();
    if (!response.ok || result.success !== true || result.paired !== true || typeof result.token !== "string" || result.token.length < 32) {
      throw new Error(response.status === 403 ? "Pairing must be initiated from the authorized extension." : result.error || `Bridge returned ${response.status}`);
    }
    codexPairingToken = result.token;
    await chrome.storage.local.set({ codexPairingToken });
    displayPairingState();
    await refreshAutomationState();
    setCodexResultFeedback("success", "Chrome access paired successfully.");
    await refreshCodexResult();
    await refreshApprovals();
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Bridge request timed out."
      : error instanceof TypeError
        ? "Bridge offline or unreachable."
        : error instanceof Error ? error.message : "Could not pair with the local bridge.";
    setCodexResultFeedback("error", message);
  } finally {
    pairCodexButton.disabled = false;
  }
});

refreshApprovalsButton.addEventListener("click", () => { refreshApprovalsButton.disabled = true; void refreshApprovals().finally(() => { refreshApprovalsButton.disabled = false; }); });

enableAutomationButton.addEventListener("click", async () => {
  if (!codexPairingToken) {
    setCodexResultFeedback("error", "Pair Chrome with the local bridge first.");
    return;
  }
  const workspace = automationWorkspace.value.trim();
  const conversationUrl = conversationUrlInput.value.trim();
  if (!workspace) {
    automationStatus.textContent = "Enter a trusted workspace path.";
    automationStatus.dataset.state = "error";
    return;
  }
  const identity = globalThis.AiDevBridgeConversation.normalizeConversationUrl(conversationUrl);
  if (!identity) {
    automationStatus.textContent = "Enter a valid ChatGPT conversation URL, including /c/<id> or /g/<gpt>/c/<id>.";
    automationStatus.dataset.state = "error";
    return;
  }
  conversationUrlInput.value = identity.url;
  if (!window.confirm("Enable automatic Codex execution only for this selected ChatGPT conversation?")) return;
  enableAutomationButton.disabled = true;
  try {
    const state = await automationControl("enable", { workspace, conversationUrl: identity.url, sandboxMode: "workspace-write" });
    await chrome.storage.local.set({ selectedConversationUrl: state.conversationUrl, automationWorkspace: state.workspace });
  } catch (error) {
    automationStatus.textContent = error instanceof Error ? error.message : "Could not enable automation.";
    automationStatus.dataset.state = "error";
  } finally { enableAutomationButton.disabled = false; }
});

useCurrentTabButton.addEventListener("click", async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const identity = globalThis.AiDevBridgeConversation.normalizeConversationUrl(tabs[0]?.url || "");
    if (!identity) throw new Error("The current tab is not a specific ChatGPT conversation.");
    conversationUrlInput.value = identity.url;
    automationStatus.textContent = "Current ChatGPT conversation selected. Review the workspace before enabling.";
    automationStatus.dataset.state = "pending";
  } catch (error) {
    automationStatus.textContent = error instanceof Error ? error.message : "Could not read the current tab.";
    automationStatus.dataset.state = "error";
  }
});

for (const [button, command] of [[pauseAutomationButton, "pause"], [resumeAutomationButton, "resume"], [stopAutomationButton, "stop"]]) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await automationControl(command); }
    catch (error) { automationStatus.textContent = error instanceof Error ? error.message : "Automation control failed."; automationStatus.dataset.state = "error"; }
    finally { button.disabled = false; }
  });
}

sendTestButton.addEventListener("click", async () => {
  sendTestButton.disabled = true;
  setBridgeFeedback("idle", "Sending test message...");

  try {
    const response = await fetch(`${bridgeUrl}/api/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello from Chrome" }),
    });
    const result = await response.json();

    if (!response.ok || result.success !== true) {
      throw new Error(result.error || `Bridge returned ${response.status}`);
    }

    setBridgeFeedback("success", "Test message delivered successfully.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error";
    setBridgeFeedback("error", `Could not send test: ${message}`);
  } finally {
    sendTestButton.disabled = false;
  }
});

void initializePopup();
