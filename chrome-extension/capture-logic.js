(function exposeCaptureLogic(root) {
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
        return (copy.innerText || copy.textContent || "").trim();
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

  function isComposerReady(state) {
    return Boolean(
      state &&
      !state.generationActive &&
      state.composerVisible &&
      state.composerEmpty &&
      state.sendVisible &&
      (!state.requireEnabledSend || !state.sendDisabled) &&
      !state.securityPrompt,
    );
  }

  root.AiDevBridgeCaptureLogic = { extractAssistantText, getResponseKey, isCompletionSafe, completionDelay, normalizeComposerText, hasComposerDraft, isComposerReady };
})(globalThis);
