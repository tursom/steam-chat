type Tone = 'muted' | 'ok' | 'warn' | 'error';
type PickerTab = 'emoticons' | 'stickers';

type ListEntry = Record<string, unknown> & {
  id: string;
  name?: string;
  avatar?: string;
  preview?: string;
  updatedAt?: string;
  gameName?: string;
  game?: string;
  online?: boolean;
  clanId?: string;
  clanid?: string;
  messageCount?: number;
};

type MessageItem = ListEntry & {
  type?: string;
  echo?: boolean;
  date?: string;
  sentAt?: string;
  message?: string;
  imageUrl?: string | null;
  lastType?: string;
  lastEcho?: boolean;
};

type InventoryItem = Record<string, unknown> & {
  name?: string;
  use_count?: number | string;
};

type WsPayload = Record<string, unknown> & {
  requestId?: string;
  type?: string;
  error?: string;
  id?: string;
  msg?: string;
  message?: string;
  wsPath?: string;
  items?: MessageItem[];
  history?: MessageItem[];
  conversations?: ListEntry[];
  friends?: ListEntry[];
  groups?: ListEntry[];
  emoticons?: InventoryItem[];
  stickers?: InventoryItem[];
};

type PendingRequest = {
  resolve: (value: WsPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type MessageRow = HTMLElement & {
  _item?: MessageItem;
};

type TextPart = { type: 'text'; text: string };
type LinkPart = { type: 'link'; href: string; label: string };
type EmoticonPart = { type: 'emoticon'; name: string };
type StickerPart = { type: 'sticker'; stickerType: string };
type ImagePart = { type: 'image'; url: string };
type OgPart = { type: 'og'; url: string; image: string; title: string; fallback: string };
type RichPart = TextPart | LinkPart | EmoticonPart | StickerPart | ImagePart | OgPart;

type Els = {
  sidebar: HTMLElement;
  backdrop: HTMLElement;
  openSidebar: HTMLButtonElement;
  closeSidebar: HTMLButtonElement;
  connectionText: HTMLElement;
  feedback: HTMLElement;
  openForm: HTMLFormElement;
  targetInput: HTMLInputElement;
  historyLimit: HTMLInputElement;
  refreshAll: HTMLButtonElement;
  conversationList: HTMLElement;
  friendList: HTMLElement;
  groupList: HTMLElement;
  chatTitle: HTMLElement;
  chatSubtitle: HTMLElement;
  messages: HTMLElement;
  uploadTray: HTMLElement;
  picker: HTMLElement;
  pickerGrid: HTMLElement;
  pickerSearch: HTMLInputElement;
  pickerToggle: HTMLButtonElement;
  autocomplete: HTMLElement;
  fileButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
  messageInput: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  imageUrlForm: HTMLFormElement;
  imageUrlInput: HTMLInputElement;
  dropOverlay: HTMLElement;
  lightbox: HTMLElement;
  lightboxImage: HTMLImageElement;
  lightboxClose: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  zoomReset: HTMLButtonElement;
};

type AppState = {
  activeId: string;
  activeName: string;
  historyLimit: number;
  conversations: ListEntry[];
  friends: ListEntry[];
  groups: ListEntry[];
  emoticons: InventoryItem[];
  stickers: InventoryItem[];
  knownEmoticons: Set<string>;
  ws: WebSocket | null;
  pending: Map<string, PendingRequest>;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pickerTab: PickerTab;
  autocompleteIndex: number;
  unread: number;
  objectUrls: Set<string>;
  imageRequests: Set<XMLHttpRequest>;
};

const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T => {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
};
const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(selector)];

const els: Els = {
  sidebar: $('#sidebar'),
  backdrop: $('#backdrop'),
  openSidebar: $('#openSidebar'),
  closeSidebar: $('#closeSidebar'),
  connectionText: $('#connectionText'),
  feedback: $('#feedback'),
  openForm: $('#openForm'),
  targetInput: $('#targetInput'),
  historyLimit: $('#historyLimit'),
  refreshAll: $('#refreshAll'),
  conversationList: $('#conversationList'),
  friendList: $('#friendList'),
  groupList: $('#groupList'),
  chatTitle: $('#chatTitle'),
  chatSubtitle: $('#chatSubtitle'),
  messages: $('#messages'),
  uploadTray: $('#uploadTray'),
  picker: $('#picker'),
  pickerGrid: $('#pickerGrid'),
  pickerSearch: $('#pickerSearch'),
  pickerToggle: $('#pickerToggle'),
  autocomplete: $('#autocomplete'),
  fileButton: $('#fileButton'),
  fileInput: $('#fileInput'),
  messageInput: $('#messageInput'),
  sendButton: $('#sendButton'),
  imageUrlForm: $('#imageUrlForm'),
  imageUrlInput: $('#imageUrlInput'),
  dropOverlay: $('#dropOverlay'),
  lightbox: $('#lightbox'),
  lightboxImage: $('#lightboxImage'),
  lightboxClose: $('#lightboxClose'),
  zoomIn: $('#zoomIn'),
  zoomOut: $('#zoomOut'),
  zoomReset: $('#zoomReset')
};

const state: AppState = {
  activeId: localStorage.getItem('steam-chat.target') || '',
  activeName: '',
  historyLimit: clampLimit(localStorage.getItem('steam-chat.history-limit') || 100),
  conversations: [],
  friends: [],
  groups: [],
  emoticons: [],
  stickers: [],
  knownEmoticons: new Set(),
  ws: null,
  pending: new Map(),
  reconnectTimer: null,
  pickerTab: 'emoticons',
  autocompleteIndex: 0,
  unread: 0,
  objectUrls: new Set(),
  imageRequests: new Set()
};

const baseTitle = document.title;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

function asListEntries(value: unknown): ListEntry[] {
  return Array.isArray(value) ? value.filter(isRecord).map((item) => ({ ...item, id: String(item.id || '') })) : [];
}

function asMessageItems(value: unknown): MessageItem[] {
  return Array.isArray(value) ? value.filter(isRecord).map((item) => ({ ...item, id: String(item.id || '') })) : [];
}

function messageItemFromPayload(payload: WsPayload): MessageItem {
  return {
    ...payload,
    id: String(payload.id || ''),
    name: typeof payload.name === 'string' ? payload.name : undefined,
    type: typeof payload.type === 'string' ? payload.type : undefined,
    echo: Boolean(payload.echo),
    date: typeof payload.date === 'string' ? payload.date : undefined,
    sentAt: typeof payload.sentAt === 'string' ? payload.sentAt : undefined,
    message: typeof payload.message === 'string' ? payload.message : undefined,
    imageUrl: typeof payload.imageUrl === 'string' ? payload.imageUrl : null
  };
}

function asInventoryItems(value: unknown): InventoryItem[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function clampLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

function setFeedback(text: string, tone: Tone = 'muted') {
  els.feedback.textContent = text;
  els.feedback.dataset.tone = tone;
  els.feedback.style.color = {
    muted: 'var(--muted)',
    ok: 'var(--green)',
    warn: 'var(--orange)',
    error: 'var(--danger)'
  }[tone] || 'var(--muted)';
}

function setConnection(text: string, online = false) {
  els.connectionText.textContent = text;
  els.connectionText.style.color = online ? 'var(--green)' : 'var(--muted)';
}

async function apiGet(path: string): Promise<unknown> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  return payload;
}

async function apiPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  return payload;
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function wsIsOpen(): boolean {
  return Boolean(state.ws && state.ws.readyState === WebSocket.OPEN);
}

function wsRequest(payload: WsPayload, timeoutMs = 20000): Promise<WsPayload> {
  if (!wsIsOpen()) return Promise.reject(new Error('WebSocket 未连接'));
  const id = payload.requestId || requestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error('请求超时'));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer });
    state.ws?.send(JSON.stringify({ ...payload, requestId: id }));
  });
}

