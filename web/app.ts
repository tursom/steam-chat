type Role = 'admin' | 'user';
type View = 'steam' | 'chat' | 'users' | 'steamAccounts' | 'audit' | 'account';
type Tone = 'muted' | 'ok' | 'warn' | 'error';
type ChatListTab = 'recent' | 'friends' | 'groups';
type ChatPanel = 'list' | 'thread';
type ChatIconName = 'arrow-left' | 'image' | 'link' | 'paperclip' | 'plus' | 'search' | 'send' | 'smile' | 'x'
  | 'panel-right' | 'messages-square' | 'gamepad-2' | 'users' | 'settings-2' | 'shield' | 'scroll-text' | 'log-out' | 'external-link' | 'copy';
type Permission =
  | 'user.manage'
  | 'session.manage'
  | 'audit.view'
  | 'steam.manage'
  | 'steam.account.manage'
  | 'chat.use'
  | 'self.password.change';

type User = {
  id: number;
  username: string;
  displayName: string;
  note: string;
  role: Role;
  disabled: boolean;
  forcePasswordChange: boolean;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  lastSeenAt: string | null;
  passwordChangedAt: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
  locked: boolean;
  steamAccountCount: number;
};

type UserSession = {
  id: string;
  userId: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
};

type SteamAccount = {
  id: number;
  steamId: string;
  label: string;
  accountNameHint: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastActiveAt: string | null;
  refreshTokenUpdatedAt: string | null;
  authorizedUserCount: number;
  active: boolean;
};

