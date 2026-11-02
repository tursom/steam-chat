// Classic script, loaded before app.js. Shared app state is only read inside functions.
type ConsoleRole = { id: string; name: string; description: string; builtin: boolean; permissions: string[]; memberCount: number; editable?: boolean; deletable?: boolean };
type ConsoleOverride = { permission: string; effect: 'grant' | 'revoke' };
type ConsolePermissionDetail = { permission: string; effective: boolean; source: string };
type ConsoleGrant = { steamAccountId: number; level: 'none' | 'read' | 'chat' | 'full'; scope: 'all' | 'some'; peers: string[]; expiresAt: string | null };
type ConsoleUserDraft = { userId: number; roleId: string; overrides: ConsoleOverride[]; grants: ConsoleGrant[] };
type ConsoleOverview = { accounts: SteamAccount[]; users: { id: number; username: string; displayName: string; all: boolean; grants: Record<string, { level: string; scope: string; peerCount: number; expiresAt: string | null }> }[] };
const consolePermissionGroups: { name: string; items: [string, string, string][] }[] = [
  { name: '用户与安全', items: [
    ['user.view', '查看用户', '查看用户资料、有效权限和 Steam 授权'],
    ['user.manage', '管理用户', '新增、编辑、禁用用户和重置密码；包含查看用户'],
    ['role.manage', '管理角色', '管理角色、用户角色和个人权限覆盖'],
    ['session.manage', '管理会话', '查看和撤销登录会话'],
    ['audit.view', '查看审计', '查看管理操作及字段变更记录']
  ] },
  { name: 'Steam', items: [
    ['steam.manage', '管理 Steam 连接', '登录、切换账户和退出 Steam'],
    ['steam.account.manage', '管理 Steam 账户资料', '编辑账户资料、启用、禁用和删除账户'],
    ['steam.grant.manage', '分配 Steam 授权', '设置授权等级、好友范围和有效期'],
    ['steam.account.all', '全部 Steam 账户', '以完整授权访问所有启用账户及旧版历史']
  ] },
  { name: '聊天与个人', items: [
    ['chat.use', '使用聊天', '使用聊天功能，仍需 Steam 账户授权'],
    ['emote.manage', '管理图片表情', '上传和管理共享图片表情'],
    ['self.password.change', '修改自己的密码', '修改当前账号密码']
  ] }
];
let consoleRoles: ConsoleRole[] = [];
let consoleSelectedUser = 0;
let consoleUserTab = 'overview';
let consoleMobileDetail = false;
let consoleRoleMobileDetail = false;
let consoleUserDraft: ConsoleUserDraft | null = null;
let consoleUserBase = '';
let consolePermissionCache: Record<number, { roleId: string; overrides: ConsoleOverride[]; details: ConsolePermissionDetail[] }> = {};
let consoleGrantCache: Record<number, ConsoleGrant[]> = {};
let consoleRoleDrafts: Record<string, string[]> = {};
let consoleSelectedRole = '';
let consoleRoleMode = 'role';
let consoleOverview: ConsoleOverview | null = null;
let consoleAuditQuery = '';
let consoleAuditCategory = '';
let consoleAuditDays = '7';
let consoleAuditRevision = 0;
let consoleUsersRevision = 0;
let consoleBusy = false;
let consoleLoginTab = 'qr';
let consoleLoginMode = '';
let consoleLoginAlreadyOnline = false;

