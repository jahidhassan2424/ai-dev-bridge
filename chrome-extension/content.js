const assistantSelector = '[data-chatgpt-search-unit-key$=":assistant"]';
const generationControlSelectors = [
  'button[aria-label*="Stop" i]',
  '[data-testid*="stop" i]',
];
const userMessageSelector = '[data-chatgpt-search-unit-key$=":user"], [data-message-author-role="user"], [data-conversation-role="user"], [data-testid*="user-message" i]';
const completionQuietPeriodMs = 1_800;
const { extractAssistantText, getResponseKey, isCompletionSafe, completionDelay, normalizeComposerText, hasComposerDraft, isComposerReady } = globalThis.AiDevBridgeCaptureLogic;
const { normalizeConversationUrl } = globalThis.AiDevBridgeConversation;

const knownAssistantMessages = new WeakSet();
const knownMessageTexts = new WeakMap();
const capturedAssistantMessages = new WeakSet();
const capturedResponseKeys = new Set();
const candidates = new Map();
const candidateKeys = new Map();
const baselineMessageTexts = new Map();
let baselineMessageKeys = new Set();
let observedConversationPath = "";
let captureEnabled = false;
let autoForwardEnabled = false;
let autoSubmitCodexResultsEnabled = false;
let selectedConversationUrl = "";
let observer;
let codexResultWatchTimer;
let codexDeliveryInFlight = false;
let generationWasActive = false;
let reconciliationQueued = false;
let extensionContextInvalidated = false;

function captureDiagnostic(stage, details = {}) {
  console.info("[AI Dev Bridge] capture", { stage, ...details });
}

function extensionContextIsAvailable() {
  try { return Boolean(chrome.runtime?.id); } catch { return false; }
}

function handleExtensionContextInvalidation() {
  if (extensionContextInvalidated) return;
  extensionContextInvalidated = true;
  captureDiagnostic("context-invalidated", { action: "observer-stopped-awaiting-content-script-reinjection" });
  stopCapture();
}

function assistantMessages() {
  const messages = Array.from(document.querySelectorAll(assistantSelector));
  if (messages.length > 0) {
    console.debug("[AI Dev Bridge] assistant wrapper found", { count: messages.length });
  }
  return messages;
}

function isGenerationInProgress() {
  if (generationControlSelectors.some((selector) => document.querySelector(selector) !== null)) {
    return true;
  }

  return Array.from(document.querySelectorAll("button")).some((button) => {
    const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.toLowerCase();
    return label.includes("stop generating") || label.trim() === "stop";
  });
}

function rememberCurrentMessages() {
  for (const message of assistantMessages()) {
    knownAssistantMessages.add(message);
    knownMessageTexts.set(message, getMessageText(message));
  }
  baselineMessageKeys = new Set(assistantMessages().map(getMessageKey));
  baselineMessageTexts.clear();
  for (const message of assistantMessages()) baselineMessageTexts.set(getMessageKey(message), getMessageText(message));
  observedConversationPath = normalizeConversationUrl(location.href)?.path || "";
}

function resetForConversation(path) {
  for (const candidate of candidates.values()) clearTimeout(candidate.timer);
  candidates.clear();
  candidateKeys.clear();
  capturedAssistantMessages.clear?.();
  baselineMessageKeys = new Set();
  baselineMessageTexts.clear();
  observedConversationPath = path;
  rememberCurrentMessages();
  generationWasActive = isGenerationInProgress();
  captureDiagnostic("navigation-reset", { conversationPath: path });
}

function getMessageKey(message) {
  return (
    message.getAttribute("data-chatgpt-search-unit-key") ||
    message.getAttribute("data-dil-message-id") ||
    message.getAttribute("data-message-id") ||
    getMessageText(message)
  );
}

function getMessageText(message) {
  const text = extractAssistantText(message);
  return text;
}

function responseKey(message, text) {
  return getResponseKey(`${normalizeConversationUrl(location.href)?.path || "unknown"}::${getMessageKey(message)}`, text);
}

function setForwardingStatus(state, message) {
  void chrome.storage.local.set({
    forwardingStatus: {
      state,
      message,
      updatedAt: new Date().toISOString(),
    },
  });
}

function codexDeliveryDiagnostic(stage, details = {}) {
  console.info("[AI Dev Bridge] Codex delivery", { stage, ...details });
}

