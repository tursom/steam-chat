export function bindAppShellEvents({
  reloadHistoryButton,
  reloadConversationsButton,
  reloadFriendsButton,
  reloadGroupsButton,
  sidebarTabs,
  bindTabKeyboardNavigation,
  switchSidebarTab,
  openConversationButton,
  targetIdInput,
  historyLimitInput,
  mobileSidebarToggleButton,
  closeSidebarButton,
  sidebarBackdrop,
  mobileLayoutMedia,
  sidebarEl,
  requestHistory,
  openConversation,
  composer,
  socketController,
  layout,
  notifications,
  handleLightboxResize,
}) {
  layout.updateViewportHeightVar();
  layout.syncResponsiveLayout();

  reloadHistoryButton.addEventListener('click', requestHistory);
  reloadConversationsButton.addEventListener('click', () => socketController.requestConversations());
  reloadFriendsButton.addEventListener('click', () => socketController.requestFriends());
  reloadGroupsButton.addEventListener('click', () => socketController.requestGroups());

  sidebarTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      switchSidebarTab(tab.dataset.tab);
    });
  });
  bindTabKeyboardNavigation();

  openConversationButton.addEventListener('click', openConversation);
  targetIdInput.addEventListener('change', openConversation);
  historyLimitInput.addEventListener('change', requestHistory);
  mobileSidebarToggleButton.addEventListener('click', layout.toggleSidebar);
  closeSidebarButton.addEventListener('click', layout.closeSidebar);
  sidebarBackdrop.addEventListener('click', layout.closeSidebar);

  if (typeof mobileLayoutMedia.addEventListener === 'function') {
    mobileLayoutMedia.addEventListener('change', layout.syncResponsiveLayout);
  } else if (typeof mobileLayoutMedia.addListener === 'function') {
    mobileLayoutMedia.addListener(layout.syncResponsiveLayout);
  }

  composer.bindEvents();

  document.addEventListener('click', (event) => {
    if (layout.isMobileLayout()
      && sidebarEl.classList.contains('open')
      && !sidebarEl.contains(event.target)
      && event.target !== mobileSidebarToggleButton) {
      layout.closeSidebar();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.hasFocus()) {
      notifications.clearUnreadCount();
    }
  });

  window.addEventListener('focus', notifications.clearUnreadCount);
  window.addEventListener('resize', () => {
    layout.updateViewportHeightVar();
    layout.syncResponsiveLayout();
    handleLightboxResize();
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      layout.updateViewportHeightVar();
      composer.handleViewportChange();
    });
    window.visualViewport.addEventListener('scroll', layout.updateViewportHeightVar);
  }

  window.addEventListener('pointerdown', notifications.warmupNotifications, { once: true });
  window.addEventListener('keydown', notifications.warmupNotifications, { once: true });
  composer.handleViewportChange();
}

export function connectSocketFromConfig(socketController, {
  configUrl = '/api/config',
  fallbackWsPath = '/ws',
  fetchImpl = (...args) => window.fetch(...args),
} = {}) {
  return fetchImpl(configUrl)
    .then((res) => res.json())
    .then((config) => {
      socketController.connect((config && config.wsPath) || fallbackWsPath);
    })
    .catch(() => {
      socketController.connect(fallbackWsPath);
    });
}