type AuditLog = {
  id: number;
  actorUserId: number | null;
  actorUsername: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

type SteamStatus = {
  status: string;
  requiresGuard: boolean;
  guardType: 'email' | 'device' | null;
  domain: string | null;
  lastCodeWrong: boolean;
  error: string | null;
  steamId: string | null;
  activeAccount?: Pick<SteamAccount, 'id' | 'steamId' | 'label'> | null;
  accessAllowed?: boolean;
};

type MeResponse = {
  needsSetup: boolean;
  user: User | null;
  permissions: Permission[];
  steam: SteamStatus;
};

type ListEntry = Record<string, unknown> & {
  id: string;
  name?: string;
  avatar?: string;
  preview?: string;
  updatedAt?: string;
  gameName?: string;
  online?: boolean;
  clanId?: string;
  clanid?: string;
};

type MessageItem = ListEntry & {
  eventId?: string;
  type?: string;
  echo?: boolean;
  date?: string;
  sentAt?: string;
  message?: string;
  ordinal?: string | number | null;
};

type OpenGraphPreview = {
  url: string;
  imageUrl: string;
  title: string;
  description: string;
};

const supportedBbcodeTags = ['og', 'url', 'img', 'emoticon', 'sticker'] as const;
type SupportedBbcodeTag = (typeof supportedBbcodeTags)[number];
const supportedBbcodeTagSet = new Set<string>(supportedBbcodeTags);
const supportedBbcodePattern = new RegExp(`\\[(${supportedBbcodeTags.join('|')})(?=[\\s=\\]])`, 'gi');

type SteamImagePreview = {
  sourceUrl: string;
  displayUrl: string;
  sourceSet: string;
  width: number;
  height: number;
};

type InventoryItem = Record<string, unknown> & {
  name?: string;
  use_count?: number | string;
};

type WsPayload = Record<string, unknown> & {
  type?: string;
  id?: string;
  name?: string;
  message?: string;
  ordinal?: string | number | null;
  echo?: boolean;
  date?: string;
  sentAt?: string;
  error?: string;
};

type AppState = {
  me: User | null;
  needsSetup: boolean;
  permissions: Permission[];
  steam: SteamStatus;
  view: View;
  users: User[];
  userSessions: Record<number, UserSession[]>;
  userSteamAccounts: Record<number, SteamAccount[]>;
  steamAccounts: SteamAccount[];
  auditLogs: AuditLog[];
  conversations: ListEntry[];
  friends: ListEntry[];
  groups: ListEntry[];
  emoticons: InventoryItem[];
  stickers: InventoryItem[];
  activeId: string;
  activeName: string;
  chatListTab: ChatListTab;
  chatQuery: string;
  chatPanel: ChatPanel;
  friendDetailsOpen: boolean;
  historyLimit: number;
  wsPath: string;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  statusTimer: ReturnType<typeof setInterval> | null;
  userQuery: string;
  userRole: string;
  userStatus: string;
  auditAction: string;
  auditTargetType: string;
  feedback: string;
  feedbackTone: Tone;
};

const defaultSteamStatus: SteamStatus = {
  status: 'logged_out',
  requiresGuard: false,
  guardType: null,
  domain: null,
  lastCodeWrong: false,
  error: null,
  steamId: null,
  activeAccount: null,
  accessAllowed: false
};

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing app root');
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

const state: AppState = {
  me: null,
  needsSetup: false,
  permissions: [],
  steam: defaultSteamStatus,
  view: normalizeView(localStorage.getItem('steam-chat.view')),
  users: [],
  userSessions: {},
  userSteamAccounts: {},
  steamAccounts: [],
  auditLogs: [],
  conversations: [],
  friends: [],
  groups: [],
  emoticons: [],
  stickers: [],
  activeId: localStorage.getItem('steam-chat.target') || '',
  activeName: '',
  chatListTab: 'recent',
  chatQuery: '',
  chatPanel: 'list',
  friendDetailsOpen: false,
  historyLimit: clampLimit(localStorage.getItem('steam-chat.history-limit') || 100),
  wsPath: '/ws',
  ws: null,
  reconnectTimer: null,
  statusTimer: null,
  userQuery: '',
  userRole: '',
  userStatus: '',
  auditAction: '',
  auditTargetType: '',
  feedback: '就绪',
  feedbackTone: 'muted'
};

let chatEpoch = 0;
let historyRequest = 0;
let listRequest = 0;
let healthRequest = 0;
let historyItems: MessageItem[] = [];
let historyBefore = '';
let historyAfter = '';
let historyAt = '';
let historyBusy = false;
let historyDetached = false;
let historyLive: MessageItem[] = [];
const pendingImageReaders = new Set<FileReader>();
let conversationsBefore = '';
let conversationsBusy = false;
const recentConversationUpdates = new Map<string, ListEntry>();
let storageHealth: unknown = null;

function chatContext() {
  return `${chatEpoch}|${state.me?.id || ''}|${state.steam.activeAccount?.id || ''}|${state.steam.steamId || ''}|${steamAccessAllowed()}`;
}

function resetHistory() {
  for (const reader of pendingImageReaders) reader.abort();
  pendingImageReaders.clear();
  historyRequest += 1;
  historyItems = [];
  historyLive = [];
  historyBefore = historyAfter = historyAt = '';
  historyBusy = historyDetached = false;
  renderHistory([]);
  updateHistoryControls();
}

function invalidateChat() {
  chatEpoch += 1;
  listRequest += 1;
  healthRequest += 1;
  conversationsBefore = '';
  conversationsBusy = false;
  recentConversationUpdates.clear();
  storageHealth = null;
  resetHistory();
  updateStorageHealth();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function chatIcon(name: ChatIconName) {
  const node = create('span', `ui-icon icon-${name}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function chatIconButton(name: ChatIconName, label: string, className = 'icon-btn') {
  const button = create('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(chatIcon(name));
  return button;
}

function clear(node: HTMLElement) {
  node.replaceChildren();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

function clampLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

function normalizeView(value: unknown): View {
  const view = String(value || '');
  return view === 'steam' || view === 'chat' || view === 'users' || view === 'steamAccounts' || view === 'audit' || view === 'account' ? view : 'chat';
}

function asListEntries(value: unknown): ListEntry[] {
  return Array.isArray(value) ? value.filter(isRecord).map((item) => ({ ...item, id: String(item.id || '') })) : [];
}

function asMessages(value: unknown): MessageItem[] {
  return Array.isArray(value) ? value.filter(isRecord).map((item) => ({ ...item, id: String(item.id || '') })) : [];
}

function asInventory(value: unknown): InventoryItem[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function setFeedback(text: string, tone: Tone = 'muted') {
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = null;
  state.feedback = text;
  state.feedbackTone = tone;
  const node = document.querySelector<HTMLElement>('#feedback');
  if (node) {
    const content = node.querySelector<HTMLElement>('#feedbackText');
    if (content) content.textContent = text;
    else node.textContent = text;
    node.dataset.tone = tone;
    node.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    if (state.view === 'chat') presentChatFeedback(node, tone);
  }
}

function presentChatFeedback(node: HTMLElement, tone: Tone) {
  node.hidden = tone === 'muted';
  if (tone === 'muted' || tone === 'error') return;
  feedbackTimer = setTimeout(() => dismissChatFeedback(node), tone === 'warn' ? 4000 : 2400);
}

function dismissChatFeedback(node = document.querySelector<HTMLElement>('#feedback')) {
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = null;
  state.feedback = '就绪';
  state.feedbackTone = 'muted';
  if (node) node.hidden = true;
}

function steamLabel(status = state.steam.status): string {
  const labels: Record<string, string> = {
    logged_out: '未连接',
    logging_in: '登录中',
    waiting_guard: '等待验证',
    online: '在线',
    error: '异常',
    reconnecting: '重连中'
  };
  return labels[status] || status;
}

function steamOnline() {
  return state.steam.status === 'online';
}

function steamAccessAllowed() {
  return state.steam.accessAllowed !== false;
}

function hasPermission(permission: Permission) {
  return state.permissions.includes(permission);
}

function displayName(user: User) {
  return user.displayName || user.username;
}

function dateTime(value: unknown): string {
  if (!value) return '无';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function compactJson(value: unknown): string {
  if (!isRecord(value) || !Object.keys(value).length) return '{}';
  return JSON.stringify(value);
}

function steamStatusSignature(status = state.steam) {
  return [
    status.status,
    status.requiresGuard,
    status.guardType || '',
    status.domain || '',
    status.lastCodeWrong,
    status.error || '',
    status.steamId || '',
    status.activeAccount?.id || '',
    status.accessAllowed
  ].join('|');
}

function updateSteamStatus(status: SteamStatus) {
  const previousSignature = steamStatusSignature();
  const previousAccess = steamAccessAllowed();
  const previousAccount = `${state.steam.activeAccount?.id || ''}|${state.steam.steamId || ''}`;
  state.steam = { ...defaultSteamStatus, ...status };
  const accountChanged = previousAccount !== `${state.steam.activeAccount?.id || ''}|${state.steam.steamId || ''}`;
  if (accountChanged || !steamAccessAllowed()) {
    invalidateChat();
    stopWebSocket();
    state.activeName = '';
    state.friendDetailsOpen = false;
    state.friends = [];
    state.groups = [];
    state.conversations = [];
  }
  const badge = document.querySelector<HTMLElement>('#steamBadge');
  if (badge) {
    badge.textContent = steamLabel();
    badge.dataset.status = state.steam.status;
  }
  const hint = document.querySelector<HTMLElement>('#steamHint');
  if (hint) hint.textContent = state.steam.error || (state.steam.steamId ? `SteamID ${state.steam.steamId}` : '后台服务已启动');
  const subtitle = document.querySelector<HTMLElement>('#pageSubtitle');
  if (subtitle) subtitle.textContent = pageSubtitle();
  const accountStatus = document.querySelector<HTMLElement>('#chatAccountStatus');
  if (accountStatus) {
    accountStatus.textContent = chatAccountLabel();
    accountStatus.dataset.status = state.steam.status;
  }
  if (steamStatusSignature() !== previousSignature) {
    const head = document.querySelector<HTMLElement>('#threadHead');
    if (head) renderThreadHeader(head);
    syncFriendDetails();
  }
  updateChatAvailability();
  if ((accountChanged || previousAccess !== steamAccessAllowed()) && state.me && state.view === 'chat') {
    updateChatLists();
    void loadHistory();
    ensureWebSocket();
  }
}

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin'
  });
  const payload: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/me') && !path.startsWith('/api/auth/login')) {
      stopWebSocket();
      state.me = null;
      state.permissions = [];
      state.needsSetup = false;
      renderLogin();
    }
    throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  return payload;
}

function jsonBody(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body)
  };
}

function formValue(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === 'string' ? value : '';
}

function authPage(title: string, subtitle: string, form: HTMLElement) {
  invalidateChat();
  stopStatusPolling();
  stopWebSocket();
  clear(root);
  const page = create('main', 'auth-page');
  const panel = create('section', 'auth-panel');
  panel.append(create('h1', '', title), create('p', 'muted', subtitle), form);
  page.append(panel);
  root.append(page);
}

function renderSetup() {
  const form = create('form', 'stack-form') as HTMLFormElement;
  form.innerHTML = `
    <label>管理员账号<input name="username" autocomplete="username" minlength="3" maxlength="64" required></label>
    <label>后台密码<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
    <button type="submit">初始化后台</button>
    <p class="form-error" id="setupError"></p>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = form.querySelector<HTMLElement>('#setupError');
    try {
      await api('/api/auth/setup', jsonBody({
        username: formValue(form, 'username'),
        password: formValue(form, 'password')
      }));
      await bootstrap();
    } catch (error) {
      if (errorNode) errorNode.textContent = errorMessage(error);
    }
  });
  authPage('初始化 Steam Chat 后台', '创建第一个管理员后，再进入工作台连接 Steam。', form);
}

function renderLogin() {
  const form = create('form', 'stack-form') as HTMLFormElement;
  form.innerHTML = `
    <label>账号<input name="username" autocomplete="username" required></label>
    <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">登录后台</button>
    <p class="form-error" id="loginError"></p>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = form.querySelector<HTMLElement>('#loginError');
    try {
      await api('/api/auth/login', jsonBody({
        username: formValue(form, 'username'),
        password: formValue(form, 'password')
      }));
      await bootstrap();
    } catch (error) {
      if (errorNode) errorNode.textContent = errorMessage(error);
    }
  });
  authPage('Steam Chat 后台登录', '登录后可使用已连接的 Steam 会话聊天，管理员可管理用户和 Steam 登录。', form);
}

function navButton(view: View, label: string) {
  const icons: Record<View, ChatIconName> = { steam: 'gamepad-2', chat: 'messages-square', users: 'users', steamAccounts: 'shield', audit: 'scroll-text', account: 'settings-2' };
  const button = chatIconButton(icons[view], label, state.view === view ? 'is-active' : '');
  button.append(create('span', 'nav-label', label));
  button.addEventListener('click', () => {
    state.view = view;
    localStorage.setItem('steam-chat.view', view);
    renderShell();
  });
  return button;
}

function panel(title: string, className = '') {
  const section = create('section', `panel${className ? ` ${className}` : ''}`);
  section.append(create('h2', 'panel-title', title));
  return section;
}

function renderShell() {
  if (!state.me) {
    renderLogin();
    return;
  }
  if (state.me.role !== 'admin' && ['users', 'steamAccounts', 'audit'].includes(state.view)) state.view = 'steam';
  clear(root);
  const shell = create('div', `admin-shell${state.view === 'chat' ? ' is-chat' : ''}`);
  const sidebar = create('aside', 'admin-sidebar');
  const brand = create('div', 'brand');
  brand.title = `Steam Chat · ${state.me.username}`;
  brand.append(chatIcon('gamepad-2'), create('strong', '', 'Steam Chat'), create('span', '', state.me.username));
  const nav = create('nav');
  nav.append(navButton('steam', 'Steam 连接'), navButton('chat', '聊天'));
  if (hasPermission('user.manage')) nav.append(navButton('users', '用户管理'));
  if (hasPermission('steam.account.manage')) nav.append(navButton('steamAccounts', 'Steam 账户'));
  if (hasPermission('audit.view')) nav.append(navButton('audit', '审计日志'));
  nav.append(navButton('account', '账号'));
  sidebar.append(brand, nav);
  if (state.view === 'chat') {
    const railLogout = chatIconButton('log-out', '退出后台', 'rail-logout');
    railLogout.addEventListener('click', () => logoutApp());
    sidebar.append(railLogout);
  }

  const main = create('main', 'workspace');
  const top = create('header', 'topbar');
  const title = create('div');
  const heading = create('h1', '', pageTitle());
  const subtitle = create('p', 'muted', pageSubtitle());
  subtitle.id = 'pageSubtitle';
  title.append(heading, subtitle);
  const status = create('div', 'top-actions');
  const badge = create('span', 'steam-badge', steamLabel());
  badge.id = 'steamBadge';
  badge.dataset.status = state.steam.status;
  const hint = create('span', 'top-hint', state.steam.error || (state.steam.steamId ? `SteamID ${state.steam.steamId}` : '后台服务已启动'));
  hint.id = 'steamHint';
  const logout = create('button', 'ghost-btn', '退出后台');
  logout.type = 'button';
  logout.addEventListener('click', () => logoutApp());
  status.append(badge, hint, logout);
  top.append(title, status);
  const content = create('section', `content${state.view === 'chat' ? ' chat-content' : ''}`);
  content.append(renderCurrentView());
  const feedback = create('div', `feedback${state.view === 'chat' ? ' chat-toast' : ''}`);
  feedback.id = 'feedback';
  feedback.dataset.tone = state.feedbackTone;
  feedback.setAttribute('aria-live', state.feedbackTone === 'error' ? 'assertive' : 'polite');
  const feedbackText = create('span', '', state.feedback);
  feedbackText.id = 'feedbackText';
  feedback.append(feedbackText);
  if (state.view === 'chat') {
    const dismiss = chatIconButton('x', '关闭提示', 'toast-close');
    dismiss.addEventListener('click', () => dismissChatFeedback(feedback));
    feedback.append(dismiss);
    feedback.hidden = state.feedbackTone === 'muted';
  }
  main.append(top, content, feedback);
  shell.append(sidebar, main);
  root.append(shell);
  if (state.view === 'chat') void refreshChatData();
  if (state.view === 'users' && hasPermission('user.manage')) {
    void loadSteamAccounts();
    void loadUsers();
  }
  if (state.view === 'steamAccounts') void loadSteamAccounts();
  if (state.view === 'audit') void loadAuditLogs();
  ensureWebSocket();
  startStatusPolling();
}

function pageTitle() {
  if (state.view === 'chat') return '聊天';
  if (state.view === 'users') return '用户管理';
  if (state.view === 'steamAccounts') return 'Steam 账户';
  if (state.view === 'audit') return '审计日志';
  if (state.view === 'account') return '账号';
  return 'Steam 连接';
}

function pageSubtitle() {
  if (state.view === 'chat') {
    if (!steamOnline()) return 'Steam 未在线，聊天操作已禁用';
    return steamAccessAllowed() ? '好友、群组、历史和实时消息' : '当前后台用户未被授权访问活动 Steam 账户';
  }
  if (state.view === 'users') return '后台用户、会话、角色、资料和 Steam 授权';
  if (state.view === 'steamAccounts') return 'Steam 账户资料、连接状态和授权计数';
  if (state.view === 'audit') return '关键管理动作和敏感字段脱敏记录';
  if (state.view === 'account') return '修改当前后台账号密码';
  return state.me?.role === 'admin' ? '管理员在这里完成 Steam 登录和 Guard 验证' : '等待管理员连接 Steam';
}

function renderCurrentView() {
  if (state.view === 'chat') return renderChatView();
  if (state.view === 'users' && hasPermission('user.manage')) return renderUsersView();
  if (state.view === 'steamAccounts' && hasPermission('steam.account.manage')) return renderSteamAccountsView();
  if (state.view === 'audit' && hasPermission('audit.view')) return renderAuditView();
  if (state.view === 'account') return renderAccountView();
  return renderSteamView();
}

function renderSteamView() {
  const view = create('div', 'steam-view');
  const summary = create('section', 'status-panel');
  const statusText = create('strong', '', steamLabel());
  const activeLabel = state.steam.activeAccount
    ? `${state.steam.activeAccount.label || state.steam.activeAccount.steamId} · ${state.steam.activeAccount.steamId}`
    : state.steam.steamId ? `当前 SteamID：${state.steam.steamId}` : '当前没有可用的 Steam 会话';
  const detail = create('p', 'muted', state.steam.error || activeLabel);
  summary.append(statusText, detail);
  view.append(summary);

  if (state.me?.role !== 'admin') {
    const access = panel('访问状态', 'status-note-panel');
    const accessDenied = steamOnline() && !steamAccessAllowed();
    const accessText = !steamOnline()
      ? 'Steam 未在线，等待管理员连接 Steam。'
      : accessDenied ? '当前账号未被授权访问活动 Steam 账户。' : '普通用户只能在 Steam 在线且被授权后使用聊天。';
    access.append(create('p', accessDenied ? 'warn-text' : 'muted', accessText));
    view.append(access);
    return view;
  }

  if (state.steam.requiresGuard) {
    const guardPanel = panel('Steam Guard', 'form-panel');
    const guardForm = create('form', 'inline-form') as HTMLFormElement;
    const guardText = state.steam.guardType === 'email'
      ? `邮箱验证码${state.steam.domain ? `：${state.steam.domain}` : ''}`
      : '手机 2FA 验证码';
    const codeLabel = create('label', '', guardText);
    const codeInput = create('input') as HTMLInputElement;
    codeInput.name = 'code';
    codeInput.autocomplete = 'one-time-code';
    codeInput.required = true;
    const submit = create('button', '', '提交验证');
    submit.type = 'submit';
    codeLabel.append(codeInput);
    guardForm.append(codeLabel, submit);
    if (state.steam.lastCodeWrong) guardForm.prepend(create('p', 'warn-text', '上一次验证码被拒绝，请等待新的验证码后再提交。'));
    guardForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await api('/api/steam/guard', jsonBody({ code: formValue(guardForm, 'code') }));
        updateSteamStatus(result as SteamStatus);
        renderShell();
      } catch (error) {
        setFeedback(errorMessage(error), 'error');
      }
    });
    guardPanel.append(guardForm);
    view.append(guardPanel);
  } else if (!['logging_in', 'online', 'reconnecting'].includes(state.steam.status)) {
    const loginPanel = panel('登录 Steam', 'form-panel');
    const loginForm = create('form', 'stack-form narrow-form') as HTMLFormElement;
    loginForm.innerHTML = `
      <label>显示名称<input name="label" autocomplete="off" placeholder="例如：客服一号"></label>
      <label>Steam 账号<input name="accountName" autocomplete="username" required></label>
      <label>Steam 密码<input name="password" type="password" autocomplete="current-password" required></label>
      <label>Logon ID<input name="logonID" inputmode="numeric" placeholder="留空使用后台固定值"></label>
      <button type="submit">登录 Steam</button>
    `;
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const rawLogonID = formValue(loginForm, 'logonID').trim();
      try {
        const result = await api('/api/steam/login', jsonBody({
          accountName: formValue(loginForm, 'accountName'),
          password: formValue(loginForm, 'password'),
          label: formValue(loginForm, 'label'),
          ...(rawLogonID ? { logonID: Number(rawLogonID) } : {})
        }));
        updateSteamStatus(result as SteamStatus);
        renderShell();
      } catch (error) {
        setFeedback(errorMessage(error), 'error');
      }
    });
    loginPanel.append(loginForm);
    view.append(loginPanel);
  }

  const actions = create('div', 'page-actions');
  const logout = create('button', 'danger-btn', '退出 Steam 并删除 token');
  logout.type = 'button';
  logout.disabled = state.steam.status === 'logged_out';
  logout.addEventListener('click', async () => {
    try {
      const result = await api('/api/steam/logout', { method: 'POST' });
      updateSteamStatus(result as SteamStatus);
      renderShell();
    } catch (error) {
      setFeedback(errorMessage(error), 'error');
    }
  });
  actions.append(logout);
  view.append(actions);
  return view;
}

function renderUsersView() {
  const view = create('div', 'users-view');
  const filterPanel = panel('筛选', 'toolbar-panel');
  const filters = create('form', 'inline-form user-filters') as HTMLFormElement;
  filters.innerHTML = `
    <label>搜索<input name="query" value="${state.userQuery}" placeholder="账号、昵称、备注"></label>
    <label>角色<select name="role"><option value="">全部</option><option value="admin">管理员</option><option value="user">普通用户</option></select></label>
    <label>状态<select name="status"><option value="">全部</option><option value="enabled">启用</option><option value="disabled">禁用</option><option value="locked">锁定</option></select></label>
    <button type="submit">筛选</button>
  `;
  (filters.elements.namedItem('role') as HTMLSelectElement).value = state.userRole;
  (filters.elements.namedItem('status') as HTMLSelectElement).value = state.userStatus;
  filters.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.userQuery = formValue(filters, 'query');
    state.userRole = formValue(filters, 'role');
    state.userStatus = formValue(filters, 'status');
    await loadUsers();
  });
  filterPanel.append(filters);
  const createPanel = panel('新增用户', 'toolbar-panel');
  const form = create('form', 'inline-form user-create') as HTMLFormElement;
  form.innerHTML = `
    <label>账号<input name="username" minlength="3" maxlength="64" required></label>
    <label>昵称<input name="displayName" maxlength="80"></label>
    <label>密码<input name="password" type="password" minlength="8" required></label>
    <label>角色<select name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></label>
    <label>备注<input name="note" maxlength="500"></label>
    <button type="submit">新增用户</button>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/users', jsonBody({
        username: formValue(form, 'username'),
        displayName: formValue(form, 'displayName'),
        password: formValue(form, 'password'),
        role: formValue(form, 'role') || 'user',
        note: formValue(form, 'note')
      }));
      form.reset();
      await loadUsers();
    } catch (error) {
      setFeedback(errorMessage(error), 'error');
    }
  });
  createPanel.append(form);
  const listPanel = panel('用户列表', 'list-panel');
  const table = create('div', 'user-table');
  table.id = 'userTable';
  listPanel.append(table);
  view.append(filterPanel, createPanel, listPanel);
  renderUserTable(table);
  return view;
}

