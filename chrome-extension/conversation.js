(function () {
  const conversationPath = /^\/c\/([^/]+)$|^\/g\/([^/]+)\/c\/([^/]+)$/;
  function normalizeConversationUrl(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(url.hostname)) return null;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const match = conversationPath.exec(pathname);
    if (!match || !(match[1] || match[3])) return null;
    return { url: `https://chatgpt.com${pathname}`, path: pathname, id: match[1] || match[3] };
  }
  globalThis.AiDevBridgeConversation = { normalizeConversationUrl };
})();