function forwardCapturedResponse(message, text) {
  if (!captureEnabled || !autoForwardEnabled) {
    captureDiagnostic("forwarding-skipped", { reason: !captureEnabled ? "capture-disabled" : "auto-forward-disabled" });
    return;
  }

  const selected = normalizeConversationUrl(selectedConversationUrl);
  const current = normalizeConversationUrl(location.href);
  if (!selected || !current || selected.path !== current.path) {
    captureDiagnostic("forwarding-skipped", { reason: "conversation-mismatch" });
    setForwardingStatus("ignored", "Response captured locally; this conversation is not selected for automation.");
    return;
  }

  if (!extensionContextIsAvailable()) {
    handleExtensionContextInvalidation();
    return;
  }
  try { void chrome.storage.local.get(["codexReturnInFlight"]).then(async ({ codexReturnInFlight: guard }) => {
    const currentPath = normalizeConversationUrl(location.href)?.path;
    if (guard && guard.expiresAt > Date.now() && guard.conversationPath === currentPath) {
      captureDiagnostic("forwarding-skipped", { reason: "codex-return-loop-guard" });
      await chrome.storage.local.remove("codexReturnInFlight");
      setForwardingStatus("ignored", "ChatGPT response was not forwarded because it followed an automatic Codex report return.");
      return;
    }
    const capture = { id: getMessageKey(message), text, timestamp: new Date().toISOString(), conversationUrl: location.href };
    captureDiagnostic("forwarding-started", { responseId: capture.id, characters: text.length });
    setForwardingStatus("pending", "Forwarding response to local bridge...");
    chrome.runtime.sendMessage({ type: "forwardCapture", capture }, (result) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) { captureDiagnostic("forwarding-failed", { reason: "runtime-error" }); setForwardingStatus("error", "Bridge unavailable; response remains captured locally."); return; }
      if (!result?.success) { captureDiagnostic("forwarding-failed", { reason: "bridge-rejected" }); setForwardingStatus("error", result?.error || "The bridge rejected the response."); return; }
      if (result.ignored) { captureDiagnostic("forwarding-skipped", { reason: "background-isolated" }); setForwardingStatus("ignored", result.reason || "Response was not forwarded because this conversation is not selected."); return; }
      captureDiagnostic("forwarding-result", { duplicate: result.duplicate === true, queued: Boolean(result.submissionId), automationDecision: result.automation?.decision || "none" });
      if (result.automation?.decision === "skipped") {
        const messages = { disabled: "Capture forwarded, but Automation Mode is disabled.", paused: "Capture forwarded, but Automation Mode is paused.", workspace_missing: "Capture forwarded, but no automation workspace is configured.", conversation_mismatch: "Capture forwarded, but this is not the selected automation conversation.", concurrent_submission: "Capture forwarded, but another Codex submission is already running.", duplicate_submission: "Capture forwarded, but this capture already has a submission.", duplicate: "Response was already forwarded." };
        const reason = result.automation.reason || "unknown";
        setForwardingStatus(reason === "conversation_mismatch" || reason === "disabled" || reason === "paused" ? "ignored" : "error", messages[reason] || `Capture forwarded; automation skipped (${reason}).`);
      } else if (result.submissionId) {
        setForwardingStatus("queued", `Capture queued for Codex (${result.status || "queued"}).`);
      } else {
        setForwardingStatus(result.duplicate ? "duplicate" : "success", result.duplicate ? "Response was already forwarded." : "Response forwarded to local bridge.");
      }
    });
  }).catch(() => { captureDiagnostic("forwarding-failed", { reason: "loop-guard-read-failed" }); setForwardingStatus("error", "Unable to inspect automatic report-return state."); }); } catch { handleExtensionContextInvalidation(); }
}

