const bridgeUrl = "http://127.0.0.1:3000";
const deliveryClaims = new Set();

function normalizeConversationUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(url.hostname)) return null;
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (!/^\/c\/[^/]+$/.test(pathname) && !/^\/g\/[^/]+\/c\/[^/]+$/.test(pathname)) return null;
  return { path: pathname, url: `https://chatgpt.com${pathname}` };
}

function sameConversation(left, right) {
  const a = normalizeConversationUrl(left);
  const b = normalizeConversationUrl(right);
  return Boolean(a && b && a.path === b.path);
}

function deliveryStateFor(state) {
  if (!state || typeof state !== "object") return null;
  if (state.status === "submitting") return { ...state, status: "uncertain", error: "Browser or bridge restarted while Codex report delivery was in progress; manual review is required." };
  return state;
}

function deliveryKey(conversationPath, submissionId) {
  return `${encodeURIComponent(conversationPath)}::${submissionId}`;
}

function matchingDeliveryState(settings, conversationPath, submissionId, recoverInterrupted = true) {
  const keyed = settings.codexDeliveryStates?.[deliveryKey(conversationPath, submissionId)];
  if (keyed) return recoverInterrupted ? deliveryStateFor(keyed) : keyed;
  const legacy = settings.codexDeliveryState;
  if (legacy?.conversationPath === conversationPath && legacy?.submissionId === submissionId) return recoverInterrupted ? deliveryStateFor(legacy) : legacy;
  return null;
}

function deliveryDiagnostic(stage, details = {}) {
  console.info("[AI Dev Bridge] background delivery", { ...details, stage });
}

async function persistDeliveryState(settings, state) {
  const states = { ...(settings.codexDeliveryStates || {}) };
  const legacy = settings.codexDeliveryState;
  if (legacy?.conversationPath && legacy?.submissionId) {
    const legacyKey = deliveryKey(legacy.conversationPath, legacy.submissionId);
    if (!states[legacyKey]) states[legacyKey] = legacy;
  }
  states[deliveryKey(state.conversationPath, state.submissionId)] = state;
  await chrome.storage.local.set({ codexDeliveryStates: states, codexDeliveryState: state, codexDeliveryStatus: state });
}

async function getAutomationState(token) {
  const response = await fetch(`${bridgeUrl}/api/codex/control`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true || !body.state) throw new Error(body.error || `Bridge returned ${response.status}`);
  return body.state;
}