function settlePending(payload: WsPayload): boolean {
  if (!payload.requestId || !state.pending.has(payload.requestId)) return false;
  const pending = state.pending.get(payload.requestId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  state.pending.delete(payload.requestId);
  if (payload.type === 'error') pending.reject(new Error(payload.error || '请求失败'));
  else pending.resolve(payload);
  return true;
}

async function wsOrHttp(wsPayload: WsPayload, httpPath: string, fallback: unknown): Promise<unknown> {
  if (wsIsOpen()) return wsRequest(wsPayload);
  if (!httpPath) return fallback;
  return apiGet(httpPath);
}

function connectWebSocket(wsPath: string) {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}${wsPath || '/ws'}`);
  state.ws = ws;
  ws.addEventListener('open', () => setConnection('已连接', true));
  ws.addEventListener('message', (event) => {
    let payload: WsPayload;
    try {
      const parsed: unknown = JSON.parse(String(event.data));
      payload = isRecord(parsed) ? parsed : {};
    } catch {
      return;
    }
    if (settlePending(payload)) return;
    handleRealtime(payload);
  });
  ws.addEventListener('close', () => {
    setConnection('正在重连', false);
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebSocket 已断开'));
    }
    state.pending.clear();
    state.reconnectTimer = setTimeout(() => connectWebSocket(wsPath), 1500);
    markUploadsFailed('连接断开');
  });
  ws.addEventListener('error', () => setConnection('连接异常', false));
}

function handleRealtime(payload: WsPayload) {
  if (payload.type === 'ready') {
    refreshInitialData();
    return;
  }
  if (payload.type === 'message' || payload.type === 'image') {
    const item = messageItemFromPayload(payload);
    mergeConversation(item);
    if (item.id === state.activeId) appendMessage(item);
    notify(item);
    renderLists();
    return;
  }
  if (payload.type === 'error') setFeedback(payload.error || '请求失败', 'error');
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function formatShortTime(value: unknown): string {
  const date = parseDate(value);
  if (!date) return '';
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function avatar(item: ListEntry) {
  const node = create('span', 'avatar');
  if (item.avatar) {
    const image = document.createElement('img');
    image.src = item.avatar;
    image.alt = '';
    node.append(image);
  } else {
    node.textContent = String(item.name || item.id || '?').slice(0, 1).toUpperCase();
  }
  return node;
}

type ListItemOptions = {
  preview?: string;
  meta?: string;
  topRight?: string;
  online?: boolean;
  avatar?: string;
};

function listItem(item: ListEntry, { preview = '', meta = '', topRight = '', online = false }: ListItemOptions = {}) {
  const button = create('button', `list-item${item.id === state.activeId ? ' is-active' : ''}`);
  button.type = 'button';
  button.dataset.id = item.id;
  button.append(avatar(item));

  const body = create('span', 'item-body');
  const top = create('span', 'item-top');
  const presence = create('span', `presence${online ? ' is-online' : ''}`);
  top.append(presence, create('span', 'item-name', item.name || item.id));
  if (topRight) top.append(create('span', 'item-time', topRight));
  body.append(top);
  if (preview) body.append(create('span', 'item-preview', preview));
  if (meta) body.append(create('span', 'item-meta', meta));
  button.append(body);
  button.addEventListener('click', () => openConversation(item.id, item.name || item.id));
  return button;
}

function renderList<T extends ListEntry>(container: HTMLElement, items: T[], mapItem: (item: T) => HTMLElement) {
  if (!items.length) {
    container.replaceChildren(create('div', 'empty', '暂无数据'));
    return;
  }
  container.replaceChildren(...items.map(mapItem));
}

function renderLists() {
  renderList(els.conversationList, state.conversations, (item) => listItem(item, {
    preview: item.preview,
    meta: item.id,
    topRight: formatShortTime(item.updatedAt)
  }));
  renderList(els.friendList, state.friends, (item) => listItem(item, {
    avatar: item.avatar,
    preview: item.gameName || item.game || item.id,
    meta: item.online ? '在线' : '离线',
    online: item.online
  }));
  renderList(els.groupList, state.groups, (item) => listItem(item, {
    preview: item.clanId || item.clanid || item.id
  }));
}

function setActiveConversation(id: unknown, name = '') {
  state.activeId = String(id || '').trim();
  state.activeName = name || state.activeId;
  localStorage.setItem('steam-chat.target', state.activeId);
  els.targetInput.value = state.activeId;
  els.chatTitle.textContent = state.activeName || '未选择会话';
  els.chatSubtitle.textContent = state.activeId || '选择好友、群组或输入 SteamID64';
  renderLists();
}

async function loadHistory() {
  if (!state.activeId) {
    renderHistory([]);
    return;
  }
  const result = await wsOrHttp(
    { type: 'get_history', id: state.activeId, limit: state.historyLimit },
    `/history?id=${encodeURIComponent(state.activeId)}&limit=${state.historyLimit}`,
    []
  );
  const items = isRecord(result) ? result.items || result.history : result;
  renderHistory(asMessageItems(items));
  setFeedback('历史已更新', 'ok');
}

async function loadConversations() {
  const result = await wsOrHttp(
    { type: 'get_conversations', limit: state.historyLimit },
    `/conversations?limit=${state.historyLimit}`,
    { conversations: [] }
  );
  const items = isRecord(result) ? result.conversations : result;
  state.conversations = asListEntries(items);
  renderLists();
  return state.conversations;
}

async function loadFriends() {
  const result = await wsOrHttp({ type: 'get_friends' }, '/api/friends', { friends: [] });
  const items = isRecord(result) ? result.friends : result;
  state.friends = asListEntries(items);
  renderLists();
}

async function loadGroups() {
  const result = await wsOrHttp({ type: 'get_groups' }, '/api/groups', { groups: [] });
  const items = isRecord(result) ? result.groups : result;
  state.groups = asListEntries(items);
  renderLists();
}

async function loadInventory() {
  const result = await wsOrHttp({ type: 'get_emoticons' }, '/api/emoticons', { emoticons: [], stickers: [] });
  state.emoticons = isRecord(result) ? asInventoryItems(result.emoticons) : [];
  state.stickers = isRecord(result) ? asInventoryItems(result.stickers) : [];
}

async function openConversation(id: unknown, name = '') {
  const target = String(id || '').trim();
  if (!target) {
    setFeedback('请输入 SteamID64', 'warn');
    return;
  }
  setActiveConversation(target, name || target);
  closeSidebar();
  try {
    await loadHistory();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function refreshInitialData() {
  try {
    const [conversations] = await Promise.all([
      loadConversations(),
      loadFriends(),
      loadGroups(),
      loadInventory()
    ]);
    if (state.activeId) await openConversation(state.activeId, state.activeName || state.activeId);
    else if (conversations[0]) await openConversation(conversations[0].id, conversations[0].name);
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

function mergeConversation(item: MessageItem) {
  const preview = item.imageUrl || item.type === 'image' ? '[图片]' : item.message || '[消息]';
  const previous = state.conversations.find((conversation) => conversation.id === item.id);
  const next = {
    id: item.id,
    name: item.echo ? (previous?.name || state.activeName || item.id) : (item.name || item.id),
    updatedAt: item.sentAt || item.date,
    preview,
    lastType: item.type,
    lastEcho: item.echo,
    messageCount: (previous?.messageCount || 0) + 1
  };
  state.conversations = [next, ...state.conversations.filter((conversation) => conversation.id !== item.id)];
}

function releaseImages() {
  for (const xhr of state.imageRequests) xhr.abort();
  state.imageRequests.clear();
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();
}

function renderHistory(items: MessageItem[]) {
  releaseImages();
  els.messages.replaceChildren();
  if (!items.length) {
    els.messages.append(create('div', 'empty', '暂无消息'));
    return;
  }
  let previous: MessageItem | null = null;
  for (const item of items) {
    appendSeparator(previous, item);
    appendMessage(item, false);
    previous = item;
  }
  scrollMessages();
}

function itemDate(item: MessageItem): Date | null {
  return parseDate(item.sentAt || item.date);
}

function appendSeparator(previous: MessageItem | null, current: MessageItem) {
  const now = itemDate(current);
  if (!now) return;
  const prev = previous ? itemDate(previous) : null;
  let label = '';
  if (!prev || prev.toDateString() !== now.toDateString()) {
    label = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  } else if (now.getTime() - prev.getTime() > 10 * 60 * 1000) {
    label = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (label) els.messages.append(create('div', 'separator', label));
}

function appendMessage(item: MessageItem, withSeparator = true) {
  const empty = $('.empty', els.messages);
  if (empty) empty.remove();
  if (withSeparator) {
    const rows = $$<MessageRow>('.msg-row', els.messages);
    const previous = rows.length ? rows[rows.length - 1]._item : null;
    appendSeparator(previous, item);
  }
  rememberEmoticons(item.message);
  const row = create('article', `msg-row${item.echo ? ' is-self' : ''}`) as MessageRow;
  row._item = item;
  const bubble = create('div', 'bubble');
  const meta = create('div', 'meta');
  const date = itemDate(item);
  meta.append(
    create('span', '', item.name || (item.echo ? '我' : item.id || 'Unknown')),
    create('span', '', date ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : item.date || '')
  );
  const content = create('div', 'content');
  const parts: RichPart[] = item.imageUrl ? [{ type: 'image', url: item.imageUrl }] : parseRichParts(item.message || '');
  const meaningful = parts.filter((part) => part.type !== 'text' || part.text.trim());
  if (meaningful.length === 1 && ['image', 'sticker', 'og'].includes(meaningful[0].type)) bubble.classList.add('is-visual');
  for (const part of parts) appendRichPart(content, part);
  bubble.append(meta, content);
  row.append(bubble);
  els.messages.append(row);
  scrollMessages();
}

function scrollMessages() {
  requestAnimationFrame(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function rememberEmoticons(text: unknown) {
  for (const match of String(text || '').matchAll(/:([A-Za-z0-9_+\-.]+):/g)) {
    state.knownEmoticons.add(match[1]);
  }
}

const tokenPattern = /\[sticker\s+type=["']?([^"'\]\s]+)["']?[^\]]*\]\s*\[\/sticker\]|\[img\]([^\[]+)\[\/img\]|\[img\s+src=["']?([^"'\]\s]+)["']?[^\]]*\][\s\S]*?\[\/img\]|<img[^>]+src=["']([^"']+)["'][^>]*>|\[og\b([^\]]*)\]([\s\S]*?)\[\/og\]|\[url=([^\]]+)\]([^\[]+)\[\/url\]|\[url\]([^\[]+)\[\/url\]|\[emoticon\s+name=["']?([^"'\]\s]+)["']?\]\s*\[\/emoticon\]|\[emoticon\]([^\[]+)\[\/emoticon\]|:([A-Za-z0-9_+\-.]+):|(https?:\/\/[^\s<>"']+)/gi;

function parseAttrs(text: unknown): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of String(text || '').matchAll(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function parseRichParts(message: unknown): RichPart[] {
  const text = String(message || '');
  const parts: RichPart[] = [];
  let lastIndex = 0;
  tokenPattern.lastIndex = 0;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > lastIndex) parts.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    if (match[1]) parts.push({ type: 'sticker', stickerType: match[1] });
    else if (match[2] || match[3] || match[4]) parts.push({ type: 'image', url: (match[2] || match[3] || match[4]).trim() });
    else if (match[5] !== undefined) {
      const attrs = parseAttrs(match[5]);
      parts.push({ type: 'og', url: attrs.url || '', image: attrs.img || attrs.image || '', title: attrs.title || match[6] || '', fallback: match[6] || attrs.url || '' });
    } else if (match[7]) parts.push({ type: 'link', href: match[7], label: match[8] });
    else if (match[9]) parts.push({ type: 'link', href: match[9], label: match[9] });
    else if (match[10] || match[11] || match[12]) parts.push({ type: 'emoticon', name: match[10] || match[11] || match[12] });
    else if (match[13]) {
      if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(match[13])) {
        parts.push({ type: 'image', url: match[13] });
      } else {
        parts.push({ type: 'link', href: match[13], label: match[13] });
      }
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', text: text.slice(lastIndex) });
  return parts.length ? parts : [{ type: 'text', text }];
}

function appendRichPart(container: HTMLElement, part: RichPart) {
  if (part.type === 'text') {
    container.append(document.createTextNode(part.text));
  } else if (part.type === 'link') {
    const link = create('a', '', part.label || part.href);
    link.href = part.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    container.append(link);
  } else if (part.type === 'emoticon') {
    const image = document.createElement('img');
    image.className = 'emoticon';
    image.src = `https://community.cloudflare.steamstatic.com/economy/emoticon/${encodeURIComponent(part.name)}`;
    image.alt = `:${part.name}:`;
    image.title = `:${part.name}:`;
    container.append(image);
  } else if (part.type === 'sticker') {
    const image = document.createElement('img');
    image.className = 'sticker';
    image.src = `/proxy/sticker/${encodeURIComponent(part.stickerType)}`;
    image.alt = part.stickerType;
    image.addEventListener('click', () => openLightbox(image.src));
    container.append(image);
  } else if (part.type === 'image') {
    container.append(managedImage(part.url));
  } else if (part.type === 'og') {
    const card = create('a', 'og-card');
    card.href = part.url || '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    if (part.image) card.append(managedImage(part.image));
    const body = create('div');
    body.append(create('strong', '', part.title || part.fallback || part.url || 'OpenGraph'), create('span', '', part.url || part.fallback || ''));
    card.append(body);
    container.append(card);
  }
}

