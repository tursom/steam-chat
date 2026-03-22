import {
  buildCachedImageUrl,
  buildSteamStickerCandidateUrls,
  buildSteamEmoticonUrl,
  extractEmoticonNames,
  extractImageUrls,
  extractStickerType,
  formatConversationTime,
  formatDayLabel,
  formatTimeLabel,
  parseBbCodeAttributes,
  parseDateString,
  sameDay,
} from './app/utils.js';
import { createStatusController } from './app/status.js';
import { createRichContentRenderer } from './app/rich-content.js';
import { createLightboxController } from './app/lightbox.js';
import { createManagedImageController } from './app/managed-images.js';
import { createMessageBubbleRenderer } from './app/message-bubble.js';
import { createMessagesController } from './app/messages.js';
import { createSidebarController } from './app/sidebar.js';
import { createComposerController } from './app/composer.js';
import { createSessionController } from './app/session.js';
import { createWebSocketController } from './app/websocket.js';
import { createNotificationController } from './app/notifications.js';
import { createLayoutController } from './app/layout.js';
import { createPreferencesController } from './app/preferences.js';
import { getAppDomRefs } from './app/dom.js';
import { bindAppShellEvents, connectSocketFromConfig } from './app/bootstrap.js';

(() => {
  const {
    targetIdInput,
    historyLimitInput,
    reloadHistoryButton,
    openConversationButton,
    reloadConversationsButton,
    conversationListEl,
    friendsListEl,
    groupsListEl,
    reloadFriendsButton,
    reloadGroupsButton,
    sidebarTabs,
    sidebarTabPanels,
    chatTitleEl,
    chatSubtitleEl,
    feedbackStatusEl,
    connectionStatusEl,
    connectionStatusLabelEl,
    messagesEl,
    dropOverlay,
    sidebarEl,
    sidebarBackdrop,
    mobileSidebarToggleButton,
    closeSidebarButton,
    imageLightbox,
    imageLightboxViewport,
    imageLightboxImage,
    imageLightboxCaption,
    closeImageLightboxButton,
    imageZoomOutButton,
    imageZoomResetButton,
    imageZoomInButton,
    messageInput,
    emoticonSuggestions,
    emoticonPreviewImage,
    emoticonPreviewLabel,
    sendMessageButton,
    attachmentButton,
    attachmentMenu,
    chooseImageButton,
    chooseUrlButton,
    imageFileInput,
    urlPanel,
    imageUrlInput,
    confirmImageUrlButton,
    cancelImageUrlButton,
    attachmentPreview,
    attachmentPreviewImage,
    attachmentPreviewTitle,
    attachmentPreviewSubtitle,
    clearAttachmentButton,
    uploadQueue,
    uploadQueueList,
    pickerButton,
    pickerPanel,
    pickerSearch,
    pickerGrid,
    pickerEmpty,
    pickerTabs,
  } = getAppDomRefs(document);

  const defaultDocumentTitle = document.title || 'Steam Chat';
  const mobileLayoutMedia = window.matchMedia('(max-width: 900px)');

  let createRichMessageContent = null;

  const { setFeedback: setStatus, setConnection: setConnectionStatus } = createStatusController({
    feedbackEl: feedbackStatusEl,
    connectionChipEl: connectionStatusEl,
    connectionLabelEl: connectionStatusLabelEl,
  });

  setConnectionStatus('connecting');

  let session = null;

  const preferences = createPreferencesController({
    targetIdInput,
    historyLimitInput,
  });
  preferences.loadPreferences();
  const {
    currentHistoryLimit,
    currentTargetId,
  } = preferences;

  const {
    createManagedImageHost,
    cleanupManagedImages,
    loadManagedImage,
    resetManagedImage,
  } = createManagedImageController();

  const {
    handleWindowResize: handleLightboxResize,
    makeImageZoomable,
  } = createLightboxController({
    buildCachedImageUrl,
    imageLightbox,
    imageLightboxViewport,
    imageLightboxImage,
    imageLightboxCaption,
    closeImageLightboxButton,
    imageZoomOutButton,
    imageZoomResetButton,
    imageZoomInButton,
    loadManagedImage,
    resetManagedImage,
  });

  ({ createRichMessageContent } = createRichContentRenderer({
    buildSteamEmoticonUrl,
    buildCachedImageUrl,
    extractImageUrls,
    parseBbCodeAttributes,
    createManagedImageHost,
    makeImageZoomable,
    loadManagedImage,
  }));

  const { renderMessageBubble } = createMessageBubbleRenderer({
    createManagedImageHost,
    makeImageZoomable,
    loadManagedImage,
    buildCachedImageUrl,
    createRichMessageContent,
    extractStickerType,
    buildSteamStickerCandidateUrls,
    extractImageUrls,
  });

  const {
    appendEntry,
    clearMessages,
    renderHistory,
  } = createMessagesController({
    messagesEl,
    cleanupManagedImages,
    parseDateString,
    sameDay,
    formatDayLabel,
    formatTimeLabel,
    getActiveConversationId: () => (session ? session.getActiveConversationId() : '') || currentTargetId(),
    renderMessageBubble,
  });

  const {
    bindTabKeyboardNavigation,
    renderConversations,
    renderFriends,
    renderGroups,
    switchSidebarTab,
  } = createSidebarController({
    conversationListEl,
    friendsListEl,
    groupsListEl,
    sidebarTabs,
    sidebarTabPanels,
    formatConversationTime,
    getActiveConversationId: () => (session ? session.getActiveConversationId() : ''),
    onConversationSelect: (conversation) => {
      session.setActiveConversation(conversation.id, conversation.name);
      requestHistory();
    },
    onFriendSelect: (friend) => {
      session.setActiveConversation(friend.id, friend.name);
      switchSidebarTab('conversations');
      requestHistory();
    },
    onGroupSelect: (group) => {
      session.setActiveConversation(group.id, group.name);
      switchSidebarTab('conversations');
      requestHistory();
    },
  });

  let composer = null;

  const layout = createLayoutController({
    mediaQuery: mobileLayoutMedia,
    sidebarEl,
    sidebarBackdrop,
    mobileSidebarToggleButton,
    onResponsiveChange: () => {
      if (composer) {
        composer.handleViewportChange();
      }
    },
  });
  const { isMobileLayout } = layout;

  composer = createComposerController({
    buildCachedImageUrl,
    buildSteamEmoticonUrl,
    extractEmoticonNames,
    isMobileLayout,
    setStatus,
    send: (payload) => socketController.send(payload),
    createRequestId: (prefix) => socketController.createRequestId(prefix),
    getConversationId: () => (session ? session.getActiveConversationId() : '') || currentTargetId(),
    controls: {
      messageInput,
      emoticonSuggestions,
      emoticonPreviewImage,
      emoticonPreviewLabel,
      sendMessageButton,
      attachmentButton,
      attachmentMenu,
      chooseImageButton,
      chooseUrlButton,
      imageFileInput,
      urlPanel,
      imageUrlInput,
      confirmImageUrlButton,
      cancelImageUrlButton,
      attachmentPreview,
      attachmentPreviewImage,
      attachmentPreviewTitle,
      attachmentPreviewSubtitle,
      clearAttachmentButton,
      uploadQueue,
      uploadQueueList,
      pickerButton,
      pickerPanel,
      pickerSearch,
      pickerGrid,
      pickerEmpty,
      pickerTabs,
      dropOverlay,
    },
  });

  session = createSessionController({
    targetIdInput,
    chatTitleEl,
    chatSubtitleEl,
    renderConversations,
    renderFriends,
    renderGroups,
    savePreferences: preferences.savePreferences,
    clearUnreadCount: () => notifications.clearUnreadCount(),
    closeSidebar: () => layout.closeSidebar(),
    buildConversationPreview: (entry) => (
      entry.type === 'image' || entry.imageUrl
        ? '[图片]'
        : (extractStickerType(entry.message)
          ? '[贴纸] ' + extractStickerType(entry.message).replace(/^Sticker_/, '')
          : String(entry.message || '').trim().slice(0, 60))
    ),
  });

  const socketController = createWebSocketController({
    setStatus,
    setConnectionStatus,
    savePreferences: preferences.savePreferences,
    clearPendingUploadRequests: (message) => composer.clearPendingUploadRequests(message),
    onReady: () => {
      socketController.requestConversations();
      socketController.requestFriends();
      socketController.requestGroups();
      composer.requestEmoticonInventory();
    },
    onEmoticons: (data) => {
      composer.applyEmoticonInventory(data);
    },
    onConversations: (data) => {
      session.setConversations((data && data.items) || []);
      const activeConversationId = session.getActiveConversationId();
      const conversations = session.getConversations();
      if (activeConversationId) {
        requestHistory();
      } else if (preferences.currentTargetId()) {
        session.setActiveConversation(preferences.currentTargetId());
        requestHistory();
      } else if (conversations.length) {
        session.setActiveConversation(conversations[0].id, conversations[0].name);
        requestHistory();
      }
    },
    onFriends: (data) => {
      session.setFriends((data && data.items) || []);
    },
    onGroups: (data) => {
      session.setGroups((data && data.items) || []);
    },
    onHistory: (data) => {
      ((data && data.items) || []).forEach((item) => composer.rememberEmoticonsFromMessage(item.message));
      renderHistory((data && data.items) || []);
      session.updateConversationList(((data && data.items) || []).slice(-1)[0]);
      setStatus('历史消息已加载');
    },
    onMessage: (entry) => {
      session.updateConversationList(entry);
      appendEntry(entry);
      notifications.notifyIncomingEntry(entry);
    },
    onMessageSent: () => {
      composer.hideSuggestions();
    },
    onImageSent: (payload) => {
      composer.resolveUploadRequest(payload.requestId, true, '已发送');
      session.updateConversationList(payload.data);
      appendEntry(payload.data);
      setStatus('图片已发送');
    },
    onError: (payload) => {
      composer.resolveUploadRequest(payload.requestId, false, payload.message);
      setStatus(payload.message || '请求失败');
    },
  });

  const notifications = createNotificationController({
    defaultDocumentTitle,
    getActiveConversationId: () => (session ? session.getActiveConversationId() : '') || preferences.currentTargetId(),
    onNotificationOpen: (entry) => {
      if (entry.id) {
        session.setActiveConversation(entry.id, entry.name);
        requestHistory();
      }
    },
  });

  function requestHistory() {
    const id = (session ? session.getActiveConversationId() : '') || currentTargetId();
    if (!id) {
      clearMessages();
      setStatus('请输入对方 SteamID64 后再加载历史');
      return;
    }

    socketController.requestHistory(id, currentHistoryLimit());
  }

  function openConversation() {
    const id = currentTargetId();
    if (!id) {
      setStatus('请输入 SteamID64');
      return;
    }

    session.setActiveConversation(id);
    requestHistory();
  }

  bindAppShellEvents({
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
  });
  connectSocketFromConfig(socketController);
})();