function renderUserTable(container: HTMLElement) {
  clear(container);
  if (!state.users.length) {
    container.append(create('div', 'empty', '暂无用户'));
    return;
  }
  for (const user of state.users) {
    const row = create('article', 'user-row');
    const info = create('div');
    const status = user.locked ? '锁定' : user.disabled ? '已禁用' : '启用';
    info.append(
      create('strong', '', `${displayName(user)} (${user.username})`),
      create('span', 'muted', `${user.role === 'admin' ? '管理员' : '普通用户'} · ${status} · 授权 ${user.steamAccountCount || 0} 个 Steam 账户`),
      create('span', 'muted', `最近登录 ${dateTime(user.lastLoginAt)} · IP ${user.lastLoginIp || '无'} · 活跃 ${dateTime(user.lastSeenAt)}`),
      create('span', 'muted', user.note ? `备注：${user.note}` : '无备注')
    );
    const actions = create('div', 'row-actions');
    const profile = create('button', 'ghost-btn', '编辑资料');
    profile.type = 'button';
    profile.addEventListener('click', () => editUserProfile(user));
    const role = create('button', 'ghost-btn', user.role === 'admin' ? '降为用户' : '设为管理员');
    role.type = 'button';
    role.disabled = user.id === state.me?.id;
    role.addEventListener('click', () => patchUser(user.id, { role: user.role === 'admin' ? 'user' : 'admin' }));
    const disabled = create('button', 'ghost-btn', user.disabled ? '启用' : '禁用');
    disabled.type = 'button';
    disabled.disabled = user.id === state.me?.id;
    disabled.addEventListener('click', () => patchUser(user.id, { disabled: !user.disabled }));
    const password = create('button', 'ghost-btn', '重置密码');
    password.type = 'button';
    password.addEventListener('click', () => resetUserPassword(user.id));
    const forcePassword = create('button', 'ghost-btn', user.forcePasswordChange ? '取消强制改密' : '要求改密');
    forcePassword.type = 'button';
    forcePassword.addEventListener('click', () => patchUser(user.id, { forcePasswordChange: !user.forcePasswordChange }));
    const sessions = create('button', 'ghost-btn', '会话');
    sessions.type = 'button';
    sessions.addEventListener('click', () => loadUserSessions(user.id));
    const grants = create('button', 'ghost-btn', '授权');
    grants.type = 'button';
    grants.addEventListener('click', () => loadUserSteamAccounts(user.id));
    const remove = create('button', 'danger-btn', '删除');
    remove.type = 'button';
    remove.disabled = user.id === state.me?.id;
    remove.addEventListener('click', () => deleteUser(user.id));
    actions.append(profile, role, disabled, password, forcePassword, sessions, grants, remove);
    row.append(info, actions);
    const detail = renderUserDetail(user);
    if (detail) row.append(detail);
    container.append(row);
  }
}

function renderUserDetail(user: User): HTMLElement | null {
  const sessions = state.userSessions[user.id];
  const grants = state.userSteamAccounts[user.id];
  if (!sessions && !grants) return null;
  const detail = create('div', 'user-detail');
  if (sessions) {
    const block = create('section', 'detail-block');
    const revokeAll = create('button', 'danger-btn', '踢下线全部会话');
    revokeAll.type = 'button';
    revokeAll.addEventListener('click', () => revokeUserSessions(user.id));
    block.append(create('h3', '', '会话'), revokeAll);
    if (!sessions.length) block.append(create('div', 'empty small', '暂无活动会话'));
    for (const session of sessions) {
      const row = create('div', 'session-row');
      row.append(create('span', '', `${dateTime(session.lastSeenAt)} · ${session.ip || '未知 IP'}`), create('span', 'muted', session.userAgent || '无 User-Agent'));
      const revoke = create('button', 'danger-btn', '踢下线');
      revoke.type = 'button';
      revoke.addEventListener('click', () => revokeSession(user.id, session.id));
      row.append(revoke);
      block.append(row);
    }
    detail.append(block);
  }
  if (grants) {
    const form = create('form', 'grant-grid') as HTMLFormElement;
    form.append(create('h3', '', 'Steam 授权'));
    if (!state.steamAccounts.length) form.append(create('div', 'empty small', '暂无 Steam 账户'));
    for (const account of state.steamAccounts) {
      const label = create('label', 'check-row');
      const input = create('input') as HTMLInputElement;
      input.type = 'checkbox';
      input.name = 'steamAccountIds';
      input.value = String(account.id);
      input.checked = grants.some((item) => item.id === account.id);
      label.append(input, create('span', '', `${account.label || account.steamId} · ${account.enabled ? '启用' : '禁用'}`));
      form.append(label);
    }
    const save = create('button', 'primary-btn', '保存授权');
    save.type = 'submit';
    form.append(save);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const ids = [...form.querySelectorAll<HTMLInputElement>('input[name="steamAccountIds"]:checked')].map((input) => Number(input.value));
      await saveUserSteamAccounts(user.id, ids);
    });
    detail.append(form);
  }
  return detail;
}