function managedImage(sourceUrl: string) {
  const shell = create('div', 'image-shell', '加载中');
  const xhr = new XMLHttpRequest();
  state.imageRequests.add(xhr);
  xhr.open('GET', `/proxy/image?url=${encodeURIComponent(sourceUrl)}`);
  xhr.responseType = 'blob';
  xhr.onprogress = (event) => {
    if (event.lengthComputable) shell.textContent = `${Math.round((event.loaded / event.total) * 100)}%`;
  };
  xhr.onload = () => {
    state.imageRequests.delete(xhr);
    if (xhr.status < 200 || xhr.status >= 300) {
      shell.textContent = '加载失败';
      return;
    }
    const objectUrl = URL.createObjectURL(xhr.response);
    state.objectUrls.add(objectUrl);
    const image = document.createElement('img');
    image.className = 'message-image';
    image.src = objectUrl;
    image.alt = '图片';
    image.addEventListener('click', () => openLightbox(objectUrl));
    shell.replaceWith(image);
  };
  xhr.onerror = () => {
    state.imageRequests.delete(xhr);
    shell.textContent = '加载失败';
  };
  xhr.onabort = () => state.imageRequests.delete(xhr);
  xhr.send();
  return shell;
}

let lightboxScale = 1;
let lightboxX = 0;
let lightboxY = 0;
let lightboxDragging = false;
let lightboxStartX = 0;
let lightboxStartY = 0;
let lastFocus: HTMLElement | null = null;