function consoleCan(permission: string) { return hasPermission(permission as Permission); }
function consoleRoleId(user: User): string { return (user as User & { roleId?: string }).roleId || 'member'; }
function consoleRoleName(user: User): string { return (user as User & { roleName?: string }).roleName || consoleRoles.find(r => r.id === consoleRoleId(user))?.name || consoleRoleId(user); }
function consoleClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function consoleButton(text: string, action: () => unknown, className = 'btn', disabledReason = '') {
  const button = create('button', className, text);
  button.type = 'button';
  button.disabled = Boolean(disabledReason);
  button.title = disabledReason || text;
  button.addEventListener('click', () => { void Promise.resolve().then(action).catch(error => setFeedback(errorMessage(error), 'error')); });
  return button;
}
function consoleBadge(text: string, tone = 'muted') { return create('span', `badge ${tone}`, text); }
function consoleAvatar(name: string, size = '') {
  const avatar = create('span', `av ${size}`, name.slice(0, 1).toUpperCase());
  let hash = 0;
  for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  avatar.style.setProperty('--h', String(Math.abs(hash) % 360));
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}
function consoleNotice(text: string, tone = '') { return create('p', `notice ${tone}`, text); }
function consoleEmpty(text: string) { return create('div', 'empty-small', text); }
function consoleInput(form: HTMLFormElement, name: string, title: string, value = '', type = 'text') {
  const label = create('label', '', title);
  const input = create('input'); input.name = name; input.type = type; input.value = value;
  label.append(input); form.append(label); return input;
}
function consoleCheck(form: HTMLFormElement, name: string, title: string, checked: boolean) {
  const label = create('label', 'check'); const input = create('input');
  input.type = 'checkbox'; input.name = name; input.checked = checked;
  label.append(input, document.createTextNode(title)); form.append(label); return input;
}
function consoleSelect(options: [string, string][], value: string, label: string, change: (value: string) => unknown, disabled = '') {
  const select = create('select'); select.setAttribute('aria-label', label);
  for (const [key, text] of options) { const option = create('option', '', text); option.value = key; select.append(option); }
  select.value = value; select.disabled = Boolean(disabled); select.title = disabled || label;
  select.addEventListener('change', () => { void Promise.resolve(change(select.value)).catch(error => setFeedback(errorMessage(error), 'error')); });
  return select;
}
function consoleSegment(options: [string, string][], value: string, label: string, change: (value: string) => unknown, disabled = '') {
  const group = create('div', 'seg'); group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', label);
  for (const [key, text] of options) {
    const button = consoleButton(text, () => change(key), key === value ? 'is-on' : '', disabled);
    button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(key === value));
    button.tabIndex = key === value ? 0 : -1; group.append(button);
  }
  group.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault(); const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
    const key = options[index][0]; void Promise.resolve(change(key)).then(() => {
      const next = document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`);
      next?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus();
    }).catch(error => setFeedback(errorMessage(error), 'error'));
  });
  return group;
}
function consoleMenu(items: HTMLElement[]) {
  const details = create('details', 'console-more'); const summary = create('summary', 'btn sm', '⋯');
  summary.title = '更多操作'; summary.setAttribute('aria-label', '更多操作');
  const menu = create('div', 'menu'); menu.append(...items); details.append(summary, menu); return details;
}
function consoleDialog(title: string, form: HTMLFormElement, save: () => Promise<void>, saveLabel = '保存') {
  const error = create('p', 'form-error'); error.setAttribute('role', 'alert'); form.append(error);
  const saveButton = create('button', 'btn primary', saveLabel); saveButton.type = 'submit'; form.append(saveButton);
  let busy = false;
  const submit = async () => {
    if (busy || !form.reportValidity()) return;
    busy = true; saveButton.disabled = true; error.textContent = '';
    try { await save(); close(); } catch (reason) { error.textContent = errorMessage(reason); } finally { busy = false; saveButton.disabled = false; }
  };
  const close = openDialog(title, form);
  form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  return close;
}
function consoleWrite(path: string, body: Record<string, unknown>, method = 'PATCH') { return api(path, { ...jsonBody(body), method }); }
function consoleSuccess() { setFeedback('已保存，已写入审计日志', 'ok'); }
function consoleDraftSnapshot(draft: ConsoleUserDraft) {
  return JSON.stringify({ ...draft,
    overrides: [...draft.overrides].sort((a, b) => a.permission.localeCompare(b.permission)),
    grants: draft.grants.filter(g => g.level !== 'none').map(g => ({ ...g, peers: g.scope === 'all' ? [] : [...g.peers].sort() })).sort((a, b) => a.steamAccountId - b.steamAccountId)
  });
}
function consoleUserDirty() { return Boolean(consoleUserDraft && consoleDraftSnapshot(consoleUserDraft) !== consoleUserBase); }
function consoleRolesDirty() { return Object.keys(consoleRoleDrafts).length > 0; }
function consoleSyncDirty() {
  setConsoleDirty(consoleUserDirty() || consoleRolesDirty(), consoleSaveDrafts, consoleUndoDrafts);
}
function consoleUndoDrafts() {
  if (consoleUserBase) consoleUserDraft = JSON.parse(consoleUserBase) as ConsoleUserDraft;
  consoleRoleDrafts = {}; consoleSyncDirty(); consoleRefreshUsers(); consoleRefreshRoles();
}
async function consoleDiscard(): Promise<boolean> {
  if (consoleBusy) { setFeedback('正在保存，请稍后再切换', 'warn'); return false; }
  if (!consoleUserDirty() && !consoleRolesDirty()) return true;
  if (!await confirmDialog('放弃未保存的更改？')) return false;
  consoleUndoDrafts(); return true;
}
async function consoleSaveDrafts() {
  if (consoleBusy) throw new Error('正在保存，请稍后');
  consoleBusy = true;
  consoleRefreshUsers(); consoleRefreshRoles();
  try {
    if (consoleUserDraft && consoleUserDirty()) {
      const draft = consoleUserDraft;
      const base = JSON.parse(consoleUserBase) as ConsoleUserDraft;
      const grantsChanged = JSON.stringify((JSON.parse(consoleDraftSnapshot(draft)) as ConsoleUserDraft).grants) !== JSON.stringify(base.grants);
      if (draft.grants.some(g => g.level !== 'none' && g.scope === 'some' && !g.peers.length)
        && !await confirmDialog('未选择任何好友，指定好友范围内将没有可见会话。仍要保存？')) throw new Error('尚未保存，请先选择好友或修改会话范围');
      const grants = draft.grants.filter(g => g.level !== 'none');
      for (const grant of grants) {
        if (grantsChanged && grant.expiresAt
          && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now())) throw new Error('授权有效期必须是将来的日期，请续期或移除已过期授权');
      }
      // Each endpoint commits independently. Advance the baseline after each success so a
      // retry never repeats an already-applied role transition or loses remaining edits.
      if (draft.roleId !== base.roleId) {
        await consoleWrite(`/api/users/${draft.userId}`, { roleId: draft.roleId });
        base.roleId = draft.roleId;
        if (draft.roleId === 'super') { draft.overrides = []; base.overrides = []; }
        consoleUserBase = consoleDraftSnapshot(base);
      }
      if (JSON.stringify(draft.overrides) !== JSON.stringify(base.overrides)) {
        await consoleWrite(`/api/users/${draft.userId}/permission-overrides`, { overrides: draft.overrides }, 'PUT');
        base.overrides = consoleClone(draft.overrides); consoleUserBase = consoleDraftSnapshot(base);
      }
      if (grantsChanged) {
        await consoleWrite(`/api/users/${draft.userId}/steam-accounts`, { grants: grants.map(g => ({ ...g, peers: g.scope === 'all' ? [] : g.peers })) }, 'PUT');
        base.grants = consoleClone(draft.grants); consoleUserBase = consoleDraftSnapshot(base);
      }
      delete consolePermissionCache[draft.userId]; delete consoleGrantCache[draft.userId];
      await loadUsers();
    }
    for (const id of Object.keys(consoleRoleDrafts)) {
      await consoleWrite(`/api/roles/${encodeURIComponent(id)}`, { permissions: consoleRoleDrafts[id] });
      const role = consoleRoles.find(r => r.id === id); if (role) role.permissions = [...consoleRoleDrafts[id]];
      delete consoleRoleDrafts[id];
      consolePermissionCache = {};
    }
    consoleSuccess(); consoleSyncDirty(); consoleRefreshUsers(); consoleRefreshRoles();
  } catch (error) { setFeedback(errorMessage(error), 'error'); throw error; }
  finally { consoleBusy = false; consoleSyncDirty(); consoleRefreshUsers(); consoleRefreshRoles(); }
}
function consoleMakeUserDraft(user: User) {
  if (consoleUserDraft?.userId === user.id) return;
  const permissions = consolePermissionCache[user.id];
  consoleUserDraft = { userId: user.id, roleId: permissions?.roleId || consoleRoleId(user), overrides: consoleClone(permissions?.overrides || []), grants: consoleClone(consoleGrantCache[user.id] || []) };
  consoleUserBase = consoleDraftSnapshot(consoleUserDraft);
}
function consoleEffective(user: User, permission: string): { effective: boolean; source: string } {
  const draft = consoleUserDraft?.userId === user.id ? consoleUserDraft : null;
  const roleId = draft?.roleId || consoleRoleId(user);
  if (roleId === 'super') return { effective: true, source: '超级管理员' };
  const effect = (draft?.overrides || consolePermissionCache[user.id]?.overrides || []).find(o => o.permission === permission)?.effect;
  const role = consoleRoles.find(r => r.id === roleId);
  let effective = effect ? effect === 'grant' : Boolean(role?.permissions.includes(permission));
  let source = effect === 'grant' ? '个人授予' : effect === 'revoke' ? '个人收回' : effective ? '来自角色' : '未授予';
  if (!role && !draft) {
    const detail = consolePermissionCache[user.id]?.details.find(d => d.permission === permission);
    if (detail) { effective = detail.effective; source = ({ super: '超级管理员', role: '来自角色', grant: '个人授予', revoke: '个人收回', implied: '由管理用户推导' } as Record<string, string>)[detail.source] || '未授予'; }
  }
  if (permission === 'user.view' && consoleEffective(user, 'user.manage').effective) return { effective: true, source: '由管理用户推导' };
  return { effective, source };
}
function consoleRefreshUsers() {
  const host = document.querySelector<HTMLElement>('#consoleUsersContent');
  if (!host) return;
  const active = document.activeElement as HTMLInputElement | null;
  const search = active?.id === 'userSearch'; const start = search ? active.selectionStart : null;
  clear(host); host.append(consoleUsersContent());
  if (search) { const input = host.querySelector<HTMLInputElement>('#userSearch'); input?.focus(); if (start !== null) input?.setSelectionRange(start, start); }
}
function consoleRenderUsersView() {
  const view = create('div', 'users-view');
  const toolbar = create('div', 'toolbar');
  if (consoleCan('user.manage')) toolbar.append(consoleButton('新增用户', consoleCreateUser, 'btn primary'));
  toolbar.append(consoleButton('刷新', loadUsers, 'btn'));
  const host = create('div'); host.id = 'consoleUsersContent'; host.append(consoleUsersContent());
  view.append(toolbar, host); return view;
}
function consoleUsersContent() {
  const selected = state.users.find(u => u.id === consoleSelectedUser) || state.users[0];
  if (selected) consoleSelectedUser = selected.id;
  const split = create('div', 'split'); split.dataset.mobileDetail = String(consoleMobileDetail);
  const list = create('section', 'card list-pane'); const tools = create('div', 'list-tools');
  const search = create('input'); search.id = 'userSearch'; search.type = 'search'; search.placeholder = '搜索账号、昵称、备注';
  search.setAttribute('aria-label', search.placeholder); search.value = state.userQuery;
  search.addEventListener('input', () => { state.userQuery = search.value; consoleRefreshUsers(); }); tools.append(search);
  const chips = create('div', 'chips');
  for (const [key, name] of [['', '全部'], ['enabled', '启用'], ['disabled', '禁用'], ['locked', '锁定']]) {
    const count = state.users.filter(u => consoleMatchesStatus(u, key)).length;
    chips.append(consoleButton(`${name} ${count}`, () => { state.userStatus = key; consoleRefreshUsers(); }, `chip${state.userStatus === key ? ' is-on' : ''}`));
  }
  const rows = create('div', 'rows user-table'); rows.id = 'userTable'; consoleRenderUserTable(rows);
  list.append(tools, chips, rows);
  const detail = selected ? consoleRenderUserDetail(selected) : create('section');
  detail.classList.add('card', 'detail-pane'); detail.id = 'consoleUserDetail';
  if (!selected) detail.append(consoleEmpty('暂无用户'));
  split.append(list, detail); return split;
}
function consoleMatchesStatus(user: User, status: string) { return !status || (status === 'disabled' ? user.disabled : status === 'locked' ? user.locked : !user.disabled && !user.locked); }
function consoleRenderUserTable(container: HTMLElement) {
  clear(container); const query = state.userQuery.trim().toLowerCase();
  const users = state.users.filter(u => consoleMatchesStatus(u, state.userStatus) && (!state.userRole || consoleRoleId(u) === state.userRole) && `${u.username} ${u.displayName} ${u.note}`.toLowerCase().includes(query));
  for (const user of users) {
    const row = consoleButton('', () => consoleSelectUser(user.id), `urow${consoleSelectedUser === user.id ? ' is-active' : ''}`);
    const copy = create('span', 'urow-body'); const name = create('span');
    name.append(create('strong', '', displayName(user)), create('small', '', `@${user.username}`));
    const badges = create('span'); badges.append(consoleBadge(consoleRoleName(user), consoleRoleId(user) === 'super' ? 'accent' : 'muted'));
    if (user.disabled || user.locked) badges.append(consoleBadge(user.disabled ? '已禁用' : '锁定', 'warn'));
    copy.append(name, badges); row.append(consoleAvatar(displayName(user)), copy); container.append(row);
  }
  if (!users.length) container.append(consoleEmpty('没有匹配的用户'));
}
async function consoleSelectUser(id: number, tab = consoleUserTab) {
  if ((id !== consoleSelectedUser || tab !== consoleUserTab) && !await consoleDiscard()) return;
  if (id !== consoleSelectedUser) { consoleUserDraft = null; consoleUserBase = ''; }
  consoleSelectedUser = id; consoleUserTab = tab; consoleMobileDetail = true;
  consoleRefreshUsers();
  if (tab === 'grant' && !state.steamAccounts.length) await loadSteamAccounts();
  await consoleLoadUserData(id);
}
async function consoleLoadUserData(id: number, force = false) {
  try {
    if (consoleUserTab === 'perm' || consoleUserTab === 'grant' || force) {
      const results = await Promise.all([
        consolePermissionCache[id] && !force ? Promise.resolve(null) : api(`/api/users/${id}/permissions`),
        consoleGrantCache[id] && !force ? Promise.resolve(null) : api(`/api/users/${id}/steam-accounts`)
      ]);
      const permissions = results[0]; const grants = results[1];
      if (isRecord(permissions)) consolePermissionCache[id] = { roleId: String(permissions.roleId || 'member'), overrides: Array.isArray(permissions.overrides) ? permissions.overrides as ConsoleOverride[] : [], details: Array.isArray(permissions.details) ? permissions.details as ConsolePermissionDetail[] : [] };
      if (isRecord(grants)) {
        state.userSteamAccounts[id] = Array.isArray(grants.steamAccounts) ? grants.steamAccounts as SteamAccount[] : [];
        consoleGrantCache[id] = Array.isArray(grants.grants) ? (grants.grants as ConsoleGrant[]).map(g => ({ ...g, steamAccountId: Number(g.steamAccountId), peers: g.peers || [], expiresAt: g.expiresAt || null })) : [];
      }
      if (consoleSelectedUser === id && !consoleUserDirty()) { consoleUserDraft = null; const user = state.users.find(u => u.id === id); if (user) consoleMakeUserDraft(user); }
    }
    if (consoleUserTab === 'sessions' && consoleCan('session.manage')) await consoleLoadSessions(id);
    consoleRefreshUsers();
  } catch (error) { setFeedback(errorMessage(error), 'error'); }
}
function consoleRenderUserDetail(user: User) {
  const detail = create('div', 'user-detail');
  const header = create('header', 'ud-head');
  header.append(consoleButton('返回', async () => { if (await consoleDiscard()) { consoleMobileDetail = false; consoleRefreshUsers(); } }, 'btn sm mobile-only'), consoleAvatar(displayName(user), 'lg'));
  const identity = create('div', 'ud-id'); const meta = create('p', '', `@${user.username} · ${consoleRoleName(user)} · ${user.disabled ? '已禁用' : user.locked ? '锁定' : '启用'}`);
  if (user.id === state.me?.id) meta.append(consoleBadge('你'));
  identity.append(create('h2', '', displayName(user)), meta);
  const actions = create('div', 'ud-actions');
  const protectedUser = consoleRoleId(user) === 'super' && (!state.me || consoleRoleId(state.me) !== 'super') ? '只有超级管理员可以修改超级管理员用户' : '';
  if (consoleCan('user.manage')) {
    actions.append(consoleButton('编辑', () => editUserProfile(user), 'btn sm', protectedUser), consoleButton('重置密码', () => resetUserPassword(user.id), 'btn sm', protectedUser));
    if (user.id !== state.me?.id) {
      const items = [consoleButton(user.disabled ? '启用用户' : '禁用用户', async () => {
        if (!user.disabled && !await confirmDialog('禁用此用户后，其所有会话将立即失效。确认禁用？')) return;
        await patchUser(user.id, { disabled: !user.disabled });
      }, 'btn', protectedUser), consoleButton(user.forcePasswordChange ? '取消下次登录改密' : '要求下次登录改密', () => patchUser(user.id, { forcePasswordChange: !user.forcePasswordChange }), 'btn', protectedUser), consoleButton('删除用户', () => deleteUser(user.id), 'danger', protectedUser)];
      if (user.locked) items.unshift(consoleButton('解除锁定', () => consoleUnlockUser(user.id), 'btn', protectedUser));
      actions.append(consoleMenu(items));
    }
  } else actions.append(consoleBadge('只读查看'));
  header.append(identity, actions); detail.append(header);
  const tabs = create('div', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '用户详情');
  const entries = [['overview', '概览'], ['perm', '权限'], ['grant', 'Steam 授权'], ['sessions', '会话']];
  entries.forEach(([key, label]) => {
    const tab = consoleButton(label, () => consoleSelectUser(user.id, key), consoleUserTab === key ? 'is-on' : '');
    tab.id = `consoleUserTab-${key}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(consoleUserTab === key)); tab.setAttribute('aria-controls', 'userTabBody'); tab.tabIndex = consoleUserTab === key ? 0 : -1;
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const index = entries.findIndex(([id]) => id === key);
      const target = entries[event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + entries.length) % entries.length][0];
      void consoleSelectUser(user.id, target).then(() => document.getElementById(`consoleUserTab-${consoleUserTab}`)?.focus());
    }); tabs.append(tab);
  });
  const body = create('div', 'tab-body'); body.id = 'userTabBody'; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `consoleUserTab-${consoleUserTab}`);
  if (consoleUserTab === 'overview') {
    const facts = create('dl', 'facts wide');
    for (const [name, value] of [['昵称', displayName(user)], ['账号', user.username], ['备注', user.note || '无'], ['创建时间', dateTime(user.createdAt)], ['最近登录', `${dateTime(user.lastLoginAt)} · ${user.lastLoginIp || '无 IP'}`], ['最近活跃', dateTime(user.lastSeenAt)], ['密码修改', dateTime(user.passwordChangedAt)], ['连续失败', `${user.failedLoginCount || 0} 次${user.lockedUntil ? ` · 锁定至 ${dateTime(user.lockedUntil)}` : ''}`]]) {
      const row = create('div'); row.append(create('dt', '', name), create('dd', '', value)); facts.append(row);
    }
    body.append(facts);
  } else if (consoleUserTab === 'perm') {
    if (!consolePermissionCache[user.id] || !consoleRoles.length) body.append(consoleEmpty('正在加载权限…'));
    else { consoleMakeUserDraft(user); body.append(consoleUserPermissions(user)); }
  } else if (consoleUserTab === 'grant') {
    if (!consolePermissionCache[user.id] || !consoleGrantCache[user.id]) body.append(consoleEmpty('正在加载授权…'));
    else { consoleMakeUserDraft(user); body.append(consoleUserGrants(user)); }
  } else body.append(consoleUserSessions(user));
  detail.append(tabs, body); return detail;
}
function consoleUserPermissions(user: User) {
  const content = create('div'); const draft = consoleUserDraft!;
  const self = user.id === state.me?.id; const targetSuper = draft.roleId === 'super';
  const actorSuper = state.me && consoleRoleId(state.me) === 'super';
  const roleReason = consoleBusy ? '正在保存，请稍后' : self ? '不能修改自己的角色与权限' : !consoleCan('role.manage') ? '你没有「管理角色与权限」权限' : consoleRoleId(user) === 'super' && !actorSuper ? '只有超级管理员可以修改超级管理员用户' : '';
  const overrideReason = roleReason || (targetSuper ? '超级管理员拥有全部权限' : '');
  const row = create('div', 'field-row'); const info = create('div'); info.append(create('strong', '', '角色'), create('p', 'hint', '角色提供基础权限；个人覆盖可额外授予或收回。'));
  row.append(info, consoleSelect(consoleRoles.filter(r => r.id !== 'super' || actorSuper || r.id === draft.roleId).map(r => [r.id, r.name]), draft.roleId, '用户角色', value => {
    draft.roleId = value; consoleSyncDirty(); consoleRefreshUsers();
  }, roleReason)); content.append(row);
  if (overrideReason) content.append(consoleNotice(overrideReason));
  for (const group of consolePermissionGroups) {
    const section = create('section', 'perm-group'); section.append(create('h3', '', group.name));
    for (const [permission, name, description] of group.items) {
      const effect = draft.overrides.find(o => o.permission === permission)?.effect || 'inherit';
      const permissionRow = create('div', `perm-row${effect !== 'inherit' ? ' is-override' : ''}`);
      const copy = create('div', 'perm-copy'); copy.append(create('strong', '', name), create('code', '', permission), create('p', '', description));
      const segment = consoleSegment([['inherit', '继承'], ['grant', '授予'], ['revoke', '收回']], effect, name, value => {
        if (value === 'grant' && !consoleCan(permission)) { setFeedback('不能授予自己没有的权限', 'error'); return; }
        draft.overrides = draft.overrides.filter(o => o.permission !== permission);
        if (value !== 'inherit') draft.overrides.push({ permission, effect: value as 'grant' | 'revoke' });
        consoleSyncDirty(); consoleRefreshUsers();
      }, overrideReason);
      const result = consoleEffective(user, permission); const effective = create('span', `eff${result.effective ? ' is-on' : ''}`);
      const text = create('span', '', result.effective ? '✓ 有效' : '✗ 无'); text.append(create('small', '', result.source)); effective.append(text);
      permissionRow.append(copy, segment, effective); section.append(permissionRow);
    }
    content.append(section);
  }
  return content;
}
function consoleExpirySoon(value: string | null) { const time = value ? Date.parse(value) : 0; return time > Date.now() && time - Date.now() <= 7 * 86400000; }
function consoleLocalDate(value: string | null) {
  if (!value) return ''; const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function consoleEndOfDay(date: string) { const value = new Date(`${date}T23:59:59`); if (!Number.isFinite(value.getTime())) throw new Error('请选择有效日期'); return value.toISOString(); }
function consoleUserGrants(user: User) {
  const content = create('div'); const draft = consoleUserDraft!;
  const all = consoleEffective(user, 'steam.account.all').effective;
  const disabled = consoleBusy ? '正在保存，请稍后' : all ? '以完整 · 全部会话访问所有账户，下列设置不生效' : !consoleCan('steam.grant.manage') ? '你没有「分配 Steam 授权」权限，只能查看' : '';
  if (disabled) content.append(consoleNotice(disabled, all ? 'accent' : ''));
  if (!consoleEffective(user, 'chat.use').effective) content.append(consoleNotice('该用户没有「使用聊天」权限，Steam 授权暂不生效。', 'warn'));
  if (!state.steamAccounts.length) content.append(consoleEmpty('暂无 Steam 账户'));
  for (const account of state.steamAccounts) {
    let grant = draft.grants.find(g => g.steamAccountId === account.id);
    // Empty cards do not mutate the baseline until an actual edit.
    if (!grant) grant = { steamAccountId: account.id, level: 'none', scope: 'all', peers: [], expiresAt: null };
    const current = grant;
    const change = (mutate: () => void) => { if (!draft.grants.includes(current)) draft.grants.push(current); mutate(); consoleSyncDirty(); consoleRefreshUsers(); };
    const reason = disabled || (!account.enabled ? '账户已禁用，授权暂不生效' : '');
    const card = create('article', `grant-card${current.level === 'none' ? ' is-none' : ''}${!account.enabled ? ' is-disabled' : ''}`);
    const header = create('header'); const identity = create('div'); identity.append(create('strong', '', account.label || account.steamId), create('small', '', account.enabled ? account.steamId : `${account.steamId} · 账户已禁用，授权暂不生效`));
    header.append(consoleAvatar(account.label || account.steamId), identity, consoleSegment([['none', '无'], ['read', '只读'], ['chat', '聊天'], ['full', '完整']], all ? 'full' : current.level, `账户 ${account.id} 授权等级`, value => change(() => { current.level = value as ConsoleGrant['level']; }), reason)); card.append(header);
    if (current.level !== 'none' && !all) {
      const scope = create('div', 'grant-line'); scope.append(create('span', '', '会话范围'), consoleSegment([['all', '全部会话'], ['some', '指定好友']], current.scope, `账户 ${account.id} 会话范围`, value => change(() => { current.scope = value as 'all' | 'some'; }), reason)); card.append(scope);
      if (current.scope === 'some') {
        const chips = create('div', 'friend-chips');
        for (const id of current.peers) {
          const friend = state.friends.find(f => f.id === id); const chip = create('span', 'fchip', friend?.name || id);
          if (!reason) { const remove = consoleButton('×', () => change(() => { current.peers = current.peers.filter(peer => peer !== id); })); remove.setAttribute('aria-label', `移除 ${friend?.name || id}`); chip.append(remove); }
          chips.append(chip);
        }
        chips.append(consoleButton('+ 添加好友', () => consolePickPeers(account, current, () => { if (!draft.grants.includes(current)) draft.grants.push(current); consoleSyncDirty(); consoleRefreshUsers(); }), 'fchip add', reason)); card.append(chips);
        card.append(create('p', 'hint', '仅可见指定好友的会话、历史和实时消息，不能新建会话或查看群组。'));
        if (!current.peers.length) card.append(consoleNotice('未选择任何好友', 'warn'));
      }
      const expiry = create('div', 'grant-line');
      const select = consoleSelect([['forever', '永久'], ['7', '7 天'], ['30', '30 天'], ['custom', '自定义日期']], current.expiresAt ? 'custom' : 'forever', `账户 ${account.id} 有效期`, value => {
        if (value === 'custom') { date.hidden = false; date.focus(); return; }
        change(() => { current.expiresAt = value === 'forever' ? null : consoleEndOfDay(consoleLocalDate(new Date(Date.now() + Number(value) * 86400000).toISOString())); });
      }, reason);
      const date = create('input'); date.type = 'date'; date.setAttribute('aria-label', '授权到期日期'); date.value = consoleLocalDate(current.expiresAt); date.min = consoleLocalDate(new Date().toISOString()); date.hidden = !current.expiresAt; date.disabled = Boolean(reason);
      date.addEventListener('change', () => { if (date.value) change(() => { current.expiresAt = consoleEndOfDay(date.value); }); });
      expiry.append(create('span', '', '有效期'), select, date);
      if (consoleExpirySoon(current.expiresAt)) expiry.append(consoleBadge('7 天内到期', 'warn'));
      if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) expiry.append(consoleBadge('已到期', 'warn'));
      card.append(expiry);
      const capabilities = create('ul', 'caps'); const levels = ['none', 'read', 'chat', 'full'];
      for (const [level, label] of [['read', '查看会话与历史'], ['chat', '发送文字与 Steam 表情'], ['full', '图片、贴纸、效果与回应']]) {
        const on = levels.indexOf(current.level) >= levels.indexOf(level); capabilities.append(create('li', on ? 'is-on' : '', `${on ? '✓' : '✗'} ${label}`));
      }
      card.append(capabilities);
    }
    content.append(card);
  }
  return content;
}
async function consolePickPeers(account: SteamAccount, grant: ConsoleGrant, changed: () => void) {
  const selected = new Set(grant.peers); let friends: ListEntry[] = [];
  const form = create('form', 'form-grid'); const note = create('p', 'hint', '可搜索、多选；最多 500 位好友。已有 SteamID 即使不在当前好友列表中也会保留。');
  const search = consoleInput(form, 'query', '搜索好友或 SteamID'); const rows = create('div', 'rows');
  const status = create('p', 'hint'); form.append(note, status, rows);
  const draw = () => {
    clear(rows); const query = search.value.toLowerCase();
    const candidates = new Map(friends.map(f => [f.id, f]));
    for (const id of selected) if (!candidates.has(id)) candidates.set(id, { id, name: id });
    for (const friend of candidates.values()) {
      if (!`${friend.name || ''} ${friend.id}`.toLowerCase().includes(query)) continue;
      const label = create('label', 'perm-row check'); const checkbox = create('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(friend.id);
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(friend.id); else selected.delete(friend.id); status.textContent = `已选择 ${selected.size} 位好友`; });
      label.append(checkbox, create('span', '', `${friend.name || friend.id} · ${friend.id}`)); rows.append(label);
    }
    if (!rows.childElementCount) rows.append(consoleEmpty('没有匹配的好友'));
  };
  search.addEventListener('input', draw);
  const manual = consoleInput(form, 'steamId', '添加 SteamID64（17 位数字）'); manual.inputMode = 'numeric';
  form.append(consoleButton('加入名单', () => { const id = manual.value.trim(); if (!/^\d{17}$/.test(id)) { status.textContent = '请输入 17 位数字 SteamID64'; return; } selected.add(id); manual.value = ''; draw(); }));
  consoleDialog(`指定好友 · ${account.label || account.steamId}`, form, async () => {
    if (selected.size > 500) throw new Error('最多选择 500 位好友');
    grant.peers = [...selected]; changed();
  }, '确定');
  draw();
  try {
    const payload = await api(`/api/friends?${new URLSearchParams({ steamAccountId: account.steamId })}`);
    friends = Array.isArray(payload) ? payload as ListEntry[] : isRecord(payload) && Array.isArray(payload.friends) ? payload.friends as ListEntry[] : [];
    status.textContent = `已选择 ${selected.size} 位好友`; draw();
  } catch (error) { status.textContent = `${errorMessage(error)}；仍可通过 SteamID 添加好友。`; }
}
function consoleUserSessions(user: User) {
  const content = create('div', 'sessions');
  if (!consoleCan('session.manage')) { content.append(consoleNotice('你没有「管理会话」权限')); return content; }
  const sessions = state.userSessions[user.id];
  if (!sessions) { content.append(consoleEmpty('正在加载会话…')); return content; }
  for (const session of sessions) {
    const row = create('div', 'session'); const copy = create('div');
    const current = (session as UserSession & { current?: boolean; isCurrent?: boolean }).current || (session as UserSession & { isCurrent?: boolean }).isCurrent;
    const name = create('strong', '', session.userAgent || '未知设备'); if (current) name.append(consoleBadge('当前', 'accent'));
    copy.append(name, create('small', '', `${session.ip || '未知 IP'} · 最近活跃 ${dateTime(session.lastSeenAt)} · 到期 ${dateTime(session.expiresAt)}`));
    row.append(copy, consoleButton('踢下线', () => revokeSession(user.id, session.id), 'btn sm danger-ghost')); content.append(row);
  }
  if (!sessions.length) content.append(consoleEmpty('暂无活动会话'));
  else content.append(consoleButton('踢下线全部会话', () => revokeUserSessions(user.id), 'btn danger-ghost'));
  return content;
}
async function consoleLoadUsers() {
  if (!consoleCan('user.view') && !consoleCan('user.manage')) return;
  const revision = ++consoleUsersRevision;
  try {
    const payload = await api('/api/users');
    if (revision !== consoleUsersRevision) return;
    state.users = isRecord(payload) && Array.isArray(payload.users) ? payload.users as User[] : [];
    consoleRefreshUsers(); consoleRefreshRoles();
    if (consoleSelectedUser && consoleUserTab !== 'overview' && document.querySelector('#consoleUsersContent')) await consoleLoadUserData(consoleSelectedUser);
  } catch (error) { setFeedback(errorMessage(error), 'error'); }
}
function consoleCreateUser() {
  const form = create('form', 'form-grid two');
  const username = consoleInput(form, 'username', '账号'); username.required = true; username.minLength = 3; username.maxLength = 64; username.autocomplete = 'off';
  const display = consoleInput(form, 'displayName', '昵称'); display.maxLength = 80;
  const password = consoleInput(form, 'password', '初始密码', '', 'password'); password.required = true; password.minLength = 8; password.autocomplete = 'new-password';
  const note = consoleInput(form, 'note', '备注'); note.maxLength = 500;
  const roleLabel = create('label', '', '角色'); let roleId = 'member';
  const roles = consoleRoles.length ? consoleRoles : [{ id: 'member', name: '成员' }];
  const options: [string, string][] = roles.filter(r => r.id !== 'super' || (state.me && consoleRoleId(state.me) === 'super')).map(r => [r.id, r.name]);
  roleLabel.append(consoleSelect(options, roleId, '新用户角色', value => { roleId = value; }, consoleCan('role.manage') ? '' : '需要管理角色权限，默认使用成员角色')); form.append(roleLabel);
  const force = consoleCheck(form, 'forcePasswordChange', '首次登录要求改密', true);
  consoleDialog('新增用户', form, async () => {
    await api('/api/users', jsonBody({ username: username.value, displayName: display.value, password: password.value, note: note.value, ...(consoleCan('role.manage') ? { roleId } : {}), forcePasswordChange: force.checked }));
    consoleSuccess(); await loadUsers();
  }, '新增用户');
}
function consoleEditUser(user: User) {
  const form = create('form', 'form-grid');
  const display = consoleInput(form, 'displayName', '昵称', user.displayName); display.maxLength = 80;
  const note = consoleInput(form, 'note', '备注', user.note); note.maxLength = 500;
  consoleDialog('编辑资料', form, async () => { await consoleWrite(`/api/users/${user.id}`, { displayName: display.value, note: note.value }); consoleSuccess(); await loadUsers(); });
}
function consoleResetPassword(id: number) {
  const form = create('form', 'form-grid'); const password = consoleInput(form, 'password', '新密码', '', 'password'); password.required = true; password.minLength = 8; password.autocomplete = 'new-password';
  const force = consoleCheck(form, 'forcePasswordChange', '要求下次登录修改', true);
  consoleDialog('重置密码', form, async () => { await api(`/api/users/${id}/password`, jsonBody({ password: password.value, forcePasswordChange: force.checked })); setFeedback('密码已重置，已写入审计日志', 'ok'); await loadUsers(); }, '重置密码');
}
async function consolePatchUser(id: number, patch: Record<string, unknown>) { await consoleWrite(`/api/users/${id}`, patch); consoleSuccess(); await loadUsers(); }
async function consoleUnlockUser(id: number) { await api(`/api/users/${id}/unlock`, jsonBody({})); consoleSuccess(); await loadUsers(); }
async function consoleDeleteUser(id: number) {
  if (!await confirmDialog('删除此后台用户后，其所有会话将立即失效，个人权限覆盖与 Steam 授权也会删除。确认删除？')) return;
  await api(`/api/users/${id}`, { method: 'DELETE' });
  if (consoleSelectedUser === id) { consoleSelectedUser = 0; consoleUserDraft = null; consoleUserBase = ''; consoleSyncDirty(); }
  delete consolePermissionCache[id]; delete consoleGrantCache[id]; delete state.userSessions[id]; delete state.userSteamAccounts[id];
  consoleSuccess(); await loadUsers();
}
async function consoleLoadSessions(id: number) {
  if (!consoleCan('session.manage')) return;
  const payload = await api(`/api/users/${id}/sessions`);
  state.userSessions[id] = isRecord(payload) && Array.isArray(payload.sessions) ? payload.sessions as UserSession[] : [];
  consoleRefreshUsers();
}
async function consoleRevokeSession(userId: number, sessionId?: string) {
  if (!await confirmDialog(sessionId ? '确认踢下线此会话？该设备需要重新登录。' : '确认踢下线全部会话？该用户所有设备都需要重新登录。')) return;
  await api(`/api/users/${userId}/sessions${sessionId ? `/${encodeURIComponent(sessionId)}` : ''}`, { method: 'DELETE' });
  await consoleLoadSessions(userId); consoleSuccess();
}
async function consoleLoadUserGrants(id: number) {
  consoleUserTab = 'grant'; await loadSteamAccounts(); await consoleLoadUserData(id);
}
async function consoleSaveLegacyGrants(id: number, ids: number[]) {
  const grants = ids.map<ConsoleGrant>(steamAccountId => ({ steamAccountId, level: 'full', scope: 'all', peers: [], expiresAt: null }));
  await consoleWrite(`/api/users/${id}/steam-accounts`, { grants }, 'PUT');
  delete consoleGrantCache[id]; await consoleLoadUserData(id, true); consoleSuccess(); await loadUsers();
}

