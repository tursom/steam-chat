export function createComposerController({
  buildCachedImageUrl,
  buildSteamEmoticonUrl,
  extractEmoticonNames,
  isMobileLayout,
  setStatus,
  send,
  createRequestId,
  getConversationId,
  controls,
}) {
  const {
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
  } = controls;

  let pendingAttachment = null;
  let dragDepth = 0;
  const knownEmoticons = new Set(['steamhappy', 'steamfacepalm', 'steamthumbsup', 'steamheart', 'steamsad', 'steammocking']);
  let currentSuggestions = [];
  let activeSuggestionIndex = 0;
  let uploadQueueItems = [];
  const uploadRequestMap = new Map();
  let activePickerTab = 'emoticons';
  let emoticonInventory = [];
  let stickerInventory = [];

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

  function categorizeEmoticon(name) {
    if (/^steam/i.test(name)) {
      return 'Steam';
    }
    return '最近使用';
  }

  function renderUploadQueue() {
    uploadQueueList.replaceChildren();
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
    const id = getConversationId();
    if (!id) {
      setStatus('请先选择会话');
      return;
    }
    const msg = '[sticker type="' + name + '" limit="0"][/sticker]';
    if (send({
      type: 'send_message',
      requestId: createRequestId('sticker-'),
      id,
      msg,
    })) {
      setStatus('贴纸已发送');
    }
  }

  function renderPickerGrid() {
    pickerGrid.replaceChildren();
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
    const id = getConversationId();
    if (!id) {
      attachFile(file, sourceLabel);
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

    const requestId = createRequestId(requestPrefix);
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
      label.className = 'emoticon-option-body';

      const code = document.createElement('code');
      code.textContent = ':' + name + ':';

      const meta = document.createElement('div');
      meta.className = 'emoticon-option-meta';
      meta.textContent = categorizeEmoticon(name);

      label.appendChild(code);
      label.appendChild(meta);

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
    const id = getConversationId();

    if (id && await sendAttachmentWithQueue(id, attachment, 'paste-')) {
      revokeAttachmentPreviewUrl(attachment);
      imageUrlInput.value = '';
      setStatus('剪切板图片发送中');
      return true;
    }

    setPendingAttachment(attachment);
    setStatus('剪切板图片已添加，点击发送即可发送');
    return true;
  }

  async function handleSendMessage() {
    const id = getConversationId();
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
          requestId: createRequestId('msg-'),
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
  }

  function requestEmoticonInventory() {
    send({
      type: 'get_emoticons',
      requestId: createRequestId('emoticons-'),
    });
  }

  function applyEmoticonInventory(data) {
    emoticonInventory = (data && data.emoticons) || [];
    emoticonInventory.forEach((e) => { e.name = e.name.replace(/^:+|:+$/g, ''); });
    stickerInventory = (data && data.stickers) || [];
    emoticonInventory.forEach((e) => knownEmoticons.add(e.name));
    if (pickerPanel.classList.contains('open')) {
      renderPickerGrid();
    }
  }

  function rememberEmoticonsFromMessage(message) {
    extractEmoticonNames(message).forEach((name) => knownEmoticons.add(name));
  }

  function bindEvents() {
    sendMessageButton.addEventListener('click', () => {
      handleSendMessage();
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
        const file = imageFileInput.files && imageFileInput.files[0];
        if (!file) {
          setStatus('请选择图片文件');
          return;
        }
        attachFile(file, '本地图片');
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
      if (!attachmentMenu.contains(event.target) && event.target !== attachmentButton) {
        closeAttachmentMenu();
      }
      if (!pickerPanel.contains(event.target) && event.target !== pickerButton) {
        closePickerPanel();
      }
    });

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
  }

  function handleViewportChange() {
    syncMessageInputPlaceholder();
    autoResizeMessageInput();
  }

  return {
    applyEmoticonInventory,
    bindEvents,
    clearPendingUploadRequests,
    handleViewportChange,
    hideSuggestions,
    rememberEmoticonsFromMessage,
    requestEmoticonInventory,
    resolveUploadRequest,
  };
}
