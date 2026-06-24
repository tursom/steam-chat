type Role = 'admin' | 'user';
type View = 'steam' | 'chat' | 'users' | 'account';
type Tone = 'muted' | 'ok' | 'warn' | 'error';

type User = {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

type SteamStatus = {
  status: string;
  requiresGuard: boolean;
  guardType: 'email' | 'device' | null;
  domain: string | null;
  lastCodeWrong: boolean;
  error: string | null;
  steamId: string | null;
};

type MeResponse = {
  needsSetup: boolean;
  user: User | null;
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
  type?: string;
  echo?: boolean;
  date?: string;
  sentAt?: string;
  message?: string;
  imageUrl?: string | null;
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
  imageUrl?: string | null;
  echo?: boolean;
  date?: string;
  sentAt?: string;
  error?: string;
};

type AppState = {
  me: User | null;
  needsSetup: boolean;
  steam: SteamStatus;
  view: View;
  users: User[];
  conversations: ListEntry[];
  friends: ListEntry[];
  groups: ListEntry[];
  emoticons: InventoryItem[];
  stickers: InventoryItem[];
  activeId: string;
  activeName: string;
  historyLimit: number;
  wsPath: string;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  statusTimer: ReturnType<typeof setInterval> | null;
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
  steamId: null
};

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing app root');

const state: AppState = {
  me: null,
  needsSetup: false,
  steam: defaultSteamStatus,
  view: normalizeView(localStorage.getItem('steam-chat.view')),
  users: [],
  conversations: [],
  friends: [],
  groups: [],
  emoticons: [],
  stickers: [],
  activeId: localStorage.getItem('steam-chat.target') || '',
  activeName: '',
  historyLimit: clampLimit(localStorage.getItem('steam-chat.history-limit') || 100),
  wsPath: '/ws',
  ws: null,
  reconnectTimer: null,
  statusTimer: null,
  feedback: '就绪',
  feedbackTone: 'muted'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
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
  return view === 'steam' || view === 'chat' || view === 'users' || view === 'account' ? view : 'steam';
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
  state.feedback = text;
  state.feedbackTone = tone;
  const node = document.querySelector<HTMLElement>('#feedback');
  if (node) {
    node.textContent = text;
    node.dataset.tone = tone;
  }
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

function steamStatusSignature(status = state.steam) {
  return [
    status.status,
    status.requiresGuard,
    status.guardType || '',
    status.domain || '',
    status.lastCodeWrong,
    status.error || '',
    status.steamId || ''
  ].join('|');
}

function updateSteamStatus(status: SteamStatus) {
  state.steam = { ...defaultSteamStatus, ...status };
  const badge = document.querySelector<HTMLElement>('#steamBadge');
  if (badge) {
    badge.textContent = steamLabel();
    badge.dataset.status = state.steam.status;
  }
  const hint = document.querySelector<HTMLElement>('#steamHint');
  if (hint) hint.textContent = state.steam.error || (state.steam.steamId ? `SteamID ${state.steam.steamId}` : '后台服务已启动');
  const subtitle = document.querySelector<HTMLElement>('#pageSubtitle');
  if (subtitle) subtitle.textContent = pageSubtitle();
  updateChatAvailability();
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
  const button = create('button', state.view === view ? 'is-active' : '', label);
  button.type = 'button';
  button.addEventListener('click', () => {
    state.view = view;
    localStorage.setItem('steam-chat.view', view);
    renderShell();
  });
  return button;
}

function renderShell() {
  if (!state.me) {
    renderLogin();
    return;
  }
  if (state.me.role !== 'admin' && state.view === 'users') state.view = 'steam';
  clear(root);
  const shell = create('div', 'admin-shell');
  const sidebar = create('aside', 'admin-sidebar');
  const brand = create('div', 'brand');
  brand.append(create('strong', '', 'Steam Chat'), create('span', '', state.me.username));
  const nav = create('nav');
  nav.append(navButton('steam', 'Steam 连接'), navButton('chat', '聊天'));
  if (state.me.role === 'admin') nav.append(navButton('users', '用户管理'));
  nav.append(navButton('account', '账号'));
  sidebar.append(brand, nav);

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
  const content = create('section', 'content');
  content.append(renderCurrentView());
  const feedback = create('div', 'feedback', state.feedback);
  feedback.id = 'feedback';
  feedback.dataset.tone = state.feedbackTone;
  main.append(top, content, feedback);
  shell.append(sidebar, main);
  root.append(shell);
  if (state.view === 'chat') void refreshChatData();
  if (state.view === 'users' && state.me.role === 'admin') void loadUsers();
  ensureWebSocket();
  startStatusPolling();
}

function pageTitle() {
  if (state.view === 'chat') return '聊天';
  if (state.view === 'users') return '用户管理';
  if (state.view === 'account') return '账号';
  return 'Steam 连接';
}

function pageSubtitle() {
  if (state.view === 'chat') return steamOnline() ? '好友、群组、历史和实时消息' : 'Steam 未在线，聊天操作已禁用';
  if (state.view === 'users') return '后台用户、角色和启用状态';
  if (state.view === 'account') return '修改当前后台账号密码';
  return state.me?.role === 'admin' ? '管理员在这里完成 Steam 登录和 Guard 验证' : '等待管理员连接 Steam';
}

function renderCurrentView() {
  if (state.view === 'chat') return renderChatView();
  if (state.view === 'users' && state.me?.role === 'admin') return renderUsersView();
  if (state.view === 'account') return renderAccountView();
  return renderSteamView();
}

function renderSteamView() {
  const view = create('div', 'steam-view');
  const summary = create('section', 'status-panel');
  const statusText = create('strong', '', steamLabel());
  const detail = create('p', 'muted', state.steam.error || (state.steam.steamId ? `当前 SteamID：${state.steam.steamId}` : '当前没有可用的 Steam 会话'));
  summary.append(statusText, detail);
  view.append(summary);

  if (state.me?.role !== 'admin') {
    view.append(create('p', 'muted', '普通用户只能在 Steam 在线后使用聊天。'));
    return view;
  }

  if (state.steam.requiresGuard) {
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
    view.append(guardForm);
  } else if (!['logging_in', 'online', 'reconnecting'].includes(state.steam.status)) {
    const loginForm = create('form', 'stack-form narrow-form') as HTMLFormElement;
    loginForm.innerHTML = `
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
          ...(rawLogonID ? { logonID: Number(rawLogonID) } : {})
        }));
        updateSteamStatus(result as SteamStatus);
        renderShell();
      } catch (error) {
        setFeedback(errorMessage(error), 'error');
      }
    });
    view.append(loginForm);
  }

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
  view.append(logout);
  return view;
}

function renderUsersView() {
  const view = create('div', 'users-view');
  const form = create('form', 'inline-form user-create') as HTMLFormElement;
  form.innerHTML = `
    <label>账号<input name="username" minlength="3" maxlength="64" required></label>
    <label>密码<input name="password" type="password" minlength="8" required></label>
    <label>角色<select name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></label>
    <button type="submit">新增用户</button>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/users', jsonBody({
        username: formValue(form, 'username'),
        password: formValue(form, 'password'),
        role: formValue(form, 'role') || 'user'
      }));
      form.reset();
      await loadUsers();
    } catch (error) {
      setFeedback(errorMessage(error), 'error');
    }
  });
  const table = create('div', 'user-table');
  table.id = 'userTable';
  view.append(form, table);
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
    info.append(create('strong', '', user.username), create('span', 'muted', `${user.role === 'admin' ? '管理员' : '普通用户'} · ${user.disabled ? '已禁用' : '启用'}`));
    const actions = create('div', 'row-actions');
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
    const remove = create('button', 'danger-btn', '删除');
    remove.type = 'button';
    remove.disabled = user.id === state.me?.id;
    remove.addEventListener('click', () => deleteUser(user.id));
    actions.append(role, disabled, password, remove);
    row.append(info, actions);
    container.append(row);
  }
}