async function loadUsers() {
  if (!hasPermission('user.manage')) return;
  try {
    const params = new URLSearchParams();
    if (state.userQuery) params.set('query', state.userQuery);
    if (state.userRole) params.set('role', state.userRole);
    if (state.userStatus) params.set('status', state.userStatus);
    const payload = await api(`/api/users${params.size ? `?${params}` : ''}`);
    state.users = isRecord(payload) && Array.isArray(payload.users) ? payload.users as User[] : [];
    const table = document.querySelector<HTMLElement>('#userTable');
    if (table) renderUserTable(table);
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function editUserProfile(user: User) {
  const display = window.prompt('昵称', user.displayName);
  if (display === null) return;
  const note = window.prompt('备注', user.note);
  if (note === null) return;
  await patchUser(user.id, { displayName: display, note });
}

async function patchUser(id: number, patch: Record<string, unknown>) {
  try {
    await api(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    await loadUsers();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function resetUserPassword(id: number) {
  const password = window.prompt('输入新密码，至少 8 位');
  if (!password) return;
  const forcePasswordChange = window.confirm('要求该用户下次登录后修改密码？');
  try {
    await api(`/api/users/${id}/password`, jsonBody({ password, forcePasswordChange }));
    setFeedback('密码已重置', 'ok');
    await loadUsers();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function loadUserSessions(id: number) {
  try {
    const payload = await api(`/api/users/${id}/sessions`);
    state.userSessions[id] = isRecord(payload) && Array.isArray(payload.sessions) ? payload.sessions as UserSession[] : [];
    renderShell();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function revokeSession(userId: number, sessionId: string) {
  try {
    await api(`/api/users/${userId}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    await loadUserSessions(userId);
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function revokeUserSessions(userId: number) {
  try {
    await api(`/api/users/${userId}/sessions`, { method: 'DELETE' });
    await loadUserSessions(userId);
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function loadUserSteamAccounts(id: number) {
  try {
    await loadSteamAccounts();
    const payload = await api(`/api/users/${id}/steam-accounts`);
    state.userSteamAccounts[id] = isRecord(payload) && Array.isArray(payload.steamAccounts) ? payload.steamAccounts as SteamAccount[] : [];
    renderShell();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function saveUserSteamAccounts(id: number, steamAccountIds: number[]) {
  try {
    const payload = await api(`/api/users/${id}/steam-accounts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamAccountIds })
    });
    state.userSteamAccounts[id] = isRecord(payload) && Array.isArray(payload.steamAccounts) ? payload.steamAccounts as SteamAccount[] : [];
    setFeedback('授权已保存', 'ok');
    await loadUsers();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function deleteUser(id: number) {
  if (!window.confirm('确认删除该后台用户？')) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    await loadUsers();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

function renderSteamAccountsView() {
  const view = create('div', 'steam-accounts-view');
  if (hasPermission('steam.manage')) {
    const loginPanel = panel('登录新账户', 'toolbar-panel');
    const loginForm = create('form', 'inline-form steam-account-login') as HTMLFormElement;
    loginForm.innerHTML = `
      <label>显示名称<input name="label" maxlength="80"></label>
      <label>Steam 账号<input name="accountName" autocomplete="username" required></label>
      <label>Steam 密码<input name="password" type="password" autocomplete="current-password" required></label>
      <label>Logon ID<input name="logonID" inputmode="numeric"></label>
      <button type="submit">登录新账户</button>
    `;
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const rawLogonID = formValue(loginForm, 'logonID').trim();
      try {
        const status = await api('/api/steam/accounts/login', jsonBody({
          label: formValue(loginForm, 'label'),
          accountName: formValue(loginForm, 'accountName'),
          password: formValue(loginForm, 'password'),
          ...(rawLogonID ? { logonID: Number(rawLogonID) } : {})
        }));
        updateSteamStatus(status as SteamStatus);
        loginForm.reset();
        await loadSteamAccounts();
      } catch (error) {
        setFeedback(errorMessage(error), 'error');
      }
    });
    loginPanel.append(loginForm);
    view.append(loginPanel);
  }
  const listPanel = panel('账户列表', 'list-panel');
  const list = create('div', 'account-table');
  list.id = 'steamAccountTable';
  listPanel.append(list);
  view.append(listPanel);
  renderSteamAccountTable(list);
  return view;
}

function renderSteamAccountTable(container: HTMLElement) {
  clear(container);
  if (!state.steamAccounts.length) {
    container.append(create('div', 'empty', '暂无 Steam 账户'));
    return;
  }
  for (const account of state.steamAccounts) {
    const row = create('article', 'account-row');
    const info = create('div');
    info.append(
      create('strong', '', account.label || account.steamId),
      create('span', 'muted', `${account.steamId} · ${account.active ? '当前活动' : '未连接'} · ${account.enabled ? '启用' : '禁用'} · 授权 ${account.authorizedUserCount || 0} 人`),
      create('span', 'muted', `最近登录 ${dateTime(account.lastLoginAt)} · 活跃 ${dateTime(account.lastActiveAt)} · token ${dateTime(account.refreshTokenUpdatedAt)}`),
      create('span', 'muted', account.accountNameHint ? `账号提示：${account.accountNameHint}` : '无账号提示')
    );
    const actions = create('div', 'row-actions');
    const connect = create('button', 'ghost-btn', '连接');
    connect.type = 'button';
    connect.disabled = account.active || !account.enabled;
    connect.addEventListener('click', () => connectSteamAccount(account.id));
    const edit = create('button', 'ghost-btn', '编辑');
    edit.type = 'button';
    edit.addEventListener('click', () => editSteamAccount(account));
    const toggle = create('button', 'ghost-btn', account.enabled ? '禁用' : '启用');
    toggle.type = 'button';
    toggle.addEventListener('click', () => patchSteamAccount(account.id, { enabled: !account.enabled }));
    const logout = create('button', 'ghost-btn', '退出');
    logout.type = 'button';
    logout.disabled = !account.active;
    logout.addEventListener('click', () => logoutSteamAccount(account.id));
    const remove = create('button', 'danger-btn', '删除');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteSteamAccount(account.id));
    actions.append(connect, edit, toggle, logout, remove);
    row.append(info, actions);
    container.append(row);
  }
}

async function loadSteamAccounts() {
  try {
    const payload = await api('/api/steam/accounts');
    state.steamAccounts = isRecord(payload) && Array.isArray(payload.steamAccounts) ? payload.steamAccounts as SteamAccount[] : [];
    const table = document.querySelector<HTMLElement>('#steamAccountTable');
    if (table) renderSteamAccountTable(table);
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function connectSteamAccount(id: number) {
  try {
    const status = await api(`/api/steam/accounts/${id}/connect`, { method: 'POST' });
    updateSteamStatus(status as SteamStatus);
    await loadSteamAccounts();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function editSteamAccount(account: SteamAccount) {
  const label = window.prompt('显示名称', account.label);
  if (label === null) return;
  const accountNameHint = window.prompt('账号提示', account.accountNameHint);
  if (accountNameHint === null) return;
  await patchSteamAccount(account.id, { label, accountNameHint });
}

async function patchSteamAccount(id: number, patch: Record<string, unknown>) {
  try {
    await api(`/api/steam/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    await loadSteamAccounts();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function logoutSteamAccount(id: number) {
  try {
    const status = await api(`/api/steam/accounts/${id}/logout`, { method: 'POST' });
    updateSteamStatus(status as SteamStatus);
    await loadSteamAccounts();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function deleteSteamAccount(id: number) {
  if (!window.confirm('确认删除该 Steam 账户资料和授权关系？')) return;
  try {
    await api(`/api/steam/accounts/${id}`, { method: 'DELETE' });
    await loadSteamAccounts();
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

function renderAuditView() {
  const view = create('div', 'audit-view');
  const filterPanel = panel('筛选', 'toolbar-panel');
  const filters = create('form', 'inline-form audit-filters') as HTMLFormElement;
  filters.innerHTML = `
    <label>动作<input name="action" value="${state.auditAction}" placeholder="例如 user.update"></label>
    <label>目标类型<input name="targetType" value="${state.auditTargetType}" placeholder="user / steam_account"></label>
    <button type="submit">筛选</button>
  `;
  filters.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.auditAction = formValue(filters, 'action');
    state.auditTargetType = formValue(filters, 'targetType');
    await loadAuditLogs();
  });
  filterPanel.append(filters);
  const listPanel = panel('日志列表', 'list-panel');
  const table = create('div', 'audit-table');
  table.id = 'auditTable';
  listPanel.append(table);
  view.append(filterPanel, listPanel);
  renderAuditTable(table);
  return view;
}

function renderAuditTable(container: HTMLElement) {
  clear(container);
  if (!state.auditLogs.length) {
    container.append(create('div', 'empty', '暂无审计日志'));
    return;
  }
  for (const item of state.auditLogs) {
    const row = create('article', 'audit-row');
    row.append(
      create('strong', '', `${dateTime(item.createdAt)} · ${item.action}`),
      create('span', 'muted', `操作者 ${item.actorUsername || item.actorUserId || '系统'} · ${item.targetType}:${item.targetId} · ${item.ip || '无 IP'}`),
      create('code', '', compactJson(item.detail))
    );
    container.append(row);
  }
}

async function loadAuditLogs() {
  try {
    const params = new URLSearchParams();
    if (state.auditAction) params.set('action', state.auditAction);
    if (state.auditTargetType) params.set('targetType', state.auditTargetType);
    const payload = await api(`/api/audit-logs${params.size ? `?${params}` : ''}`);
    state.auditLogs = isRecord(payload) && Array.isArray(payload.auditLogs) ? payload.auditLogs as AuditLog[] : [];
    const table = document.querySelector<HTMLElement>('#auditTable');
    if (table) renderAuditTable(table);
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

function renderAccountView() {
  const view = create('div', 'account-view');
  const accountPanel = panel('修改密码', 'form-panel');
  const form = create('form', 'stack-form narrow-form') as HTMLFormElement;
  form.innerHTML = `
    <label>当前密码<input name="oldPassword" type="password" autocomplete="current-password" required></label>
    <label>新密码<input name="newPassword" type="password" autocomplete="new-password" minlength="8" required></label>
    <button type="submit">修改密码</button>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/auth/password', jsonBody({
        oldPassword: formValue(form, 'oldPassword'),
        newPassword: formValue(form, 'newPassword')
      }));
      form.reset();
      setFeedback('密码已修改', 'ok');
    } catch (error) {
      setFeedback(errorMessage(error), 'error');
    }
  });
  accountPanel.append(form);
  view.append(accountPanel);
  return view;
}

function renderChatView() {
  const view = create('div', 'chat-layout');
  view.id = 'chatLayout';
  view.dataset.mobilePanel = state.chatPanel;
  const lists = create('aside', 'chat-lists');
  lists.setAttribute('aria-label', '会话列表');

  const listHead = create('header', 'chat-list-head');
  const account = create('button', 'chat-account');
  account.type = 'button';
  account.title = 'Steam 连接';
  const accountCopy = create('span', 'chat-account-copy');
  const accountName = create('strong', '', 'Steam Chat');
  accountName.id = 'chatAccountName';
  const accountStatus = create('span');
  accountStatus.id = 'chatAccountStatus';
  accountStatus.textContent = chatAccountLabel();
  accountStatus.dataset.status = state.steam.status;
  accountCopy.append(accountName, accountStatus);
  account.append(chatIcon('gamepad-2'), accountCopy);
  account.addEventListener('click', () => {
    state.view = 'steam';
    localStorage.setItem('steam-chat.view', 'steam');
    renderShell();
  });
  const titleRow = create('div', 'chat-list-title');
  titleRow.append(create('h2', '', '消息'));
  const newConversation = create('button', 'new-chat-btn');
  newConversation.type = 'button';
  newConversation.append(chatIcon('plus'), create('span', '', '新建'));
  titleRow.append(newConversation);

  const search = create('label', 'chat-search');
  search.append(chatIcon('search'));
  const searchInput = create('input') as HTMLInputElement;
  searchInput.type = 'search';
  searchInput.placeholder = '搜索会话';
  searchInput.value = state.chatQuery;
  searchInput.setAttribute('aria-label', '搜索当前分类');
  searchInput.addEventListener('input', () => {
    state.chatQuery = searchInput.value;
    updateChatLists();
  });
  search.append(searchInput);

  const tabList = create('div', 'chat-tabs');
  tabList.setAttribute('role', 'tablist');
  const tabLabels: Array<[ChatListTab, string]> = [['recent', '最近'], ['friends', '好友'], ['groups', '群组']];
  for (const [tab, label] of tabLabels) {
    const button = create('button', state.chatListTab === tab ? 'is-active' : '', label);
    button.type = 'button';
    button.dataset.chatTab = tab;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'chatListSections');
    button.setAttribute('aria-selected', String(state.chatListTab === tab));
    button.addEventListener('click', () => {
      state.chatListTab = tab;
      updateChatTabs();
      updateChatLists();
    });
    tabList.append(button);
  }
  listHead.append(account, titleRow, search, tabList);

  const listBody = create('div', 'conversation-list');
  listBody.id = 'chatListSections';
  listBody.setAttribute('role', 'tabpanel');
  renderChatListSections(listBody);

  const dialog = create('dialog', 'new-chat-dialog') as HTMLDialogElement;
  const targetInput = create('input') as HTMLInputElement;
  targetInput.name = 'target';
  targetInput.inputMode = 'numeric';
  targetInput.autocomplete = 'off';
  targetInput.placeholder = 'SteamID64';
  targetInput.pattern = '[0-9]+';
  targetInput.required = true;
  const dialogHead = create('div', 'dialog-head');
  dialogHead.append(create('h2', '', '新建会话'));
  const closeDialog = chatIconButton('x', '关闭', 'dialog-close');
  closeDialog.addEventListener('click', () => dialog.close());
  dialogHead.append(closeDialog);
  const openForm = create('form', 'new-chat-form') as HTMLFormElement;
  const targetLabel = create('label', '', 'SteamID64');
  targetLabel.append(targetInput);
  const openButton = create('button', 'primary-btn', '打开会话');
  openButton.type = 'submit';
  openForm.append(targetLabel, openButton);
  openForm.addEventListener('submit', (event) => {
    event.preventDefault();
    dialog.close();
    openConversation(formValue(openForm, 'target'));
  });
  dialog.append(dialogHead, openForm);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  newConversation.addEventListener('click', () => {
    targetInput.value = '';
    dialog.showModal();
    targetInput.focus();
  });
  lists.append(listHead, listBody, dialog);

  const thread = create('section', 'thread');
  const head = create('header', 'thread-head');
  head.id = 'threadHead';
  renderThreadHeader(head);
  const messages = create('div', 'messages');
  messages.id = 'messages';
  messages.setAttribute('aria-live', 'polite');
  const composer = renderComposer();
  thread.append(head, renderHistoryTools(), messages, composer);
  const detailsBackdrop = create('button', 'friend-details-backdrop');
  detailsBackdrop.id = 'friendDetailsBackdrop';
  detailsBackdrop.type = 'button';
  detailsBackdrop.hidden = true;
  detailsBackdrop.setAttribute('aria-label', '关闭会话资料');
  detailsBackdrop.addEventListener('click', () => setFriendDetailsOpen(false));
  const details = create('aside', 'friend-details');
  details.id = 'friendDetails';
  details.setAttribute('aria-label', '会话资料');
  details.hidden = true;
  view.append(lists, thread, detailsBackdrop, details);
  renderFriendDetails(details);
  view.dataset.detailsOpen = String(state.friendDetailsOpen && Boolean(state.activeId));
  details.hidden = !state.friendDetailsOpen || !state.activeId;
  detailsBackdrop.hidden = details.hidden;
  setTimeout(() => {
    if (state.activeId) void loadHistory();
    else renderHistory([]);
    updateChatAvailability();
    updateHistoryControls();
    updateStorageHealth();
    void loadStorageHealth();
  }, 0);
  return view;
}

function renderChatListSections(container: HTMLElement) {
  clear(container);
  const items = filterChatEntries(chatEntriesForActiveTab(), state.chatQuery);
  if (!items.length) {
    container.append(create('div', 'conversation-empty', state.chatQuery.trim() ? '没有匹配的会话' : '暂无会话'));
  }
  for (const item of items) container.append(renderListItem(item));
  if (state.chatListTab === 'recent' && conversationsBefore) {
    const more = create('button', 'ghost-btn conversations-more', conversationsBusy ? '加载中…' : '加载更多会话');
    more.type = 'button';
    more.disabled = conversationsBusy;
    more.addEventListener('click', () => void loadConversations(true));
    container.append(more);
  }
}

function filterChatEntries(items: ListEntry[], query: string): ListEntry[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return items;
  return items.filter((item) => [item.name, item.id, item.preview]
    .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(normalized)));
}

function chatEntriesForActiveTab() {
  if (state.chatListTab === 'friends') return state.friends;
  if (state.chatListTab === 'groups') return state.groups;
  return state.conversations;
}

function updateChatTabs() {
  document.querySelectorAll<HTMLButtonElement>('[data-chat-tab]').forEach((button) => {
    const active = button.dataset.chatTab === state.chatListTab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function updateChatLists() {
  const list = document.querySelector<HTMLElement>('#chatListSections');
  if (list) renderChatListSections(list);
}

function renderAvatar(item: ListEntry | null, name: string, className = 'avatar') {
  const avatar = create('span', className, String(name || '?').slice(0, 1).toUpperCase());
  if (item?.avatar) {
    const image = document.createElement('img');
    image.src = item.avatar;
    image.alt = '';
    avatar.replaceChildren(image);
  }
  if (item?.online) avatar.append(create('span', 'online-dot'));
  return avatar;
}

function activeChatEntry(): ListEntry | null {
  const recent = state.conversations.find((item) => item.id === state.activeId);
  const persona = state.friends.find((item) => item.id === state.activeId)
    || state.groups.find((item) => item.id === state.activeId);
  return recent || persona ? { ...recent, ...persona, id: state.activeId } : null;
}

function chatAccountLabel() {
  const account = state.steam.activeAccount;
  return `${account?.label || account?.steamId || 'Steam'} · ${steamLabel()}`;
}

function friendStatusLabel(item: ListEntry | null) {
  if (!steamOnline()) return `Steam ${steamLabel()}`;
  if (!steamAccessAllowed()) return '无账户访问权限';
  if (item?.gameName) return `正在玩 ${item.gameName}`;
  const personaLabels: Record<number, string> = { 0: '离线', 1: '在线', 2: '忙碌', 3: '离开', 4: '打盹', 5: '想交易', 6: '想玩游戏' };
  if (typeof item?.personaState === 'number' && personaLabels[item.personaState]) return personaLabels[item.personaState];
  if (typeof item?.online !== 'boolean') return '状态未知';
  return item.online ? '在线' : '离线';
}

function setFriendDetailsOpen(open: boolean, restoreFocus = true) {
  state.friendDetailsOpen = open && Boolean(state.activeId) && steamAccessAllowed();
  syncFriendDetails();
  if (state.friendDetailsOpen) document.querySelector<HTMLButtonElement>('#friendDetailsClose')?.focus();
  else if (restoreFocus) document.querySelector<HTMLButtonElement>('#friendDetailsToggle')?.focus();
}

function syncFriendDetails() {
  const open = state.friendDetailsOpen && Boolean(state.activeId) && steamAccessAllowed();
  const focusedClose = document.activeElement?.id === 'friendDetailsClose';
  const layout = document.querySelector<HTMLElement>('#chatLayout');
  if (layout) layout.dataset.detailsOpen = String(open);
  const details = document.querySelector<HTMLElement>('#friendDetails');
  if (details) {
    details.hidden = !open;
    renderFriendDetails(details);
    if (open && focusedClose) details.querySelector<HTMLButtonElement>('#friendDetailsClose')?.focus();
  }
  const backdrop = document.querySelector<HTMLElement>('#friendDetailsBackdrop');
  if (backdrop) backdrop.hidden = !open;
  const toggle = document.querySelector<HTMLButtonElement>('#friendDetailsToggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
}

function renderFriendDetails(container: HTMLElement) {
  clear(container);
  const head = create('header', 'friend-details-head');
  head.append(create('h2', '', '会话资料'));
  const close = chatIconButton('x', '关闭会话资料', 'icon-btn');
  close.id = 'friendDetailsClose';
  close.addEventListener('click', () => setFriendDetailsOpen(false));
  head.append(close);
  container.append(head);
  if (!state.activeId || !steamAccessAllowed()) return;
  const item = activeChatEntry();
  const name = item?.name || state.activeName || state.activeId;
  const isGroup = state.groups.some((entry) => entry.id === state.activeId);
  const profile = create('div', 'friend-profile');
  profile.append(renderAvatar(item, name, 'friend-avatar'), create('h3', '', name), create('p', 'muted', friendStatusLabel(item)));
  const facts = create('dl', 'friend-facts');
  const fact = (label: string, value: string) => facts.append(create('dt', '', label), create('dd', '', value));
  fact('SteamID', state.activeId);
  fact('关系', isGroup ? '群组' : state.friends.some((entry) => entry.id === state.activeId) ? 'Steam 好友' : '会话联系人');
  if (item?.gameName && steamOnline()) fact('正在游戏', item.gameName);
  if (state.steam.activeAccount) fact('当前账户', state.steam.activeAccount.label || state.steam.activeAccount.steamId);
  container.append(profile, facts);
  if (/^\d{17}$/.test(state.activeId)) {
    const profileLink = externalLink('friend-profile-link', `https://steamcommunity.com/${isGroup ? 'gid' : 'profiles'}/${state.activeId}`, 'Steam 主页');
    profileLink.append(chatIcon('external-link'));
    container.append(profileLink);
  }
}

function renderThreadHeader(container: HTMLElement) {
  clear(container);
  const back = chatIconButton('arrow-left', '返回会话列表', 'thread-back');
  back.addEventListener('click', showChatList);
  const item = activeChatEntry();
  const name = item?.name || state.activeName || state.activeId || '未选择会话';
  const identity = create('div', 'thread-identity');
  identity.append(create('strong', '', name), create('span', 'muted', state.activeId ? friendStatusLabel(item) : 'Steam Chat'));
  const actions = create('div', 'thread-actions');
  const toggle = chatIconButton('panel-right', '会话资料', 'icon-btn details-toggle');
  toggle.id = 'friendDetailsToggle';
  toggle.disabled = !state.activeId || !steamAccessAllowed();
  toggle.setAttribute('aria-controls', 'friendDetails');
  toggle.setAttribute('aria-expanded', String(state.friendDetailsOpen));
  toggle.addEventListener('click', () => setFriendDetailsOpen(!state.friendDetailsOpen));
  actions.append(toggle);
  container.append(back, renderAvatar(item, name, 'thread-avatar'), identity, actions);
}

function formatConversationTime(value: unknown) {
  if (!value) return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function renderListItem(item: ListEntry) {
  const button = create('button', `list-item${item.id === state.activeId ? ' is-active' : ''}`);
  button.type = 'button';
  button.setAttribute('aria-current', item.id === state.activeId ? 'true' : 'false');
  const name = item.name || item.id;
  const body = create('span', 'item-body');
  const title = create('span', 'item-title');
  title.append(create('strong', '', name), create('time', '', formatConversationTime(item.updatedAt)));
  body.append(title, create('span', 'item-preview', item.preview || item.gameName || item.clanId || item.clanid || item.id));
  const persona = state.friends.find((friend) => friend.id === item.id);
  button.append(renderAvatar(persona || item, name), body);
  button.addEventListener('click', () => openConversation(item.id, item.name || item.id));
  return button;
}

function renderComposer() {
  const shell = create('footer', 'composer');
  const disabledNote = create('div', 'offline-note', 'Steam 未在线，聊天发送和素材操作不可用。');
  disabledNote.id = 'offlineNote';
  const picker = create('div', 'picker');
  picker.id = 'picker';
  picker.hidden = true;
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', '表情和贴纸');
  const row = create('div', 'compose-row');
  const pickerButton = chatIconButton('smile', '表情和贴纸', 'composer-tool');
  pickerButton.id = 'pickerToggle';
  const pickerControls = bindFloatingPanel(pickerButton, picker);
  pickerButton.addEventListener('click', () => {
    attachmentControls.close();
    if (picker.hidden) renderPicker(picker);
    pickerControls.toggle();
  });

  const attachment = create('div', 'attachment-shell');
  const attachmentButton = chatIconButton('paperclip', '添加图片', 'composer-tool');
  attachmentButton.id = 'attachmentToggle';
  const attachmentMenu = create('div', 'attachment-menu');
  attachmentMenu.id = 'attachmentMenu';
  attachmentMenu.hidden = true;
  attachmentMenu.setAttribute('role', 'dialog');
  attachmentMenu.setAttribute('aria-label', '添加图片');
  const fileInput = create('input') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.hidden = true;
  const uploadButton = create('button', 'attachment-action');
  uploadButton.type = 'button';
  uploadButton.append(chatIcon('image'), create('span', '', '上传图片'));
  const urlButton = create('button', 'attachment-action');
  urlButton.type = 'button';
  urlButton.append(chatIcon('link'), create('span', '', '图片 URL'));
  const imageForm = create('form', 'image-url-form') as HTMLFormElement;
  imageForm.hidden = true;
  imageForm.innerHTML = '<input name="url" type="url" placeholder="https://..." aria-label="图片 URL" required><button type="submit">发送</button>';
  const attachmentControls = bindFloatingPanel(attachmentButton, attachmentMenu);
  attachmentButton.addEventListener('click', () => {
    pickerControls.close();
    if (attachmentMenu.hidden) imageForm.hidden = true;
    attachmentControls.toggle();
  });
  uploadButton.addEventListener('click', () => {
    attachmentControls.close();
    fileInput.click();
  });
  urlButton.addEventListener('click', () => {
    imageForm.hidden = !imageForm.hidden;
    if (!imageForm.hidden) imageForm.querySelector<HTMLInputElement>('input')?.focus();
  });
  fileInput.addEventListener('change', () => {
    sendFiles(fileInput.files);
    fileInput.value = '';
  });
  imageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = formValue(imageForm, 'url').trim();
    if (!url) return;
    imageForm.reset();
    attachmentControls.close();
    void sendImage({ url });
  });
  attachmentMenu.append(uploadButton, urlButton, imageForm);
  attachment.append(attachmentButton, attachmentMenu, fileInput);

  const input = create('textarea') as HTMLTextAreaElement;
  input.id = 'messageInput';
  input.rows = 1;
  input.placeholder = '发送消息';
  input.setAttribute('aria-label', '消息');
  input.addEventListener('paste', handleImagePaste);
  input.addEventListener('input', () => resizeComposerInput(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendText();
    }
  });
  const send = chatIconButton('send', '发送消息', 'send-btn');
  send.id = 'sendButton';
  send.addEventListener('click', () => sendText());
  const tools = create('div', 'composer-tools');
  tools.append(pickerButton, attachment);
  row.append(input, tools, send);
  shell.append(disabledNote, picker, row);
  shell.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('button, input, textarea').forEach((node) => {
    node.dataset.chatControl = '';
  });
  return shell;
}

function bindFloatingPanel(trigger: HTMLButtonElement, panel: HTMLElement) {
  const close = () => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', handlePointerDown);
    document.removeEventListener('keydown', handleKeyDown);
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (event.target instanceof Node && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
      trigger.focus();
    }
  };
  const toggle = () => {
    if (!panel.hidden) {
      close();
      return;
    }
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
  };
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  return { close, toggle };
}

function resizeComposerInput(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function updateChatAvailability() {
  const unavailable = !steamOnline() || !steamAccessAllowed();
  const disabled = unavailable || !state.activeId;
  document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('[data-chat-control]').forEach((node) => {
    node.disabled = disabled;
  });
  const note = document.querySelector<HTMLElement>('#offlineNote');
  if (note) {
    note.textContent = !steamOnline() ? 'Steam 未在线，聊天发送和素材操作不可用。' : '当前账号未被授权访问活动 Steam 账户。';
    note.hidden = !unavailable;
  }
}

async function refreshChatData() {
  if (!state.me) return;
  if (!steamAccessAllowed()) {
    state.conversations = [];
    state.friends = [];
    state.groups = [];
    state.emoticons = [];
    state.stickers = [];
    updateChatLists();
    updateChatAvailability();
    return;
  }
  const context = chatContext();
  const request = ++listRequest;
  try {
    await loadConversations();
    if (context !== chatContext() || request !== listRequest) return;
    if (steamOnline()) {
      const [friends, groups, inventory] = await Promise.all([
        api('/api/friends'),
        api('/api/groups'),
        api('/api/emoticons')
      ]);
      if (context !== chatContext() || request !== listRequest) return;
      state.friends = asListEntries(friends);
      state.groups = asListEntries(groups);
      state.emoticons = isRecord(inventory) ? asInventory(inventory.emoticons) : [];
      state.stickers = isRecord(inventory) ? asInventory(inventory.stickers) : [];
    } else {
      state.friends = [];
      state.groups = [];
      state.emoticons = [];
      state.stickers = [];
    }
    if (state.view === 'chat') {
      updateChatLists();
      if (!state.activeName) state.activeName = activeChatEntry()?.name || '';
      const head = document.querySelector<HTMLElement>('#threadHead');
      if (head) renderThreadHeader(head);
      syncFriendDetails();
      updateChatAvailability();
    }
  } catch (error) {
    if (context === chatContext() && request === listRequest) setFeedback('会话列表暂时无法加载，请稍后重试。', 'warn');
  }
}

function openConversation(id: unknown, name = '') {
  const target = String(id || '').trim();
  if (!target) {
    setFeedback('请输入 SteamID64', 'warn');
    return;
  }
  const alreadyActive = target === state.activeId;
  state.activeId = target;
  if (!alreadyActive) resetHistory();
  state.activeName = name || target;
  state.chatPanel = 'thread';
  localStorage.setItem('steam-chat.target', state.activeId);
  if (state.view !== 'chat') return;
  const layout = document.querySelector<HTMLElement>('#chatLayout');
  if (!layout) {
    renderShell();
    return;
  }
  syncChatPanel();
  updateChatLists();
  const head = document.querySelector<HTMLElement>('#threadHead');
  if (head) renderThreadHeader(head);
  syncFriendDetails();
  updateChatAvailability();
  if (!alreadyActive) void loadHistory();
}

function showChatList() {
  state.chatPanel = 'list';
  setFriendDetailsOpen(false, false);
  syncChatPanel();
}

function syncChatPanel() {
  const layout = document.querySelector<HTMLElement>('#chatLayout');
  if (layout) layout.dataset.mobilePanel = state.chatPanel;
}

function pageCursor(payload: unknown, key = 'nextCursor'): string {
  return isRecord(payload) && typeof payload[key] === 'string' ? payload[key] as string : '';
}

let conversationRequest = 0;
async function loadConversations(more = false) {
  if (!state.me || !steamAccessAllowed() || (more && (conversationsBusy || !conversationsBefore))) return;
  const context = chatContext();
  const request = ++conversationRequest;
  const params = new URLSearchParams({ limit: String(state.historyLimit) });
  if (more) params.set('before', conversationsBefore);
  conversationsBusy = true;
  updateChatLists();
  try {
    const payload = await api(`/api/conversations?${params}`);
    if (context !== chatContext() || request !== conversationRequest) return;
    const items = asListEntries(isRecord(payload) ? payload.items : payload);
    const merged = new Map((more ? state.conversations : []).map((item) => [item.id, item]));
    for (const item of items) if (!more || !merged.has(item.id)) merged.set(item.id, item);
    for (const [id, local] of recentConversationUpdates) {
      const stored = items.find((entry) => entry.id === id);
      const storedAt = conversationTimestamp(stored?.updatedAt);
      const localAt = conversationTimestamp(local.updatedAt);
      if (stored && (storedAt > localAt || (storedAt === localAt && stored.preview === local.preview && stored.lastEcho === local.lastEcho))) {
        recentConversationUpdates.delete(id);
        merged.set(id, { ...merged.get(id), ...stored });
      } else {
        merged.set(id, { ...merged.get(id), ...local });
      }
    }
    state.conversations = [...merged.values()].sort((left, right) => conversationTimestamp(right.updatedAt) - conversationTimestamp(left.updatedAt));
    conversationsBefore = pageCursor(payload);
  } catch (_) {
    if (context === chatContext() && request === conversationRequest) setFeedback('会话列表暂时无法加载，请稍后重试。', 'warn');
  } finally {
    if (context === chatContext() && request === conversationRequest) {
      conversationsBusy = false;
      updateChatLists();
    }
  }
}

function renderHistoryTools() {
  const tools = create('div', 'history-tools');
  tools.id = 'historyTools';
  const actions = create('form', 'history-actions');
  const older = create('button', 'ghost-btn', '更早消息');
  older.id = 'historyOlder';
  older.type = 'button';
  older.addEventListener('click', () => void loadHistory('older'));
  const date = create('input');
  date.type = 'datetime-local';
  date.id = 'historyDate';
  date.setAttribute('aria-label', '消息日期和时间');
  date.value = historyAt;
  const jump = chatIconButton('search', '查询日期');
  jump.id = 'historyJump';
  jump.type = 'submit';
  actions.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!date.value || !Number.isFinite(new Date(date.value).getTime())) {
      setFeedback('请选择有效的日期和时间。', 'warn');
      return;
    }
    void loadHistory('date', date.value);
  });
  const newer = create('button', 'ghost-btn', '较新消息');
  newer.id = 'historyNewer';
  newer.type = 'button';
  newer.addEventListener('click', () => void loadHistory('newer'));
  const latest = create('button', 'ghost-btn', '返回最新');
  latest.id = 'historyLatest';
  latest.type = 'button';
  latest.addEventListener('click', () => void loadHistory());
  actions.append(older, date, jump, newer, latest);
  const health = create('div', 'storage-health');
  health.id = 'storageHealth';
  health.setAttribute('role', 'status');
  health.setAttribute('aria-live', 'polite');
  tools.append(actions, health);
  return tools;
}

function updateHistoryControls() {
  for (const [id, disabled, hidden] of [
    ['historyOlder', historyBusy || !historyBefore, false],
    ['historyNewer', historyBusy || !historyAfter, !historyDetached],
    ['historyJump', false, false],
    ['historyLatest', false, !historyDetached]
  ] as Array<[string, boolean, boolean]>) {
    const button = document.querySelector<HTMLButtonElement>(`#${id}`);
    if (button) {
      button.disabled = disabled || !state.activeId || !steamAccessAllowed();
      button.hidden = hidden;
    }
  }
  const older = document.querySelector<HTMLElement>('#historyOlder');
  if (older) older.textContent = historyBusy ? '加载中…' : '更早消息';
  document.querySelector('#historyTools')?.setAttribute('aria-busy', String(historyBusy));
}

function storageHealthText(payload: unknown): string {
  if (!isRecord(payload)) return '消息存储状态暂不可用';
  return [['jsonl', '消息归档'], ['rocksdb', '历史索引']].map(([key, label]) => {
    const health = payload[key];
    if (!isRecord(health)) return `${label}：状态未知`;
    const labels: Record<string, string> = { healthy: '正常', failed: '暂时异常', lagging: '正在同步', closed: '已关闭' };
    const notes = [labels[String(health.state)] || '状态未知'];
    if (health.writable === false) notes.push('暂不可写入');
    if (health.durable === false) notes.push('尚未持久保存');
    if (typeof health.queued === 'number' && health.queued > 0) notes.push(`${health.queued} 条待处理`);
    if (typeof health.missed === 'number' && health.missed > 0) notes.push(`${health.missed} 条未写入`);
    return `${label}：${notes.join('，')}`;
  }).join(' · ');
}

function updateStorageHealth() {
  const node = document.querySelector<HTMLElement>('#storageHealth');
  const text = storageHealthText(storageHealth);
  if (node && node.textContent !== text) node.textContent = text;
}

async function loadStorageHealth() {
  if (!state.me || !steamAccessAllowed()) return;
  const context = chatContext();
  const request = ++healthRequest;
  try {
    const payload = await api('/api/history/status');
    if (context !== chatContext() || request !== healthRequest) return;
    storageHealth = payload;
  } catch (_) {
    if (context !== chatContext() || request !== healthRequest) return;
    storageHealth = null;
  }
  updateStorageHealth();
}

function uniqueMessages(items: MessageItem[]): MessageItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.eventId) return true;
    if (seen.has(item.eventId)) return false;
    seen.add(item.eventId);
    return true;
  });
}

