const bridgeUrl = "http://127.0.0.1:3000";
const sendTestButton = document.querySelector("#send-test");
const checkConnectionButton = document.querySelector("#check-connection");
const bridgeStatus = document.querySelector("#bridge-status");
const bridgeStatusText = document.querySelector("#bridge-status-text");
const bridgeFeedback = document.querySelector("#bridge-feedback");
const captureEnabled = document.querySelector("#capture-enabled");
const captureStatus = document.querySelector("#capture-status");
const captureMetadata = document.querySelector("#capture-metadata");
const capturedResponse = document.querySelector("#captured-response");

if (
  !sendTestButton ||
  !checkConnectionButton ||
  !bridgeStatus ||
  !bridgeStatusText ||
  !bridgeFeedback ||
  !captureEnabled ||
  !captureStatus ||
  !captureMetadata ||
  !capturedResponse
) {
  throw new Error("Popup UI is missing required elements.");
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
  const { captureEnabled: enabled = false, latestCapturedResponse } = await chrome.storage.local.get([
    "captureEnabled",
    "latestCapturedResponse",
  ]);
  captureEnabled.checked = enabled;
  captureStatus.textContent = enabled ? "Capture is active on ChatGPT." : "Capture is disabled.";
  displayCapture(latestCapturedResponse);
  await checkConnection();
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
});

checkConnectionButton.addEventListener("click", () => {
  void checkConnection();
});

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
