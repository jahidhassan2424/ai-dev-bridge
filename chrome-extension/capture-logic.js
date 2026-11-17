(function exposeCaptureLogic(root) {
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

  root.AiDevBridgeCaptureLogic = { isCompletionSafe };
})(globalThis);
