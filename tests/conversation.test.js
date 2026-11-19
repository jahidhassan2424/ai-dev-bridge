const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeConversationUrl, sameConversation } = require("../dist/conversation.js");

test("normalizes standard and custom GPT conversation URLs without changing identity", () => {
  assert.equal(normalizeConversationUrl("https://www.chatgpt.com/c/abc/?q=ignored#reply").url, "https://chatgpt.com/c/abc");
  assert.equal(normalizeConversationUrl("https://chatgpt.com/g/g-custom/c/abc/").path, "/g/g-custom/c/abc");
  assert.equal(sameConversation("https://chatgpt.com/c/abc?one=1", "https://www.chatgpt.com/c/abc#two"), true);
  assert.equal(sameConversation("https://chatgpt.com/c/abc", "https://chatgpt.com/c/other"), false);
});

test("rejects homepage, share links, and ambiguous conversation paths", () => {
  for (const value of ["https://chatgpt.com/", "https://chatgpt.com/g/g-custom", "https://chatgpt.com/share/abc", "https://chatgpt.com/c/a/b", "https://evil.example/c/abc"]) {
    assert.equal(normalizeConversationUrl(value), undefined);
  }
});