async function loadHistory(mode: 'latest' | 'older' | 'newer' | 'date' = 'latest', date = '') {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages || !state.activeId || !steamAccessAllowed()) return;
  if ((mode === 'older' || mode === 'newer') && (historyBusy || !(mode === 'older' ? historyBefore : historyAfter))) return;
  const target = state.activeId;
  const context = chatContext();
  const request = ++historyRequest;
  const current = () => request === historyRequest && target === state.activeId && context === chatContext() && messages === document.querySelector('#messages');
  historyBusy = true;
  updateHistoryControls();
  try {
    const params = new URLSearchParams({ id: target, limit: String(state.historyLimit) });
    if (mode === 'older') params.set('before', historyBefore);
    if (mode === 'newer') params.set('after', historyAfter);
    if (mode === 'date') params.set('at', String(new Date(date).getTime()));
    const payload = await api(`/api/history?${params}`);
    if (!current()) return;
    const items = uniqueMessages(asMessages(isRecord(payload) ? payload.items : payload));
    const confirmed = new Set(items.map((item) => item.eventId).filter(Boolean));
    historyLive = historyLive.filter((item) => !item.eventId || !confirmed.has(item.eventId));
    if (mode === 'older' || mode === 'newer') {
      const seen = new Set(historyItems.map((item) => item.eventId).filter(Boolean));
      const additions = items.filter((item) => !item.eventId || !seen.has(item.eventId));
      const top = messages.scrollTop;
      const height = messages.scrollHeight;
      messages.querySelector('.thread-empty')?.remove();
      if (mode === 'older') {
        messages.prepend(...additions.map(renderMessage));
        historyItems = [...additions, ...historyItems];
        messages.scrollTop = top + messages.scrollHeight - height;
        historyBefore = pageCursor(payload);
      } else {
        messages.append(...additions.map(renderMessage));
        historyItems.push(...additions);
        messages.scrollTop = top;
        historyAfter = pageCursor(payload, 'previousCursor');
      }
    } else {
      historyDetached = mode === 'date';
      historyAt = mode === 'date' ? date : '';
      historyItems = uniqueMessages([...items, ...(historyDetached ? [] : historyLive)]).sort((left, right) => {
        const difference = Date.parse(left.sentAt || left.date || '') - Date.parse(right.sentAt || right.date || '');
        return (Number.isFinite(difference) ? difference : 0) || Number(left.ordinal || 0) - Number(right.ordinal || 0);
      });
      historyBefore = pageCursor(payload);
      historyAfter = pageCursor(payload, 'previousCursor');
      renderHistory(historyItems);
      if (historyDetached) messages.scrollTop = 0;
      const input = document.querySelector<HTMLInputElement>('#historyDate');
      if (input) input.value = historyAt;
    }
  } catch (_) {
    if (current()) setFeedback('历史消息暂时无法加载，请重试。', 'warn');
  } finally {
    if (current()) {
      historyBusy = false;
      updateHistoryControls();
    }
  }
}