function isVisible(element) {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function composerValue(composer) {
  return composer instanceof HTMLTextAreaElement ? composer.value : (composer.innerText || composer.textContent || "");
}

function isAriaHidden(element) {
  return Boolean(element?.closest?.('[aria-hidden="true"]'));
}

function isComposerElement(element) {
  return element instanceof HTMLTextAreaElement || element?.isContentEditable === true;
}

function composerPriority(element) {
  return (element === document.activeElement ? 100 : 0) +
    (element.id === "prompt-textarea" ? 50 : 0) +
    (element instanceof HTMLTextAreaElement ? 20 : 0) +
    (element.getAttribute("role") === "textbox" ? 10 : 0);
}

function findComposer() {
  if (document.querySelector('input[type="password"], iframe[src*="captcha" i]')) return null;
  const candidates = Array.from(document.querySelectorAll('#prompt-textarea, textarea[placeholder*="message" i], textarea[data-testid*="composer" i], div[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label*="message" i], div[contenteditable="true"][data-placeholder*="message" i]'));
  return candidates
    .filter((element) => element.isConnected && isComposerElement(element) && !isAriaHidden(element) && isVisible(element) && (!element.getAttribute("aria-label") || !/search|find/i.test(element.getAttribute("aria-label"))))
    .sort((left, right) => composerPriority(right) - composerPriority(left))[0] || null;
}

function composerDraftState(composer) {
  if (!composer || !composer.isConnected || !isComposerElement(composer) || isAriaHidden(composer) || !isVisible(composer)) {
    return { hasDraft: false, characters: 0, reason: "composer-unavailable" };
  }
  if (composer instanceof HTMLTextAreaElement) {
    const text = normalizeComposerText(composer.value);
    return { hasDraft: hasComposerDraft(text), characters: text.length, reason: text ? "textarea-value" : "textarea-empty" };
  }
  const copy = composer.cloneNode(true);
  copy.querySelectorAll('[data-placeholder], [data-lexical-placeholder], [data-testid*="placeholder" i], [aria-hidden="true"]').forEach((node) => node.remove());
  const text = normalizeComposerText(copy.innerText || copy.textContent || "");
  return { hasDraft: hasComposerDraft(text), characters: text.length, reason: text ? "editable-text" : "editable-empty" };
}

function composerDiagnostic(composer, draft) {
  if (!composer) return { selected: false, draftState: draft.reason };
  return {
    selected: true,
    tag: composer.tagName.toLowerCase(),
    id: composer.id || undefined,
    role: composer.getAttribute("role") || undefined,
    kind: composer instanceof HTMLTextAreaElement ? "textarea" : "contenteditable",
    connected: composer.isConnected,
    visible: isVisible(composer),
    draftState: draft.reason,
    draftCharacters: draft.characters,
  };
}

function composerReadiness() {
  const composer = findComposer();
  const draft = composerDraftState(composer);
  const sendButton = findSendButton(true);
  const securityPrompt = Boolean(document.querySelector('input[type="password"], iframe[src*="captcha" i]'));
  const checks = {
    generationIdle: !isGenerationInProgress(),
    composerSelected: Boolean(composer),
    composerVisible: Boolean(composer && isVisible(composer)),
    composerEmpty: !draft.hasDraft,
    securityPromptAbsent: !securityPrompt,
    sendControlPresent: Boolean(sendButton && isVisible(sendButton)),
    sendControlEnabled: Boolean(sendButton && isVisible(sendButton) && !isSendButtonDisabled(sendButton)),
  };
  return {
    composer,
    draft,
    sendButton,
    securityPrompt,
    ready: isComposerReady({
      generationActive: !checks.generationIdle,
      composerVisible: checks.composerVisible,
      composerEmpty: checks.composerEmpty,
      sendVisible: checks.sendControlPresent,
      sendDisabled: isSendButtonDisabled(sendButton),
      securityPrompt,
    }),
    checks,
  };
}

function isSendButtonDisabled(button) {
  return Boolean(button?.disabled) || button?.getAttribute("aria-disabled") === "true";
}

function findSendButton(includeDisabled = false) {
  const candidates = Array.from(document.querySelectorAll('button[data-testid="send-button"], button[aria-label*="Send" i], form button[type="submit"]'));
  return candidates.find((button) => isVisible(button) && (includeDisabled || !isSendButtonDisabled(button)) && !/stop|cancel/i.test(`${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`)) || null;
}

function findUserMessages() {
  return Array.from(document.querySelectorAll(userMessageSelector)).filter((element) => element.isConnected);
}

function normalizedMessageText(element) {
  return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
}

function userMessageKey(element) {
  return element.getAttribute("data-chatgpt-search-unit-key") || element.getAttribute("data-message-id") || element.getAttribute("data-dil-message-id") || normalizedMessageText(element);
}

function userMessageBaseline() {
  const messages = findUserMessages();
  return { elements: new Set(messages), keys: new Set(messages.map(userMessageKey)) };
}

function waitForMatchingUserMessage(text, baseline, timeoutMs = 10_000) {
  const expected = text.replace(/\s+/g, " ").trim();
  return new Promise((resolve) => {
    let observer;
    const finish = (value) => { observer?.disconnect(); clearTimeout(timer); resolve(value); };
    const check = () => {
      const messages = findUserMessages();
      const matched = messages.some((element) => normalizedMessageText(element) === expected && !baseline.elements.has(element) && !baseline.keys.has(userMessageKey(element)));
      if (matched) finish(true);
    };
    observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(false), timeoutMs);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    check();
  });
}