async function loadUsers() {
  if (state.me?.role !== 'admin') return;
  try {
    const payload = await api('/api/users');
    state.users = isRecord(payload) && Array.isArray(payload.users) ? payload.users as User[] : [];
    const table = document.querySelector<HTMLElement>('#userTable');
    if (table) renderUserTable(table);
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
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
  try {
    await api(`/api/users/${id}/password`, jsonBody({ password }));
    setFeedback('密码已重置', 'ok');
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

function renderAccountView() {
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
  return form;
}

function renderChatView() {
  const view = create('div', 'chat-layout');
  const lists = create('aside', 'chat-lists');
  const openForm = create('form', 'open-chat-form') as HTMLFormElement;
  const targetInput = create('input') as HTMLInputElement;
  targetInput.name = 'target';
  targetInput.inputMode = 'numeric';
  targetInput.autocomplete = 'off';
  targetInput.placeholder = 'SteamID64';
  targetInput.value = state.activeId;
  const openButton = create('button', '', '打开');
  openButton.type = 'submit';
  openForm.append(targetInput, openButton);
  openForm.addEventListener('submit', (event) => {
    event.preventDefault();
    openConversation(formValue(openForm, 'target'));
  });
  const tabs = create('div', 'list-sections');
  tabs.id = 'chatListSections';
  renderChatListSections(tabs);
  lists.append(openForm, tabs);

  const thread = create('section', 'thread');
  const head = create('header', 'thread-head');
  head.append(create('div', '', state.activeName || state.activeId || '未选择会话'), create('span', 'muted', state.activeId || '选择好友、群组或输入 SteamID64'));
  const messages = create('div', 'messages');
  messages.id = 'messages';
  const composer = renderComposer();
  thread.append(head, messages, composer);
  view.append(lists, thread);
  setTimeout(() => {
    if (state.activeId) void loadHistory();
    else renderHistory([]);
    updateChatAvailability();
  }, 0);
  return view;
}

function renderChatListSections(container: HTMLElement) {
  clear(container);
  container.append(renderListSection('最近', state.conversations), renderListSection('好友', state.friends), renderListSection('群组', state.groups));
}

function updateChatLists() {
  const tabs = document.querySelector<HTMLElement>('#chatListSections');
  if (tabs) renderChatListSections(tabs);
}

function renderListSection(title: string, items: ListEntry[]) {
  const section = create('section', 'list-section');
  section.append(create('h2', '', title));
  const body = create('div');
  if (!items.length) {
    body.append(create('div', 'empty small', '暂无数据'));
  } else {
    for (const item of items) body.append(renderListItem(item));
  }
  section.append(body);
  return section;
}

function renderListItem(item: ListEntry) {
  const button = create('button', `list-item${item.id === state.activeId ? ' is-active' : ''}`);
  button.type = 'button';
  const avatar = create('span', 'avatar', String(item.name || item.id || '?').slice(0, 1).toUpperCase());
  if (item.avatar) {
    const image = document.createElement('img');
    image.src = item.avatar;
    image.alt = '';
    avatar.replaceChildren(image);
  }
  const body = create('span', 'item-body');
  body.append(create('strong', '', item.name || item.id), create('span', 'muted', item.preview || item.gameName || item.clanId || item.clanid || item.id));
  button.append(avatar, body);
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
  const row = create('div', 'compose-row');
  const pickerButton = create('button', 'icon-btn', '素材');
  pickerButton.id = 'pickerToggle';
  pickerButton.type = 'button';
  pickerButton.addEventListener('click', () => {
    picker.hidden = !picker.hidden;
    renderPicker(picker);
  });
  const fileButton = create('button', 'icon-btn', '图片');
  fileButton.id = 'fileButton';
  fileButton.type = 'button';
  const fileInput = create('input') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    sendFiles(fileInput.files);
    fileInput.value = '';
  });
  const input = create('textarea') as HTMLTextAreaElement;
  input.id = 'messageInput';
  input.rows = 1;
  input.placeholder = '发送消息';
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendText();
    }
  });
  const send = create('button', 'primary-btn', '发送');
  send.id = 'sendButton';
  send.type = 'button';
  send.addEventListener('click', () => sendText());
  row.append(pickerButton, fileButton, fileInput, input, send);
  const imageForm = create('form', 'image-url-form') as HTMLFormElement;
  imageForm.innerHTML = '<input name="url" type="url" placeholder="图片 URL"><button type="submit">发送图片</button>';
  imageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = formValue(imageForm, 'url').trim();
    if (!url) return;
    imageForm.reset();
    void sendImage({ url });
  });
  shell.append(disabledNote, picker, row, imageForm);
  return shell;
}

