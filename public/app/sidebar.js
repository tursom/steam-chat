const PERSONA_STATE_LABELS = {
  0: '离线',
  1: '在线',
  2: '忙碌',
  3: '离开',
  4: '打盹',
  5: '想交易',
  6: '想玩游戏',
};

export function createSidebarController({
  conversationListEl,
  friendsListEl,
  groupsListEl,
  sidebarTabs,
  sidebarTabPanels,
  formatConversationTime,
  getActiveConversationId,
  onConversationSelect,
  onFriendSelect,
  onGroupSelect,
}) {
  function switchSidebarTab(tabName) {
    sidebarTabs.forEach((tab) => {
      const isActive = tab.dataset.tab === tabName;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.tabIndex = isActive ? 0 : -1;
    });
    Object.keys(sidebarTabPanels).forEach((key) => {
      sidebarTabPanels[key].hidden = key !== tabName;
    });
  }

  function bindTabKeyboardNavigation() {
    sidebarTabs.forEach((tab) => {
      tab.addEventListener('keydown', (event) => {
        const tabs = Array.from(sidebarTabs);
        const currentIndex = tabs.indexOf(tab);
        if (currentIndex === -1) {
          return;
        }

        let nextIndex = currentIndex;
        if (event.key === 'ArrowRight') {
          nextIndex = (currentIndex + 1) % tabs.length;
        } else if (event.key === 'ArrowLeft') {
          nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = tabs.length - 1;
        } else {
          return;
        }

        event.preventDefault();
        const nextTab = tabs[nextIndex];
        switchSidebarTab(nextTab.dataset.tab);
        nextTab.focus();
      });
    });
  }

  function renderConversations(conversations) {
    conversationListEl.replaceChildren();

    if (!conversations.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无历史会话';
      conversationListEl.appendChild(empty);
      return;
    }

    const activeConversationId = getActiveConversationId();
    const fragment = document.createDocumentFragment();
    conversations.forEach((conversation) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'conversation-item' + (conversation.id === activeConversationId ? ' active' : '');

      const top = document.createElement('div');
      top.className = 'conversation-top';

      const name = document.createElement('div');
      name.className = 'conversation-name';
      name.textContent = conversation.name || conversation.id;

      const time = document.createElement('div');
      time.className = 'conversation-time';
      time.textContent = formatConversationTime(conversation.updatedAt);

      top.appendChild(name);
      top.appendChild(time);

      const preview = document.createElement('div');
      preview.className = 'conversation-preview';
      preview.textContent = conversation.preview || '[空会话]';

      const idLine = document.createElement('div');
      idLine.className = 'conversation-id';
      idLine.textContent = conversation.id;

      item.appendChild(top);
      item.appendChild(preview);
      item.appendChild(idLine);
      item.addEventListener('click', () => onConversationSelect(conversation));
      fragment.appendChild(item);
    });
    conversationListEl.appendChild(fragment);
  }

  function renderFriends(friendsList) {
    friendsListEl.replaceChildren();

    if (!friendsList.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无好友数据';
      friendsListEl.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    friendsList.forEach((friend) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'friend-item';

      if (friend.avatar) {
        const avatar = document.createElement('img');
        avatar.className = 'friend-avatar';
        avatar.src = friend.avatar;
        avatar.alt = friend.name;
        avatar.loading = 'lazy';
        item.appendChild(avatar);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'friend-avatar';
        item.appendChild(placeholder);
      }

      const info = document.createElement('div');
      info.className = 'friend-info';

      const name = document.createElement('div');
      name.className = 'friend-name';
      name.textContent = friend.name || friend.id;
      info.appendChild(name);

      const status = document.createElement('div');
      const isOnline = friend.status > 0;
      const inGame = friend.game;
      status.className = 'friend-status' + (inGame ? ' in-game' : isOnline ? ' online' : '');
      status.textContent = inGame
        ? ('正在游戏: ' + friend.game)
        : (PERSONA_STATE_LABELS[friend.status] || '离线');
      info.appendChild(status);

      const idLine = document.createElement('div');
      idLine.className = 'friend-id';
      idLine.textContent = friend.id;
      info.appendChild(idLine);

      item.appendChild(info);
      item.addEventListener('click', () => onFriendSelect(friend));
      fragment.appendChild(item);
    });
    friendsListEl.appendChild(fragment);
  }

  function renderGroups(groupsList) {
    groupsListEl.replaceChildren();

    if (!groupsList.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无群组数据';
      groupsListEl.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    groupsList.forEach((group) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'group-item';

      const info = document.createElement('div');
      info.className = 'group-info';

      const name = document.createElement('div');
      name.className = 'group-name';
      name.textContent = group.name || group.id;
      info.appendChild(name);

      const idLine = document.createElement('div');
      idLine.className = 'group-id';
      idLine.textContent = group.id;
      info.appendChild(idLine);

      item.appendChild(info);
      item.addEventListener('click', () => onGroupSelect(group));
      fragment.appendChild(item);
    });
    groupsListEl.appendChild(fragment);
  }

  return {
    bindTabKeyboardNavigation,
    renderConversations,
    renderFriends,
    renderGroups,
    switchSidebarTab,
  };
}