function emitComposerInput(composer, text) {
  composer.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function insertComposerText(composer, text) {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(composer, text);
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand?.("insertText", false, text);
    if (!inserted || composerValue(composer) !== text) composer.replaceChildren(document.createTextNode(text));
  }
  emitComposerInput(composer, text);
  return composerValue(composer) === text;
}

function waitForEnabledSendButton(timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let observer;
    const finish = (button) => { observer?.disconnect(); clearTimeout(timer); resolve(button); };
    const check = () => {
      const button = findSendButton();
      if (button) finish(button);
    };
    observer = new MutationObserver(check);
    const timer = setTimeout(() => finish(null), timeoutMs);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "data-testid", "aria-label"] });
    check();
  });
}

function waitForComposerClear(composer, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const finish = (value) => { observer?.disconnect(); clearTimeout(timer); resolve(value); };
    const observer = new MutationObserver(() => { if (!composerValue(composer).trim()) finish(true); });
    const timer = setTimeout(() => finish(!composerValue(composer).trim()), timeoutMs);
    observer.observe(composer, { childList: true, subtree: true, characterData: true, attributes: true });
    if (!composerValue(composer).trim()) finish(true);
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    if (!extensionContextIsAvailable()) {
      handleExtensionContextInvalidation();
      resolve({ success: false, error: "Extension context was invalidated; reload the ChatGPT tab." });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (result) => {
        if (chrome.runtime.lastError) {
          if (/context invalidated/i.test(chrome.runtime.lastError.message || "")) handleExtensionContextInvalidation();
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(result);
      });
    } catch {
      handleExtensionContextInvalidation();
      resolve({ success: false, error: "Extension context was invalidated; reload the ChatGPT tab." });
    }
  });
}

