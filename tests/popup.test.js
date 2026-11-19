const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const popupHtml = fs.readFileSync("chrome-extension/popup.html", "utf8");
const popupJs = fs.readFileSync("chrome-extension/popup.js", "utf8");

test("popup exposes manual Codex result refresh and copy controls", () => {
  assert.match(popupHtml, /id="latest-codex-heading"/);
  assert.match(popupHtml, /id="refresh-codex-result"/);
  assert.match(popupHtml, /id="copy-codex-result"/);
  assert.match(popupJs, /\/api\/codex\/latest/);
  assert.match(popupJs, /\/api\/codex\/pair/);
  assert.match(popupJs, /Authorization: `Bearer \$\{codexPairingToken\}`/);
  assert.match(popupJs, /navigator\.clipboard\.writeText/);
  assert.match(popupHtml, /id="auto-submit-enabled"/);
  assert.match(popupJs, /autoSubmitCodexResultsEnabled/);
  assert.match(popupJs, /lastFocusedWindow: true/);
  assert.match(popupJs, /normalizeConversationUrl\(conversationUrl\)/);
  assert.match(popupJs, /Enter a trusted workspace path/);
  assert.match(popupJs, /refreshAutoSubmitDeliveryStatus/);
  assert.match(popupJs, /getCodexResultForConversation/);
  assert.match(popupJs, /ready: "A completed Codex report is ready for automatic delivery/);
});

test("popup does not contain a ChatGPT injection or automatic submission path", () => {
  assert.doesNotMatch(popupJs, /executeScript|chrome\.scripting/);
  assert.doesNotMatch(popupJs, /chatgpt\.com/);
});