function updateChatAvailability() {
  const disabled = !steamOnline();
  for (const selector of ['#messageInput', '#sendButton', '#pickerToggle', '#fileButton', '.image-url-form input', '.image-url-form button']) {
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>(selector).forEach((node) => {
      node.disabled = disabled;
    });
  }
  const note = document.querySelector<HTMLElement>('#offlineNote');
  if (note) note.hidden = !disabled;
}

async function refreshChatData() {
  if (!state.me) return;
  try {
    const conversations = await api(`/conversations?limit=${state.historyLimit}`);
    state.conversations = asListEntries(conversations);
    if (steamOnline()) {
      const [friends, groups, inventory] = await Promise.all([
        api('/api/friends'),
        api('/api/groups'),
        api('/api/emoticons')
      ]);
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
      updateChatAvailability();
    }
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

function openConversation(id: unknown, name = '') {
  const target = String(id || '').trim();
  if (!target) {
    setFeedback('请输入 SteamID64', 'warn');
    return;
  }
  state.activeId = target;
  state.activeName = name || target;
  localStorage.setItem('steam-chat.target', state.activeId);
  if (state.view === 'chat') renderShell();
}

async function loadHistory() {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  if (!state.activeId) {
    renderHistory([]);
    return;
  }
  try {
    const history = await api(`/history?id=${encodeURIComponent(state.activeId)}&limit=${state.historyLimit}`);
    renderHistory(asMessages(history));
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

function renderHistory(items: MessageItem[]) {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;
  clear(messages);
  if (!items.length) {
    messages.append(create('div', 'empty', '暂无消息'));
    return;
  }
  for (const item of items) messages.append(renderMessage(item));
  messages.scrollTop = messages.scrollHeight;
}

function renderMessage(item: MessageItem) {
  const row = create('article', `msg-row${item.echo ? ' is-self' : ''}`);
  const bubble = create('div', 'bubble');
  const meta = create('div', 'meta');
  meta.append(create('span', '', item.name || (item.echo ? '我' : item.id)), create('span', '', formatTime(item.sentAt || item.date)));
  const content = create('div', 'message-content');
  if (item.imageUrl) content.append(imageNode(item.imageUrl));
  else appendMessageText(content, item.message || '');
  bubble.append(meta, content);
  row.append(bubble);
  return row;
}

function appendMessageText(container: HTMLElement, text: string) {
  const pattern = /\[sticker\s+type=["']?([^"'\]\s]+)["']?[^\]]*\]\s*\[\/sticker\]|:([A-Za-z0-9_+\-.]+):|(https?:\/\/[^\s<>"']+)/gi;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) container.append(document.createTextNode(text.slice(lastIndex, match.index)));
    if (match[1]) {
      const image = document.createElement('img');
      image.className = 'sticker';
      image.src = `/proxy/sticker/${encodeURIComponent(match[1])}`;
      image.alt = match[1];
      container.append(image);
    } else if (match[2]) {
      const image = document.createElement('img');
      image.className = 'emoticon';
      image.src = `https://community.cloudflare.steamstatic.com/economy/emoticon/${encodeURIComponent(match[2])}`;
      image.alt = `:${match[2]}:`;
      container.append(image);
    } else if (match[3]) {
      const link = create('a', '', match[3]);
      link.href = match[3];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      container.append(link);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) container.append(document.createTextNode(text.slice(lastIndex)));
}

function imageNode(sourceUrl: string) {
  const shell = create('button', 'image-button', '加载图片');
  shell.type = 'button';
  const image = document.createElement('img');
  image.src = `/proxy/image?url=${encodeURIComponent(sourceUrl)}`;
  image.alt = '图片';
  image.onload = () => shell.replaceChildren(image);
  image.onerror = () => shell.textContent = '图片加载失败';
  shell.addEventListener('click', () => openLightbox(image.src));
  return shell;
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
  try {
    await api('/message', jsonBody({ id, msg }));
    if (input) input.value = '';
    await loadHistory();
    setFeedback('已发送', 'ok');
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

async function sendImage(payload: Record<string, string>) {
  const id = activeIdOrWarn();
  if (!id) return;
  try {
    await api('/image', jsonBody({ id, ...payload }));
    await loadHistory();
    setFeedback('图片已发送', 'ok');
  } catch (error) {
    setFeedback(errorMessage(error), 'error');
  }
}

function sendFiles(files: FileList | null) {
  if (!files) return;
  [...files].filter((file) => file.type.startsWith('image/')).forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') void sendImage({ img: reader.result });
    };
    reader.onerror = () => setFeedback('读取图片失败', 'error');
    reader.readAsDataURL(file);
  });
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
        ? `https://community.cloudflare.steamstatic.com/economy/emoticon/${encodeURIComponent(name)}`
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
  if (!state.me || state.ws || state.reconnectTimer) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}${state.wsPath}`);
  state.ws = ws;
  ws.addEventListener('message', (event) => {
    let payload: WsPayload;
    try {
      const parsed: unknown = JSON.parse(String(event.data));
      payload = isRecord(parsed) ? parsed : {};
    } catch {
      return;
    }
    if (payload.type === 'message' || payload.type === 'image') {
      const item: MessageItem = {
        ...payload,
        id: String(payload.id || ''),
        name: typeof payload.name === 'string' ? payload.name : undefined,
        message: typeof payload.message === 'string' ? payload.message : undefined,
        imageUrl: typeof payload.imageUrl === 'string' ? payload.imageUrl : null,
        echo: Boolean(payload.echo),
        date: typeof payload.date === 'string' ? payload.date : undefined,
        sentAt: typeof payload.sentAt === 'string' ? payload.sentAt : undefined
      };
      if (item.id === state.activeId) {
        const messages = document.querySelector<HTMLElement>('#messages');
        messages?.append(renderMessage(item));
        if (messages) messages.scrollTop = messages.scrollHeight;
      }
    }
  });
  ws.addEventListener('close', () => {
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
  if (state.ws) state.ws.close();
  state.ws = null;
}

function startStatusPolling() {
  if (state.statusTimer || !state.me) return;
  state.statusTimer = setInterval(async () => {
    try {
      const status = await api('/api/steam/status');
      const previousSignature = steamStatusSignature();
      const wasOnline = steamOnline();
      updateSteamStatus(status as SteamStatus);
      if (state.view === 'steam' && steamStatusSignature() !== previousSignature) {
        renderShell();
        return;
      }
      if (state.view === 'chat' && steamOnline() !== wasOnline) await refreshChatData();
    } catch (_) {
      // Authentication errors are handled by api().
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
  renderLogin();
}

async function bootstrap() {
  const mePayload = await api('/api/auth/me') as MeResponse;
  state.needsSetup = Boolean(mePayload.needsSetup);
  state.me = mePayload.user || null;
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
  if (state.view === 'chat' && steamOnline()) event.preventDefault();
});

document.addEventListener('drop', (event) => {
  if (state.view !== 'chat' || !steamOnline()) return;
  const files = event.dataTransfer?.files || null;
  if (files && files.length) {
    event.preventDefault();
    sendFiles(files);
  }
});

bootstrap().catch((error) => {
  authPage('启动失败', errorMessage(error), create('div'));
});