function applyLightboxTransform() {
  els.lightboxImage.style.transform = `translate(${lightboxX}px, ${lightboxY}px) scale(${lightboxScale})`;
}

function openLightbox(src: string) {
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  lightboxScale = 1;
  lightboxX = 0;
  lightboxY = 0;
  els.lightboxImage.src = src;
  els.lightbox.hidden = false;
  applyLightboxTransform();
  els.lightboxClose.focus();
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightboxImage.src = '';
  lastFocus?.focus?.();
}

function zoomLightbox(delta: number) {
  lightboxScale = Math.min(6, Math.max(0.2, lightboxScale + delta));
  applyLightboxTransform();
}

function autoSizeInput() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(els.messageInput.scrollHeight, window.innerWidth <= 900 ? 108 : 160)}px`;
}

function activeIdOrWarn() {
  if (state.activeId) return state.activeId;
  setFeedback('请选择会话', 'warn');
  return '';
}

async function sendText() {
  const id = activeIdOrWarn();
  const msg = els.messageInput.value.trim();
  if (!id || !msg) {
    if (!msg) setFeedback('请输入消息', 'warn');
    return;
  }
  els.sendButton.disabled = true;
  try {
    if (wsIsOpen()) await wsRequest({ type: 'send_message', id, msg });
    else await apiPost('/message', { id, msg });
    els.messageInput.value = '';
    autoSizeInput();
    setFeedback('已发送', 'ok');
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  } finally {
    els.sendButton.disabled = false;
  }
}

function addUpload(label: string): HTMLElement {
  const row = create('div', 'upload-item');
  row.append(create('strong', '', label), create('span', '', '等待'));
  els.uploadTray.append(row);
  return row;
}

function setUpload(row: HTMLElement, text: string) {
  const status = row.querySelector('span');
  if (status) status.textContent = text;
}

function markUploadsFailed(reason: string) {
  for (const row of $$('.upload-item', els.uploadTray)) {
    if (!/成功|失败/.test(row.textContent)) setUpload(row, `失败：${reason}`);
  }
}

function fileToDataUrl(file: File, progress: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('读取图片失败'));
    };
    reader.readAsDataURL(file);
  });
}

async function sendImagePayload(label: string, payload: Record<string, string>) {
  const id = activeIdOrWarn();
  if (!id) return;
  const row = addUpload(label);
  setUpload(row, '发送中');
  try {
    if (wsIsOpen()) await wsRequest({ type: 'send_image', id, ...payload });
    else await apiPost('/image', { id, ...payload });
    setUpload(row, '成功');
    setFeedback('图片已发送', 'ok');
    setTimeout(() => row.remove(), 1800);
  } catch (error) {
    setUpload(row, `失败：${errorMessage(error)}`);
    setFeedback(errorMessage(error), 'error');
  }
}

async function sendFiles(files: FileList | File[] | null) {
  if (!files) return;
  for (const file of [...files].filter((item) => item.type.startsWith('image/'))) {
    const row = addUpload(file.name);
    try {
      const dataUrl = await fileToDataUrl(file, (progress) => setUpload(row, `${progress}%`));
      row.remove();
      await sendImagePayload(file.name, { img: dataUrl });
    } catch (error) {
      setUpload(row, `失败：${errorMessage(error)}`);
    }
  }
}

function sortInventory(items: InventoryItem[]): InventoryItem[] {
  return [...items].sort((left, right) => {
    const usage = Number(right.use_count || 0) - Number(left.use_count || 0);
    return usage || String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
  });
}

function inventoryNames(): string[] {
  return [...new Set([...state.emoticons.map((item) => item.name).filter((name): name is string => Boolean(name)), ...state.knownEmoticons])].sort();
}

function renderPicker() {
  $$<HTMLButtonElement>('.picker-head button').forEach((button) => button.classList.toggle('is-active', button.dataset.picker === state.pickerTab));
  const query = els.pickerSearch.value.trim().toLowerCase();
  const source = state.pickerTab === 'emoticons' ? state.emoticons : state.stickers;
  const items = sortInventory(source).filter((item) => String(item.name || '').toLowerCase().includes(query)).slice(0, 240);
  if (!items.length) {
    els.pickerGrid.replaceChildren(create('div', 'empty', '暂无内容'));
    return;
  }
  els.pickerGrid.replaceChildren(...items.map((item) => {
    const name = item.name || '';
    const button = create('button');
    button.type = 'button';
    const image = document.createElement('img');
    image.src = state.pickerTab === 'emoticons'
      ? `https://community.cloudflare.steamstatic.com/economy/emoticon/${encodeURIComponent(name)}`
      : `/proxy/sticker/${encodeURIComponent(name)}`;
    image.alt = '';
    button.append(image, create('span', '', name));
    button.addEventListener('click', () => {
      if (state.pickerTab === 'emoticons') insertAtCursor(`:${name}:`);
      else {
        els.messageInput.value = `[sticker type="${name}" limit="0"][/sticker]`;
        sendText();
      }
      els.picker.hidden = true;
    });
    return button;
  }));
}