async function loadRoles() {
  if (!consoleCan('role.manage') && !consoleCan('user.view')) return;
  try {
    const payload = await api('/api/roles');
    consoleRoles = isRecord(payload) && Array.isArray(payload.roles) ? payload.roles as ConsoleRole[] : [];
    consoleRefreshUsers(); consoleRefreshRoles();
  } catch (error) { setFeedback(errorMessage(error), 'error'); }
}
function consoleRefreshRoles() {
  const host = document.querySelector<HTMLElement>('#consoleRolesContent'); if (!host) return;
  clear(host); host.append(consoleRolesContent());
}
function renderRolesView() {
  const host = create('div', 'roles-view'); host.id = 'consoleRolesContent'; host.append(consoleRolesContent()); return host;
}
function consoleRolePermissions(role: ConsoleRole) { return role.id === 'super' ? consolePermissionGroups.flatMap(g => g.items.map(p => p[0])) : consoleRoleDrafts[role.id] || role.permissions; }
function consoleRoleEditable(role: ConsoleRole, permission?: string) {
  return consoleBusy ? '正在保存，请稍后' : role.id === 'super' ? '超级管理员拥有全部权限，不可修改' : !consoleCan('role.manage') ? '你没有「管理角色与权限」权限' : permission && !consoleCan(permission) ? '不能授予自己没有的权限' : '';
}
function consoleToggleRolePermission(role: ConsoleRole, permission: string, checked: boolean) {
  const permissions = new Set(consoleRolePermissions(role)); if (checked) permissions.add(permission); else permissions.delete(permission);
  const next = consolePermissionGroups.flatMap(g => g.items.map(p => p[0])).filter(p => permissions.has(p));
  if (JSON.stringify([...next].sort()) === JSON.stringify([...role.permissions].sort())) delete consoleRoleDrafts[role.id];
  else consoleRoleDrafts[role.id] = next;
  consoleSyncDirty(); consoleRefreshRoles();
}
function consoleRoleCheckbox(role: ConsoleRole, permission: string, name: string) {
  const input = create('input'); input.type = 'checkbox'; input.checked = consoleRolePermissions(role).includes(permission);
  const reason = consoleRoleEditable(role, input.checked ? undefined : permission); input.disabled = Boolean(reason); input.title = reason || `${role.name}：${name}`;
  input.setAttribute('aria-label', `${role.name}：${name}`);
  input.addEventListener('change', () => consoleToggleRolePermission(role, permission, input.checked)); return input;
}
function consoleRolesContent() {
  const content = create('div'); const toolbar = create('div', 'toolbar');
  toolbar.append(consoleSegment([['role', '按角色'], ['matrix', '权限对照表']], consoleRoleMode, '角色展示方式', async value => { if (!await consoleDiscard()) return; consoleRoleMode = value; consoleRefreshRoles(); }));
  if (consoleCan('role.manage')) toolbar.append(consoleButton('新建角色', () => consoleRoleDialog(), 'btn primary'));
  content.append(toolbar);
  if (!consoleRoles.length) { content.append(consoleEmpty('暂无角色')); return content; }
  if (consoleRoleMode === 'matrix') {
    const wrap = create('div', 'card matrix-wrap'); const table = create('table', 'matrix');
    const head = create('thead'); const headings = create('tr'); headings.append(create('th', '', '权限点'));
    for (const role of consoleRoles) headings.append(create('th', '', `${role.name}${role.builtin ? ' · 内置' : ''}`)); head.append(headings); table.append(head);
    const body = create('tbody');
    for (const group of consolePermissionGroups) {
      const groupRow = create('tr', 'mg'); const cell = create('td', '', group.name); cell.colSpan = consoleRoles.length + 1; groupRow.append(cell); body.append(groupRow);
      for (const [permission, name] of group.items) {
        const row = create('tr'); const label = create('td'); label.append(create('strong', '', name), create('code', '', permission)); row.append(label);
        for (const role of consoleRoles) { const cell = create('td'); cell.append(consoleRoleCheckbox(role, permission, name)); row.append(cell); } body.append(row);
      }
    }
    table.append(body); wrap.append(table); content.append(wrap); return content;
  }
  const selected = consoleRoles.find(r => r.id === consoleSelectedRole) || consoleRoles[0]; consoleSelectedRole = selected.id;
  const split = create('div', 'split roles-split'); split.dataset.mobileDetail = String(consoleRoleMobileDetail);
  const list = create('section', 'card list-pane'); const rows = create('div', 'rows');
  for (const role of consoleRoles) {
    const row = consoleButton('', async () => { if (role.id !== consoleSelectedRole && !await consoleDiscard()) return; consoleSelectedRole = role.id; consoleRoleMobileDetail = true; consoleRefreshRoles(); }, `urow${role.id === selected.id ? ' is-active' : ''}`);
    const copy = create('span', 'urow-body'); const title = create('span'); title.append(create('strong', '', role.name)); if (role.builtin) title.append(consoleBadge('内置'));
    copy.append(title, create('small', '', `${role.memberCount || 0} 名成员 · ${consoleRolePermissions(role).length} 项权限`)); row.append(create('span', 'role-ic', '◇'), copy); rows.append(row);
  }
  list.append(rows); const detail = create('section', 'card detail-pane'); const header = create('header', 'ud-head');
  header.append(consoleButton('返回', async () => { if (await consoleDiscard()) { consoleRoleMobileDetail = false; consoleRefreshRoles(); } }, 'btn sm mobile-only'));
  const identity = create('div', 'ud-id'); identity.append(create('h2', '', selected.name), create('p', '', selected.description)); header.append(identity);
  const actions = create('div', 'ud-actions');
  if (selected.builtin) actions.append(consoleBadge(selected.id === 'super' ? '不可修改' : '不可删除'));
  if (consoleCan('role.manage') && selected.id !== 'super') {
    actions.append(consoleButton(selected.builtin ? '编辑说明' : '重命名', () => consoleRoleDialog(selected), 'btn sm'));
    if (!selected.builtin) actions.append(consoleButton('删除角色', () => consoleDeleteRole(selected), 'btn sm danger-ghost', selected.memberCount ? `删除前需先把 ${selected.memberCount} 名成员改为其他角色` : ''));
  }
  header.append(actions); detail.append(header);
  const members = create('div', 'members'); members.append(create('span', 'hint', '成员'));
  const users = state.users.filter(user => consoleRoleId(user) === selected.id);
  for (const user of users) members.append(consoleButton(displayName(user), () => consoleGotoUser(user.id, 'overview'), 'fchip'));
  if (!users.length) members.append(create('span', 'hint', '暂无成员')); detail.append(members);
  const body = create('div', 'tab-body');
  if (selected.memberCount) body.append(create('p', 'hint', `删除前需先把 ${selected.memberCount} 名成员改为其他角色。`));
  for (const group of consolePermissionGroups) {
    const section = create('section', 'perm-group'); section.append(create('h3', '', group.name));
    for (const [permission, name, description] of group.items) {
      const label = create('label', 'perm-row check'); const copy = create('div', 'perm-copy'); copy.append(create('strong', '', name), create('code', '', permission), create('p', '', description));
      label.append(consoleRoleCheckbox(selected, permission, name), copy); section.append(label);
    }
    body.append(section);
  }
  detail.append(body); split.append(list, detail); content.append(split); return content;
}
async function consoleRoleDialog(role?: ConsoleRole) {
  if (!await consoleDiscard()) return;
  const form = create('form', 'form-grid'); const name = consoleInput(form, 'name', '名称', role?.name || ''); name.required = true; name.maxLength = 32; name.disabled = Boolean(role?.builtin);
  const description = consoleInput(form, 'description', '说明', role?.description || ''); description.maxLength = 200;
  let source = '';
  if (!role) { const label = create('label', '', '复制权限自'); label.append(consoleSelect([['', '不复制'], ...consoleRoles.map(r => [r.id, r.name] as [string, string])], '', '复制权限自', value => { source = value; })); form.append(label); }
  consoleDialog(role ? '编辑角色' : '新建角色', form, async () => {
    const permissions = source ? consoleRolePermissions(consoleRoles.find(r => r.id === source)!) : [];
    if (permissions.some(p => !consoleCan(p))) throw new Error('不能授予自己没有的权限，请选择其他来源角色');
    if (role) await consoleWrite(`/api/roles/${encodeURIComponent(role.id)}`, { ...(!role.builtin ? { name: name.value } : {}), description: description.value });
    else await api('/api/roles', jsonBody({ name: name.value, description: description.value, permissions }));
    consoleSuccess(); await loadRoles();
  }, role ? '保存' : '新建角色');
}
async function consoleDeleteRole(role: ConsoleRole) {
  if (!await consoleDiscard() || !await confirmDialog(`确认删除角色「${role.name}」？`)) return;
  await api(`/api/roles/${encodeURIComponent(role.id)}`, { method: 'DELETE' }); consoleSuccess(); await loadRoles();
}
async function consoleGotoUser(id: number, tab: string) {
  if (!consoleCan('user.view')) { setFeedback('需要查看用户权限才能打开用户详情', 'error'); return; }
  if (!await consoleDiscard()) return;
  consoleSelectedUser = id; consoleUserTab = tab; consoleUserDraft = null; consoleUserBase = ''; consoleMobileDetail = true;
  await openConsole('users'); await loadUsers(); await consoleLoadUserData(id);
}