async function attemptCodexResultDelivery() {
  if (codexDeliveryInFlight || !autoSubmitCodexResultsEnabled || !selectedConversationUrl) return;
  const current = normalizeConversationUrl(location.href);
  if (!current || current.path !== normalizeConversationUrl(selectedConversationUrl)?.path) return;
  codexDeliveryDiagnostic("eligibility", { conversationPath: current.path, autoSubmitEnabled: true });
  const available = await sendRuntimeMessage({ type: "getCodexResultForConversation", conversationUrl: location.href });
  codexDeliveryDiagnostic("availability", { status: available?.status || "unreachable", submissionId: available?.result?.submissionId || available?.submissionId });
  if (!available || available.status === "disabled" || available.status === "idle" || available.status === "submitted") return;
  if (available.status === "paused") { setForwardingStatus("pending", "Automatic Codex report submission is paused."); return; }
  if (available.status === "uncertain" || available.status === "error") {
    setForwardingStatus("error", available.error || "Codex report delivery requires manual review.");
    return;
  }
  const result = available.result;
  if (!result || result.status !== "completed" || !result.response || !result.submissionId) return;
  if (isGenerationInProgress()) { setForwardingStatus("pending", "Waiting for ChatGPT to become idle before returning the Codex report."); return; }
  let readiness = composerReadiness();
  let composer = readiness.composer;
  const baselineUsers = userMessageBaseline();
  codexDeliveryDiagnostic("composer-detection", { composer: composerDiagnostic(composer, readiness.draft), checks: readiness.checks, baselineUserMessageCount: baselineUsers.elements.size });
  if (!readiness.ready) {
    const safetyError = readiness.securityPrompt ? "ChatGPT is requesting login or CAPTCHA; automatic report submission stopped." : readiness.draft.hasDraft ? "ChatGPT composer contains a draft; automatic report submission stopped." : "ChatGPT composer or Send control was not recognized; manual review is required.";
    codexDeliveryDiagnostic("not-attempted", { reason: readiness.securityPrompt ? "security-prompt" : readiness.draft.hasDraft ? "composer-draft" : composer ? "composer-not-ready" : "composer-not-found", composer: composerDiagnostic(composer, readiness.draft) });
    await sendRuntimeMessage({ type: "markCodexDeliveryUncertain", conversationUrl: location.href, submissionId: result.submissionId, error: safetyError, stage: "composer-readiness" });
    stopCodexResultWatch();
    setForwardingStatus("error", safetyError);
    return;
  }
  const begun = await sendRuntimeMessage({ type: "beginCodexDelivery", conversationUrl: location.href, submissionId: result.submissionId });
  if (!begun?.success) { if (begun?.status === "uncertain") setForwardingStatus("error", begun.error || "Codex report delivery is uncertain; manual review is required."); return; }
  codexDeliveryInFlight = true;
  let clicked = false;
  try {
    await chrome.storage.local.set({ codexReturnInFlight: { conversationPath: current.path, submissionId: result.submissionId, expiresAt: Date.now() + 300_000 } });
    readiness = composerReadiness();
    composer = readiness.composer;
    codexDeliveryDiagnostic("composer-revalidation", { composer: composerDiagnostic(composer, readiness.draft), checks: readiness.checks, ready: readiness.ready });
    if (!readiness.ready) {
      throw new Error(readiness.draft.hasDraft ? "ChatGPT composer contains a draft; automatic report submission stopped." : "ChatGPT composer changed before report insertion; delivery was not attempted.");
    }
    if (!insertComposerText(composer, result.response)) throw new Error("ChatGPT composer did not accept the Codex report text.");
    codexDeliveryDiagnostic("insertion", { accepted: true, characters: result.response.length });
    if (isGenerationInProgress()) throw new Error("ChatGPT started generating before the Codex report could be submitted.");
    const currentSendButton = await waitForEnabledSendButton();
    if (!currentSendButton) throw new Error("ChatGPT did not enable its Send control after report insertion; delivery was not attempted.");
    codexDeliveryDiagnostic("send-attempt", { sendButtonFound: true, composerAccepted: true });
    currentSendButton.click();
    clicked = true;
    const confirmed = await waitForMatchingUserMessage(result.response, baselineUsers);
    codexDeliveryDiagnostic("confirmation", { confirmed, userMessageCount: findUserMessages().length, attempted: true });
    if (!confirmed) throw new Error("ChatGPT did not confirm a new matching user message; delivery remains uncertain.");
    const finished = await sendRuntimeMessage({ type: "finishCodexDelivery", conversationUrl: location.href, submissionId: result.submissionId, status: "submitted", attempted: true, stage: "acknowledged" });
    if (!finished?.success) throw new Error(finished?.error || "Bridge did not confirm Codex report delivery state.");
    await chrome.storage.local.remove("codexReturnInFlight");
    codexDeliveryDiagnostic("return-guard-cleared", { submissionId: result.submissionId, conversationPath: current.path });
    setForwardingStatus("success", "Completed Codex report submitted to the selected ChatGPT conversation.");
  } catch (error) {
    if (!clicked) await chrome.storage.local.remove("codexReturnInFlight");
    if (clicked) {
      codexDeliveryDiagnostic("attempted-unconfirmed", { reason: "acknowledgment-missing" });
    } else {
      codexDeliveryDiagnostic("not-attempted", { reason: "pre-send-failure" });
    }
    await sendRuntimeMessage({ type: "finishCodexDelivery", conversationUrl: location.href, submissionId: result.submissionId, status: "uncertain", error: error instanceof Error ? error.message : "Report submission could not be confirmed.", attempted: clicked, stage: clicked ? "acknowledgment" : "pre-send" });
    setForwardingStatus("error", error instanceof Error ? error.message : "Report submission could not be confirmed; manual review is required.");
  } finally {
    codexDeliveryInFlight = false;
  }
}

function startCodexResultWatch() {
  if (codexResultWatchTimer) return;
  codexDeliveryDiagnostic("watch-started", { conversationPath: normalizeConversationUrl(location.href)?.path });
  codexResultWatchTimer = setInterval(() => { void attemptCodexResultDelivery(); }, 1_500);
  void attemptCodexResultDelivery();
}

function stopCodexResultWatch() {
  if (codexResultWatchTimer) clearInterval(codexResultWatchTimer);
  codexResultWatchTimer = undefined;
}