function conversationTimestamp(value: unknown): number {
  const at = Date.parse(String(value || ''));
  return Number.isFinite(at) ? at : 0;
}

function updateRecentConversation(item: MessageItem) {
  const previous = state.conversations.find((entry) => entry.id === item.id);
  const updatedAt = item.sentAt || item.date || new Date().toISOString();
  if (previous && conversationTimestamp(previous.updatedAt) > conversationTimestamp(updatedAt)) return;
  const friend = state.friends.find((entry) => entry.id === item.id);
  const name = friend?.name || previous?.name
    || (item.id === state.activeId ? state.activeName : '')
    || (!item.echo ? item.name : '') || item.id;
  const preview = item.type === 'image' ? '[图片]' : (item.message || '').replace(/\s+/g, ' ').trim() || '[空消息]';
  const conversation: ListEntry = { ...previous, id: item.id, name, updatedAt, preview,
    lastType: item.type || 'message', lastEcho: Boolean(item.echo) };
  recentConversationUpdates.set(item.id, conversation);
  state.conversations = [conversation, ...state.conversations.filter((entry) => entry.id !== item.id)]
    .sort((left, right) => conversationTimestamp(right.updatedAt) - conversationTimestamp(left.updatedAt));
  updateChatLists();
}

function receiveHistoryMessage(item: MessageItem) {
  if (!item.id || !steamAccessAllowed()) return;
  const account = state.steam.activeAccount?.steamId || state.steam.steamId;
  if (item.steamAccountId && item.steamAccountId !== account) return;
  updateRecentConversation(item);
  if (item.id !== state.activeId) return;
  historyLive = uniqueMessages([...historyLive, item]).slice(-500);
  if (historyDetached || (item.eventId && historyItems.some((entry) => entry.eventId === item.eventId))) return;
  historyItems.push(item);
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
  messages.querySelector('.thread-empty')?.remove();
  messages.append(renderMessage(item));
  if (atBottom) messages.scrollTop = messages.scrollHeight;
}

