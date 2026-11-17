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

  root.AiDevBridgeCaptureLogic = { extractAssistantText, isCompletionSafe };
})(globalThis);