function insertAtCursor(value: string) {
  const start = els.messageInput.selectionStart;
  const end = els.messageInput.selectionEnd;
  els.messageInput.value = `${els.messageInput.value.slice(0, start)}${value}${els.messageInput.value.slice(end)}`;
  const next = start + value.length;
  els.messageInput.setSelectionRange(next, next);
  autoSizeInput();
  els.messageInput.focus();
}

function autocompletePrefix(): string {
  const before = els.messageInput.value.slice(0, els.messageInput.selectionStart);
  const match = before.match(/:([A-Za-z0-9_+\-.]{1,32})$/);
  return match ? match[1] : '';
}

function renderAutocomplete() {
  const prefix = autocompletePrefix();
  if (!prefix) {
    els.autocomplete.hidden = true;
    return;
  }
  const matches = inventoryNames().filter((name) => name.toLowerCase().includes(prefix.toLowerCase())).slice(0, 8);
  if (!matches.length) {
    els.autocomplete.hidden = true;
    return;
  }
  state.autocompleteIndex = Math.min(state.autocompleteIndex, matches.length - 1);
  els.autocomplete.replaceChildren(...matches.map((name, index) => {
    const button = create('button', index === state.autocompleteIndex ? 'is-active' : '');
    button.type = 'button';
    const image = document.createElement('img');
    image.className = 'emoticon';
    image.src = `https://community.cloudflare.steamstatic.com/economy/emoticon/${encodeURIComponent(name)}`;
    image.alt = '';
    button.append(image, create('span', '', `:${name}:`));
    button.addEventListener('mousedown', (event: MouseEvent) => {
      event.preventDefault();
      applyAutocomplete(name);
    });
    return button;
  }));
  els.autocomplete.hidden = false;
}

