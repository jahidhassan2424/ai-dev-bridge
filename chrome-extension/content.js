const assistantSelector = '[conversation-role="assistant"]';
const generationControlSelectors = [
  'button[aria-label*="Stop" i]',
  '[data-testid*="stop" i]',
];
const completionQuietPeriodMs = 1_800;
const { extractAssistantText, isCompletionSafe } = globalThis.AiDevBridgeCaptureLogic;

const knownAssistantMessages = new WeakSet();
const knownMessageTexts = new WeakMap();
const capturedAssistantMessages = new WeakSet();
const candidates = new Map();
let baselineMessageKeys = new Set();
let lastCapturedText = "";
let captureEnabled = false;
let observer;

function assistantMessages() {
  return Array.from(document.querySelectorAll(assistantSelector));
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
}

function getMessageKey(message) {
  return message.getAttribute("data-dil-message-id") || message.getAttribute("data-message-id") || getMessageText(message);
}

function getMessageText(message) {
  return extractAssistantText(message);
}

function scheduleCompletionCheck(message) {
  const candidate = candidates.get(message);
  if (!candidate) {
    return;
  }

  clearTimeout(candidate.timer);
  candidate.timer = setTimeout(() => {
    void captureIfComplete(message);
  }, completionQuietPeriodMs);
}

async function captureIfComplete(message) {
  const candidate = candidates.get(message);
  const latestMessage = assistantMessages().at(-1);
  const text = getMessageText(message);
  if (candidate) {
    candidate.text = text;
  }

  if (
    !captureEnabled ||
    !candidate ||
    capturedAssistantMessages.has(message) ||
    latestMessage !== message ||
    !isCompletionSafe(candidate, {
      latest: latestMessage === message,
      connected: message.isConnected,
      generationActive: isGenerationInProgress(),
      now: Date.now(),
      quietPeriodMs: completionQuietPeriodMs,
    })
  ) {
    return;
  }

  if (text === lastCapturedText) {
    console.debug("[AI Dev Bridge] duplicate response skipped");
    candidates.delete(message);
    return;
  }

  capturedAssistantMessages.add(message);
  candidates.delete(message);
  console.debug("[AI Dev Bridge] response complete", { characters: text.length });

  try {
    await chrome.storage.local.set({
      latestCapturedResponse: {
        text,
        capturedAt: new Date().toISOString(),
      },
    });
    lastCapturedText = text;
    console.debug("[AI Dev Bridge] response stored", { characters: text.length });
  } catch (error) {
    console.debug("[AI Dev Bridge] response storage failed", error);
  }
}

function inspectForResponses() {
  if (!captureEnabled) {
    return;
  }

  const generationActive = isGenerationInProgress();
  for (const message of assistantMessages()) {
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

    if (!candidates.has(message) && baselineMessageKeys.has(getMessageKey(message))) {
      knownAssistantMessages.add(message);
      knownMessageTexts.set(message, text);
      continue;
    }

    let candidate = candidates.get(message);
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
      console.debug("[AI Dev Bridge] assistant response detected", { characters: text.length });
      if (text) {
        scheduleCompletionCheck(message);
      }
      continue;
    }

    if (text !== candidate.text) {
      candidate.text = text;
      candidate.lastChangedAt = Date.now();
      candidate.stableChecks = 1;
      console.debug("[AI Dev Bridge] response updated", { characters: text.length });
      scheduleCompletionCheck(message);
    } else if (text) {
      candidate.stableChecks += 1;
    }

    if (generationActive) {
      candidate.generationObserved = true;
    }
  }
}

function startCapture() {
  stopCapture();
  rememberCurrentMessages();
  observer = new MutationObserver(inspectForResponses);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  console.debug("[AI Dev Bridge] capture enabled");
}

function stopCapture() {
  observer?.disconnect();
  observer = undefined;
  for (const candidate of candidates.values()) {
    clearTimeout(candidate.timer);
  }
  candidates.clear();
  console.debug("[AI Dev Bridge] capture disabled");
}

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
  if (areaName !== "local" || !changes.captureEnabled) {
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
  .get("captureEnabled")
  .then(({ captureEnabled: enabled = false }) => {
    captureEnabled = enabled === true;
    if (captureEnabled) {
      startCapture();
    }
  })
  .catch((error) => {
    console.debug("[AI Dev Bridge] capture initialization failed", error);
  });