function consoleRenderSteamAccountsView() {
  const view = create('div', 'steam-accounts-view');
  const connection = create('div'); connection.id = 'consoleSteamConnection'; connection.append(consoleSteamConnection()); view.append(connection);
  const card = create('section', 'card'); const header = create('header', 'card-head'); const title = create('div'); title.append(create('h3', '', '账户'), create('p', '', '同一时间只有一个活动账户在线')); header.append(title);
  if (consoleCan('steam.manage')) header.append(consoleButton('添加账户', consoleOpenSteamLogin, 'btn primary'));
  const table = create('div', 'table account-table'); table.id = 'steamAccountTable'; consoleRenderSteamAccountTable(table); card.append(header, table); view.append(card);
  if (consoleCan('steam.grant.manage')) {
    const overview = create('section', 'card'); const header = create('header', 'card-head'); const title = create('div'); title.append(create('h3', '', '授权概览'), create('p', '', '用户 × 账户 · 点击进入用户的 Steam 授权')); header.append(title); overview.append(header);
    const matrix = create('div', 'grant-matrix'); matrix.id = 'consoleGrantOverview'; consoleRenderOverview(matrix); overview.append(matrix); view.append(overview);
  }
  return view;
}
function consoleSteamConnection() {
  const card = create('section', 'card conn'); const account = state.steamAccounts.find(a => a.active);
  const main = create('div', 'conn-main'); const identity = create('div'); identity.append(create('span', `status ${steamOnline() ? 'is-online' : 'is-off'}`, steamLabel()), create('h2', '', account?.label || state.steam.activeAccount?.label || '当前没有连接'), create('p', 'mono', account?.steamId || state.steam.steamId || ''));
  main.append(consoleAvatar(account?.label || 'Steam', 'lg'), identity); const actions = create('div', 'conn-actions');
  if (consoleCan('steam.manage')) {
    const accounts = state.steamAccounts.filter(a => a.enabled);
    const selector = consoleSelect([['', '切换账户'], ...accounts.map(a => [String(a.id), a.label || a.steamId] as [string, string])], '', '切换 Steam 账户', value => { if (value) return connectSteamAccount(Number(value)); }, steamLoginBlocked() ? 'Steam 登录处理中，请稍后' : ''); actions.append(selector);
    if (steamOnline()) {
      const logout = consoleButton('退出 Steam', async () => {
        if (account) await logoutSteamAccount(account.id);
        else if (await confirmDialog('退出 Steam 将删除保存的登录 Token，所有用户暂时无法聊天。确认退出？')) { updateSteamStatus(await api('/api/steam/logout', { method: 'POST' }) as SteamStatus); await loadSteamAccounts(); }
      }, 'btn danger-ghost'); logout.id = 'steamLogout'; actions.append(logout);
    } else actions.append(consoleButton('连接', () => state.steam.requiresGuard || !account?.enabled ? consoleOpenSteamLogin() : connectSteamAccount(account.id), 'btn primary', steamLoginBlocked() && !state.steam.requiresGuard ? 'Steam 登录处理中' : ''));
  } else actions.append(create('span', 'hint', '你没有登录或切换 Steam 的权限'));
  const facts = create('dl', 'conn-facts');
  for (const [name, text] of [['最近登录', dateTime(account?.lastLoginAt)], ['Token 更新', dateTime(account?.refreshTokenUpdatedAt)], ['授权用户', `${account?.authorizedUserCount || 0} 人`], ['消息存储', storageHealthText(storageHealth)]]) {
    const item = create('div'); item.append(create('dt', '', name), create('dd', '', text)); facts.append(item);
  }
  card.append(main, actions, facts); return card;
}
function consoleRenderSteamAccountTable(container: HTMLElement) {
  clear(container);
  for (const account of state.steamAccounts) {
    const row = create('article', 'trow account-row'); const info = create('div', 'cell grow'); const copy = create('div');
    copy.append(create('strong', '', account.label || account.steamId), create('small', 'mono', `${account.steamId}${account.accountNameHint ? ` · ${account.accountNameHint}` : ''}`)); info.append(consoleAvatar(account.label || account.steamId), copy);
    const status = create('div', 'cell'); status.append(consoleBadge(account.active ? '当前活动' : account.enabled ? '已启用' : '已禁用', account.active ? 'accent' : account.enabled ? 'ok' : 'muted'));
    const users = create('div', 'cell hide-sm', `授权 ${account.authorizedUserCount || 0} 人`); const seen = create('div', 'cell hide-sm', dateTime(account.lastActiveAt)); const actions = create('div', 'cell actions');
    if (consoleCan('steam.manage') && !account.active && account.enabled) {
      const connect = consoleButton('连接', () => connectSteamAccount(account.id), 'btn sm steam-account-connect', steamLoginBlocked() ? 'Steam 登录处理中' : ''); connect.dataset.unavailable = 'false'; actions.append(connect);
    }
    const menu: HTMLElement[] = [];
    if (consoleCan('steam.account.manage')) menu.push(consoleButton('编辑资料', () => editSteamAccount(account)), consoleButton(account.enabled ? '禁用' : '启用', async () => {
      if (account.enabled && !await confirmDialog('禁用账户后，其全部授权暂不生效。确认禁用？')) return;
      await patchSteamAccount(account.id, { enabled: !account.enabled });
    }));
    if (consoleCan('steam.manage') && account.active) menu.push(consoleButton('退出登录', () => logoutSteamAccount(account.id)));
    if (consoleCan('steam.account.manage')) menu.push(consoleButton('删除', () => deleteSteamAccount(account.id), 'danger'));
    if (menu.length) actions.append(consoleMenu(menu)); row.append(info, status, users, seen, actions); container.append(row);
  }
  if (!state.steamAccounts.length) container.append(consoleEmpty('暂无 Steam 账户'));
}
async function consoleLoadSteamAccounts() {
  try {
    const payload = await api('/api/steam/accounts');
    state.steamAccounts = isRecord(payload) && Array.isArray(payload.steamAccounts) ? payload.steamAccounts as SteamAccount[] : [];
    const table = document.querySelector<HTMLElement>('#steamAccountTable'); if (table) consoleRenderSteamAccountTable(table);
    const connection = document.querySelector<HTMLElement>('#consoleSteamConnection'); if (connection) { clear(connection); connection.append(consoleSteamConnection()); }
    consoleRefreshUsers();
    if (consoleCan('steam.grant.manage')) await consoleLoadOverview();
  } catch (error) { setFeedback(errorMessage(error), 'error'); }
}
async function consoleLoadOverview() {
  try {
    const payload = await api('/api/steam/grants');
    if (isRecord(payload) && Array.isArray(payload.accounts) && Array.isArray(payload.users)) consoleOverview = payload as unknown as ConsoleOverview;
    const matrix = document.querySelector<HTMLElement>('#consoleGrantOverview'); if (matrix) consoleRenderOverview(matrix);
  } catch (error) { setFeedback(errorMessage(error), 'error'); }
}
function consoleRenderOverview(container: HTMLElement) {
  clear(container);
  if (!consoleOverview) { container.append(consoleEmpty('正在加载授权概览…')); return; }
  container.style.setProperty('--cols', String(consoleOverview.accounts.length));
  const head = create('div', 'gm-head'); head.append(create('span', '', '用户')); for (const account of consoleOverview.accounts) head.append(create('span', '', account.label || account.steamId)); container.append(head);
  const labels: Record<string, string> = { none: '无', read: '只读', chat: '聊天', full: '完整' };
  for (const user of consoleOverview.users) {
    const row = consoleButton('', () => consoleGotoUser(user.id, 'grant'), 'gm-row', consoleCan('user.view') ? '' : '需要查看用户权限'); row.append(create('span', 'gm-user', user.displayName || user.username));
    for (const account of consoleOverview.accounts) {
      const grant = user.grants[String(account.id)]; const expired = grant?.expiresAt && Date.parse(grant.expiresAt) <= Date.now();
      const level = user.all && account.enabled ? 'full' : expired || !account.enabled ? 'none' : grant?.level || 'none';
      const badge = create('span', `lvl lvl-${level}${consoleExpirySoon(grant?.expiresAt) ? ' warn' : ''}`, user.all ? (account.enabled ? '全部（权限）' : '账户已禁用') : `${labels[level] || level}${grant?.scope === 'some' ? ` · ${grant.peerCount} 人` : ''}${consoleExpirySoon(grant?.expiresAt) ? ' · 即将到期' : ''}`);
      badge.title = grant?.expiresAt ? `至 ${dateTime(grant.expiresAt)}` : '永久'; row.append(badge);
    }
    container.append(row);
  }
}
function consoleEditSteamAccount(account: SteamAccount) {
  const form = create('form', 'form-grid'); const label = consoleInput(form, 'label', '显示名称', account.label); label.maxLength = 80;
  const hint = consoleInput(form, 'accountNameHint', '账号提示', account.accountNameHint); hint.maxLength = 80;
  consoleDialog('编辑账户资料', form, async () => { await consoleWrite(`/api/steam/accounts/${account.id}`, { label: label.value, accountNameHint: hint.value }); consoleSuccess(); await loadSteamAccounts(); });
}
async function consoleConnectSteamAccount(id: number) {
  if (steamLoginBlocked()) return;
  updateSteamStatus(await api(`/api/steam/accounts/${id}/connect`, { method: 'POST' }) as SteamStatus); await loadSteamAccounts();
}
async function consolePatchSteamAccount(id: number, patch: Record<string, unknown>) { await consoleWrite(`/api/steam/accounts/${id}`, patch); consoleSuccess(); await loadSteamAccounts(); }
async function consoleLogoutSteamAccount(id: number) {
  if (!await confirmDialog('退出 Steam 将删除保存的登录 Token，所有用户暂时无法使用该账户聊天。确认退出？')) return;
  updateSteamStatus(await api(`/api/steam/accounts/${id}/logout`, { method: 'POST' }) as SteamStatus); await loadSteamAccounts();
}
async function consoleDeleteSteamAccount(id: number) {
  if (!await confirmDialog('删除此 Steam 账户资料和全部授权关系？该账户历史消息将保留。')) return;
  await api(`/api/steam/accounts/${id}`, { method: 'DELETE' }); consoleSuccess(); await loadSteamAccounts();
}
function consoleOpenSteamLogin() {
  consoleLoginAlreadyOnline = steamOnline();
  const content = create('div'); const tabs = create('div', 'tabs'); const body = create('div'); body.id = 'consoleSteamLoginBody';
  const draw = () => {
    clear(tabs);
    for (const [key, label] of [['qr', '扫码登录'], ['password', '密码登录']]) tabs.append(consoleButton(label, () => { consoleLoginTab = key; consoleLoginMode = ''; draw(); }, consoleLoginTab === key ? 'is-on' : ''));
    consoleSyncSteamLoginDialog();
  };
  content.append(tabs, body); openDialog('添加 Steam 账户', content); consoleLoginMode = ''; draw();
  // Keep the modal's Guard and success steps current without rebuilding the chat shell.
  // The interval is disposed as soon as this dialog leaves the document.
  const timer = window.setInterval(() => {
    if (!content.isConnected) { window.clearInterval(timer); return; }
    consoleSyncSteamLoginDialog();
  }, 500);
}
function consoleSyncSteamLoginDialog() {
  const body = document.querySelector<HTMLElement>('#consoleSteamLoginBody'); if (!body) return;
  const mode = `${consoleLoginTab}|${state.steam.requiresGuard ? `guard|${state.steam.guardType}|${state.steam.lastCodeWrong}` : steamOnline() ? 'done' : ['logging_in', 'reconnecting'].includes(state.steam.status) ? 'connecting' : 'login'}`;
  if (mode === consoleLoginMode) { const qr = body.querySelector<HTMLElement>('#steamQrLogin'); if (qr) syncSteamQrLogin(qr); return; }
  consoleLoginMode = mode; clear(body);
  if (steamOnline()) {
    if (consoleLoginAlreadyOnline) {
      body.append(consoleNotice('当前 Steam 已在线，添加其他账户前请先退出当前账户。'));
      body.append(consoleButton('退出当前账户并添加', async () => {
        const account = state.steamAccounts.find(a => a.active);
        if (account) await consoleLogoutSteamAccount(account.id);
        else if (await confirmDialog('退出 Steam 后，所有用户暂时无法聊天。确认退出？')) updateSteamStatus(await api('/api/steam/logout', { method: 'POST' }) as SteamStatus);
        if (!steamOnline()) { consoleLoginAlreadyOnline = false; consoleLoginMode = ''; consoleSyncSteamLoginDialog(); }
      }, 'btn danger-ghost'));
    } else { body.append(consoleNotice('已登录，账户已添加。', 'accent')); void loadSteamAccounts(); }
    return;
  }
  if (state.steam.requiresGuard) {
    const form = create('form', 'form-grid'); form.append(create('p', '', state.steam.guardType === 'email' ? `输入邮箱验证码${state.steam.domain ? `（${state.steam.domain}）` : ''}` : '输入 Steam 令牌验证码'));
    if (state.steam.lastCodeWrong) form.append(consoleNotice('上一次验证码被拒绝，请输入新的验证码。', 'warn'));
    const boxes = create('div', 'otp guard-code'); const inputs: HTMLInputElement[] = [];
    for (let i = 0; i < 5; i++) {
      const input = create('input'); input.maxLength = 1; input.size = 1; input.required = true; input.autocomplete = i === 0 ? 'one-time-code' : 'off'; input.setAttribute('aria-label', `验证码第 ${i + 1} 位`);
      input.addEventListener('input', () => { input.value = input.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(-1); if (input.value) inputs[i + 1]?.focus(); });
      input.addEventListener('keydown', event => { if (event.key === 'Backspace' && !input.value) inputs[i - 1]?.focus(); });
      input.addEventListener('paste', event => { const value = event.clipboardData?.getData('text').replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase(); if (!value) return; event.preventDefault(); [...value].forEach((char, index) => { inputs[index].value = char; }); inputs[Math.min(value.length, 4)].focus(); });
      inputs.push(input); boxes.append(input);
    }
    const error = create('p', 'form-error'); error.setAttribute('role', 'alert'); const submit = create('button', 'btn primary', '提交验证'); submit.type = 'submit'; form.append(boxes, error, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true;
      try { updateSteamStatus(await api('/api/steam/guard', jsonBody({ code: inputs.map(i => i.value).join('') })) as SteamStatus); consoleSyncSteamLoginDialog(); }
      catch (reason) { error.textContent = errorMessage(reason); }
      finally { submit.disabled = false; }
    }); body.append(form); return;
  }
  if (['logging_in', 'reconnecting'].includes(state.steam.status)) { body.append(consoleNotice('正在连接 Steam…')); return; }
  if (consoleLoginTab === 'qr') { body.append(renderSteamQrLogin()); return; }
  const form = create('form', 'form-grid steam-password-login steam-account-login');
  const label = consoleInput(form, 'label', '显示名称'); label.maxLength = 80;
  const username = consoleInput(form, 'accountName', 'Steam 账号'); username.required = true; username.autocomplete = 'username';
  const password = consoleInput(form, 'password', 'Steam 密码', '', 'password'); password.required = true; password.autocomplete = 'current-password';
  const logon = consoleInput(form, 'logonID', 'Logon ID（可选）'); logon.inputMode = 'numeric';
  const error = create('p', 'form-error', state.steam.error || ''); error.setAttribute('role', 'alert'); const submit = create('button', 'btn primary', '登录账户'); submit.type = 'submit'; form.append(error, submit);
  form.addEventListener('submit', async event => { event.preventDefault(); await submitSteamPassword(form, '/api/steam/accounts/login'); error.textContent = state.steam.error || ''; consoleSyncSteamLoginDialog(); }); body.append(form); syncSteamLoginUi();
}