function completionRejectionReason(candidate, message, latestMessage, text) {
  if (!captureEnabled) return "capture disabled";
  if (!candidate) return "no candidate";
  if (capturedAssistantMessages.has(message)) return "already captured";
  if (latestMessage !== message) return "not latest wrapper";
  if (!message.isConnected) return "wrapper detached";
  if (candidate.manuallyStopped) return "manually stopped";
  if (isGenerationInProgress()) return "generation active";
  if (!text) return "empty response";
  if (Date.now() - candidate.lastChangedAt < completionQuietPeriodMs) return "quiet period incomplete";
  if (candidate.stableChecks < 1) return "not stable";
  return "duplicate response";
}

function scheduleCompletionCheck(message, delay = completionQuietPeriodMs) {
  const candidate = candidates.get(message);
  if (!candidate) {
    return;
  }

  clearTimeout(candidate.timer);
  candidate.timer = setTimeout(() => {
    candidate.timer = undefined;
    void captureIfComplete(message);
  }, delay);
}

async function captureIfComplete(message) {
  const candidate = candidates.get(message);
  const latestMessage = assistantMessages().at(-1);
  const latestKey = latestMessage ? getMessageKey(latestMessage) : "";
  const text = getMessageText(message);
  if (candidate) {
    candidate.text = text;
  }

  const completionState = {
    latest: latestKey === getMessageKey(message),
    connected: message.isConnected,
    generationActive: isGenerationInProgress(),
    now: Date.now(),
    quietPeriodMs: completionQuietPeriodMs,
  };
  if (!isCompletionSafe(candidate, completionState)) {
    captureDiagnostic("completion-rejected", {
      reason: completionRejectionReason(candidate, message, latestMessage, text),
    });
    return;
  }

  const key = responseKey(message, text);
  if (capturedResponseKeys.has(key)) {
    captureDiagnostic("completion-rejected", { reason: "duplicate-response" });
    candidates.delete(message);
    candidateKeys.delete(getMessageKey(message));
    return;
  }

  capturedAssistantMessages.add(message);
  capturedResponseKeys.add(key);
  candidates.delete(message);
  captureDiagnostic("completion-accepted", { responseId: getMessageKey(message), characters: text.length });

  try {
    await chrome.storage.local.set({
      latestCapturedResponse: {
        text,
        capturedAt: new Date().toISOString(),
      },
    });
    captureDiagnostic("storage-result", { result: "stored", characters: text.length });
  } catch (error) {
    captureDiagnostic("storage-result", { result: "failed", reason: error instanceof Error ? error.name : "unknown" });
  }

  forwardCapturedResponse(message, text);
}

function inspectForResponses(reason = "mutation") {
  if (!captureEnabled) {
    return;
  }

  const generationActive = isGenerationInProgress();
  const generationFinished = generationWasActive && !generationActive;
  const currentPath = normalizeConversationUrl(location.href)?.path || "";
  if (currentPath && currentPath !== observedConversationPath) resetForConversation(currentPath);
  for (const message of assistantMessages()) {
    const messageKey = getMessageKey(message);
    const text = getMessageText(message);
    if (knownAssistantMessages.has(message)) {
      if (knownMessageTexts.get(message) === text) {
        continue;
      }
      knownAssistantMessages.delete(message);
      knownMessageTexts.set(message, text);
      baselineMessageKeys.delete(getMessageKey(message));
    }

    if (capturedAssistantMessages.has(message)) {
      continue;
    }

    if (!candidates.has(message) && baselineMessageKeys.has(messageKey) && baselineMessageTexts.get(messageKey) === text) {
      knownAssistantMessages.add(message);
      knownMessageTexts.set(message, text);
      continue;
    }

    let candidate = candidates.get(message);
    if (!candidate && candidateKeys.has(messageKey)) {
      const previousMessage = candidateKeys.get(messageKey);
      candidate = candidates.get(previousMessage);
      if (candidate) {
        candidates.delete(previousMessage);
        candidates.set(message, candidate);
        candidate.message = message;
        candidateKeys.set(messageKey, message);
        captureDiagnostic("wrapper-rerendered", { responseId: messageKey, characters: text.length });
      }
    }
    if (!candidate) {
      candidate = {
        text,
        lastChangedAt: Date.now(),
        stableChecks: text ? 1 : 0,
        generationObserved: generationActive,
        manuallyStopped: false,
        timer: undefined,
      };
      candidates.set(message, candidate);
      candidateKeys.set(messageKey, message);
      captureDiagnostic("candidate-detected", { responseId: messageKey, characters: text.length, reason });
      if (text) {
        scheduleCompletionCheck(message);
      }
      continue;
    }

    if (text !== candidate.text) {
      candidate.text = text;
      candidate.lastChangedAt = Date.now();
      candidate.stableChecks = 1;
      captureDiagnostic("candidate-updated", { responseId: messageKey, characters: text.length });
      scheduleCompletionCheck(message);
    } else if (text) {
      candidate.stableChecks += 1;
      const delay = completionDelay(candidate, { generationActive, now: Date.now(), quietPeriodMs: completionQuietPeriodMs });
      if (!candidate.timer && delay !== null && (generationFinished || reason !== "mutation")) {
        scheduleCompletionCheck(message, delay);
      }
    }

    if (generationActive) {
      candidate.generationObserved = true;
    }
  }
  generationWasActive = generationActive;
}

