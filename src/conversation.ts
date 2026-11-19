const conversationPath = /^\/c\/([^/]+)$|^\/g\/([^/]+)\/c\/([^/]+)$/;

interface ConversationIdentity {
  url: string;
  path: string;
  id: string;
}

function normalizeConversationUrl(value: unknown): ConversationIdentity | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(url.hostname)) return undefined;
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const match = conversationPath.exec(pathname);
  if (!match) return undefined;
  const id = match[1] || match[3];
  if (!id || id === "." || id === "..") return undefined;
  const normalizedPath = pathname;
  return { url: `https://chatgpt.com${normalizedPath}`, path: normalizedPath, id };
}

function sameConversation(a: unknown, b: unknown): boolean {
  const left = normalizeConversationUrl(a);
  const right = normalizeConversationUrl(b);
  return Boolean(left && right && left.path === right.path);
}

export = { normalizeConversationUrl, sameConversation };