async function availableResult(settings, conversationUrl) {
  const selected = normalizeConversationUrl(settings.selectedConversationUrl);
  const current = normalizeConversationUrl(conversationUrl);
  if (settings.autoSubmitCodexResultsEnabled !== true || !settings.codexPairingToken || !selected || !current || selected.path !== current.path) return { status: "disabled" };
  const automation = await getAutomationState(settings.codexPairingToken);
  if (!automation.enabled || !sameConversation(automation.conversationUrl, current.url)) return { status: "disabled" };
  if (automation.paused) return { status: "paused" };
  const response = await fetch(`${bridgeUrl}/api/codex/latest?conversationUrl=${encodeURIComponent(current.url)}`, { headers: { Accept: "application/json", Authorization: `Bearer ${settings.codexPairingToken}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Bridge returned ${response.status}`);
  const result = body.result;
  if (!result || result.status !== "completed" || typeof result.submissionId !== "string" || typeof result.response !== "string") return { status: "idle" };
  if (!sameConversation(result.sourceConversationUrl, current.url)) return { status: "disabled" };
  const stored = matchingDeliveryState(settings, current.path, result.submissionId);
  if (stored?.status === "submitting" || stored?.status === "uncertain") return { status: "uncertain", submissionId: result.submissionId, attempted: stored.attempted === true, stage: stored.stage, error: stored.error || "Manual review is required before report delivery can continue." };
  if (stored?.status === "submitted" && stored.submissionId === result.submissionId && stored.conversationPath === current.path) return { status: "submitted" };
  return { status: "ready", result };
}

async function respondWithResult(sendResponse, conversationUrl) {
  try {
    const settings = await chrome.storage.local.get(["autoSubmitCodexResultsEnabled", "codexPairingToken", "selectedConversationUrl", "codexDeliveryState", "codexDeliveryStates"]);
    const state = deliveryStateFor(settings.codexDeliveryState);
    if (state !== settings.codexDeliveryState) await chrome.storage.local.set({ codexDeliveryState: state, codexDeliveryStatus: state });
    const available = await availableResult({ ...settings, codexDeliveryState: state }, conversationUrl);
    deliveryDiagnostic("result-check", { status: available.status, submissionId: available.result?.submissionId || available.submissionId, conversationPath: normalizeConversationUrl(conversationUrl)?.path });
    sendResponse(available);
  } catch (error) {
    deliveryDiagnostic("result-check-failed", { reason: error && typeof error.message === "string" ? error.message : "unknown" });
    sendResponse({ status: "error", error: error && typeof error.message === "string" ? error.message : "Unable to retrieve Codex result." });
  }
}

async function beginDelivery(sendResponse, conversationUrl, submissionId) {
  let claim;
  try {
    const settings = await chrome.storage.local.get(["autoSubmitCodexResultsEnabled", "codexPairingToken", "selectedConversationUrl", "codexDeliveryState", "codexDeliveryStates"]);
    const available = await availableResult(settings, conversationUrl);
    const current = normalizeConversationUrl(conversationUrl);
    if (available.status !== "ready" || !current || available.result.submissionId !== submissionId) {
      sendResponse({ success: false, status: available.status, error: available.error || "Codex result is not available for this selected conversation." });
      return;
    }
    claim = deliveryKey(current.path, submissionId);
    if (deliveryClaims.has(claim)) {
      sendResponse({ success: false, status: "submitting", error: "Codex report delivery is already being started." });
      return;
    }
    deliveryClaims.add(claim);
    const next = { status: "submitting", submissionId, conversationPath: current.path, updatedAt: new Date().toISOString() };
    await persistDeliveryState(settings, next);
    deliveryDiagnostic("delivery-started", { submissionId, conversationPath: current.path });
    sendResponse({ success: true, result: available.result });
  } catch (error) {
    sendResponse({ success: false, status: "error", error: error && typeof error.message === "string" ? error.message : "Unable to begin Codex report delivery." });
  } finally {
    if (claim) deliveryClaims.delete(claim);
  }
}

async function finishDelivery(sendResponse, conversationUrl, submissionId, status, error, attempted = false, stage) {
  try {
    const current = normalizeConversationUrl(conversationUrl);
    const settings = await chrome.storage.local.get(["codexDeliveryState", "codexDeliveryStates"]);
    const previous = matchingDeliveryState(settings, current?.path, submissionId, false);
    if (!current || !previous || previous.status !== "submitting" || previous.submissionId !== submissionId || previous.conversationPath !== current.path) {
      sendResponse({ success: false, error: "Codex delivery state is stale or bound to another conversation." });
      return;
    }
    const next = { ...previous, status, error, attempted: attempted === true, stage: typeof stage === "string" ? stage : undefined, updatedAt: new Date().toISOString() };
    await persistDeliveryState(settings, next);
    deliveryDiagnostic("delivery-finished", { submissionId, conversationPath: current.path, status, attempted: attempted === true, stage: next.stage });
    sendResponse({ success: true, status });
  } catch (caught) {
    sendResponse({ success: false, error: caught && typeof caught.message === "string" ? caught.message : "Unable to persist Codex delivery state." });
  }
}

async function markDeliveryUncertain(sendResponse, conversationUrl, submissionId, error, stage) {
  try {
    const current = normalizeConversationUrl(conversationUrl);
    const settings = await chrome.storage.local.get(["autoSubmitCodexResultsEnabled", "codexPairingToken", "selectedConversationUrl", "codexDeliveryState", "codexDeliveryStates"]);
    const available = await availableResult(settings, conversationUrl);
    if (!current || !available.result || available.result.submissionId !== submissionId || available.status === "submitted") {
      sendResponse({ success: false, error: "Codex delivery is stale or no longer available." });
      return;
    }
    const next = { status: "uncertain", submissionId, conversationPath: current.path, error: error || "Manual review is required before report delivery can continue.", attempted: false, stage: typeof stage === "string" ? stage : "pre-send", updatedAt: new Date().toISOString() };
    await persistDeliveryState(settings, next);
    deliveryDiagnostic("delivery-blocked", { submissionId, conversationPath: current.path, status: "uncertain", attempted: false, stage: next.stage });
    sendResponse({ success: true, status: "uncertain" });
  } catch (caught) {
    sendResponse({ success: false, error: caught && typeof caught.message === "string" ? caught.message : "Unable to persist uncertain Codex delivery state." });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  if (message?.type === "forwardCapture") {
    void chrome.storage.local.get(["autoForwardEnabled", "selectedConversationUrl"]).then(async (settings) => {
      const selected = normalizeConversationUrl(settings.selectedConversationUrl);
      const incoming = normalizeConversationUrl(message.capture?.conversationUrl);
      if (settings.autoForwardEnabled !== true || !selected || !incoming || selected.path !== incoming.path) {
        sendResponse({ success: true, ignored: true, reason: "Conversation is not selected for automation." });
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      fetch(`${bridgeUrl}/api/captures`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message.capture), signal: controller.signal })
        .then(async (response) => {
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.success !== true || typeof result.duplicate !== "boolean") throw new Error(result.error || `Bridge returned ${response.status}`);
          sendResponse({ success: true, duplicate: result.duplicate === true, submissionId: typeof result.submissionId === "string" ? result.submissionId : undefined, status: typeof result.status === "string" ? result.status : undefined, automation: result.automation && typeof result.automation.reason === "string" ? result.automation : undefined });
        })
        .catch((error) => sendResponse({ success: false, error: error?.name === "AbortError" ? "Bridge request timed out." : error?.message || "Bridge unavailable." }))
        .finally(() => clearTimeout(timeout));
    }).catch(() => sendResponse({ success: false, error: "Unable to read automation selection." }));
    return true;
  }

  if (message?.type === "getCodexResultForConversation") {
    void respondWithResult(sendResponse, message.conversationUrl);
    return true;
  }
  if (message?.type === "beginCodexDelivery") {
    void beginDelivery(sendResponse, message.conversationUrl, message.submissionId);
    return true;
  }
  if (message?.type === "finishCodexDelivery") {
    void finishDelivery(sendResponse, message.conversationUrl, message.submissionId, message.status, message.error, message.attempted, message.stage);
    return true;
  }
  if (message?.type === "markCodexDeliveryUncertain") {
    void markDeliveryUncertain(sendResponse, message.conversationUrl, message.submissionId, message.error, message.stage);
    return true;
  }
  return false;
});