function applyAutocomplete(name: string) {
  const start = els.messageInput.selectionStart;
  const before = els.messageInput.value.slice(0, start).replace(/:([A-Za-z0-9_+\-.]{1,32})$/, `:${name}:`);
  els.messageInput.value = `${before}${els.messageInput.value.slice(start)}`;
  els.messageInput.setSelectionRange(before.length, before.length);
  els.autocomplete.hidden = true;
  autoSizeInput();
}

function updateTitle() {
  document.title = state.unread ? `(${state.unread}) ${baseTitle}` : baseTitle;
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function notify(item: MessageItem) {
  if (!item || item.echo) return;
  const inactive = item.id !== state.activeId || document.hidden || !document.hasFocus();
  if (!inactive) return;
  state.unread += 1;
  updateTitle();
  if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(item.name || 'Steam Chat', {
      body: item.message || (item.imageUrl ? '[图片]' : '[消息]'),
      tag: item.id
    });
    notification.onclick = () => {
      window.focus();
      openConversation(item.id, item.name || item.id);
      notification.close();
    };
  }
}

function clearUnread() {
  state.unread = 0;
  updateTitle();
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}

function setupEvents() {
  els.openSidebar.addEventListener('click', openSidebar);
  els.closeSidebar.addEventListener('click', closeSidebar);
  els.backdrop.addEventListener('click', closeSidebar);
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) closeSidebar();
  });
  $$<HTMLButtonElement>('.tabs button').forEach((tab, index, tabs) => {
    tab.addEventListener('click', () => {
      tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
      $$<HTMLElement>('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab));
    });
    tab.addEventListener('keydown', (event) => {
      const keyMap = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 };
      const key = event.key as keyof typeof keyMap;
      if (key in keyMap) {
        event.preventDefault();
        tabs[keyMap[key]].click();
        tabs[keyMap[key]].focus();
      }
    });
  });
  els.openForm.addEventListener('submit', (event) => {
    event.preventDefault();
    openConversation(els.targetInput.value.trim());
  });
  els.refreshAll.addEventListener('click', () => refreshInitialData());
  els.historyLimit.addEventListener('change', () => {
    state.historyLimit = clampLimit(els.historyLimit.value);
    els.historyLimit.value = String(state.historyLimit);
    localStorage.setItem('steam-chat.history-limit', String(state.historyLimit));
    loadHistory().catch((error: unknown) => setFeedback(errorMessage(error), 'error'));
    loadConversations().catch((error: unknown) => setFeedback(errorMessage(error), 'error'));
  });
  els.sendButton.addEventListener('click', sendText);
  els.messageInput.addEventListener('input', () => {
    autoSizeInput();
    renderAutocomplete();
  });
  els.messageInput.addEventListener('keydown', (event) => {
    if (!els.autocomplete.hidden && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key)) {
      const buttons = $$<HTMLButtonElement>('.autocomplete button');
      if (event.key === 'Escape') {
        els.autocomplete.hidden = true;
        return;
      }
      event.preventDefault();
      if (event.key === 'ArrowDown') state.autocompleteIndex = (state.autocompleteIndex + 1) % buttons.length;
      if (event.key === 'ArrowUp') state.autocompleteIndex = (state.autocompleteIndex - 1 + buttons.length) % buttons.length;
      if (event.key === 'Tab' || event.key === 'Enter') {
        buttons[state.autocompleteIndex]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return;
      }
      renderAutocomplete();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendText();
    }
  });
  els.fileButton.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    sendFiles(els.fileInput.files);
    els.fileInput.value = '';
  });
  els.imageUrlForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = els.imageUrlInput.value.trim();
    if (!url) return;
    els.imageUrlInput.value = '';
    sendImagePayload(url, { url });
  });
  els.pickerToggle.addEventListener('click', () => {
    els.picker.hidden = !els.picker.hidden;
    renderPicker();
  });
  $$<HTMLButtonElement>('.picker-head button').forEach((button) => {
    button.addEventListener('click', () => {
      state.pickerTab = button.dataset.picker === 'stickers' ? 'stickers' : 'emoticons';
      renderPicker();
    });
  });
  els.pickerSearch.addEventListener('input', renderPicker);
  document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (files.length) {
      event.preventDefault();
      sendFiles(files);
    }
  });
  document.addEventListener('dragenter', (event) => {
    if ([...(event.dataTransfer?.items || [])].some((item) => item.type.startsWith('image/'))) {
      els.dropOverlay.classList.add('is-visible');
    }
  });
  document.addEventListener('dragover', (event) => {
    if (els.dropOverlay.classList.contains('is-visible')) event.preventDefault();
  });
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) els.dropOverlay.classList.remove('is-visible');
  });
  document.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith('image/'));
    els.dropOverlay.classList.remove('is-visible');
    if (files.length) {
      event.preventDefault();
      sendFiles(files);
    }
  });
  window.addEventListener('pointerdown', requestNotificationPermission, { once: true });
  window.addEventListener('keydown', requestNotificationPermission, { once: true });
  window.addEventListener('focus', clearUnread);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clearUnread();
  });
  els.lightboxClose.addEventListener('click', closeLightbox);
  els.lightbox.addEventListener('click', (event) => {
    if (event.target === els.lightbox) closeLightbox();
  });
  els.zoomIn.addEventListener('click', () => zoomLightbox(0.25));
  els.zoomOut.addEventListener('click', () => zoomLightbox(-0.25));
  els.zoomReset.addEventListener('click', () => {
    lightboxScale = 1;
    lightboxX = 0;
    lightboxY = 0;
    applyLightboxTransform();
  });
  els.lightbox.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomLightbox(event.deltaY > 0 ? -0.12 : 0.12);
  }, { passive: false });
  els.lightboxImage.addEventListener('dblclick', () => {
    lightboxScale = lightboxScale === 1 ? 2 : 1;
    applyLightboxTransform();
  });
  els.lightboxImage.addEventListener('pointerdown', (event) => {
    lightboxDragging = true;
    lightboxStartX = event.clientX - lightboxX;
    lightboxStartY = event.clientY - lightboxY;
    els.lightboxImage.setPointerCapture(event.pointerId);
  });
  els.lightboxImage.addEventListener('pointermove', (event) => {
    if (!lightboxDragging) return;
    lightboxX = event.clientX - lightboxStartX;
    lightboxY = event.clientY - lightboxStartY;
    applyLightboxTransform();
  });
  els.lightboxImage.addEventListener('pointerup', () => {
    lightboxDragging = false;
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.lightbox.hidden) closeLightbox();
  });
}

async function bootstrap() {
  els.historyLimit.value = String(state.historyLimit);
  setActiveConversation(state.activeId, state.activeId);
  renderHistory([]);
  renderLists();
  setupEvents();
  let wsPath = '/ws';
  try {
    const config = await apiGet('/api/config');
    if (isRecord(config) && typeof config.wsPath === 'string') wsPath = config.wsPath;
  } catch {
    // Keep the default WebSocket path when the config endpoint is temporarily unavailable.
  }
  connectWebSocket(wsPath);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  setFeedback(errorMessage(error) || '启动失败', 'error');
});
