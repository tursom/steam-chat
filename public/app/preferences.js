export function createPreferencesController({
  targetIdInput,
  historyLimitInput,
  storage = window.localStorage,
}) {
  function loadPreferences() {
    targetIdInput.value = storage.getItem('steam-chat-target-id') || '';
    historyLimitInput.value = storage.getItem('steam-chat-history-limit') || '100';
  }

  function currentTargetId() {
    return targetIdInput.value.trim();
  }

  function currentHistoryLimit() {
    const value = Number.parseInt(historyLimitInput.value, 10);
    if (!Number.isFinite(value) || value <= 0) {
      return 100;
    }
    return Math.min(value, 500);
  }

  function savePreferences() {
    storage.setItem('steam-chat-target-id', currentTargetId());
    storage.setItem('steam-chat-history-limit', String(currentHistoryLimit()));
  }

  return {
    currentHistoryLimit,
    currentTargetId,
    loadPreferences,
    savePreferences,
  };
}
