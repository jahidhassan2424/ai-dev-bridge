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
  if (state.status === "submitting" || state.status === "verifying" || state.status === "recovering") return { ...state, status: "uncertain", error: "Browser or bridge restarted while Codex report delivery was in progress; manual review is required." };
  return state;
}

function deliveryKey(conversationPath, submissionId) {
  return `${encodeURIComponent(conversationPath)}::${submissionId}`;
}

function recoveryRecordKey(conversationPath, submissionId, fingerprint) {
  return `${deliveryKey(conversationPath, submissionId)}::${encodeURIComponent(fingerprint || "legacy")}`;
}

function matchingDeliveryState(settings, conversationPath, submissionId, recoverInterrupted = true, fingerprint = "") {
  const keyed = settings.codexDeliveryStates?.[recoveryRecordKey(conversationPath, submissionId, fingerprint)] || settings.codexDeliveryStates?.[deliveryKey(conversationPath, submissionId)];
  if (keyed) return recoverInterrupted ? deliveryStateFor(keyed) : keyed;
  const legacy = settings.codexDeliveryState;
  if (legacy?.conversationPath === conversationPath && legacy?.submissionId === submissionId) return recoverInterrupted ? deliveryStateFor(legacy) : legacy;
  return null;
}

function deliveryDiagnostic(stage, details = {}) {
  console.info("[AI Dev Bridge] background delivery", { ...details, stage });
}

function reportFingerprint(value) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

async function persistDeliveryState(settings, state) {
  const states = { ...(settings.codexDeliveryStates || {}) };
  const legacy = settings.codexDeliveryState;
  if (legacy?.conversationPath && legacy?.submissionId) {
    const legacyKey = deliveryKey(legacy.conversationPath, legacy.submissionId);
    if (!states[legacyKey]) states[legacyKey] = legacy;
  }
  states[recoveryRecordKey(state.conversationPath, state.submissionId, state.reportFingerprint)] = state;
  states[deliveryKey(state.conversationPath, state.submissionId)] = state;
  await chrome.storage.local.set({ codexDeliveryStates: states, codexDeliveryState: state, codexDeliveryStatus: state });
}

async function getAutomationState(token) {
  const response = await fetch(`${bridgeUrl}/api/codex/control`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true || !body.state) throw new Error(body.error || `Bridge returned ${response.status}`);
  return body.state;
}

