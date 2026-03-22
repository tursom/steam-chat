export function createSessionController({
  targetIdInput,
  chatTitleEl,
  chatSubtitleEl,
  renderConversations,
  renderFriends,
  renderGroups,
  savePreferences,
  clearUnreadCount,
  closeSidebar,
  buildConversationPreview,
}) {
  let activeConversationId = '';
  let conversations = [];
  let friendsList = [];
  let groupsList = [];

  function getActiveConversationId() {
    return activeConversationId;
  }

  function getConversations() {
    return conversations;
  }

  function setActiveConversation(id, name) {
    activeConversationId = id || '';
    targetIdInput.value = activeConversationId;
    savePreferences();
    const conversation = conversations.find((item) => item.id === activeConversationId);
    chatTitleEl.textContent = name || (conversation && conversation.name) || activeConversationId || '未选择会话';
    chatSubtitleEl.textContent = activeConversationId
      ? ('SteamID64: ' + activeConversationId)
      : '请选择左侧会话，或手动输入 SteamID64';
    renderConversations(conversations);

    if (!document.hidden && document.hasFocus()) {
      clearUnreadCount();
    }

    if (activeConversationId) {
      closeSidebar();
    }
  }

  function setConversations(items) {
    conversations = Array.isArray(items) ? items : [];
    renderConversations(conversations);
  }

  function setFriends(items) {
    friendsList = Array.isArray(items) ? items : [];
    renderFriends(friendsList);
  }

  function setGroups(items) {
    groupsList = Array.isArray(items) ? items : [];
    renderGroups(groupsList);
  }

  function updateConversationList(entry) {
    if (!entry || !entry.id) {
      return;
    }

    const preview = buildConversationPreview(entry);
    const current = conversations.find((item) => item.id === entry.id);

    if (current) {
      if (!entry.echo) {
        current.name = entry.name || current.name;
      }
      current.updatedAt = entry.date || entry.sentAt || current.updatedAt;
      current.preview = preview || current.preview;
    } else {
      conversations.push({
        id: entry.id,
        name: entry.echo ? entry.id : (entry.name || entry.id),
        updatedAt: entry.date || entry.sentAt || '',
        preview,
      });
    }

    conversations.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    renderConversations(conversations);
  }

  return {
    getActiveConversationId,
    getConversations,
    setActiveConversation,
    setConversations,
    setFriends,
    setGroups,
    updateConversationList,
  };
}