const consoleAuditActions: Record<string, string> = {
  'role.create': '新建角色', 'role.update': '修改角色', 'role.delete': '删除角色',
  'user.create': '新增用户', 'user.update': '修改用户', 'user.delete': '删除用户', 'user.unlock': '解除用户锁定',
  'user.password.reset': '重置密码', 'user.password_reset': '重置密码', 'user.role.change': '修改用户角色',
  'user.permission_overrides.update': '修改个人权限覆盖',
  'steam_account.grant_update': '修改 Steam 授权', 'steam_account.grant_replace': '替换 Steam 授权',
  'steam_account.update': '修改 Steam 账户', 'steam_account.delete': '删除 Steam 账户', 'steam_account.connect': '连接 Steam 账户', 'steam_account.login': '登录 Steam 账户', 'steam_account.logout': '退出 Steam 账户',
  'steam.login': '登录 Steam', 'steam.logout': '退出 Steam', 'steam.guard': '提交 Steam 验证',
  'session.revoke': '踢下线会话', 'session.revoke_user': '踢下线全部会话',
  'auth.login': '用户登录', 'auth.login_failed': '登录失败', 'auth.logout': '退出登录', 'auth.logout_all': '退出所有设备', 'auth.password.change': '修改密码', 'auth.setup': '初始化管理员'
};
function consoleAuditCategoryFor(action: string) {
  return action.startsWith('steam_account.grant_') ? 'grant' : action.startsWith('role.') || action === 'user.role.change' || action === 'user.permission_overrides.update' ? 'role' : action.startsWith('user.') ? 'user' : action.startsWith('steam.') || action.startsWith('steam_account.') ? 'steam' : 'session';
}
function consoleRenderAuditView() {
  const view = create('div', 'audit-view'); const toolbar = create('form', 'toolbar audit-filters');
  const search = create('input'); search.type = 'search'; search.placeholder = '搜索操作者、动作、目标、IP'; search.setAttribute('aria-label', search.placeholder); search.value = consoleAuditQuery;
  const range = consoleSelect([['7', '最近 7 天'], ['30', '最近 30 天'], ['', '全部']], consoleAuditDays, '时间范围', value => { consoleAuditDays = value; return loadAuditLogs(); });
  const submit = create('button', 'btn', '搜索'); submit.type = 'submit'; toolbar.append(search, range, submit);
  toolbar.addEventListener('submit', event => { event.preventDefault(); consoleAuditQuery = search.value; void loadAuditLogs(); });
  const chips = create('div', 'chips');
  for (const [key, name] of [['', '全部'], ['grant', 'Steam 授权'], ['role', '角色与权限'], ['user', '用户'], ['steam', 'Steam'], ['session', '会话']]) {
    const chip = consoleButton(name, async () => { consoleAuditCategory = key; for (const button of chips.querySelectorAll('button')) button.classList.toggle('is-on', button === chip); await loadAuditLogs(); }, `chip${consoleAuditCategory === key ? ' is-on' : ''}`); chips.append(chip);
  }
  const card = create('section', 'card'); const table = create('div', 'audit audit-table'); table.id = 'auditTable'; consoleRenderAuditTable(table); card.append(table); view.append(toolbar, chips, card); return view;
}
function consoleAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.map(consoleAuditValue).join('、') : '无';
  if (isRecord(value)) return Object.entries(value).map(([key, entry]) => `${key}：${consoleAuditValue(entry)}`).join('；') || '无';
  return String(value);
}
function consoleRenderAuditTable(container: HTMLElement) {
  clear(container);
  for (const item of state.auditLogs) {
    const category = consoleAuditCategoryFor(item.action); const row = create('details', 'arow'); const summary = create('summary', 'arow-main');
    const icon = create('span', `cat cat-${category}`); icon.append(chatIcon(category === 'grant' ? 'shield' : category === 'role' ? 'settings-2' : category === 'user' ? 'users' : category === 'steam' ? 'gamepad-2' : 'log-out'));
    const body = create('span', 'arow-body'); body.append(create('strong', '', consoleAuditActions[item.action] || item.action), create('small', '', `${item.actorUsername || item.actorUserId || '系统'} → ${item.targetType}:${item.targetId}`));
    const meta = create('span', 'arow-meta'); meta.append(create('time', '', dateTime(item.createdAt)), create('small', 'mono', item.ip || '无 IP')); summary.append(icon, body, meta);
    const diff = create('table', 'diff'); const head = create('thead'); const headings = create('tr'); for (const name of ['字段', '之前', '之后']) headings.append(create('th', '', name)); head.append(headings); diff.append(head);
    const changes = isRecord(item.detail) && Array.isArray(item.detail.changes) ? item.detail.changes.filter(isRecord) : [];
    const rows = changes.length ? changes.map(change => ({ field: String(change.field || '字段'), before: change.before, after: change.after })) : Object.entries(item.detail || {}).map<{ field: string; before: unknown; after: unknown }>(([field, after]) => ({ field, before: null, after }));
    const tbody = create('tbody');
    for (const change of rows) { const tr = create('tr'); tr.append(create('td', '', change.field), create('td', 'before', consoleAuditValue(change.before)), create('td', 'after', consoleAuditValue(change.after))); tbody.append(tr); }
    if (!rows.length) { const tr = create('tr'); const cell = create('td', '', '无字段变更详情'); cell.colSpan = 3; tr.append(cell); tbody.append(tr); }
    diff.append(tbody); row.append(summary, diff); container.append(row);
  }
  if (!state.auditLogs.length) container.append(consoleEmpty('没有匹配的记录'));
}
async function consoleLoadAuditLogs() {
  if (!consoleCan('audit.view')) return;
  const revision = ++consoleAuditRevision;
  try {
    const params = new URLSearchParams({ limit: '500' });
    if (consoleAuditQuery) params.set('query', consoleAuditQuery);
    if (consoleAuditCategory) params.set('category', consoleAuditCategory);
    if (consoleAuditDays) params.set('from', new Date(Date.now() - Number(consoleAuditDays) * 86400000).toISOString());
    if (state.auditAction) params.set('action', state.auditAction);
    if (state.auditTargetType) params.set('targetType', state.auditTargetType);
    const payload = await api(`/api/audit-logs?${params}`);
    if (revision !== consoleAuditRevision) return;
    state.auditLogs = isRecord(payload) && Array.isArray(payload.auditLogs) ? payload.auditLogs as AuditLog[] : [];
    const table = document.querySelector<HTMLElement>('#auditTable'); if (table) consoleRenderAuditTable(table);
  } catch (error) { setFeedback(errorMessage(error), 'error'); }
}