async function publishDeliveryStatus(token, conversationUrl, submissionId, status, stage, fingerprint, messageKey, evidence) {
  if (!token) return;
  const response = await fetch(`${bridgeUrl}/api/codex/delivery-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ conversationUrl, submissionId, status, stage, reportFingerprint: fingerprint, messageKey, evidence }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) throw new Error(body.error || `Bridge returned ${response.status}`);
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
  const fingerprint = reportFingerprint(result.response);
  const stored = matchingDeliveryState(settings, current.path, result.submissionId, true, fingerprint);
  if (stored?.status === "submitting" || stored?.status === "verifying" || stored?.status === "recovering" || stored?.status === "uncertain") return { status: "uncertain", submissionId: result.submissionId, attempted: stored.attempted === true, stage: stored.stage, error: stored.error || "Manual review is required before report delivery can continue." };
  if (stored?.status === "submitted" && stored.submissionId === result.submissionId && stored.conversationPath === current.path) return { status: "submitted" };
  if (stored?.status === "abandoned" && stored.submissionId === result.submissionId && stored.conversationPath === current.path) return { status: "abandoned", submissionId: result.submissionId, error: "This uncertain delivery was abandoned. It will not be resent automatically." };
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

async function beginDelivery(sendResponse, conversationUrl, submissionId, baselineMessageKeys) {
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
    const baseline = Array.isArray(baselineMessageKeys) ? [...new Set(baselineMessageKeys.filter((key) => typeof key === "string" && key.length > 0 && key.length <= 512))].slice(0, 500) : undefined;
    const next = { status: "submitting", submissionId, conversationPath: current.path, reportFingerprint: reportFingerprint(available.result.response), baselineMessageKeys: baseline, baselineCapturedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await persistDeliveryState(settings, next);
    deliveryDiagnostic("delivery-started", { submissionId, conversationPath: current.path });
    sendResponse({ success: true, result: available.result });
  } catch (error) {
    sendResponse({ success: false, status: "error", error: error && typeof error.message === "string" ? error.message : "Unable to begin Codex report delivery." });
  } finally {
    if (claim) deliveryClaims.delete(claim);
  }
}

async function beginDeliveryRecovery(sendResponse, conversationUrl, submissionId) {
  let claim;
  try {
    const current = normalizeConversationUrl(conversationUrl);
    const settings = await chrome.storage.local.get(["autoSubmitCodexResultsEnabled", "codexPairingToken", "selectedConversationUrl", "codexDeliveryState", "codexDeliveryStates"]);
    const available = await availableResult(settings, conversationUrl);
    const previous = matchingDeliveryState(settings, current?.path, submissionId);
    if (!current || available.status !== "uncertain" || !available.submissionId || available.submissionId !== submissionId || !previous || previous.status !== "uncertain") {
      sendResponse({ success: false, error: "Only the current uncertain delivery in the selected conversation can be checked." });
      return;
    }
    claim = deliveryKey(current.path, submissionId);
    if (deliveryClaims.has(claim)) { sendResponse({ success: false, error: "A delivery recovery check is already in progress." }); return; }
    deliveryClaims.add(claim);
    const response = await fetch(`${bridgeUrl}/api/codex/latest?conversationUrl=${encodeURIComponent(current.url)}`, { headers: { Accept: "application/json", Authorization: `Bearer ${settings.codexPairingToken}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.result || body.result.submissionId !== submissionId || typeof body.result.response !== "string" || !sameConversation(body.result.sourceConversationUrl, current.url)) throw new Error(body.error || "The original completed result is no longer available for this conversation.");
    const fingerprint = reportFingerprint(body.result.response);
    if (previous.reportFingerprint && previous.reportFingerprint !== fingerprint) throw new Error("The completed result no longer matches the uncertain delivery.");
    const hasReliableBaseline = Array.isArray(previous.baselineMessageKeys);
    const next = { ...previous, status: "verifying", stage: hasReliableBaseline ? "recovery-verifying" : "recovery-legacy-baseline", reportFingerprint: fingerprint, updatedAt: new Date().toISOString() };
    await persistDeliveryState(settings, next);
    deliveryDiagnostic("recovery-started", { submissionId, conversationPath: current.path, attempted: previous.attempted === true });
    sendResponse({ success: true, submissionId, conversationPath: current.path, reportFingerprint: fingerprint, response: body.result.response, baselineMessageKeys: hasReliableBaseline ? previous.baselineMessageKeys : undefined, requiresManualConfirmation: !hasReliableBaseline });
  } catch (error) {
    if (claim) deliveryClaims.delete(claim);
    sendResponse({ success: false, error: error?.message || "Unable to begin delivery recovery." });
  }
}

async function resolveDeliveryRecovery(sendResponse, conversationUrl, submissionId, reportHash, outcome, messageKey) {
  const current = normalizeConversationUrl(conversationUrl);
  const claim = current ? deliveryKey(current.path, submissionId) : "";
  try {
    const settings = await chrome.storage.local.get(["codexDeliveryState", "codexDeliveryStates", "codexPairingToken"]);
    const previous = matchingDeliveryState(settings, current?.path, submissionId, false);
    if (!current || !deliveryClaims.has(claim) || !previous || previous.status !== "verifying" || previous.reportFingerprint !== reportHash) {
      sendResponse({ success: false, error: "Delivery recovery state is stale or bound to another conversation." });
      return;
    }
    if (outcome === "confirmed") {
      if (!Array.isArray(previous.baselineMessageKeys) || typeof messageKey !== "string" || !messageKey) { sendResponse({ success: false, error: "Reliable message identity evidence is required for automatic confirmation." }); return; }
      const next = { ...previous, status: "submitted", stage: "recovery-confirmed", recoveredAt: new Date().toISOString(), messageKey: messageKey.slice(0, 512), evidence: "observed", error: undefined, updatedAt: new Date().toISOString() };
      try { await publishDeliveryStatus(settings.codexPairingToken, current.url, submissionId, "submitted", "recovery-confirmed", previous.reportFingerprint, messageKey.slice(0, 512), "observed"); }
      catch (error) {
        await persistDeliveryState(settings, { ...previous, status: "uncertain", stage: "recovery-sync-failed", error: error?.message || "Server rejected delivery evidence; manual review is required.", updatedAt: new Date().toISOString() });
        sendResponse({ success: false, status: "uncertain", error: error?.message || "Server rejected delivery evidence; manual review is required." });
        return;
      }
      await persistDeliveryState(settings, next);
      deliveryDiagnostic("recovery-confirmed", { submissionId, conversationPath: current.path });
      let resumeAllowed = false;
      try {
        const automation = await getAutomationState(settings.codexPairingToken);
        resumeAllowed = automation.enabled === true && automation.paused !== true && automation.stopped !== true && sameConversation(automation.conversationUrl, current.url);
      } catch { /* Delivery recovery remains valid even if the optional automation-state recheck is offline. */ }
      if (resumeAllowed) deliveryDiagnostic("automation-resumed", { submissionId, conversationPath: current.path });
      sendResponse({ success: true, status: "submitted", resumeAllowed });
    } else {
      const next = { ...previous, status: "uncertain", stage: outcome === "ambiguous" ? "recovery-ambiguous" : "recovery-not-found", updatedAt: new Date().toISOString() };
      await persistDeliveryState(settings, next);
      deliveryDiagnostic(outcome === "ambiguous" ? "recovery-uncertain" : "matching-message-not-found", { submissionId, conversationPath: current.path });
      sendResponse({ success: true, status: "uncertain", outcome });
    }
  } catch (error) { sendResponse({ success: false, error: error?.message || "Unable to resolve delivery recovery." }); }
  finally { if (claim) deliveryClaims.delete(claim); }
}

