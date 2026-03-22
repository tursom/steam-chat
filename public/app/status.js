const CONNECTION_LABELS = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '异常',
};

export function createStatusController({ feedbackEl, connectionChipEl, connectionLabelEl }) {
  function setFeedback(text) {
    feedbackEl.textContent = text || '准备就绪';
  }

  function setConnection(state, text) {
    const normalizedState = CONNECTION_LABELS[state] ? state : 'connecting';
    connectionChipEl.classList.remove('is-connecting', 'is-connected', 'is-disconnected', 'is-error');
    connectionChipEl.classList.add('is-' + normalizedState);
    connectionLabelEl.textContent = text || CONNECTION_LABELS[normalizedState];
  }

  return {
    setFeedback,
    setConnection,
  };
}