function requestReconciliation(reason) {
  if (!captureEnabled || reconciliationQueued) return;
  reconciliationQueued = true;
  queueMicrotask(() => {
    reconciliationQueued = false;
    inspectForResponses(reason);
  });
}

function startCapture() {
  stopCapture();
  rememberCurrentMessages();
  generationWasActive = isGenerationInProgress();
  observer = new MutationObserver(() => requestReconciliation("mutation"));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-busy", "aria-label", "data-testid", "disabled"],
  });
  captureDiagnostic("initialization", { enabled: true, baselineCount: baselineMessageKeys.size });
  inspectForResponses("initialization");
}

function stopCapture() {
  observer?.disconnect();
  observer = undefined;
  for (const candidate of candidates.values()) {
    clearTimeout(candidate.timer);
  }
  candidates.clear();
  candidateKeys.clear();
  captureDiagnostic("initialization", { enabled: false });
}

function observeNavigation() {
  const reconcileNavigation = () => requestReconciliation("navigation");
  window.addEventListener("popstate", reconcileNavigation);
  window.addEventListener("hashchange", reconcileNavigation);
  window.addEventListener("pageshow", reconcileNavigation);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestReconciliation("visibility-return");
  });
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      reconcileNavigation();
      return result;
    };
  }
}

observeNavigation();

document.addEventListener(
  "click",
  (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(generationControlSelectors.join(","))) {
      return;
    }

    for (const candidate of candidates.values()) {
      candidate.manuallyStopped = true;
    }
    console.debug("[AI Dev Bridge] generation manually stopped; response withheld");
  },
  true,
);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.autoForwardEnabled) {
    autoForwardEnabled = changes.autoForwardEnabled.newValue === true;
  }
  if (changes.selectedConversationUrl) {
    selectedConversationUrl = changes.selectedConversationUrl.newValue || "";
  }
  if (changes.autoSubmitCodexResultsEnabled) {
    autoSubmitCodexResultsEnabled = changes.autoSubmitCodexResultsEnabled.newValue === true;
  }
  if (changes.autoSubmitCodexResultsEnabled || changes.autoForwardEnabled || changes.selectedConversationUrl) {
    if (autoSubmitCodexResultsEnabled && selectedConversationUrl) startCodexResultWatch(); else stopCodexResultWatch();
  }
  if (!changes.captureEnabled) {
    return;
  }

  captureEnabled = changes.captureEnabled.newValue === true;
  if (captureEnabled) {
    startCapture();
  } else {
    stopCapture();
  }
});

void chrome.storage.local
.get(["captureEnabled", "autoForwardEnabled", "selectedConversationUrl", "autoSubmitCodexResultsEnabled"])
  .then(({ captureEnabled: enabled = false, autoForwardEnabled: forwarding = false, selectedConversationUrl: selected = "", autoSubmitCodexResultsEnabled: autoSubmit = false }) => {
    autoForwardEnabled = forwarding === true;
    autoSubmitCodexResultsEnabled = autoSubmit === true;
    selectedConversationUrl = selected;
    console.debug("[AI Dev Bridge] capture initialization", {
      enabled: enabled === true,
      autoForwardEnabled,
    });
    captureEnabled = enabled === true;
    if (captureEnabled) {
      startCapture();
    }
    if (autoSubmitCodexResultsEnabled && selectedConversationUrl) startCodexResultWatch();
  })
  .catch((error) => {
    console.debug("[AI Dev Bridge] capture initialization", { enabled: false, error });
  });