function renderHistory(items: MessageItem[]) {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  clear(messages);
  if (!items.length) {
    const empty = create('div', 'thread-empty');
    empty.append(create('strong', '', state.activeId ? '暂无消息' : '未选择会话'));
    messages.append(empty);
    return;
  }
  for (const item of items) messages.append(renderMessage(item));
  messages.scrollTop = messages.scrollHeight;
}

function renderMessage(item: MessageItem) {
  const row = create('article', `msg-row${item.echo ? ' is-self' : ''}`);
  if (item.eventId) row.dataset.eventId = item.eventId;
  const bubble = create('div', 'bubble');
  const meta = create('div', 'meta');
  meta.append(create('span', '', item.name || (item.echo ? '我' : item.id)), create('span', '', formatTime(item.sentAt || item.date)));
  const content = create('div', 'message-content');
  const message = item.message || '';
  if (item.type === 'image') {
    if (isRemoteImageSource(message)) content.append(imageNode(message));
    else appendMessageText(content, message || '[图片]');
  } else {
    appendMessageText(content, message);
  }
  bubble.append(meta, content);
  row.append(bubble);
  return row;
}

function appendMessageText(container: HTMLElement, text: string) {
  const lowerText = text.toLowerCase();
  let lastIndex = 0;
  while (lastIndex < text.length) {
    const block = findSupportedBbcodeStart(text, lastIndex);
    if (!block) break;
    const { start, tag } = block;
    if (start > lastIndex) appendInlineMessageText(container, text.slice(lastIndex, start));

    const openEnd = findBbcodeTagEnd(text, start + tag.length + 1);
    if (openEnd < 0) {
      appendInlineMessageText(container, text.slice(start));
      return;
    }
    const closeTag = `[/${tag}]`;
    const closeStart = lowerText.indexOf(closeTag, openEnd + 1);
    if (closeStart < 0) {
      appendInlineMessageText(container, text.slice(start));
      return;
    }

    const blockEnd = closeStart + closeTag.length;
    const attributes = text.slice(start + tag.length + 1, openEnd);
    const body = text.slice(openEnd + 1, closeStart);
    if (!appendSupportedBbcode(container, tag, attributes, body)) {
      appendInlineMessageText(container, text.slice(start, blockEnd));
    }
    lastIndex = blockEnd;
  }
  if (lastIndex < text.length) appendInlineMessageText(container, text.slice(lastIndex));
}

function findSupportedBbcodeStart(text: string, fromIndex: number): { start: number; tag: SupportedBbcodeTag } | null {
  supportedBbcodePattern.lastIndex = fromIndex;
  const match = supportedBbcodePattern.exec(text);
  const tag = match?.[1].toLowerCase() || '';
  return match && isSupportedBbcodeTag(tag) ? { start: match.index, tag } : null;
}

function isSupportedBbcodeTag(value: string): value is SupportedBbcodeTag {
  return supportedBbcodeTagSet.has(value);
}

function findBbcodeTagEnd(text: string, fromIndex: number): number {
  let quote = '';
  for (let index = fromIndex; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\' && index + 1 < text.length) index += 1;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ']') {
      return index;
    }
  }
  return -1;
}

function appendSupportedBbcode(
  container: HTMLElement,
  tag: SupportedBbcodeTag,
  attributes: string,
  body: string
): boolean {
  if (tag === 'og') {
    const preview = parseOpenGraphPreview(attributes);
    if (!preview) return false;
    container.append(openGraphNode(preview));
    if (body.trim() !== preview.url) appendInlineMessageText(container, body);
    return true;
  }

  if (tag === 'url') {
    const url = parseUrlTarget(attributes, body);
    if (!url) return false;
    container.append(externalLink('', url, body.trim() ? body : url));
    return true;
  }

  if (tag === 'emoticon') {
    const name = body.trim();
    if (attributes.trim() || !/^[A-Za-z0-9_+\-.]+$/.test(name)) return false;
    container.append(emoticonNode(name));
    return true;
  }

  if (tag === 'sticker') {
    const values = parseBbcodeAttributes(attributes, new Set(['type', 'limit']));
    const type = values?.type?.trim() || '';
    if (!values || !type || body.trim()) return false;
    container.append(stickerNode(type));
    return true;
  }

  const preview = parseSteamImagePreview(attributes, body);
  if (!preview) return false;
  container.append(steamImageNode(preview));
  return true;
}

function parseUrlTarget(attributes: string, body: string): string {
  if (!attributes.trim()) return httpUrl(body);
  const values = parseBbcodeAttributes(`href${attributes}`, new Set(['href']));
  return values ? httpUrl(values.href) : '';
}

function parseOpenGraphPreview(attributes: string): OpenGraphPreview | null {
  const values = parseBbcodeAttributes(attributes, new Set(['url', 'img', 'title', 'desc']), true);
  if (!values) return null;
  const url = httpUrl(values.url);
  if (!url) return null;
  return {
    url,
    imageUrl: httpUrl(values.img),
    title: values.title || '',
    description: values.desc || ''
  };
}

function parseBbcodeAttributes(source: string, allowed: Set<string>, requireQuoted = false): Record<string, string> | null {
  const values: Record<string, string> = {};
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) break;
    if (!/[a-z_]/i.test(source[index])) return null;

    const nameStart = index;
    index += 1;
    while (index < source.length && /[a-z0-9_-]/i.test(source[index])) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    if (!allowed.has(name) || Object.hasOwn(values, name)) return null;

    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] !== '=') return null;
    index += 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    const quote = source[index];
    if (requireQuoted && quote !== '"' && quote !== "'") return null;

    let value = '';
    const quoted = quote === '"' || quote === "'";
    if (quoted) {
      index += 1;
      let closed = false;
      while (index < source.length) {
        const character = source[index];
        if (character === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (character === '\\' && index + 1 < source.length && (source[index + 1] === quote || source[index + 1] === '\\')) {
          value += source[index + 1];
          index += 2;
        } else {
          value += character;
          index += 1;
        }
      }
      if (!closed) return null;
    } else {
      const valueStart = index;
      while (index < source.length && !/\s/.test(source[index])) index += 1;
      value = source.slice(valueStart, index);
    }
    if (!value && !quoted) return null;
    values[name] = value;
  }
  return values;
}

function parseSteamImagePreview(attributes: string, body: string): SteamImagePreview | null {
  const values = parseBbcodeAttributes(attributes, new Set(['src', 'thumbnail_src', 'srcset', 'width', 'height']));
  if (!values) return null;
  const sourceUrl = httpUrl(values.src);
  if (!sourceUrl || !imageBodyMatchesSource(body, sourceUrl)) return null;
  return {
    sourceUrl,
    displayUrl: httpUrl(values.thumbnail_src) || sourceUrl,
    sourceSet: proxyImageSourceSet(values.srcset),
    width: positiveInteger(values.width),
    height: positiveInteger(values.height)
  };
}

function imageBodyMatchesSource(body: string, sourceUrl: string): boolean {
  const trimmed = body.trim();
  if (!/^\[url(?=[=\]])/i.test(trimmed)) return false;
  const openEnd = findBbcodeTagEnd(trimmed, 4);
  if (openEnd < 0) return false;
  const closeStart = trimmed.toLowerCase().indexOf('[/url]', openEnd + 1);
  if (closeStart < 0 || closeStart + '[/url]'.length !== trimmed.length) return false;
  const linkBody = trimmed.slice(openEnd + 1, closeStart);
  const target = parseUrlTarget(trimmed.slice(4, openEnd), linkBody);
  return target === sourceUrl && linkBody.trim() === sourceUrl;
}

function positiveInteger(value: unknown): number {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!/^[1-9]\d*$/.test(source)) return 0;
  const parsed = Number(source);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function proxyImageSourceSet(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return '';
  const candidates: string[] = [];
  for (const candidate of source.split(',')) {
    const parts = candidate.trim().split(/\s+/);
    if (!parts[0] || parts.length > 2) return '';
    const url = httpUrl(parts[0]);
    const descriptor = parts[1] || '';
    if (!url || (descriptor && !validSourceSetDescriptor(descriptor))) return '';
    candidates.push(`${proxiedImageUrl(url)}${descriptor ? ` ${descriptor}` : ''}`);
  }
  return candidates.join(', ');
}

function validSourceSetDescriptor(value: string): boolean {
  if (/^[1-9]\d*w$/.test(value)) return true;
  const match = value.match(/^(\d+(?:\.\d+)?|\.\d+)x$/);
  return Boolean(match && Number(match[1]) > 0);
}

function httpUrl(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return '';
  try {
    const parsed = new URL(source);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? source : '';
  } catch (_) {
    return '';
  }
}

function proxiedImageUrl(url: string): string {
  return `/proxy/image?url=${encodeURIComponent(url)}`;
}

function externalLink(className: string, url: string, text = '') {
  const link = create('a', className, text);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function openGraphNode(preview: OpenGraphPreview) {
  const card = create('section', 'og-card');
  const main = create('div', 'og-main');

  if (preview.imageUrl) {
    const imageLink = externalLink('og-image-link', preview.url);
    const image = document.createElement('img');
    image.className = 'og-image';
    image.src = proxiedImageUrl(preview.imageUrl);
    image.alt = preview.title || '链接预览';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      imageLink.hidden = true;
    });
    imageLink.append(image);
    main.append(imageLink);
  }

  const body = create('div', 'og-body');
  if (preview.title) body.append(externalLink('og-title', preview.url, preview.title));
  if (preview.description) body.append(create('p', 'og-description', preview.description));
  main.append(body);

  const footer = create('div', 'og-footer');
  const domain = externalLink('og-domain', preview.url, new URL(preview.url).hostname.replace(/^www\./i, '').toUpperCase());
  domain.title = preview.url;
  const copyButton = create('button', 'og-copy-button');
  copyButton.type = 'button';
  copyButton.title = '复制链接';
  copyButton.setAttribute('aria-label', '复制链接');
  copyButton.append(create('span', 'og-copy-icon'));
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(preview.url);
      copyButton.title = '已复制';
      setTimeout(() => {
        copyButton.title = '复制链接';
      }, 1500);
    } catch (_) {
      setFeedback('复制链接失败', 'error');
    }
  });
  footer.append(domain, copyButton);
  card.append(main, footer);
  return card;
}

function emoticonNode(name: string) {
  const image = document.createElement('img');
  image.className = 'emoticon';
  image.src = emoticonImageUrl(name);
  image.alt = `:${name}:`;
  return image;
}

function emoticonImageUrl(name: string): string {
  return proxiedImageUrl(`https://community.cloudflare.steamstatic.com/economy/emoticon/${encodeURIComponent(name)}`);
}

