(function exposeCaptureLogic(root) {
  const blockTags = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION",
    "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
    "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL",
  ]);

  function structuredNodeText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || node.textContent || "";
    if (node.nodeType !== 1) return "";
    const tag = String(node.tagName || "").toUpperCase();
    if (tag === "BR") return "\n";
    const children = Array.from(node.childNodes || []);
    const content = children.length
      ? children.map(structuredNodeText).join("")
      : (node.textContent || "");
    if (tag === "PRE") return `\n\`\`\`\n${content}\n\`\`\`\n`;
    if (tag === "BLOCKQUOTE") {
      const quoted = content.replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
      return `\n${quoted}\n`;
    }
    return blockTags.has(tag) ? `\n${content}\n` : content;
  }

  function normalizeStructuredText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractAssistantText(message) {
    const markdownNodes = Array.from(
      message.querySelectorAll('[data-markdown-text-style="assistant-message"]'),
    );
    const contentNodes = markdownNodes.length
      ? markdownNodes
      : Array.from(message.querySelectorAll("[data-response-body]"));

    return contentNodes
      .map((node) => {
        const copy = node.cloneNode(true);
        copy
          .querySelectorAll('button, [role="button"], [aria-label*="copy" i], [data-testid*="toolbar" i]')
          .forEach((control) => control.remove());
        const structured = structuredNodeText(copy);
        return normalizeStructuredText(structured || copy.innerText || copy.textContent || "");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  function isCompletionSafe(candidate, state) {
    return Boolean(
      candidate &&
        state.latest &&
        state.connected &&
        !candidate.manuallyStopped &&
        !state.generationActive &&
        candidate.text.length > 0 &&
        state.now - candidate.lastChangedAt >= state.quietPeriodMs &&
        candidate.stableChecks >= 1,
    );
  }

  function completionDelay(candidate, state) {
    if (!candidate || candidate.manuallyStopped || !candidate.text || state.generationActive) return null;
    return Math.max(0, candidate.lastChangedAt + state.quietPeriodMs - state.now);
  }

  function getResponseKey(responseId, text) {
    return `${responseId || "unknown"}::${text}`;
  }

  function normalizeComposerText(value) {
    return String(value || "").replace(/[\u200B\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }

  function hasComposerDraft(value) {
    return normalizeComposerText(value).length > 0;
  }

  function hasTerminalStopMarker(value) {
    let fenced = false;
    for (const line of String(value || "").replace(/\r\n?/g, "\n").split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (!fenced && /^\s*AI_BRIDGE_STOP\s*$/.test(line)) return true;
    }
    return false;
  }

  function isComposerReady(state) {
    return Boolean(
      state &&
      !state.generationActive &&
      state.composerVisible &&
      state.composerEmpty &&
      (!state.requireSendControl || state.sendVisible) &&
      (!state.requireEnabledSend || (state.sendVisible && !state.sendDisabled)) &&
      !state.securityPrompt,
    );
  }

  root.AiDevBridgeCaptureLogic = { extractAssistantText, getResponseKey, isCompletionSafe, completionDelay, normalizeComposerText, hasComposerDraft, hasTerminalStopMarker, isComposerReady, structuredNodeText, normalizeStructuredText };
})(globalThis);
