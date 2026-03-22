export function createNotificationController({
  defaultDocumentTitle,
  getActiveConversationId,
  onNotificationOpen,
}) {
  let unreadCount = 0;
  let notificationPermissionRequested = false;

  function updateDocumentTitle() {
    document.title = unreadCount > 0
      ? '(' + unreadCount + ') ' + defaultDocumentTitle
      : defaultDocumentTitle;
  }

  function clearUnreadCount() {
    if (!unreadCount) {
      return;
    }

    unreadCount = 0;
    updateDocumentTitle();
  }

  function shouldRequestNotificationPermission() {
    return typeof Notification !== 'undefined'
      && Notification.permission === 'default'
      && !notificationPermissionRequested;
  }

  async function ensureNotificationPermission() {
    if (!shouldRequestNotificationPermission()) {
      return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    }

    notificationPermissionRequested = true;

    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }

  function warmupNotifications() {
    ensureNotificationPermission().catch(() => {});
  }

  function shouldNotifyForEntry(entry) {
    const activeId = getActiveConversationId();
    return document.hidden || !document.hasFocus() || !activeId || entry.id !== activeId;
  }

  function buildNotificationBody(entry) {
    if (!entry) {
      return '你有一条新消息';
    }

    if (entry.type === 'image' || entry.imageUrl) {
      return '[图片]';
    }

    const text = String(entry.message || '').replace(/\s+/g, ' ').trim();
    return text || '你有一条新消息';
  }

  function notifyIncomingEntry(entry) {
    if (!entry || entry.echo || !shouldNotifyForEntry(entry)) {
      return;
    }

    unreadCount += 1;
    updateDocumentTitle();

    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      return;
    }

    const notification = new Notification(entry.name || entry.id || 'Steam Chat', {
      body: buildNotificationBody(entry),
      tag: 'steam-chat-' + (entry.id || 'unknown'),
    });

    notification.addEventListener('click', () => {
      window.focus();
      onNotificationOpen(entry);
      clearUnreadCount();
      notification.close();
    });
  }

  return {
    clearUnreadCount,
    notifyIncomingEntry,
    warmupNotifications,
  };
}