function stickerNode(type: string) {
  const image = document.createElement('img');
  image.className = 'sticker';
  image.src = `/proxy/sticker/${encodeURIComponent(type)}`;
  image.alt = type;
  return image;
}

function steamImageNode(preview: SteamImagePreview) {
  const shell = create('span', 'bbcode-image-shell');
  const button = create('button', 'image-button bbcode-image-button');
  button.type = 'button';
  button.title = '查看大图';
  button.setAttribute('aria-label', '查看大图');
  if (preview.width && preview.height) {
    button.style.aspectRatio = `${preview.width} / ${preview.height}`;
    button.style.width = `${Math.max(1, Math.min(420, Math.floor((420 * preview.width) / preview.height)))}px`;
  }

  const image = document.createElement('img');
  image.className = 'bbcode-image';
  image.src = proxiedImageUrl(preview.displayUrl);
  if (preview.sourceSet) image.srcset = preview.sourceSet;
  image.alt = '图片';
  image.loading = 'lazy';
  image.addEventListener('error', () => {
    const fallback = externalLink('bbcode-image-fallback', preview.sourceUrl, preview.sourceUrl);
    fallback.title = '图片加载失败';
    shell.replaceChildren(fallback);
  });
  button.addEventListener('click', () => openLightbox(proxiedImageUrl(preview.sourceUrl)));
  button.append(image);
  shell.append(button);
  return shell;
}

function appendInlineMessageText(container: HTMLElement, text: string) {
  const pattern = /:([A-Za-z0-9_+\-.]+):|(https?:\/\/[^\s<>"'\[\]]+)/gi;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) container.append(document.createTextNode(text.slice(lastIndex, match.index)));
    if (match[1]) {
      container.append(emoticonNode(match[1]));
    } else if (match[2]) {
      container.append(externalLink('', match[2], match[2]));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) container.append(document.createTextNode(text.slice(lastIndex)));
}

function imageNode(sourceUrl: string) {
  const shell = create('button', 'image-button', '加载图片');
  shell.type = 'button';
  const image = document.createElement('img');
  image.src = proxiedImageUrl(sourceUrl);
  image.alt = '图片';
  image.onload = () => shell.replaceChildren(image);
  image.onerror = () => shell.textContent = '图片加载失败';
  shell.addEventListener('click', () => openLightbox(image.src));
  return shell;
}

function isRemoteImageSource(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function formatTime(value: unknown): string {
  if (!value) return '';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function activeIdOrWarn() {
  if (state.activeId) return state.activeId;
  setFeedback('请选择会话', 'warn');
  return '';
}

async function sendText() {
  const id = activeIdOrWarn();
  const input = document.querySelector<HTMLTextAreaElement>('#messageInput');
  const msg = input?.value.trim() || '';
  if (!id || !msg) return;
  const context = chatContext();
  try {
    const response = await api('/message', jsonBody({ id, msg }));
    if (context !== chatContext() || id !== state.activeId) return;
    if (isRecord(response)) for (const item of asMessages([response.item])) receiveHistoryMessage(item);
    if (input) {
      input.value = '';
      resizeComposerInput(input);
    }
    await loadHistory();
    setFeedback('已发送', 'ok');
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function sendImage(payload: Record<string, string>) {
  const id = activeIdOrWarn();
  if (!id) return;
  const context = chatContext();
  const steamAccountId = state.steam.activeAccount?.steamId || state.steam.steamId;
  try {
    const response = await api('/image', jsonBody({ id, ...payload, ...(steamAccountId ? { steamAccountId } : {}) }));
    if (context !== chatContext() || id !== state.activeId) return;
    if (isRecord(response)) for (const item of asMessages([response.item])) receiveHistoryMessage(item);
    await loadHistory();
    setFeedback('图片已发送', 'ok');
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

function canSendImages() {
  return Boolean(state.me && state.view === 'chat' && steamOnline() && steamAccessAllowed() && state.activeId);
}

function handleImagePaste(event: ClipboardEvent) {
  if (!canSendImages() || !event.clipboardData) return;
  const clipboard = event.clipboardData;
  const images = Array.from(clipboard.items || [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  // Some browsers expose pasted files only through files, not items.
  const files = images.length ? images : Array.from(clipboard.files || []).filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  sendFiles(files);
}

function sendFiles(files: FileList | File[] | null) {
  if (!files || !canSendImages()) return;
  const context = chatContext();
  const target = state.activeId;
  const current = () => context === chatContext() && target === state.activeId && canSendImages();
  for (const file of Array.from(files).filter((file) => file.type.startsWith('image/'))) {
    // Base64 plus JSON must fit the server's 10 MiB request body limit.
    if (!file.size || file.size > 7 * 1024 * 1024) {
      setFeedback(file.size ? '图片不能超过 7 MiB。' : '不能发送空图片。', 'warn');
      continue;
    }
    const reader = new FileReader();
    pendingImageReaders.add(reader);
    reader.onload = () => {
      if (!pendingImageReaders.delete(reader)) return;
      if (current() && typeof reader.result === 'string') void sendImage({ img: reader.result });
    };
    reader.onerror = () => {
      pendingImageReaders.delete(reader);
      if (current()) setFeedback('读取图片失败', 'error');
    };
    reader.onabort = () => pendingImageReaders.delete(reader);
    try { reader.readAsDataURL(file); }
    catch (_) {
      pendingImageReaders.delete(reader);
      if (current()) setFeedback('读取图片失败', 'error');
    }
  }
}

function renderPicker(container: HTMLElement) {
  clear(container);
  const tabs = create('div', 'picker-tabs');
  const emoticons = create('button', '', '表情');
  const stickers = create('button', '', '贴纸');
  const grid = create('div', 'picker-grid');
  function fill(type: 'emoticons' | 'stickers') {
    clear(grid);
    const source = (type === 'emoticons' ? state.emoticons : state.stickers).slice(0, 160);
    if (!source.length) {
      grid.append(create('div', 'empty small', '暂无素材'));
      return;
    }
    for (const item of source) {
      const name = String(item.name || '');
      if (!name) continue;
      const button = create('button');
      button.type = 'button';
      const image = document.createElement('img');
      image.src = type === 'emoticons'
        ? emoticonImageUrl(name)
        : `/proxy/sticker/${encodeURIComponent(name)}`;
      image.alt = name;
      button.append(image, create('span', '', name));
      button.addEventListener('click', () => {
        const input = document.querySelector<HTMLTextAreaElement>('#messageInput');
        if (!input) return;
        input.value += type === 'emoticons' ? `:${name}:` : `[sticker type="${name}" limit="0"][/sticker]`;
        input.focus();
      });
      grid.append(button);
    }
  }
  emoticons.type = 'button';
  stickers.type = 'button';
  emoticons.addEventListener('click', () => fill('emoticons'));
  stickers.addEventListener('click', () => fill('stickers'));
  tabs.append(emoticons, stickers);
  container.append(tabs, grid);
  fill('emoticons');
}

function ensureWebSocket() {
  if (!state.me || !steamAccessAllowed() || state.ws || state.reconnectTimer) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}${state.wsPath}`);
  state.ws = ws;
  const context = chatContext();
  ws.addEventListener('message', (event) => {
    if (state.ws !== ws || context !== chatContext()) return;
    let payload: WsPayload;
    try {
      const parsed: unknown = JSON.parse(String(event.data));
      payload = isRecord(parsed) ? parsed : {};
    } catch {
      return;
    }
    if (payload.type === 'storage_status') {
      healthRequest += 1;
      storageHealth = isRecord(payload.status) ? payload.status : payload;
      updateStorageHealth();
      return;
    }
    if (payload.type === 'message' || payload.type === 'image') {
      const item: MessageItem = {
        ...payload,
        id: String(payload.id || ''),
        name: typeof payload.name === 'string' ? payload.name : undefined,
        message: typeof payload.message === 'string' ? payload.message : undefined,
        ordinal: typeof payload.ordinal === 'string' || typeof payload.ordinal === 'number' ? payload.ordinal : 0,
        echo: Boolean(payload.echo),
        date: typeof payload.date === 'string' ? payload.date : undefined,
        sentAt: typeof payload.sentAt === 'string' ? payload.sentAt : undefined
      };
      receiveHistoryMessage(item);
    }
  });
  ws.addEventListener('close', () => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.me) {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        ensureWebSocket();
      }, 1500);
    }
  });
}

function stopWebSocket() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  const ws = state.ws;
  state.ws = null;
  ws?.close();
}

function startStatusPolling() {
  if (state.statusTimer || !state.me) return;
  let polling = false;
  state.statusTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    const context = chatContext();
    try {
      const status = await api('/api/steam/status');
      if (context !== chatContext() || !state.me) return;
      const previousSignature = steamStatusSignature();
      const wasOnline = steamOnline();
      updateSteamStatus(status as SteamStatus);
      if (state.view === 'steam' && steamStatusSignature() !== previousSignature) {
        renderShell();
        return;
      }
      if (state.view === 'chat') await loadStorageHealth();
      ensureWebSocket();
      if (state.view === 'chat' && (steamOnline() !== wasOnline || steamStatusSignature() !== previousSignature)) await refreshChatData();
    } catch (_) {
      // Authentication errors are handled by api().
    } finally {
      polling = false;
    }
  }, 3000);
}

function stopStatusPolling() {
  if (state.statusTimer) clearInterval(state.statusTimer);
  state.statusTimer = null;
}

async function logoutApp() {
  await api('/api/auth/logout', { method: 'POST' }).catch((): null => null);
  stopStatusPolling();
  stopWebSocket();
  state.me = null;
  state.permissions = [];
  renderLogin();
}

async function bootstrap() {
  const mePayload = await api('/api/auth/me') as MeResponse;
  state.needsSetup = Boolean(mePayload.needsSetup);
  state.me = mePayload.user || null;
  state.permissions = Array.isArray(mePayload.permissions) ? mePayload.permissions : [];
  updateSteamStatus(mePayload.steam || defaultSteamStatus);
  if (state.needsSetup) {
    renderSetup();
    return;
  }
  if (!state.me) {
    renderLogin();
    return;
  }
  const [status, config] = await Promise.all([
    api('/api/steam/status').catch((): SteamStatus => state.steam),
    api('/api/config').catch(() => ({ wsPath: '/ws' }))
  ]);
  if (isRecord(status)) updateSteamStatus(status as SteamStatus);
  if (isRecord(config) && typeof config.wsPath === 'string') state.wsPath = config.wsPath;
  renderShell();
}

function openLightbox(src: string) {
  const box = document.querySelector<HTMLElement>('#lightbox');
  const image = document.querySelector<HTMLImageElement>('#lightboxImage');
  if (!box || !image) return;
  image.src = src;
  box.hidden = false;
}

document.querySelector('#lightboxClose')?.addEventListener('click', () => {
  const box = document.querySelector<HTMLElement>('#lightbox');
  const image = document.querySelector<HTMLImageElement>('#lightboxImage');
  if (box) box.hidden = true;
  if (image) image.src = '';
});

document.addEventListener('dragover', (event) => {
  if (state.view === 'chat' && steamOnline() && steamAccessAllowed() && state.activeId) event.preventDefault();
});

document.addEventListener('drop', (event) => {
  if (state.view !== 'chat' || !steamOnline() || !steamAccessAllowed() || !state.activeId) return;
  const files = event.dataTransfer?.files || null;
  if (files && files.length) {
    event.preventDefault();
    sendFiles(files);
  }
});

document.addEventListener('keydown', (event) => {
  if (state.view !== 'chat' || !state.friendDetailsOpen) return;
  if (event.key === 'Escape') {
    setFriendDetailsOpen(false);
  }
  if (event.key === 'Tab' && typeof matchMedia === 'function' && matchMedia('(max-width: 1100px)').matches) {
    const controls = document.querySelector<HTMLElement>('#friendDetails')?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

bootstrap().catch((error) => {
  authPage('启动失败', errorMessage(error), create('div'));
});
