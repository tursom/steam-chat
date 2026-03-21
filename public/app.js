(() => {
  const targetIdInput = document.getElementById('targetId');
  const historyLimitInput = document.getElementById('historyLimit');
  const reloadHistoryButton = document.getElementById('reloadHistory');
  const openConversationButton = document.getElementById('openConversation');
  const reloadConversationsButton = document.getElementById('reloadConversations');
  const conversationListEl = document.getElementById('conversationList');
  const chatTitleEl = document.getElementById('chatTitle');
  const chatSubtitleEl = document.getElementById('chatSubtitle');
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const dropOverlay = document.getElementById('dropOverlay');
  const sidebarEl = document.querySelector('.sidebar');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const mobileSidebarToggleButton = document.getElementById('mobileSidebarToggle');
  const closeSidebarButton = document.getElementById('closeSidebar');
  const imageLightbox = document.getElementById('imageLightbox');
  const imageLightboxViewport = document.getElementById('imageLightboxViewport');
  const imageLightboxImage = document.getElementById('imageLightboxImage');
  const imageLightboxCaption = document.getElementById('imageLightboxCaption');
  const closeImageLightboxButton = document.getElementById('closeImageLightbox');
  const imageZoomOutButton = document.getElementById('imageZoomOut');
  const imageZoomResetButton = document.getElementById('imageZoomReset');
  const imageZoomInButton = document.getElementById('imageZoomIn');
  const messageInput = document.getElementById('messageInput');
  const emoticonSuggestions = document.getElementById('emoticonSuggestions');
  const emoticonPreview = document.getElementById('emoticonPreview');
  const emoticonPreviewImage = document.getElementById('emoticonPreviewImage');
  const emoticonPreviewLabel = document.getElementById('emoticonPreviewLabel');
  const sendMessageButton = document.getElementById('sendMessage');
  const attachmentButton = document.getElementById('attachmentButton');
  const attachmentMenu = document.getElementById('attachmentMenu');
  const chooseImageButton = document.getElementById('chooseImageButton');
  const chooseUrlButton = document.getElementById('chooseUrlButton');
  const imageFileInput = document.getElementById('imageFile');
  const urlPanel = document.getElementById('urlPanel');
  const imageUrlInput = document.getElementById('imageUrl');
  const confirmImageUrlButton = document.getElementById('confirmImageUrl');
  const cancelImageUrlButton = document.getElementById('cancelImageUrl');
  const attachmentPreview = document.getElementById('attachmentPreview');
  const attachmentPreviewImage = document.getElementById('attachmentPreviewImage');
  const attachmentPreviewTitle = document.getElementById('attachmentPreviewTitle');
  const attachmentPreviewSubtitle = document.getElementById('attachmentPreviewSubtitle');
  const clearAttachmentButton = document.getElementById('clearAttachment');
  const uploadQueue = document.getElementById('uploadQueue');
  const uploadQueueList = document.getElementById('uploadQueueList');
  const pickerButton = document.getElementById('pickerButton');
  const pickerPanel = document.getElementById('pickerPanel');
  const pickerSearch = document.getElementById('pickerSearch');
  const pickerGrid = document.getElementById('pickerGrid');
  const pickerEmpty = document.getElementById('pickerEmpty');
  const pickerTabs = pickerPanel.querySelectorAll('.picker-tab');

  targetIdInput.value = localStorage.getItem('steam-chat-target-id') || '';
  historyLimitInput.value = localStorage.getItem('steam-chat-history-limit') || '100';

  let socket = null;
  let nextRequestId = 1;
  let activeConversationId = '';
  let conversations = [];
  let pendingAttachment = null;
  let dragDepth = 0;
  const knownEmoticons = new Set(['steamhappy', 'steamfacepalm', 'steamthumbsup', 'steamheart', 'steamsad', 'steammocking']);
  let currentSuggestions = [];
  let activeSuggestionIndex = 0;
  let uploadQueueItems = [];
  const uploadRequestMap = new Map();
  const managedImageRequestMap = new WeakMap();
  let activePickerTab = 'emoticons';
  let emoticonInventory = [];
  let stickerInventory = [];
  const defaultDocumentTitle = document.title || 'Steam Chat';
  let unreadCount = 0;
  let notificationPermissionRequested = false;
  let nextManagedImageToken = 1;
  const mobileLayoutMedia = window.matchMedia('(max-width: 900px)');
  const imageLightboxState = {
    scale: 1,
    minScale: 1,
    maxScale: 6,
    offsetX: 0,
    offsetY: 0,
    dragging: false,
    dragPointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginX: 0,
    dragOriginY: 0,
    activePointers: new Map(),
    pinching: false,
    pinchStartDistance: 0,
    pinchStartScale: 1,
    pinchContentX: 0,
    pinchContentY: 0,
    rafPending: false,
    cachedBaseSize: null,
    cachedViewportRect: null,
  };

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function updateViewportHeightVar() {
    const viewport = window.visualViewport;
    const height = viewport && Number.isFinite(viewport.height)
      ? viewport.height
      : window.innerHeight;
    const offsetTop = viewport && Number.isFinite(viewport.offsetTop)
      ? viewport.offsetTop
      : 0;
    document.documentElement.style.setProperty('--app-height', height + 'px');
    document.documentElement.style.setProperty('--viewport-offset-top', offsetTop + 'px');
  }

  function isMobileLayout() {
    return mobileLayoutMedia.matches;
  }

  function setSidebarOpen(open) {
    const shouldOpen = Boolean(open && isMobileLayout());
    sidebarEl.classList.toggle('open', shouldOpen);
    sidebarBackdrop.classList.toggle('open', shouldOpen);
    sidebarBackdrop.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
    mobileSidebarToggleButton.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  function toggleSidebar() {
    setSidebarOpen(!sidebarEl.classList.contains('open'));
  }

  function syncResponsiveLayout() {
    if (!isMobileLayout()) {
      closeSidebar();
    }
    syncMessageInputPlaceholder();
  }

  function autoResizeMessageInput() {
    const minHeight = isMobileLayout() ? 30 : 80;
    const maxHeight = isMobileLayout() ? 72 : 220;
    messageInput.style.height = 'auto';
    const nextHeight = Math.max(minHeight, Math.min(messageInput.scrollHeight, maxHeight));
    messageInput.style.height = nextHeight + 'px';
    messageInput.style.overflowY = messageInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function syncMessageInputPlaceholder() {
    const mobilePlaceholder = messageInput.dataset.mobilePlaceholder || '输入消息';
    const desktopPlaceholder = messageInput.dataset.desktopPlaceholder || mobilePlaceholder;
    messageInput.placeholder = isMobileLayout() ? mobilePlaceholder : desktopPlaceholder;
  }

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

  function resolveDisplayImageUrl(url) {
    const value = String(url || '').trim();
    if (!value) {
      return '';
    }

    try {
      const parsed = new URL(value, location.origin);
      if (parsed.origin === location.origin) {
        return parsed.toString();
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return buildCachedImageUrl(parsed.toString());
      }
      return parsed.toString();
    } catch {
      return value;
    }
  }

  function computeImageLightboxBaseSize() {
    const viewportWidth = imageLightboxViewport.clientWidth || 1;
    const viewportHeight = imageLightboxViewport.clientHeight || 1;
    const naturalWidth = imageLightboxImage.naturalWidth || viewportWidth;
    const naturalHeight = imageLightboxImage.naturalHeight || viewportHeight;
    const fitScale = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight, 1);

    return {
      width: naturalWidth * fitScale,
      height: naturalHeight * fitScale,
      viewportWidth,
      viewportHeight,
    };
  }

  function refreshImageLightboxBaseSize() {
    imageLightboxState.cachedBaseSize = computeImageLightboxBaseSize();
    imageLightboxState.cachedViewportRect = imageLightboxViewport.getBoundingClientRect();
  }

  function getImageLightboxBaseSize() {
    return imageLightboxState.cachedBaseSize || computeImageLightboxBaseSize();
  }

  function clampImageLightboxOffset() {
    if (imageLightboxState.scale <= 1) {
      imageLightboxState.offsetX = 0;
      imageLightboxState.offsetY = 0;
      return;
    }

    const { width, height, viewportWidth, viewportHeight } = getImageLightboxBaseSize();
    const scaledWidth = width * imageLightboxState.scale;
    const scaledHeight = height * imageLightboxState.scale;
    const limitX = Math.max(0, (scaledWidth - viewportWidth) / 2);
    const limitY = Math.max(0, (scaledHeight - viewportHeight) / 2);

    imageLightboxState.offsetX = Math.min(limitX, Math.max(-limitX, imageLightboxState.offsetX));
    imageLightboxState.offsetY = Math.min(limitY, Math.max(-limitY, imageLightboxState.offsetY));
  }

  function getViewportRelativePoint(clientX, clientY) {
    const rect = imageLightboxState.cachedViewportRect || imageLightboxViewport.getBoundingClientRect();
    return {
      x: clientX - rect.left - (rect.width / 2),
      y: clientY - rect.top - (rect.height / 2),
    };
  }

  function getTouchPointerList() {
    return [...imageLightboxState.activePointers.values()].filter((pointer) => pointer.pointerType === 'touch');
  }

  function getTouchPointerMetrics(pointers) {
    if (!pointers || pointers.length < 2) {
      return null;
    }

    const [first, second] = pointers;
    const deltaX = second.clientX - first.clientX;
    const deltaY = second.clientY - first.clientY;

    return {
      distance: Math.hypot(deltaX, deltaY),
      centerX: (first.clientX + second.clientX) / 2,
      centerY: (first.clientY + second.clientY) / 2,
    };
  }

  function applyImageLightboxTransform() {
    imageLightboxState.rafPending = false;
    clampImageLightboxOffset();
    imageLightboxImage.style.transform = 'translate3d(' + imageLightboxState.offsetX + 'px, ' + imageLightboxState.offsetY + 'px, 0) scale(' + imageLightboxState.scale + ')';
  }

  function updateImageLightboxTransform() {
    const isActive = imageLightboxState.dragging || imageLightboxState.pinching;
    imageLightboxImage.classList.toggle('is-dragging', isActive);
    imageLightboxImage.style.cursor = imageLightboxState.scale > 1
      ? (isActive ? 'grabbing' : 'grab')
      : 'zoom-in';
    imageZoomResetButton.textContent = Math.round(imageLightboxState.scale * 100) + '%';
    if (!imageLightboxState.rafPending) {
      imageLightboxState.rafPending = true;
      requestAnimationFrame(applyImageLightboxTransform);
    }
  }

  function scheduleTransformOnly() {
    if (!imageLightboxState.rafPending) {
      imageLightboxState.rafPending = true;
      requestAnimationFrame(applyImageLightboxTransform);
    }
  }

  function beginImageLightboxDrag(pointerId, clientX, clientY) {
    imageLightboxState.dragging = true;
    imageLightboxState.dragPointerId = pointerId;
    imageLightboxState.dragStartX = clientX;
    imageLightboxState.dragStartY = clientY;
    imageLightboxState.dragOriginX = imageLightboxState.offsetX;
    imageLightboxState.dragOriginY = imageLightboxState.offsetY;
    updateImageLightboxTransform();
  }

  function resetImageLightboxTransform() {
    imageLightboxState.scale = 1;
    imageLightboxState.offsetX = 0;
    imageLightboxState.offsetY = 0;
    imageLightboxState.dragging = false;
    imageLightboxState.dragPointerId = null;
    imageLightboxState.activePointers.clear();
    imageLightboxState.pinching = false;
    imageLightboxState.pinchStartDistance = 0;
    imageLightboxState.pinchStartScale = 1;
    imageLightboxState.pinchContentX = 0;
    imageLightboxState.pinchContentY = 0;
    updateImageLightboxTransform();
  }

  function setImageLightboxScale(nextScale, clientX, clientY) {
    const clampedScale = Math.min(imageLightboxState.maxScale, Math.max(imageLightboxState.minScale, nextScale));
    const previousScale = imageLightboxState.scale;

    if (Math.abs(clampedScale - previousScale) < 0.001) {
      return;
    }

    const anchorPoint = (typeof clientX === 'number' && typeof clientY === 'number')
      ? getViewportRelativePoint(clientX, clientY)
      : { x: 0, y: 0 };
    const anchorX = anchorPoint.x;
    const anchorY = anchorPoint.y;

    imageLightboxState.offsetX = anchorX - (((anchorX - imageLightboxState.offsetX) / previousScale) * clampedScale);
    imageLightboxState.offsetY = anchorY - (((anchorY - imageLightboxState.offsetY) / previousScale) * clampedScale);
    imageLightboxState.scale = clampedScale;
    updateImageLightboxTransform();
  }

  function beginImageLightboxPinch() {
    const metrics = getTouchPointerMetrics(getTouchPointerList());
    if (!metrics) {
      return;
    }

    const center = getViewportRelativePoint(metrics.centerX, metrics.centerY);
    imageLightboxState.pinching = true;
    imageLightboxState.dragging = false;
    imageLightboxState.dragPointerId = null;
    imageLightboxState.pinchStartDistance = Math.max(metrics.distance, 1);
    imageLightboxState.pinchStartScale = imageLightboxState.scale;
    imageLightboxState.pinchContentX = (center.x - imageLightboxState.offsetX) / imageLightboxState.scale;
    imageLightboxState.pinchContentY = (center.y - imageLightboxState.offsetY) / imageLightboxState.scale;
    updateImageLightboxTransform();
  }

  function updateImageLightboxPinch() {
    const metrics = getTouchPointerMetrics(getTouchPointerList());
    if (!metrics || !imageLightboxState.pinching) {
      return;
    }

    const center = getViewportRelativePoint(metrics.centerX, metrics.centerY);
    const nextScale = Math.min(
      imageLightboxState.maxScale,
      Math.max(
        imageLightboxState.minScale,
        imageLightboxState.pinchStartScale * (metrics.distance / Math.max(imageLightboxState.pinchStartDistance, 1)),
      ),
    );

    imageLightboxState.scale = nextScale;
    imageLightboxState.offsetX = center.x - (imageLightboxState.pinchContentX * nextScale);
    imageLightboxState.offsetY = center.y - (imageLightboxState.pinchContentY * nextScale);
    scheduleTransformOnly();
  }

  function endImageLightboxPinch() {
    if (!imageLightboxState.pinching) {
      return;
    }

    imageLightboxState.pinching = false;
    imageLightboxState.pinchStartDistance = 0;
    imageLightboxState.pinchStartScale = imageLightboxState.scale;
    const remainingTouch = getTouchPointerList()[0];
    if (remainingTouch && imageLightboxState.scale > 1) {
      beginImageLightboxDrag(remainingTouch.pointerId, remainingTouch.clientX, remainingTouch.clientY);
      return;
    }
    updateImageLightboxTransform();
  }

  function openImageLightbox(url, caption) {
    const displayUrl = resolveDisplayImageUrl(url);
    if (!displayUrl) {
      return;
    }

    resetImageLightboxTransform();
    loadManagedImage(imageLightboxViewport, imageLightboxImage, displayUrl, {
      loadingText: '大图加载中',
      errorText: '大图加载失败',
      onLoad() {
        refreshImageLightboxBaseSize();
        updateImageLightboxTransform();
      },
    });
    imageLightboxCaption.textContent = caption || url || '';
    imageLightbox.classList.add('open');
    imageLightbox.setAttribute('aria-hidden', 'false');
  }

  function closeImageLightbox() {
    if (!imageLightbox.classList.contains('open')) {
      return;
    }

    imageLightbox.classList.remove('open');
    imageLightbox.setAttribute('aria-hidden', 'true');
    resetManagedImage(imageLightboxViewport, imageLightboxImage);
    imageLightboxCaption.textContent = '';
    imageLightboxState.cachedBaseSize = null;
    imageLightboxState.cachedViewportRect = null;
    resetImageLightboxTransform();
  }

  function makeImageZoomable(element, url, caption) {
    element.classList.add('zoomable-image');
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openImageLightbox(url, caption || element.getAttribute('alt') || '');
    });
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
    localStorage.setItem('steam-chat-target-id', currentTargetId());
    localStorage.setItem('steam-chat-history-limit', String(currentHistoryLimit()));
  }

  function formatConversationTime(value) {
    if (!value) {
      return '';
    }
    return String(value).slice(5, 16);
  }

  function parseDateString(value) {
    if (!value) {
      return null;
    }
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
    if (!match) {
      return null;
    }
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7] || 0),
    );
  }

  function sameDay(left, right) {
    return left && right &&
      left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() &&
      left.getDate() === right.getDate();
  }

  function formatDayLabel(value) {
    const date = parseDateString(value);
    if (!date) {
      return value || '';
    }
    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0');
  }

  function formatTimeLabel(value) {
    const date = parseDateString(value);
    if (!date) {
      return value || '';
    }
    return String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0');
  }

  function extractStickerType(message) {
    const match = String(message || '').match(/\[sticker\s+type="([^"]+)"/i);
    return match ? match[1] : null;
  }

  function extractEmoticonNames(message) {
    const content = String(message || '');
    const names = new Set();

    for (const match of content.matchAll(/\[emoticon\s+name="([^"]+)"\](?:\[\/emoticon\])?/gi)) {
      if (match[1]) {
        names.add(match[1]);
      }
    }

    for (const match of content.matchAll(/\[emoticon\]([^\[]+)\[\/emoticon\]/gi)) {
      if (match[1]) {
        names.add(match[1].trim());
      }
    }

    for (const match of content.matchAll(/(^|\s):([a-z0-9_][a-z0-9_\-]*):(?=\s|$|[!?,.])/gi)) {
      if (match[2]) {
        names.add(match[2]);
      }
    }

    return [...names];
  }

  function extractImageUrls(message) {
    const content = String(message || '');
    const urls = new Set();

    for (const match of content.matchAll(/\[img\](https?:\/\/[^\s\[\]]+?)\[\/img\]/gi)) {
      if (match[1]) {
        urls.add(match[1]);
      }
    }

    for (const match of content.matchAll(/<img\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
      if (match[1]) {
        urls.add(match[1]);
      }
    }

    for (const match of content.matchAll(/https?:\/\/\S+?(?:png|jpe?g|gif|webp|bmp)(?:\?\S*)?/gi)) {
      if (match[0]) {
        urls.add(match[0]);
      }
    }

    return [...urls];
  }

  function parseBbCodeAttributes(rawAttributes) {
    const attrs = {};
    const content = String(rawAttributes || '');
    const attributeRegex = /([a-z][a-z0-9_-]*)=(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s"'=<>`]+))/gi;
    let match;

    while ((match = attributeRegex.exec(content)) !== null) {
      const key = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      attrs[key] = value.replace(/\\(["'])/g, '$1');
    }

    return attrs;
  }

  function extractOpenGraphEmbeds(message) {
    const content = String(message || '');
    const embeds = [];

    for (const match of content.matchAll(/\[og\s+([^\]]+)\]([\s\S]*?)\[\/og\]/gi)) {
      const attrs = parseBbCodeAttributes(match[1] || '');
      const fallbackUrl = String(match[2] || '').trim();

      embeds.push({
        url: attrs.url || fallbackUrl,
        img: attrs.img || null,
        title: attrs.title || '',
      });
    }

    return embeds.filter((item) => item.url);
  }

  function buildSteamEmoticonUrl(name, large = true) {
    const normalized = String(name || '').trim().replace(/^:+|:+$/g, '');
    if (!normalized) {
      return '';
    }
    return 'https://steamcommunity-a.akamaihd.net/economy/' + (large ? 'emoticonlarge' : 'emoticon') + '/' + encodeURIComponent(normalized);
  }

  function buildCachedImageUrl(url) {
    return location.origin + '/proxy/image?url=' + encodeURIComponent(String(url || ''));
  }

  function createManagedImageHost(hostClassName, imageClassName) {
    const host = document.createElement('div');
    host.className = 'image-loading-host';
    if (hostClassName) {
      hostClassName.split(/\s+/).filter(Boolean).forEach((className) => host.classList.add(className));
    }

    const img = document.createElement('img');
    img.dataset.managedImage = 'true';
    img.classList.add('image-loading-target');
    if (imageClassName) {
      imageClassName.split(/\s+/).filter(Boolean).forEach((className) => img.classList.add(className));
    }

    host.appendChild(img);
    return { host, img };
  }

  function ensureManagedImageUi(host) {
    if (host.__managedImageUi) {
      return host.__managedImageUi;
    }

    const overlay = document.createElement('div');
    overlay.className = 'image-loading-overlay';

    const label = document.createElement('div');
    label.className = 'image-loading-label';
    label.textContent = '正在加载中';

    const progress = document.createElement('div');
    progress.className = 'image-loading-progress';

    const bar = document.createElement('div');
    bar.className = 'image-loading-progress-bar';

    progress.appendChild(bar);
    overlay.appendChild(label);
    overlay.appendChild(progress);
    host.appendChild(overlay);

    host.__managedImageUi = { overlay, label, progress, bar };
    return host.__managedImageUi;
  }

  function setManagedImageState(host, state, labelText, progressValue, indeterminate) {
    const ui = ensureManagedImageUi(host);
    const nextState = state || 'idle';

    host.classList.toggle('is-loading', nextState === 'loading');
    host.classList.toggle('is-loaded', nextState === 'loaded');
    host.classList.toggle('is-error', nextState === 'error');
    host.classList.toggle('is-indeterminate', Boolean(indeterminate));

    if (labelText) {
      ui.label.textContent = labelText;
    } else if (nextState === 'error') {
      ui.label.textContent = '图片加载失败';
    } else if (nextState === 'loaded') {
      ui.label.textContent = '';
    } else {
      ui.label.textContent = '正在加载中';
    }

    const width = Number.isFinite(progressValue)
      ? Math.max(0, Math.min(100, progressValue))
      : 0;
    ui.bar.style.width = width + '%';
  }

  function abortManagedImageRequest(img) {
    const request = managedImageRequestMap.get(img);
    if (!request) {
      return;
    }

    managedImageRequestMap.delete(img);

    try {
      request.abort();
    } catch (error) {
      // ignore
    }
  }

  function revokeManagedImageObjectUrl(img) {
    const objectUrl = img && img.dataset ? img.dataset.objectUrl : '';
    if (!objectUrl) {
      return;
    }

    try {
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      // ignore
    }

    delete img.dataset.objectUrl;
  }

  function resetManagedImage(host, img) {
    abortManagedImageRequest(img);
    revokeManagedImageObjectUrl(img);
    delete img.dataset.managedImageLoadToken;
    img.removeAttribute('src');

    if (host) {
      setManagedImageState(host, 'idle', '', 0, false);
    }
  }

  function cleanupManagedImages(root) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return;
    }

    root.querySelectorAll('img[data-managed-image="true"]').forEach((img) => {
      resetManagedImage(img.closest('.image-loading-host'), img);
    });
  }

  function loadManagedImage(host, img, src, options) {
    const settings = options || {};
    const loadingText = settings.loadingText || '正在加载中';
    const errorText = settings.errorText || '图片加载失败';
    const normalizedSrc = String(src || '').trim();

    if (!host || !img) {
      return;
    }

    host.classList.add('image-loading-host');
    img.dataset.managedImage = 'true';
    img.classList.add('image-loading-target');

    resetManagedImage(host, img);

    if (!normalizedSrc) {
      setManagedImageState(host, 'error', errorText, 100, false);
      if (typeof settings.onError === 'function') {
        settings.onError();
      }
      return;
    }

    const token = String(nextManagedImageToken++);
    img.dataset.managedImageLoadToken = token;
    setManagedImageState(host, 'loading', loadingText, 8, true);

    const request = new XMLHttpRequest();
    managedImageRequestMap.set(img, request);
    request.open('GET', normalizedSrc, true);
    request.responseType = 'blob';

    request.onprogress = (event) => {
      if (img.dataset.managedImageLoadToken !== token) {
        return;
      }

      if (event.lengthComputable && event.total > 0) {
        const percent = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
        setManagedImageState(host, 'loading', loadingText + ' ' + percent + '%', percent, false);
      } else {
        setManagedImageState(host, 'loading', loadingText, 32, true);
      }
    };

    request.onerror = () => {
      if (img.dataset.managedImageLoadToken !== token) {
        return;
      }
      managedImageRequestMap.delete(img);
      setManagedImageState(host, 'error', errorText, 100, false);
      if (typeof settings.onError === 'function') {
        settings.onError();
      }
    };

    request.onabort = () => {
      if (img.dataset.managedImageLoadToken !== token) {
        return;
      }
      managedImageRequestMap.delete(img);
    };

    request.onload = () => {
      if (img.dataset.managedImageLoadToken !== token) {
        return;
      }

      managedImageRequestMap.delete(img);

      if (request.status < 200 || request.status >= 300 || !(request.response instanceof Blob)) {
        setManagedImageState(host, 'error', errorText, 100, false);
        if (typeof settings.onError === 'function') {
          settings.onError();
        }
        return;
      }

      const objectUrl = URL.createObjectURL(request.response);
      img.dataset.objectUrl = objectUrl;

      img.addEventListener('load', () => {
        if (img.dataset.managedImageLoadToken !== token) {
          return;
        }
        setManagedImageState(host, 'loaded', '', 100, false);
        if (typeof settings.onLoad === 'function') {
          settings.onLoad();
        }
      }, { once: true });

      img.addEventListener('error', () => {
        if (img.dataset.managedImageLoadToken !== token) {
          return;
        }
        revokeManagedImageObjectUrl(img);
        setManagedImageState(host, 'error', errorText, 100, false);
        if (typeof settings.onError === 'function') {
          settings.onError();
        }
      }, { once: true });

      setManagedImageState(host, 'loading', '即将显示', 100, false);
      img.src = objectUrl;
    };

    request.send();
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
    } catch (error) {
      return Notification.permission;
    }
  }

  function warmupNotifications() {
    ensureNotificationPermission().catch(() => {});
  }

  function shouldNotifyForEntry(entry) {
    const activeId = activeConversationId || currentTargetId();
    return document.hidden || !document.hasFocus() || !activeId || entry.id !== activeId;
  }

  function buildNotificationBody(entry) {
    if (!entry) {
      return '你有一条新消息';
    }

    if (entry.type === 'image' || entry.imageUrl) {
      return '[图片]';
    }

    const stickerType = extractStickerType(entry.message);
    if (stickerType) {
      return '[贴纸] ' + stickerType.replace(/^Sticker_/, '');
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
      if (entry.id) {
        setActiveConversation(entry.id, entry.name);
        requestHistory();
      }
      clearUnreadCount();
      notification.close();
    });
  }

  function appendEmoticonImage(fragment, name) {
    const rawUrl = buildSteamEmoticonUrl(name, true);
    if (!rawUrl) {
      fragment.appendChild(document.createTextNode(':' + name + ':'));
      return;
    }

    const link = document.createElement('a');
    link.href = rawUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';

    const img = document.createElement('img');
    img.src = buildCachedImageUrl(rawUrl);
    img.alt = ':' + name + ':';
    img.title = ':' + name + ':';
    img.style.display = 'inline-block';
    img.style.width = '28px';
    img.style.height = '28px';
    img.style.verticalAlign = 'middle';
    img.style.margin = '0 2px';
    img.style.objectFit = 'contain';
    link.appendChild(img);
    fragment.appendChild(link);
  }

  function appendInlineImage(fragment, url, altText) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.style.display = 'inline-block';
    link.style.margin = '4px 4px 4px 0';

    const { host, img } = createManagedImageHost('image-loading-host--inline', 'image-preview');
    img.alt = altText || '[图片]';
    img.title = altText || url;
    makeImageZoomable(host, url, altText || url);
    loadManagedImage(host, img, buildCachedImageUrl(url));

    link.appendChild(host);
    fragment.appendChild(link);
  }

  function appendOpenGraphCard(fragment, embed) {
    const wrapper = document.createElement('a');
    wrapper.href = embed.url;
    wrapper.target = '_blank';
    wrapper.rel = 'noreferrer';
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '8px';
    wrapper.style.margin = '6px 0';
    wrapper.style.padding = '10px';
    wrapper.style.border = '1px solid #475569';
    wrapper.style.borderRadius = '12px';
    wrapper.style.background = 'rgba(15, 23, 42, 0.45)';
    wrapper.style.color = 'inherit';
    wrapper.style.textDecoration = 'none';

    if (embed.img) {
      const { host, img } = createManagedImageHost('image-loading-host--card', 'image-preview');
      img.alt = embed.title || embed.url;
      makeImageZoomable(host, embed.img, embed.title || embed.url);
      loadManagedImage(host, img, buildCachedImageUrl(embed.img));
      wrapper.appendChild(host);
    }

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.lineHeight = '1.5';
    title.textContent = embed.title || embed.url;
    wrapper.appendChild(title);

    const url = document.createElement('div');
    url.style.fontSize = '12px';
    url.style.opacity = '0.8';
    url.textContent = embed.url;
    wrapper.appendChild(url);

    fragment.appendChild(wrapper);
  }

  function createRichMessageContent(text) {
    const fragment = document.createDocumentFragment();
    // Normalize [img src=URL ...]...[/img] to [img]URL[/img]
    const content = String(text || '').replace(/\[img\s+src=(https?:\/\/[^\s\]]+)[^\]]*\][\s\S]*?\[\/img\]/gi, '[img]$1[/img]');
    const tokenRegex = /(\[emoticon\s+name="([^"]+)"\](?:\[\/emoticon\])?)|(\[emoticon\]([^\[]+)\[\/emoticon\])|(:([a-z0-9_][a-z0-9_\-]*):)|(\[img\](https?:\/\/[^\s\[\]]+?)\[\/img\])|(<img\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>)|(\[og\s+([^\]]+)\]([\s\S]*?)\[\/og\])|(\[url=([^\]]+)\]([\s\S]*?)\[\/url\])|(\[url\]([\s\S]*?)\[\/url\])|(https?:\/\/\S+)/gi;
    let cursor = 0;
    let match;

    while ((match = tokenRegex.exec(content)) !== null) {
      if (match.index > cursor) {
        fragment.appendChild(document.createTextNode(content.slice(cursor, match.index)));
      }

      if (match[2]) {
        appendEmoticonImage(fragment, match[2]);
      } else if (match[4]) {
        appendEmoticonImage(fragment, match[4].trim());
      } else if (match[6]) {
        appendEmoticonImage(fragment, match[6]);
      } else if (match[8]) {
        appendInlineImage(fragment, match[8], '[img]');
      } else if (match[10]) {
        appendInlineImage(fragment, match[10], '<img>');
      } else if (match[11]) {
        const attrs = parseBbCodeAttributes(match[12] || '');
        const fallbackUrl = String(match[13] || '').trim();
        const embed = {
          url: attrs.url || fallbackUrl,
          img: attrs.img || null,
          title: attrs.title || '',
        };
        if (embed.url) {
          appendOpenGraphCard(fragment, embed);
        }
      } else if (match[14]) {
        // [url=HREF]LABEL[/url]
        const href = match[15];
        const label = match[16] || href;
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = label;
        fragment.appendChild(link);
      } else if (match[17]) {
        // [url]HREF[/url]
        const href = match[18];
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = href;
        fragment.appendChild(link);
      } else if (match[19]) {
        const rawUrl = match[19];
        if (extractImageUrls(rawUrl).length > 0) {
          appendInlineImage(fragment, rawUrl, rawUrl);
        } else {
          const link = document.createElement('a');
          link.href = rawUrl;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = rawUrl;
          fragment.appendChild(link);
        }
      }

      cursor = match.index + match[0].length;
    }

    if (cursor < content.length) {
      fragment.appendChild(document.createTextNode(content.slice(cursor)));
    }

    return fragment;
  }

  function clearMessages() {
    cleanupManagedImages(messagesEl);
    messagesEl.innerHTML = '';
  }

  function categorizeEmoticon(name) {
    if (/^steam/i.test(name)) {
      return 'Steam';
    }
    return '最近使用';
  }

  function renderUploadQueue() {
    uploadQueueList.innerHTML = '';
    uploadQueue.classList.toggle('active', uploadQueueItems.length > 0);

    uploadQueueItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'upload-queue-item';
      if (item.state) {
        row.classList.add('is-' + item.state);
      }

      const name = document.createElement('div');
      name.className = 'upload-queue-name';
      name.textContent = item.name;

      const status = document.createElement('div');
      status.className = 'upload-queue-status';
      status.textContent = item.statusText;

      const progress = document.createElement('div');
      progress.className = 'upload-queue-progress';

      const bar = document.createElement('div');
      bar.className = 'upload-queue-progress-bar';
      if (item.state) {
        bar.classList.add('is-' + item.state);
      }
      bar.style.width = item.progress + '%';

      progress.appendChild(bar);
      row.appendChild(name);
      row.appendChild(status);
      row.appendChild(progress);
      uploadQueueList.appendChild(row);
    });
  }

  function updateQueueItem(id, patch) {
    const item = uploadQueueItems.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    Object.assign(item, patch);
    renderUploadQueue();
  }

  function removeQueueItem(id) {
    const nextItems = uploadQueueItems.filter((entry) => entry.id !== id);
    if (nextItems.length === uploadQueueItems.length) {
      return;
    }
    uploadQueueItems = nextItems;
    renderUploadQueue();
  }

  function scheduleQueueItemRemoval(id, delay) {
    window.setTimeout(() => {
      removeQueueItem(id);
    }, delay || 1500);
  }

  function createQueueItem(name, statusText, progress) {
    const queueId = 'queue-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    uploadQueueItems.push({
      id: queueId,
      name: name || '图片',
      progress: Number.isFinite(progress) ? progress : 0,
      statusText: statusText || '准备中',
      state: 'pending',
    });
    renderUploadQueue();
    return queueId;
  }

  function markQueueItemCompleted(id, statusText) {
    updateQueueItem(id, {
      progress: 100,
      statusText: statusText || '已发送',
      state: 'done',
    });
    scheduleQueueItemRemoval(id, 1200);
  }

  function markQueueItemFailed(id, statusText) {
    updateQueueItem(id, {
      progress: 100,
      statusText: statusText || '发送失败',
      state: 'error',
    });
    scheduleQueueItemRemoval(id, 2500);
  }

  function resolveUploadRequest(requestId, ok, message) {
    if (!requestId || !uploadRequestMap.has(requestId)) {
      return false;
    }

    const queueId = uploadRequestMap.get(requestId);
    uploadRequestMap.delete(requestId);

    if (ok) {
      markQueueItemCompleted(queueId, message || '已发送');
    } else {
      markQueueItemFailed(queueId, message || '发送失败');
    }
    return true;
  }

  function clearPendingUploadRequests(message) {
    for (const [, queueId] of uploadRequestMap.entries()) {
      markQueueItemFailed(queueId, message || '发送中断');
    }
    uploadRequestMap.clear();
  }

  function buildSteamStickerCandidateUrls(type) {
    const normalized = String(type || '').trim();
    if (!normalized) {
      return [];
    }

    return [
      'https://steamcommunity-a.akamaihd.net/economy/sticker/' + encodeURIComponent(normalized),
      'https://steamcommunity-a.akamaihd.net/economy/stickerlarge/' + encodeURIComponent(normalized),
      'https://steamcommunity.com/economy/sticker/' + encodeURIComponent(normalized),
      'https://steamcommunity.com/economy/stickerlarge/' + encodeURIComponent(normalized),
      location.origin + '/proxy/sticker/' + encodeURIComponent(normalized),
    ];
  }

  function closeAttachmentMenu() {
    attachmentMenu.classList.remove('open');
  }

  function toggleAttachmentMenu() {
    attachmentMenu.classList.toggle('open');
  }

  function closeUrlPanel() {
    urlPanel.classList.remove('open');
  }

  function togglePickerPanel() {
    const isOpen = pickerPanel.classList.toggle('open');
    if (isOpen) {
      closeAttachmentMenu();
      pickerSearch.value = '';
      renderPickerGrid();
      pickerSearch.focus();
    }
  }

  function closePickerPanel() {
    pickerPanel.classList.remove('open');
  }

  function setPickerTab(tab) {
    activePickerTab = tab;
    pickerTabs.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    pickerSearch.value = '';
    renderPickerGrid();
  }

  function renderPickerGrid() {
    pickerGrid.innerHTML = '';
    const query = (pickerSearch.value || '').trim().toLowerCase();

    if (activePickerTab === 'emoticons') {
      pickerGrid.className = 'picker-grid emoticon-grid';
      const items = emoticonInventory
        .filter((e) => !query || e.name.toLowerCase().includes(query))
        .sort((a, b) => (b.use_count || 0) - (a.use_count || 0) || a.name.localeCompare(b.name));

      if (!items.length) {
        pickerEmpty.textContent = emoticonInventory.length ? '无匹配结果' : '加载中…';
        pickerEmpty.classList.add('active');
        return;
      }
      pickerEmpty.classList.remove('active');

      items.forEach((e) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'picker-item emoticon-item';
        btn.title = ':' + e.name + ':';

        const img = document.createElement('img');
        img.src = buildCachedImageUrl(buildSteamEmoticonUrl(e.name, true));
        img.alt = e.name;
        img.loading = 'lazy';

        const label = document.createElement('div');
        label.className = 'picker-item-name';
        label.textContent = e.name;

        btn.appendChild(img);
        btn.appendChild(label);
        btn.addEventListener('click', () => {
          insertEmoticonAtCursor(e.name);
          closePickerPanel();
        });
        pickerGrid.appendChild(btn);
      });
    } else {
      pickerGrid.className = 'picker-grid sticker-grid';
      const items = stickerInventory
        .filter((s) => !query || s.name.toLowerCase().includes(query))
        .sort((a, b) => (b.use_count || 0) - (a.use_count || 0) || a.name.localeCompare(b.name));

      if (!items.length) {
        pickerEmpty.textContent = stickerInventory.length ? '无匹配结果' : '加载中…';
        pickerEmpty.classList.add('active');
        return;
      }
      pickerEmpty.classList.remove('active');

      items.forEach((s) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'picker-item sticker-item';
        btn.title = s.name;

        const img = document.createElement('img');
        img.src = location.origin + '/proxy/sticker/' + encodeURIComponent(s.name);
        img.alt = s.name;
        img.loading = 'lazy';

        const label = document.createElement('div');
        label.className = 'picker-item-name';
        label.textContent = s.name.replace(/^Sticker_/, '');

        btn.appendChild(img);
        btn.appendChild(label);
        btn.addEventListener('click', () => {
          sendStickerMessage(s.name);
          closePickerPanel();
        });
        pickerGrid.appendChild(btn);
      });
    }
  }

  function insertEmoticonAtCursor(name) {
    const value = messageInput.value;
    const selectionStart = messageInput.selectionStart || 0;
    const selectionEnd = messageInput.selectionEnd || selectionStart;
    let replaceStart = selectionStart;
    let replaceEnd = selectionEnd;

    if (selectionStart === selectionEnd) {
      const leftSide = value.slice(0, selectionStart);
      const colonIndex = leftSide.lastIndexOf(':');

      if (colonIndex !== -1) {
        const partialName = value.slice(colonIndex + 1, selectionStart);
        if (/^[a-z0-9_\-]*$/i.test(partialName)) {
          let tokenEnd = selectionStart;

          while (tokenEnd < value.length && /[a-z0-9_\-]/i.test(value.charAt(tokenEnd))) {
            tokenEnd += 1;
          }

          if (value.charAt(tokenEnd) === ':') {
            tokenEnd += 1;
          }

          replaceStart = colonIndex;
          replaceEnd = tokenEnd;
        }
      }
    }

    const before = value.slice(0, replaceStart);
    const after = value.slice(replaceEnd);
    const insertion = ':' + name + ': ';
    messageInput.value = before + insertion + after;
    const newCaret = replaceStart + insertion.length;
    messageInput.setSelectionRange(newCaret, newCaret);
    autoResizeMessageInput();
    messageInput.focus();
    knownEmoticons.add(name);
  }

  function sendStickerMessage(name) {
    const id = activeConversationId || currentTargetId();
    if (!id) {
      setStatus('请先选择会话');
      return;
    }
    const msg = '[sticker type="' + name + '" limit="0"][/sticker]';
    if (send({
      type: 'send_message',
      requestId: 'sticker-' + (nextRequestId++),
      id,
      msg,
    })) {
      setStatus('贴纸已发送');
    }
  }

  function fetchEmoticonInventory() {
    send({
      type: 'get_emoticons',
      requestId: 'emoticons-' + (nextRequestId++),
    });
  }

  function revokeAttachmentPreviewUrl(attachment) {
    if (attachment && attachment.previewUrl && String(attachment.previewUrl).startsWith('blob:')) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }

  function revokePendingAttachmentUrl() {
    revokeAttachmentPreviewUrl(pendingAttachment);
  }

  function clearPendingAttachment() {
    revokePendingAttachmentUrl();
    pendingAttachment = null;
    attachmentPreview.classList.remove('active');
    attachmentPreviewImage.hidden = true;
    attachmentPreviewImage.removeAttribute('src');
    attachmentPreviewTitle.textContent = '';
    attachmentPreviewSubtitle.textContent = '';
    imageFileInput.value = '';
  }

  function setPendingAttachment(attachment) {
    if (!attachment) {
      clearPendingAttachment();
      return;
    }

    revokePendingAttachmentUrl();
    pendingAttachment = attachment;

    attachmentPreview.classList.add('active');
    attachmentPreviewTitle.textContent = attachment.title || '待发送图片';
    attachmentPreviewSubtitle.textContent = attachment.subtitle || '';

    if (attachment.previewUrl) {
      attachmentPreviewImage.hidden = false;
      attachmentPreviewImage.src = attachment.previewUrl;
    } else {
      attachmentPreviewImage.hidden = true;
      attachmentPreviewImage.removeAttribute('src');
    }
  }

  function readFileAsDataUrl(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (event) => {
        if (typeof onProgress === 'function') {
          onProgress(event.loaded || 0, event.total || file.size || 0);
        }
      };
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function createFileAttachment(file, sourceLabel) {
    if (!file) {
      throw new Error('请选择图片文件');
    }

    return {
      kind: 'file',
      file,
      previewUrl: URL.createObjectURL(file),
      title: file.name || '待发送图片',
      subtitle: sourceLabel || '本地图片',
    };
  }

  async function resolveAttachmentPayload(attachment, onProgress) {
    if (!attachment) {
      throw new Error('缺少图片内容');
    }

    if (attachment.kind === 'url' || attachment.kind === 'base64') {
      return attachment;
    }

    if (attachment.kind !== 'file' || !attachment.file) {
      throw new Error('暂不支持的图片类型');
    }

    const dataUrl = await readFileAsDataUrl(attachment.file, onProgress);

    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) {
      throw new Error('图片编码失败');
    }

    return {
      kind: 'base64',
      payload: base64,
      previewUrl: attachment.previewUrl,
      title: attachment.title,
      subtitle: attachment.subtitle,
    };
  }

  function attachFile(file, sourceLabel) {
    if (!file) {
      return;
    }

    const attachment = createFileAttachment(file, sourceLabel);
    setPendingAttachment(attachment);
    setStatus((sourceLabel || '图片') + ' 已添加，点击发送即可发送');
  }

  async function sendFileDirectly(file, sourceLabel) {
    const id = activeConversationId || currentTargetId();
    if (!id) {
      await attachFile(file, sourceLabel);
      setStatus('请先选择会话，图片已加入待发送');
      return;
    }

    const attachment = createFileAttachment(file, sourceLabel);
    if (await sendAttachmentWithQueue(id, attachment, 'drop-')) {
      revokeAttachmentPreviewUrl(attachment);
      setStatus((sourceLabel || '图片') + ' 已发送');
    }
  }

  async function sendFilesDirectly(files, sourceLabel) {
    const imageFiles = Array.from(files || []).filter((file) => String(file.type || '').startsWith('image/'));
    if (!imageFiles.length) {
      return;
    }

    for (let index = 0; index < imageFiles.length; index += 1) {
      await sendFileDirectly(imageFiles[index], imageFiles.length > 1 ? ((sourceLabel || '拖拽图片') + ' #' + (index + 1)) : sourceLabel);
    }

    if (imageFiles.length > 1) {
      setStatus('已连续发送 ' + imageFiles.length + ' 张图片');
    }
  }

  function confirmImageUrl() {
    const url = imageUrlInput.value.trim();
    if (!url) {
      setStatus('请输入图片 URL');
      return;
    }

    setPendingAttachment({
      kind: 'url',
      payload: url,
      previewUrl: url,
      title: '待发送图片 URL',
      subtitle: url,
    });
    closeUrlPanel();
    closeAttachmentMenu();
    setStatus('图片 URL 已添加，点击发送即可发送');
  }

  function sendAttachmentPayload(id, attachment, requestId) {
    const payload = {
      type: 'send_image',
      requestId,
      id,
    };

    if (attachment.kind === 'url') {
      payload.url = attachment.payload;
    } else {
      payload.img = attachment.payload;
    }

    return send(payload);
  }

  async function sendAttachmentWithQueue(id, attachment, requestPrefix) {
    if (!id) {
      throw new Error('请先选择会话');
    }
    if (!attachment) {
      return false;
    }

    const name = attachment.title || attachment.subtitle || '图片';
    const isFileAttachment = attachment.kind === 'file' && attachment.file;
    const queueId = createQueueItem(name, isFileAttachment ? '读取中 0%' : '准备发送', isFileAttachment ? 0 : 20);

    let resolvedAttachment;
    try {
      resolvedAttachment = await resolveAttachmentPayload(attachment, (loaded, total) => {
        if (!isFileAttachment) {
          return;
        }

        const ratio = total > 0 ? loaded / total : 0;
        const progress = Math.max(1, Math.min(90, Math.round(ratio * 90)));
        const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));

        updateQueueItem(queueId, {
          progress,
          statusText: '读取中 ' + percent + '%',
          state: 'pending',
        });
      });
    } catch (error) {
      markQueueItemFailed(queueId, error.message || '图片读取失败');
      throw error;
    }

    const requestId = requestPrefix + (nextRequestId++);
    updateQueueItem(queueId, {
      progress: 95,
      statusText: '等待发送确认',
      state: 'pending',
    });
    uploadRequestMap.set(requestId, queueId);

    if (!sendAttachmentPayload(id, resolvedAttachment, requestId)) {
      uploadRequestMap.delete(requestId);
      markQueueItemFailed(queueId, '发送失败');
      return false;
    }

    return true;
  }

  function hideSuggestions() {
    currentSuggestions = [];
    activeSuggestionIndex = 0;
    emoticonSuggestions.classList.remove('open');
  }

  function getAutocompleteContext() {
    const value = messageInput.value;
    const caret = messageInput.selectionStart || 0;
    const textBefore = value.slice(0, caret);
    const match = textBefore.match(/(^|\s):([a-z0-9_][a-z0-9_\-]*)?$/i);
    if (!match) {
      return null;
    }

    return {
      start: caret - (match[2] ? match[2].length + 1 : 1),
      end: caret,
      query: (match[2] || '').toLowerCase(),
    };
  }

  function refreshSuggestionHighlight() {
    Array.from(emoticonSuggestions.querySelectorAll('.emoticon-option')).forEach((node, index) => {
      node.classList.toggle('active', index === activeSuggestionIndex);
    });
    if (currentSuggestions[activeSuggestionIndex]) {
      updateSuggestionPreview(currentSuggestions[activeSuggestionIndex]);
    }
  }

  function updateSuggestionPreview(name) {
    emoticonPreviewImage.src = buildSteamEmoticonUrl(name, true);
    emoticonPreviewLabel.textContent = ':' + name + ': · ' + categorizeEmoticon(name);
  }

  function applySuggestion(index = activeSuggestionIndex) {
    const suggestion = currentSuggestions[index];
    const context = getAutocompleteContext();
    if (!suggestion || !context) {
      hideSuggestions();
      return;
    }

    const value = messageInput.value;
    const replacement = ':' + suggestion + ': ';
    messageInput.value = value.slice(0, context.start) + replacement + value.slice(context.end);
    const caret = context.start + replacement.length;
    messageInput.setSelectionRange(caret, caret);
    knownEmoticons.add(suggestion);
    autoResizeMessageInput();
    hideSuggestions();
    messageInput.focus();
  }

  function renderSuggestionList(names) {
    Array.from(emoticonSuggestions.querySelectorAll('.emoticon-option')).forEach((node) => node.remove());
    currentSuggestions = names.slice(0, 8);
    activeSuggestionIndex = 0;

    if (!currentSuggestions.length) {
      hideSuggestions();
      return;
    }

    updateSuggestionPreview(currentSuggestions[0]);

    currentSuggestions.forEach((name, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'emoticon-option' + (index === 0 ? ' active' : '');

      const img = document.createElement('img');
      img.src = buildSteamEmoticonUrl(name, true);
      img.alt = name;

      const label = document.createElement('div');
      label.innerHTML = '<code>:' + name + ':</code><div style="font-size:12px;color:#94a3b8;margin-top:2px;">' + categorizeEmoticon(name) + '</div>';

      option.appendChild(img);
      option.appendChild(label);
      option.addEventListener('click', () => applySuggestion(index));
      option.addEventListener('mouseenter', () => {
        activeSuggestionIndex = index;
        refreshSuggestionHighlight();
        updateSuggestionPreview(name);
      });
      emoticonSuggestions.appendChild(option);
    });

    emoticonSuggestions.classList.add('open');
  }

  function updateEmoticonSuggestions() {
    const context = getAutocompleteContext();
    if (!context) {
      hideSuggestions();
      return;
    }

    const query = context.query;
    const names = [...knownEmoticons]
      .filter((name) => !query || name.toLowerCase().includes(query))
      .sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        const aCategory = categorizeEmoticon(a);
        const bCategory = categorizeEmoticon(b);
        const aStarts = query ? aLower.startsWith(query) : true;
        const bStarts = query ? bLower.startsWith(query) : true;

        if (aStarts !== bStarts) {
          return aStarts ? -1 : 1;
        }

        if (aCategory !== bCategory) {
          return aCategory.localeCompare(bCategory);
        }

        return a.localeCompare(b);
      });

    renderSuggestionList(names);
  }

  async function handlePasteImage(event) {
    const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
    const imageItem = items.find((item) => item && item.type && item.type.startsWith('image/'));
    if (!imageItem) {
      return false;
    }

    const file = imageItem.getAsFile();
    if (!file) {
      return false;
    }

    event.preventDefault();
    const attachment = createFileAttachment(file, '剪切板图片');
    const id = activeConversationId || currentTargetId();

    if (id && socket && socket.readyState === WebSocket.OPEN) {
      if (await sendAttachmentWithQueue(id, attachment, 'paste-')) {
        revokeAttachmentPreviewUrl(attachment);
        imageUrlInput.value = '';
        setStatus('剪切板图片发送中');
        return true;
      }
    }

    setPendingAttachment(attachment);
    setStatus('剪切板图片已添加，点击发送即可发送');
    return true;
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
    renderConversations();

    if (!document.hidden && document.hasFocus()) {
      clearUnreadCount();
    }

    if (activeConversationId) {
      closeSidebar();
    }
  }

  function renderConversations() {
    conversationListEl.innerHTML = '';

    if (!conversations.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无历史会话';
      conversationListEl.appendChild(empty);
      return;
    }

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
      idLine.style.marginTop = '6px';

      item.appendChild(top);
      item.appendChild(preview);
      item.appendChild(idLine);
      item.addEventListener('click', () => {
        setActiveConversation(conversation.id, conversation.name);
        requestHistory();
      });
      conversationListEl.appendChild(item);
    });
  }

  function insertDivider(text, className) {
    const divider = document.createElement('div');
    divider.className = className;
    divider.textContent = text;
    messagesEl.appendChild(divider);
  }

  function appendEntry(entry, previousEntry) {
    if (!entry || !entry.id) {
      return;
    }

    const activeId = activeConversationId || currentTargetId();
    if (activeId && entry.id !== activeId) {
      return;
    }

    const currentDate = parseDateString(entry.date || entry.sentAt);
    const previousDate = previousEntry ? parseDateString(previousEntry.date || previousEntry.sentAt) : null;

    if (currentDate && (!previousDate || !sameDay(currentDate, previousDate))) {
      insertDivider(formatDayLabel(entry.date || entry.sentAt), 'day-divider');
    } else if (currentDate && previousDate && (currentDate.getTime() - previousDate.getTime()) >= 10 * 60 * 1000) {
      insertDivider(formatTimeLabel(entry.date || entry.sentAt), 'time-divider');
    }

    const row = document.createElement('div');
    row.className = 'message-row ' + (entry.echo ? 'self' : 'other');

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = (entry.name || (entry.echo ? '我' : '对方')) + ' · ' + formatTimeLabel(entry.date || entry.sentAt);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (entry.type === 'image' || entry.imageUrl) {
      bubble.classList.add('image-bubble');

      const rawImageUrl = entry.imageUrl;
      const { host, img } = createManagedImageHost('image-loading-host--bubble');
      img.alt = 'image';
      makeImageZoomable(host, rawImageUrl, rawImageUrl);
      loadManagedImage(host, img, buildCachedImageUrl(rawImageUrl));
      bubble.appendChild(host);
    } else {
      const stickerType = extractStickerType(entry.message);
      if (stickerType) {
        bubble.classList.add('sticker-bubble');

        const stickerCandidates = buildSteamStickerCandidateUrls(stickerType);
        if (stickerCandidates.length) {
          const stickerImage = document.createElement('img');
          stickerImage.className = 'sticker-image';
          stickerImage.alt = stickerType;
          let stickerIndex = 0;
          stickerImage.src = location.origin + '/proxy/sticker/' + encodeURIComponent(stickerType);
          stickerImage.addEventListener('error', () => {
            stickerIndex += 1;
            if (stickerIndex < stickerCandidates.length) {
              stickerImage.src = stickerCandidates[stickerIndex];
            } else {
              stickerImage.remove();
            }
          });
          bubble.appendChild(stickerImage);
        }

        const title = document.createElement('div');
        title.className = 'sticker-title';
        title.textContent = '\u2728';

        const name = document.createElement('div');
        name.className = 'sticker-name';
        name.textContent = stickerType.replace(/^Sticker_/, '');

        const raw = document.createElement('div');
        raw.style.marginTop = '6px';
        raw.style.fontSize = '12px';
        raw.style.opacity = '0.8';
        raw.textContent = 'Sticker';

        bubble.appendChild(title);
        bubble.appendChild(name);
        bubble.appendChild(raw);
      } else {
        bubble.appendChild(createRichMessageContent(entry.message || ''));
      }
    }

    row.appendChild(meta);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderHistory(items) {
    clearMessages();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无历史消息';
      messagesEl.appendChild(empty);
      return;
    }

    let previousEntry = null;
    items.forEach((entry) => {
      appendEntry(entry, previousEntry);
      previousEntry = entry;
    });
  }

  function updateConversationList(entry) {
    if (!entry || !entry.id) {
      return;
    }

    extractEmoticonNames(entry.message).forEach((name) => knownEmoticons.add(name));

    const preview = entry.type === 'image' || entry.imageUrl
      ? '[图片]'
      : (extractStickerType(entry.message) ? '[贴纸] ' + extractStickerType(entry.message).replace(/^Sticker_/, '') : String(entry.message || '').trim().slice(0, 60));
    const current = conversations.find((item) => item.id === entry.id);

    if (current) {
      current.name = entry.name || current.name;
      current.updatedAt = entry.date || entry.sentAt || current.updatedAt;
      current.preview = preview || current.preview;
    } else {
      conversations.push({
        id: entry.id,
        name: entry.name || entry.id,
        updatedAt: entry.date || entry.sentAt || '',
        preview,
      });
    }

    conversations.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    renderConversations();
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus('WebSocket 未连接');
      return false;
    }

    savePreferences();
    socket.send(JSON.stringify(payload));
    return true;
  }

  function requestConversations() {
    send({
      type: 'get_conversations',
      requestId: 'conv-' + (nextRequestId++),
      limit: 200,
    });
  }

  function requestHistory() {
    const id = activeConversationId || currentTargetId();
    if (!id) {
      clearMessages();
      setStatus('请输入对方 SteamID64 后再加载历史');
      return;
    }

    send({
      type: 'get_history',
      requestId: 'history-' + (nextRequestId++),
      id,
      limit: currentHistoryLimit(),
    });
  }

  function sendImageFile() {
    const file = imageFileInput.files && imageFileInput.files[0];
    if (!file) {
      setStatus('请选择图片文件');
      return;
    }
    attachFile(file, '本地图片');
  }

  function connect(wsPath) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(protocol + '//' + location.host + wsPath);

    socket.addEventListener('open', () => {
      setStatus('WebSocket 已连接');
    });

    socket.addEventListener('close', () => {
      clearPendingUploadRequests('连接已断开');
      setStatus('WebSocket 已断开，3 秒后重连');
      setTimeout(() => connect(wsPath), 3000);
    });

    socket.addEventListener('error', () => {
      setStatus('WebSocket 连接异常');
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        setStatus('收到无法解析的消息');
        return;
      }

      switch (payload.type) {
        case 'ready':
          setStatus('WebSocket 已连接');
          requestConversations();
          fetchEmoticonInventory();
          break;
        case 'emoticons':
          emoticonInventory = (payload.data && payload.data.emoticons) || [];
          emoticonInventory.forEach((e) => { e.name = e.name.replace(/^:+|:+$/g, ''); });
          stickerInventory = (payload.data && payload.data.stickers) || [];
          emoticonInventory.forEach((e) => knownEmoticons.add(e.name));
          if (pickerPanel.classList.contains('open')) {
            renderPickerGrid();
          }
          break;
        case 'conversations':
          conversations = (payload.data && payload.data.items) || [];
          renderConversations();
          if (activeConversationId) {
            requestHistory();
          } else if (currentTargetId()) {
            setActiveConversation(currentTargetId());
            requestHistory();
          } else if (conversations.length) {
            setActiveConversation(conversations[0].id, conversations[0].name);
            requestHistory();
          }
          break;
        case 'history':
          ((payload.data && payload.data.items) || []).forEach((item) => extractEmoticonNames(item.message).forEach((name) => knownEmoticons.add(name)));
          renderHistory((payload.data && payload.data.items) || []);
          updateConversationList(((payload.data && payload.data.items) || []).slice(-1)[0]);
          setStatus('历史消息已加载');
          break;
        case 'message':
        case 'image':
          updateConversationList(payload.data);
          appendEntry(payload.data, null);
          notifyIncomingEntry(payload.data);
          break;
        case 'message_sent':
          hideSuggestions();
          break;
        case 'image_sent':
          resolveUploadRequest(payload.requestId, true, '已发送');
          updateConversationList(payload.data);
          appendEntry(payload.data, null);
          setStatus('图片已发送');
          break;
        case 'error':
          resolveUploadRequest(payload.requestId, false, payload.message);
          setStatus(payload.message || '请求失败');
          break;
        case 'pong':
          break;
        default:
          console.log('unknown payload', payload);
      }
    });
  }

  function openConversation() {
    const id = currentTargetId();
    if (!id) {
      setStatus('请输入 SteamID64');
      return;
    }

    setActiveConversation(id);
    requestHistory();
  }

  updateViewportHeightVar();
  syncResponsiveLayout();
  syncMessageInputPlaceholder();
  reloadHistoryButton.addEventListener('click', requestHistory);
  reloadConversationsButton.addEventListener('click', requestConversations);
  openConversationButton.addEventListener('click', openConversation);
  targetIdInput.addEventListener('change', openConversation);
  historyLimitInput.addEventListener('change', requestHistory);
  mobileSidebarToggleButton.addEventListener('click', toggleSidebar);
  closeSidebarButton.addEventListener('click', closeSidebar);
  sidebarBackdrop.addEventListener('click', closeSidebar);
  if (typeof mobileLayoutMedia.addEventListener === 'function') {
    mobileLayoutMedia.addEventListener('change', syncResponsiveLayout);
  } else if (typeof mobileLayoutMedia.addListener === 'function') {
    mobileLayoutMedia.addListener(syncResponsiveLayout);
  }

  sendMessageButton.addEventListener('click', async () => {
    const id = activeConversationId || currentTargetId();
    const msg = messageInput.value.trim();
    if (!id || (!msg && !pendingAttachment)) {
      setStatus('请输入目标 SteamID，并填写消息或添加图片');
      return;
    }

    try {
      if (pendingAttachment) {
        const attachment = pendingAttachment;
        if (await sendAttachmentWithQueue(id, attachment, 'img-')) {
          clearPendingAttachment();
          imageUrlInput.value = '';
          setStatus('图片发送中');
        }
      }

      if (msg) {
        if (send({
          type: 'send_message',
          requestId: 'msg-' + (nextRequestId++),
          id,
          msg,
        })) {
          messageInput.value = '';
          autoResizeMessageInput();
        }
      }
    } catch (error) {
      setStatus(error.message || '发送图片失败');
    }
  });

  attachmentButton.addEventListener('click', (event) => {
    event.stopPropagation();
    closePickerPanel();
    toggleAttachmentMenu();
  });

  pickerButton.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePickerPanel();
  });

  pickerTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      setPickerTab(tab.dataset.tab);
    });
  });

  pickerSearch.addEventListener('input', renderPickerGrid);

  pickerPanel.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  chooseImageButton.addEventListener('click', () => {
    closeAttachmentMenu();
    closeUrlPanel();
    imageFileInput.click();
  });

  chooseUrlButton.addEventListener('click', () => {
    closeAttachmentMenu();
    urlPanel.classList.add('open');
    imageUrlInput.focus();
  });

  imageFileInput.addEventListener('change', () => {
    try {
      sendImageFile();
    } catch (error) {
      setStatus(error.message || '读取图片失败');
    }
  });

  confirmImageUrlButton.addEventListener('click', confirmImageUrl);
  cancelImageUrlButton.addEventListener('click', () => {
    closeUrlPanel();
    imageUrlInput.value = '';
  });
  clearAttachmentButton.addEventListener('click', clearPendingAttachment);

  document.addEventListener('click', (event) => {
    if (isMobileLayout()
      && sidebarEl.classList.contains('open')
      && !sidebarEl.contains(event.target)
      && event.target !== mobileSidebarToggleButton) {
      closeSidebar();
    }
    if (!attachmentMenu.contains(event.target) && event.target !== attachmentButton) {
      closeAttachmentMenu();
    }
    if (!pickerPanel.contains(event.target) && event.target !== pickerButton) {
      closePickerPanel();
    }
  });

  imageLightbox.addEventListener('click', (event) => {
    if (event.target === imageLightbox) {
      closeImageLightbox();
    }
  });

  imageLightboxViewport.addEventListener('wheel', (event) => {
    if (!imageLightbox.classList.contains('open')) {
      return;
    }

    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0025);
    setImageLightboxScale(imageLightboxState.scale * factor, event.clientX, event.clientY);
  }, { passive: false });

  imageLightboxViewport.addEventListener('pointerdown', (event) => {
    if (!imageLightbox.classList.contains('open')) {
      return;
    }

    imageLightboxViewport.setPointerCapture(event.pointerId);
    imageLightboxState.activePointers.set(event.pointerId, {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
    });

    if (event.pointerType === 'touch') {
      event.preventDefault();
      if (getTouchPointerList().length >= 2) {
        beginImageLightboxPinch();
        return;
      }
    }

    if (event.button !== 0 || imageLightboxState.scale <= 1) {
      return;
    }

    event.preventDefault();
    beginImageLightboxDrag(event.pointerId, event.clientX, event.clientY);
  });

  imageLightboxViewport.addEventListener('pointermove', (event) => {
    if (imageLightboxState.activePointers.has(event.pointerId)) {
      imageLightboxState.activePointers.set(event.pointerId, {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }

    if (imageLightboxState.pinching) {
      event.preventDefault();
      updateImageLightboxPinch();
      return;
    }

    if (!imageLightboxState.dragging || imageLightboxState.dragPointerId !== event.pointerId) {
      return;
    }

    imageLightboxState.offsetX = imageLightboxState.dragOriginX + (event.clientX - imageLightboxState.dragStartX);
    imageLightboxState.offsetY = imageLightboxState.dragOriginY + (event.clientY - imageLightboxState.dragStartY);
    scheduleTransformOnly();
  });

  function stopImageLightboxDrag(event) {
    const hadPointer = imageLightboxState.activePointers.delete(event.pointerId);

    if (imageLightboxState.pinching && getTouchPointerList().length < 2) {
      endImageLightboxPinch();
    }

    if (!imageLightboxState.dragging || imageLightboxState.dragPointerId !== event.pointerId) {
      if (hadPointer && imageLightboxViewport.hasPointerCapture(event.pointerId)) {
        imageLightboxViewport.releasePointerCapture(event.pointerId);
      }
      return;
    }

    imageLightboxState.dragging = false;
    imageLightboxState.dragPointerId = null;
    if (imageLightboxViewport.hasPointerCapture(event.pointerId)) {
      imageLightboxViewport.releasePointerCapture(event.pointerId);
    }
    updateImageLightboxTransform();
  }

  imageLightboxViewport.addEventListener('pointerup', stopImageLightboxDrag);
  imageLightboxViewport.addEventListener('pointercancel', stopImageLightboxDrag);
  imageLightboxViewport.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (imageLightboxState.scale > 1) {
      resetImageLightboxTransform();
      return;
    }
    setImageLightboxScale(2, event.clientX, event.clientY);
  });

  imageLightboxImage.addEventListener('load', () => {
    refreshImageLightboxBaseSize();
    resetImageLightboxTransform();
  });

  imageZoomOutButton.addEventListener('click', () => {
    setImageLightboxScale(imageLightboxState.scale / 1.2);
  });

  imageZoomResetButton.addEventListener('click', resetImageLightboxTransform);

  imageZoomInButton.addEventListener('click', () => {
    setImageLightboxScale(imageLightboxState.scale * 1.2);
  });

  closeImageLightboxButton.addEventListener('click', closeImageLightbox);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.hasFocus()) {
      clearUnreadCount();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && imageLightbox.classList.contains('open')) {
      closeImageLightbox();
      return;
    }

    if (!imageLightbox.classList.contains('open')) {
      return;
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setImageLightboxScale(imageLightboxState.scale * 1.2);
    } else if (event.key === '-') {
      event.preventDefault();
      setImageLightboxScale(imageLightboxState.scale / 1.2);
    } else if (event.key === '0') {
      event.preventDefault();
      resetImageLightboxTransform();
    }
  });

  window.addEventListener('focus', clearUnreadCount);
  window.addEventListener('resize', () => {
    updateViewportHeightVar();
    syncResponsiveLayout();
    autoResizeMessageInput();
    if (imageLightbox.classList.contains('open')) {
      refreshImageLightboxBaseSize();
    }
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      updateViewportHeightVar();
      autoResizeMessageInput();
    });
    window.visualViewport.addEventListener('scroll', updateViewportHeightVar);
  }
  window.addEventListener('pointerdown', warmupNotifications, { once: true });
  window.addEventListener('keydown', warmupNotifications, { once: true });

  messageInput.addEventListener('keydown', (event) => {
    if (emoticonSuggestions.classList.contains('open')) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex + 1) % currentSuggestions.length;
        refreshSuggestionHighlight();
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeSuggestionIndex = (activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
        refreshSuggestionHighlight();
        return;
      }

      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        applySuggestion();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        hideSuggestions();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessageButton.click();
    }
  });

  messageInput.addEventListener('input', () => {
    autoResizeMessageInput();
    updateEmoticonSuggestions();
  });
  messageInput.addEventListener('click', updateEmoticonSuggestions);
  messageInput.addEventListener('blur', () => {
    setTimeout(hideSuggestions, 120);
  });

  messageInput.addEventListener('paste', (event) => {
    handlePasteImage(event).catch((error) => {
      setStatus(error.message || '处理剪切板图片失败');
    });
  });

  document.addEventListener('paste', (event) => {
    if (document.activeElement === messageInput) {
      return;
    }

    handlePasteImage(event).catch((error) => {
      setStatus(error.message || '处理剪切板图片失败');
    });
  });

  document.addEventListener('dragenter', (event) => {
    const hasFile = Array.from((event.dataTransfer && event.dataTransfer.items) || []).some((item) => item.kind === 'file');
    if (!hasFile) {
      return;
    }

    dragDepth += 1;
    dropOverlay.classList.add('active');
  });

  document.addEventListener('dragover', (event) => {
    const hasFile = Array.from((event.dataTransfer && event.dataTransfer.items) || []).some((item) => item.kind === 'file');
    if (!hasFile) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.classList.remove('active');
    }
  });

  document.addEventListener('drop', (event) => {
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []).filter((file) => String(file.type || '').startsWith('image/'));
    if (!files.length) {
      dragDepth = 0;
      dropOverlay.classList.remove('active');
      return;
    }

    event.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('active');

    sendFilesDirectly(files, '拖拽图片').catch((error) => {
      setStatus(error.message || '发送拖拽图片失败');
    });
  });

  autoResizeMessageInput();

  // Fetch wsPath from backend config, then connect
  fetch('/api/config')
    .then((res) => res.json())
    .then((config) => {
      connect(config.wsPath || '/ws');
    })
    .catch(() => {
      // Fallback to default wsPath
      connect('/ws');
    });
})();