async function abandonDelivery(sendResponse, conversationUrl, submissionId) {
  try {
    const current = normalizeConversationUrl(conversationUrl);
    const settings = await chrome.storage.local.get(["codexDeliveryState", "codexDeliveryStates", "codexPairingToken"]);
    const previous = matchingDeliveryState(settings, current?.path, submissionId);
    if (!current || !previous || previous.status !== "uncertain") { sendResponse({ success: false, error: "Only an uncertain delivery can be abandoned." }); return; }
    const next = { ...previous, status: "abandoned", stage: "recovery-abandoned", abandonedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    try { await publishDeliveryStatus(settings.codexPairingToken, current.url, submissionId, "abandoned", "recovery-abandoned", previous.reportFingerprint, undefined, "manual"); }
    catch (error) { sendResponse({ success: false, status: "uncertain", error: error?.message || "Server rejected abandonment; the delivery remains uncertain." }); return; }
    await persistDeliveryState(settings, next);
    await chrome.storage.local.remove("codexReturnInFlight");
    deliveryClaims.delete(deliveryKey(current.path, submissionId));
    deliveryDiagnostic("recovery-abandoned", { submissionId, conversationPath: current.path });
    sendResponse({ success: true, status: "abandoned" });
  } catch (error) { sendResponse({ success: false, error: error?.message || "Unable to abandon delivery." }); }
}

async function confirmAmbiguousDelivery(sendResponse, conversationUrl, submissionId) {
  try {
    const current = normalizeConversationUrl(conversationUrl);
    const settings = await chrome.storage.local.get(["codexDeliveryState", "codexDeliveryStates", "codexPairingToken"]);
    const previous = matchingDeliveryState(settings, current?.path, submissionId);
    if (!current || !previous || previous.status !== "uncertain" || previous.stage !== "recovery-legacy-baseline") {
      sendResponse({ success: false, error: "Only the current ambiguous delivery can be manually confirmed." }); return;
    }
    const next = { ...previous, status: "submitted", stage: "recovery-manually-confirmed", evidence: "manual", recoveredAt: new Date().toISOString(), error: undefined, updatedAt: new Date().toISOString() };
    await chrome.storage.local.remove("codexReturnInFlight");
    deliveryDiagnostic("recovery-confirmed", { submissionId, conversationPath: current.path, confirmation: "explicit-ambiguous" });
    try { await publishDeliveryStatus(settings.codexPairingToken, current.url, submissionId, "submitted", "recovery-manually-confirmed", previous.reportFingerprint, undefined, "manual"); }
    catch (error) {
      await persistDeliveryState(settings, { ...previous, status: "uncertain", stage: "recovery-sync-failed", error: error?.message || "Server rejected delivery evidence; manual review is required.", updatedAt: new Date().toISOString() });
      sendResponse({ success: false, status: "uncertain", error: error?.message || "Server rejected delivery evidence; manual review is required." });
      return;
    }
    await persistDeliveryState(settings, next);
    let resumeAllowed = false;
    try {
      const automation = await getAutomationState(settings.codexPairingToken);
      resumeAllowed = automation.enabled === true && automation.paused !== true && automation.stopped !== true && sameConversation(automation.conversationUrl, current.url);
    } catch { /* Retain a confirmed result even if the optional state recheck is offline. */ }
    if (resumeAllowed) deliveryDiagnostic("automation-resumed", { submissionId, conversationPath: current.path });
    sendResponse({ success: true, status: "submitted", resumeAllowed });
  } catch (error) { sendResponse({ success: false, error: error?.message || "Unable to confirm ambiguous delivery." }); }
}

async function finishDelivery(sendResponse, conversationUrl, submissionId, status, error, attempted = false, stage, messageKey, evidence) {
  try {
    const current = normalizeConversationUrl(conversationUrl);
    const settings = await chrome.storage.local.get(["codexDeliveryState", "codexDeliveryStates", "codexPairingToken"]);
    const previous = matchingDeliveryState(settings, current?.path, submissionId, false);
    if (!current || !previous || previous.status !== "submitting" || previous.submissionId !== submissionId || previous.conversationPath !== current.path) {
      sendResponse({ success: false, error: "Codex delivery state is stale or bound to another conversation." });
      return;
    }
    const next = { ...previous, status, error, attempted: attempted === true, stage: typeof stage === "string" ? stage : undefined, messageKey: typeof messageKey === "string" ? messageKey.slice(0, 512) : undefined, evidence: evidence === "observed" || evidence === "manual" ? evidence : undefined, updatedAt: new Date().toISOString() };
    await publishDeliveryStatus(settings.codexPairingToken, current.url, submissionId, status, next.stage, next.reportFingerprint, next.messageKey, next.evidence);
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

async function stopForTerminalSignal(sendResponse, capture) {
  try {
    const settings = await chrome.storage.local.get(["codexPairingToken", "selectedConversationUrl"]);
    const selected = normalizeConversationUrl(settings.selectedConversationUrl);
    const incoming = normalizeConversationUrl(capture?.conversationUrl);
    if (!settings.codexPairingToken || !selected || !incoming || selected.path !== incoming.path) {
      sendResponse({ success: false, error: "Terminal signal is not from the selected paired conversation." });
      return;
    }
    const response = await fetch(`${bridgeUrl}/api/codex/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.codexPairingToken}` },
      body: JSON.stringify({ command: "stop", reason: "task-completed", capture }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success !== true || !body.state?.stopped) throw new Error(body.error || `Bridge returned ${response.status}`);
    await chrome.storage.local.set({ autoForwardEnabled: false, autoSubmitCodexResultsEnabled: false, automationStopped: { reason: body.state.stoppedReason || "task-completed", at: body.state.stoppedAt || new Date().toISOString() } });
    deliveryDiagnostic("automation-stopped", { reason: body.state.stoppedReason, conversationPath: selected.path });
    sendResponse({ success: true, state: body.state });
  } catch (error) {
    sendResponse({ success: false, error: error?.message || "Unable to stop automation." });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  if (message?.type === "forwardCapture") {
    void chrome.storage.local.get(["autoForwardEnabled", "selectedConversationUrl"]).then(async (settings) => {
      const selected = normalizeConversationUrl(settings.selectedConversationUrl);
      const incoming = normalizeConversationUrl(message.capture?.conversationUrl);
      const skippedMarker = message.capture?.status === "skipped";
      if ((settings.autoForwardEnabled !== true && !skippedMarker) || !selected || !incoming || selected.path !== incoming.path) {
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
  if (message?.type === "stopAutomationForTerminalSignal") {
    void stopForTerminalSignal(sendResponse, message.capture);
    return true;
  }

  if (message?.type === "getCodexResultForConversation") {
    void respondWithResult(sendResponse, message.conversationUrl);
    return true;
  }
  if (message?.type === "beginCodexDelivery") {
    void beginDelivery(sendResponse, message.conversationUrl, message.submissionId, message.baselineMessageKeys);
    return true;
  }
  if (message?.type === "finishCodexDelivery") {
    void finishDelivery(sendResponse, message.conversationUrl, message.submissionId, message.status, message.error, message.attempted, message.stage, message.messageKey, message.evidence);
    return true;
  }
  if (message?.type === "markCodexDeliveryUncertain") {
    void markDeliveryUncertain(sendResponse, message.conversationUrl, message.submissionId, message.error, message.stage);
    return true;
  }
  if (message?.type === "beginCodexDeliveryRecovery") {
    void beginDeliveryRecovery(sendResponse, message.conversationUrl, message.submissionId);
    return true;
  }
  if (message?.type === "resolveCodexDeliveryRecovery") {
    void resolveDeliveryRecovery(sendResponse, message.conversationUrl, message.submissionId, message.reportFingerprint, message.outcome, message.messageKey);
    return true;
  }
  if (message?.type === "abandonCodexDelivery") {
    void abandonDelivery(sendResponse, message.conversationUrl, message.submissionId);
    return true;
  }
  if (message?.type === "confirmAmbiguousCodexDelivery") {
    void confirmAmbiguousDelivery(sendResponse, message.conversationUrl, message.submissionId);
    return true;
  }
  return false;
});
