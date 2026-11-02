// Steam Chat redesign prototype (selected direction C: minimal focus) plus the authorization v2 model.
// Isolated from production: mock data only, nothing is sent anywhere. Spec: ../../docs/web-redesign.md, ../../docs/authorization-v2.md
const PAGES = {
  chat: { label: '聊天', icon: 'messages-square', allow: () => can('chat.use') },
  accounts: { label: 'Steam 账户', icon: 'shield', desc: '连接状态、账户资料与授权概览', allow: () => can('steam.manage') || can('steam.account.manage') || can('steam.grant.manage') },
  users: { label: '用户', icon: 'users', desc: '后台用户、个人权限、Steam 授权与登录会话', allow: () => can('user.view') || can('user.manage') },
  roles: { label: '角色与权限', icon: 'key-round', desc: '角色决定基础权限，可对单个用户覆盖', allow: () => can('role.manage') },
  audit: { label: '审计日志', icon: 'scroll-text', desc: '关键管理动作，敏感字段已脱敏', allow: () => can('audit.view') },
  emotes: { label: '图片表情', icon: 'image', desc: '共享图片表情的分组与素材', allow: () => can('emote.manage') },
  settings: { label: '设置', icon: 'settings', desc: '通知、应用安装、我的权限与账号安全', allow: () => true }
};
const ADMIN = ['accounts', 'users', 'roles', 'audit', 'emotes'];
const ACTIVE_ACCOUNT = 1;

const clone = v => JSON.parse(JSON.stringify(v));
let users = clone(USERS);
let roles = clone(ROLES);
const audit = clone(AUDIT);
const emoteGroups = clone(EMOTE_GROUPS);
const unread = Object.fromEntries(FRIENDS.map(f => [f.id, f.unread || 0]));
const DRAFT_IMAGES = [A + 'stardew.jpg', A + 'cs2.jpg', A + 'dota.jpg'];

const qs = new URLSearchParams(location.search);
const S = {
  page: PAGES[qs.get('page')] || qs.get('page') === 'login' ? qs.get('page') : 'chat',
  persona: PERSONAS[qs.get('as')] ? qs.get('as') : 'admin',
  theme: ['light', 'dark'].includes(qs.get('theme')) ? qs.get('theme') : 'auto',
  phone: qs.get('phone') === '1',
  steamOnline: true, storageOk: true, dragging: false, loginError: false,
  tab: 'recent', query: '', active: FRIENDS[0].id, mobileThread: qs.get('thread') === '1',
  details: false, datePop: false, picker: false, pickerTab: 'emote', detached: false, ctx: null,
  drafts: {}, imageDrafts: {}, transfers: [], sent: {}, closed: new Set(),
  userSel: 2, userTab: qs.get('utab') || 'grant', userQuery: '', userFilter: 'all', mobileDetail: false,
  roleSel: 'cs', roleView: 'role', auditCat: 'all', auditOpen: 0, auditQuery: '', emoteGroup: 'common',
  modal: null, menu: null, palette: false, paletteQuery: '', loginMode: 'login',
  snapshot: null, scrollBottom: true,
  settings: { notify: true, bgOnly: true }
};

// ---------- Authorization model (see docs/authorization-v2.md) ----------
const roleOf = u => roles.find(r => r.id === u.role) || roles[1];
function effective(u, p) {
  const r = roleOf(u);
  if (r.id === 'super') return { on: true, src: '角色「超级管理员」' };
  const o = u.overrides[p];
  if (o === 'grant') return { on: true, src: '个人授予' };
  if (o === 'revoke') return { on: false, src: '个人收回' };
  return r.perms.includes(p) ? { on: true, src: `角色「${r.name}」` } : { on: false, src: '未授予' };
}
const me = () => users.find(u => u.id === PERSONAS[S.persona].user);
const can = p => effective(me(), p).on;
function grantFor(u, accountId) {
  if (effective(u, 'steam.account.all').on) return { level: 'full', scope: 'all', friends: [], expires: '', all: true };
  return u.grants[accountId] || { level: 'none', scope: 'all', friends: [], expires: '' };
}
const myGrant = () => grantFor(me(), ACTIVE_ACCOUNT);
const levelName = l => LEVELS.find(x => x[0] === l)[1];
const levelAtLeast = (g, l) => LEVELS.findIndex(x => x[0] === g.level) >= LEVELS.findIndex(x => x[0] === l);
const scopeOk = id => { const g = myGrant(); return g.scope !== 'some' || g.friends.includes(id); };
const firstAllowed = () => Object.keys(PAGES).find(p => PAGES[p].allow());

// ---------- Helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, cls = '') => `<i data-lucide="${n}" class="ic ${cls}" aria-hidden="true"></i>`;
const ib = (icon, label, act, extra = '', cls = 'icon-btn') => `<button type="button" class="${cls}" data-act="${act}" title="${label}" aria-label="${label}" ${extra}>${ic(icon)}</button>`;
const attrs = o => Object.entries(o).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
const btn = (label, act, o = {}, cls = 'btn', icon = '') => `<button type="button" class="${cls}" data-act="${act}" ${attrs(o)}>${icon ? ic(icon) : ''}<span>${label}</span></button>`;
const all = [...FRIENDS, ...GROUPS];
const byId = id => all.find(x => x.id === id);
const STATUS = { game: '游戏中', online: '在线', away: '离开', offline: '离线' };
function statusText(x) {
  if (x.group) return 'Steam 社区群组';
  return x.presence === 'game' ? `正在玩 ${x.game}` : x.presence === 'offline' ? `${x.lastOnline}在线` : STATUS[x.presence];
}
function av(x, size = 'md', dot = true) {
  const initial = [...x.name.trim()][0].toUpperCase();
  return `<span class="av av-${size}${x.group ? ' is-group' : ''}" style="--h:${x.hue}">${esc(initial)}${dot && !x.group && x.presence ? `<i class="dot p-${x.presence}"></i>` : ''}</span>`;
}
const userAv = (u, size = 'md') => av({ name: u.display || u.username, hue: (u.id * 67) % 360 }, size, false);
const accAv = (a, size = 'md') => `<span class="av av-${size} is-steam">${ic('gamepad-2')}</span>`;
const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
const seg = (items, value, act, o = {}, disabled = false) => `<div class="seg" role="radiogroup">${items.map(([v, label]) =>
  `<button type="button" role="radio" aria-checked="${v === value}" class="${v === value ? 'is-on' : ''}" data-act="${act}" ${attrs({ ...o, v })} ${disabled ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
const toggle = (on, act, o = {}, disabled = false) => `<button type="button" role="switch" aria-checked="${on}" class="switch${on ? ' is-on' : ''}" data-act="${act}" ${attrs(o)} ${disabled ? 'disabled' : ''}><i></i></button>`;
const userStatus = u => u.status === 'locked' ? badge('已锁定', 'warn') : u.status === 'disabled' ? badge('已禁用', 'muted') : badge('启用', 'ok');
const levelBadge = g => g.level === 'none' ? '<span class="lvl lvl-none">—</span>' : `<span class="lvl lvl-${g.level}">${levelName(g.level)}${g.scope === 'some' ? ` · ${g.friends.length} 人` : ''}</span>`;
const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

function toast(text) {
  const node = $('#toast');
  node.textContent = text; node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2600);
}
function mutate(fn) {
  if (!S.snapshot) S.snapshot = clone({ users, roles });
  fn();
}

// ---------- Conversation list ----------
function entries() {
  const g = myGrant();
  let list = S.tab === 'groups' ? GROUPS : S.tab === 'friends' ? FRIENDS : S.tab === 'unread' ? FRIENDS.filter(f => unread[f.id]) : FRIENDS.filter(f => !S.closed.has(f.id));
  if (g.scope === 'some') list = list.filter(x => !x.group && g.friends.includes(x.id));
  const q = S.query.trim().toLowerCase();
  return q ? list.filter(x => x.name.toLowerCase().includes(q) || (x.nickname || '').includes(q) || x.id.includes(q)) : list;
}
function activeConv() {
  const g = myGrant();
  let conv = byId(S.active);
  if (!conv || (g.scope === 'some' && !g.friends.includes(conv.id))) {
    conv = FRIENDS.find(f => scopeOk(f.id)) || null;
    if (conv) S.active = conv.id;
  }
  return conv;
}
const chatBlocked = () => myGrant().level === 'none';
const canOpenAny = () => { const g = myGrant(); return g.scope !== 'some' && levelAtLeast(g, 'chat'); };

function convRow(x) {
  const n = unread[x.id] || 0;
  return `<button type="button" class="conv${x.id === S.active ? ' is-active' : ''}" data-act="open" data-id="${x.id}" data-ctx="${S.tab === 'recent' ? x.id : ''}" aria-current="${x.id === S.active}">
    ${av(x)}<span class="conv-body"><span class="conv-top"><strong>${esc(x.name)}</strong><time>${esc(x.time)}</time></span>
    <span class="conv-bottom"><span class="conv-preview">${esc(x.preview)}</span>${n ? `<span class="unread">${n}</span>` : ''}</span></span></button>`;
}
function convTabs(items) {
  return `<div class="conv-tabs" role="tablist">${items.map(([t, label]) => `<button type="button" role="tab" aria-selected="${S.tab === t}" class="${S.tab === t ? 'is-on' : ''}" data-act="tab" data-t="${t}">${label}</button>`).join('')}</div>`;
}
const searchBox = (placeholder, id, input, value) =>
  `<label class="search">${ic('search')}<input id="${id}" type="search" placeholder="${placeholder}" value="${esc(value)}" data-input="${input}" autocomplete="off"></label>`;
function convListBody() {
  const items = entries();
  if (!items.length) return `<div class="empty-small">${myGrant().scope === 'some' ? '你的授权范围内没有匹配的会话' : '没有匹配的会话'}</div>`;
  return items.map(convRow).join('');
}
function scopeNotice() {
  const g = myGrant();
  if (g.all || g.level === 'none') return '';
  const scope = g.scope === 'some' ? `仅 ${g.friends.length} 位指定好友` : '全部会话';
  return `<div class="scope-note">${ic('shield-check')}<span>主号 · Dove：<b>${levelName(g.level)}</b> · ${scope}${g.expires ? ` · 至 ${g.expires}` : ''}</span></div>`;
}
function contextMenu() {
  if (!S.ctx) return '';
  const x = byId(S.ctx.id);
  return `<div class="menu ctx-menu" style="left:${S.ctx.x}px;top:${S.ctx.y}px">
    ${btn('打开会话', 'open', { id: x.id }, '', 'message-square')}${unread[x.id] ? btn('标为已读', 'markRead', { id: x.id }, '', 'check') : ''}
    ${btn('关闭会话', 'closeConv', { id: x.id }, 'danger', 'x')}</div>`;
}

// ---------- Messages ----------
function msgBody(m) {
  if (m.t === 'image') return `<button type="button" class="msg-image" data-act="lightbox" data-src="${m.img}"><img src="${m.img}" alt="图片" width="460" height="215"></button>`;
  if (m.t === 'og') return `<a class="og" href="#" data-act="noop"><img src="${m.img}" alt=""><span class="og-copy"><small>${esc(m.url)}</small><strong>${esc(m.title)}</strong><span>${esc(m.desc)}</span></span></a>`;
  if (m.t === 'sticker') return `<span class="sticker">${esc(m.text)}</span>`;
  if (m.t === 'effect') return `<span class="effect">${ic('sparkles')} 聊天效果：${esc(m.text)}</span>`;
  const emote = m.t === 'emote' ? ` <img class="emoticon" src="${EMOTICONS.find(e => e.name === m.emote).img}" alt=":${m.emote}:">` : '';
  return `<p>${esc(m.text)}${emote}</p>`;
}
const SEND_STATE = {
  sending: ['clock', '发送中'],
  failed: ['circle-alert', '发送失败'],
  unknown: ['circle-help', '结果未确认，请先检查聊天记录'],
  retry_wait: ['refresh-cw', '图片上传超时 · 12 秒后重试 · 第 2/5 次']
};
function sendState(m, i) {
  const s = SEND_STATE[m.state];
  if (!s) return '';
  // Retrying is a send, so it needs the same grant as the composer.
  const action = !levelAtLeast(myGrant(), 'chat') ? '' : m.state === 'failed' ? `<button type="button" data-act="retry" data-i="${i}">重试</button>`
    : m.state === 'retry_wait' ? `<button type="button" data-act="retry" data-i="${i}">立即重试</button><button type="button" data-act="toastClose" data-v="已停止重试">停止</button>` : '';
  return `<span class="send-state is-${m.state}">${ic(s[0])}${s[1]}${action}</span>`;
}
function msgRow(m, conv, cont, i) {
  const who = m.self ? { name: 'Dove', hue: 210 } : conv;
  const full = levelAtLeast(myGrant(), 'full') && S.steamOnline;
  const reacts = (m.reactions || []).map(r => `<button type="button" class="react${r.mine ? ' is-mine' : ''}" data-act="react" ${full ? '' : 'disabled title="表情回应需要「完整」授权"'}><img src="${EMOTICONS.find(e => e.name === r.e).img}" alt=":${r.e}:">${r.n}</button>`).join('');
  const state = sendState(m, i);
  return `<article class="msg${m.self ? ' is-self' : ''}${cont ? ' is-cont' : ''}" data-state="${m.state || ''}">
    <span class="msg-av">${cont ? '' : av(who, 'sm', false)}</span>
    <div class="msg-main">
      ${cont ? '' : `<header class="msg-head"><strong>${esc(who.name)}</strong>${m.self ? '<span class="me-tag">我</span>' : ''}<time>${m.time}</time></header>`}
      <div class="msg-body">${msgBody(m)}</div>
      ${reacts || state ? `<div class="msg-foot">${reacts}${state}</div>` : ''}
    </div>
    <div class="msg-tools">${ib('smile', full ? '添加回应' : '表情回应需要「完整」授权', 'react', full ? '' : 'disabled')}${ib('copy', '复制', 'copy')}</div>
  </article>`;
}
function messages(conv) {
  const base = S.detached ? ARCHIVE : (THREADS[conv.id] || [{ day: '今天' }, { self: false, time: conv.time || '刚刚', t: 'text', text: conv.preview }]);
  const list = S.detached ? base : base.concat(S.sent[conv.id] || []);
  let prev = null;
  const rows = list.map((m, i) => {
    if (m.day) { prev = null; return `<div class="day"><span>${m.day}</span></div>`; }
    const html = msgRow(m, conv, prev && prev.self === m.self && !m.state, i);
    prev = m;
    return html;
  }).join('');
  const detached = S.detached ? `<div class="detached">${ic('history')}<span>正在查看 10 月 26 日的历史</span><button type="button" data-act="latest">回到最新 ${ic('arrow-down')}</button></div>` : '';
  return `<div class="messages" id="messages" data-scroll><div class="messages-inner"><div class="older-auto">${ic('arrow-up')}向上滚动自动加载更早的消息</div>${rows}</div></div>${detached}`;
}
function datePopover() {
  if (!S.datePop) return '';
  return `<div class="popover date-pop" role="dialog" aria-label="跳转到日期">
    <strong>跳转到日期</strong>
    <div class="quick">${['昨天', '上周一', '一个月前'].map(t => `<button type="button" class="chip" data-act="jump">${t}</button>`).join('')}</div>
    <input type="datetime-local" value="2026-10-26T21:00" aria-label="日期和时间">
    <button type="button" class="btn primary" data-act="jump"><span>跳转</span></button>
    <p class="hint">跳转后可继续向上或向下浏览，随时回到最新。</p>
  </div>`;
}
function picker() {
  if (!S.picker) return '';
  const full = levelAtLeast(myGrant(), 'full');
  const tabs = [['emote', '表情'], ['sticker', '贴纸'], ['effect', '效果'], ['custom', '自定义']];
  let body = '';
  if (S.pickerTab === 'emote') body = EMOTICONS.map(e => `<button type="button" data-act="insert" data-v=":${e.name}:" title=":${e.name}:"><img src="${e.img}" alt=""></button>`).join('') + UNICODE.map(u => `<button type="button" data-act="insert" data-v="${u}">${u}</button>`).join('');
  else if (!full) body = `<div class="picker-locked">${ic('lock')}<span>贴纸、聊天效果和自定义图片需要「完整」授权</span></div>`;
  else if (S.pickerTab === 'sticker') body = STICKERS.map(s => `<button type="button" class="big" data-act="sendRich" data-t="sticker" data-v="${s}">${s}</button>`).join('');
  else if (S.pickerTab === 'effect') body = EFFECTS.map(s => `<button type="button" class="wide" data-act="sendRich" data-t="effect" data-v="${s}">${s}</button>`).join('');
  else body = emoteGroups.flatMap(g => g.items).map(e => `<button type="button" class="big" data-act="sendRich" data-t="image" data-v="${e.img}" title="${e.name}"><img src="${e.img}" alt=""></button>`).join('');
  return `<div class="popover picker" role="dialog" aria-label="表情和贴纸">
    <div class="picker-tabs">${tabs.map(([t, l]) => `<button type="button" class="${S.pickerTab === t ? 'is-on' : ''}" data-act="pickerTab" data-t="${t}">${l}</button>`).join('')}</div>
    <div class="picker-grid${S.pickerTab === 'effect' ? ' is-list' : ''}">${body}</div></div>`;
}
function composer(conv) {
  const g = myGrant();
  // Permanent reasons (read-only grant, group) win over the transient offline state; read-only drops the input entirely.
  if (g.level === 'read') return `<footer class="composer"><div class="composer-note is-muted">${ic('lock')}<span>你在「主号 · Dove」上的授权为<b>只读</b>：可以浏览会话和历史，不能发送消息。</span></div></footer>`;
  let note = '';
  if (conv.group) note = `${ic('info')}<span>这是 Steam 社区群组，尚未接入群聊频道。可在资料中打开群组主页。</span>`;
  else if (!S.steamOnline) note = `${ic('wifi-off')}<span>Steam 未在线，暂时不能发送。草稿会保留，连接恢复后可继续。</span>`;
  const off = Boolean(note);
  const media = levelAtLeast(g, 'full');
  const drafts = S.imageDrafts[conv.id] || [];
  const transfers = S.transfers.filter(t => t.conv === conv.id);
  return `<footer class="composer">
    ${note ? `<div class="composer-note">${note}</div>` : ''}
    ${picker()}
    ${transfers.length ? `<div class="transfers">${transfers.map(t => `<div class="transfer"><img src="${t.img}" alt=""><span><strong>${t.name}</strong><small>${t.pct < 100 ? `上传中 ${t.pct}%` : '处理中…'}</small></span><i style="--p:${t.pct}%"></i>${ib('x', '取消', 'cancelTransfer', `data-id="${t.id}"`, 'icon-btn xs')}</div>`).join('')}</div>` : ''}
    <div class="composer-box${off ? ' is-off' : ''}">
      ${drafts.length ? `<div class="image-drafts">${drafts.map(d => `<span class="image-draft"><img src="${d.img}" alt="待发送图片">${ib('x', '移除', 'removeDraft', `data-id="${d.id}"`, 'icon-btn xs')}</span>`).join('')}</div>` : ''}
      <div class="composer-row">
        ${ib('smile', '表情和贴纸', 'picker', off ? 'disabled' : `aria-expanded="${S.picker}"`, 'icon-btn tool')}
        ${ib('image-plus', media ? '添加图片（也可粘贴或拖入）' : '发送图片需要「完整」授权', 'attach', off || !media ? 'disabled' : '', 'icon-btn tool')}
        <textarea id="composer" rows="1" placeholder="${off ? '' : `发送给 ${esc(conv.name)}`}" data-input="draft" ${off ? 'disabled' : ''} aria-label="消息">${esc(S.drafts[conv.id] || '')}</textarea>
        ${ib('send', '发送（Enter）', 'send', off ? 'disabled' : '', 'icon-btn send')}
      </div>
    </div>
    ${g.level === 'chat' && !off ? `<p class="composer-hint">${ic('info')}聊天授权：可发送文字与 Steam 表情；图片、贴纸、效果和回应需要「完整」授权。</p>` : ''}
  </footer>`;
}
function profileFacts(conv) {
  const g = myGrant();
  const rows = [
    ['SteamID', `<span class="mono">${conv.id}</span>${ib('copy', '复制 SteamID', 'copy', '', 'icon-btn xs')}`],
    ['关系', conv.group ? 'Steam 社区群组' : 'Steam 好友'],
    ...(conv.nickname ? [['备注', esc(conv.nickname)]] : []),
    ['当前账户', '主号 · Dove'],
    ['我的授权', g.all ? '完整 · 全部账户' : `${levelName(g.level)} · ${g.scope === 'some' ? '指定好友' : '全部会话'}`]
  ];
  return `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}
function gameCard(conv) {
  if (conv.presence !== 'game') return '';
  return `<div class="game-card"><img src="${conv.art}" alt=""><div><small>正在玩</small><strong>${esc(conv.game)}</strong><span>${esc(conv.rich)}</span>
    <a href="#" data-act="noop">商店页面 ${ic('external-link')}</a></div></div>`;
}
function profilePanel(conv) {
  return `<div class="profile">
    <div class="profile-id">${av(conv, 'xl')}<h3>${esc(conv.name)}</h3><span class="presence-text p-${conv.presence || 'group'}">${esc(statusText(conv))}</span>
      <a href="#" class="link" data-act="noop">${conv.group ? '群组主页' : 'Steam 主页'} ${ic('external-link')}</a></div>
    ${gameCard(conv)}${profileFacts(conv)}</div>`;
}
function emptyState(icon, title, text) {
  return `<div class="empty-state">${ic(icon, 'big')}<strong>${title}</strong><span>${text}</span></div>`;
}

// ---------- Console pages ----------
function pageHead(page, actions = '') {
  return `<header class="page-head"><div><h1>${PAGES[page].label}</h1><p>${PAGES[page].desc}</p></div><div class="page-actions">${actions}</div></header>`;
}
function accountsContent() {
  const active = STEAM_ACCOUNTS.find(a => a.active);
  const manage = can('steam.manage');
  const online = S.steamOnline;
  const conn = `<section class="card conn">
    <div class="conn-main">${accAv(active, 'lg')}
      <div><span class="status ${online ? 'is-online' : 'is-off'}"><i></i>${online ? '在线' : '未连接'}</span><h2>${active.label}</h2><p class="mono">${active.steamId}</p></div></div>
    <div class="conn-actions">${manage ? (online ? btn('切换账户', 'menu', { m: 'switch' }, 'btn', 'refresh-cw') + btn('退出 Steam', 'confirm', { k: 'steamLogout' }, 'btn danger-ghost', 'power') : btn('连接', 'steamToggle', {}, 'btn primary', 'power')) : '<span class="hint">你没有登录或切换 Steam 的权限</span>'}
      ${S.menu === 'switch' ? `<div class="menu">${STEAM_ACCOUNTS.filter(a => a.enabled).map(a => `<button type="button" data-act="toastClose" data-v="已切换到 ${a.label}">${accAv(a, 'xs')}<span>${a.label}</span>${a.active ? ic('check') : ''}</button>`).join('')}</div>` : ''}</div>
    <dl class="conn-facts"><div><dt>最近登录</dt><dd>今天 09:12</dd></div><div><dt>Token 更新</dt><dd>${active.token}</dd></div><div><dt>授权用户</dt><dd>${active.users} 人</dd></div><div><dt>消息存储</dt><dd>${S.storageOk ? '<span class="status is-online"><i></i>正常</span>' : '<span class="status is-warn"><i></i>历史索引正在同步</span>'}</dd></div></dl>
  </section>`;
  const rows = STEAM_ACCOUNTS.map(a => `<div class="trow">
      <div class="cell grow">${accAv(a)}<div><strong>${a.label}</strong><small class="mono">${a.steamId}${a.hint ? ` · ${a.hint}` : ''}</small></div></div>
      <div class="cell">${a.active ? badge('当前活动', 'accent') : a.enabled ? badge('已启用', 'ok') : badge('已禁用', 'muted')}</div>
      <div class="cell hide-sm"><small>授权</small>${a.users} 人</div>
      <div class="cell hide-sm"><small>活跃</small>${a.lastActive}</div>
      <div class="cell actions">${manage && !a.active && a.enabled ? btn('连接', 'toastClose', { v: `正在连接 ${a.label}…` }, 'btn sm') : ''}${can('steam.account.manage') ? ib('ellipsis', '更多操作', 'menu', `data-m="acct${a.id}"`) : ''}
        ${S.menu === `acct${a.id}` ? `<div class="menu">${btn('编辑资料', 'modal', { m: 'editAccount' }, '', 'pencil')}${btn(a.enabled ? '禁用' : '启用', 'toastClose', { v: a.enabled ? '已禁用' : '已启用' }, '', 'power')}${a.active ? btn('退出登录', 'confirm', { k: 'steamLogout' }, '', 'log-out') : ''}${btn('删除', 'confirm', { k: 'deleteAccount' }, 'danger', 'trash-2')}</div>` : ''}</div>
    </div>`).join('');
  const list = `<section class="card"><header class="card-head"><div><h3>账户</h3><p>同一时间只有一个活动账户在线</p></div>${manage ? btn('添加账户', 'modal', { m: 'addSteam' }, 'btn primary', 'plus') : ''}</header><div class="table">${rows}</div></section>`;
  const overview = can('steam.grant.manage') ? `<section class="card"><header class="card-head"><div><h3>授权概览</h3><p>谁能以什么等级访问哪个账户 · 点击进入用户的 Steam 授权</p></div></header>
    <div class="grant-matrix" style="--cols:${STEAM_ACCOUNTS.length}"><div class="gm-head"><span>用户</span>${STEAM_ACCOUNTS.map(a => `<span>${a.label}</span>`).join('')}</div>
    ${users.map(u => `<button type="button" class="gm-row" data-act="gotoGrant" data-id="${u.id}"><span class="gm-user">${userAv(u, 'xs')}${esc(u.display)}</span>${STEAM_ACCOUNTS.map(a => levelBadge(grantFor(u, a.id))).join('')}</button>`).join('')}</div></section>` : '';
  return conn + list + overview;
}

function usersContent() {
  const filters = [['all', '全部'], ['enabled', '启用'], ['disabled', '禁用'], ['locked', '锁定']];
  const q = S.userQuery.trim().toLowerCase();
  const list = users.filter(u => (S.userFilter === 'all' || u.status === S.userFilter) && (!q || `${u.username}${u.display}${u.note}`.toLowerCase().includes(q)));
  const sel = users.find(u => u.id === S.userSel) || users[0];
  return `<div class="split" data-mobile-detail="${S.mobileDetail}">
    <section class="card list-pane">
      <div class="list-tools">${searchBox('搜索账号、昵称、备注', 'userSearch', 'userQuery', S.userQuery)}</div>
      <div class="chips">${filters.map(([v, l]) => `<button type="button" class="chip${S.userFilter === v ? ' is-on' : ''}" data-act="userFilter" data-v="${v}">${l}<small>${v === 'all' ? users.length : users.filter(u => u.status === v).length}</small></button>`).join('')}</div>
      <div class="rows" id="userRows" data-scroll>${list.map(u => `<button type="button" class="urow${u.id === sel.id ? ' is-active' : ''}" data-act="userSel" data-id="${u.id}">
        ${userAv(u)}<span class="urow-body"><span><strong>${esc(u.display)}</strong> <small>@${u.username}</small></span><span>${badge(roleOf(u).name, roleOf(u).id === 'super' ? 'accent' : '')}${u.status !== 'enabled' ? userStatus(u) : ''}</span></span>${ic('chevron-right', 'chev')}</button>`).join('') || '<div class="empty-small">没有匹配的用户</div>'}</div>
    </section>
    <section class="card detail-pane">${userDetail(sel)}</section>
  </div>`;
}
function userDetail(u) {
  const manage = can('user.manage');
  const self = u.id === me().id;
  const tabs = [['overview', '概览'], ['perm', '权限'], ['grant', 'Steam 授权'], ['sessions', `会话 ${u.sessions.length}`]];
  let body = '';
  if (S.userTab === 'overview') body = `<dl class="facts wide">${[['昵称', esc(u.display)], ['账号', `@${u.username}`], ['备注', esc(u.note) || '<span class="hint">无</span>'], ['创建时间', u.created], ['最近登录', `${u.lastLogin} · ${u.ip}`], ['最近活跃', u.seen], ['密码修改', u.pwd], ['连续失败', `${u.failed} 次${u.status === 'locked' ? ' · 锁定 15 分钟' : ''}`]].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  else if (S.userTab === 'perm') body = permTab(u, self);
  else if (S.userTab === 'grant') body = grantTab(u);
  else body = `<div class="sessions">${u.sessions.map((s, i) => `<div class="session">${ic(s.device.includes('Android') || s.device.includes('iPhone') ? 'smartphone' : 'monitor')}<div><strong>${s.device}${s.current ? ' ' + badge('当前', 'accent') : ''}</strong><small>${s.ip} · ${s.seen}</small></div>${can('session.manage') && !s.current ? btn('踢下线', 'kick', { i }, 'btn sm danger-ghost') : ''}</div>`).join('') || '<div class="empty-small">暂无活动会话</div>'}
    ${u.sessions.length && can('session.manage') ? btn('踢下线全部会话', 'confirm', { k: 'kickAll' }, 'btn danger-ghost', 'log-out') : ''}</div>`;
  const more = S.menu === 'userMore' ? `<div class="menu">${btn(u.status === 'disabled' ? '启用用户' : '禁用用户', 'userStatus', {}, '', 'power')}${u.status === 'locked' ? btn('解除锁定', 'toastClose', { v: '已解除锁定' }, '', 'lock-open') : ''}${btn('要求下次登录改密', 'toastClose', { v: '已要求该用户下次登录修改密码' }, '', 'key-round')}${btn('删除用户', 'confirm', { k: 'deleteUser' }, 'danger', 'trash-2')}</div>` : '';
  return `<header class="ud-head">${ib('arrow-left', '返回用户列表', 'userBack', '', 'icon-btn mobile-only')}${userAv(u, 'lg')}
      <div class="ud-id"><h2>${esc(u.display)}</h2><p>@${u.username} · ${badge(roleOf(u).name, roleOf(u).id === 'super' ? 'accent' : '')} ${userStatus(u)}${self ? ' ' + badge('你', 'muted') : ''}</p></div>
      <div class="ud-actions">${manage ? btn('编辑', 'modal', { m: 'editUser' }, 'btn sm', 'pencil') + btn('重置密码', 'modal', { m: 'resetPwd' }, 'btn sm', 'key-round') + (self ? '' : ib('ellipsis', '更多', 'menu', 'data-m="userMore"')) + more : badge('只读查看', 'muted')}</div></header>
    <div class="tabs" role="tablist">${tabs.map(([t, l]) => `<button type="button" role="tab" aria-selected="${S.userTab === t}" class="${S.userTab === t ? 'is-on' : ''}" data-act="userTab" data-t="${t}">${l}</button>`).join('')}</div>
    <div class="tab-body" id="userTabBody" data-scroll>${body}</div>${saveBar()}`;
}
function permTab(u, self) {
  const editable = can('role.manage') && !self && roleOf(u).id !== 'super';
  // Changing a role is privilege assignment, so it needs role.manage, not just user.manage.
  const roleSelect = `<select data-change="userRole" ${can('role.manage') && !self ? '' : 'disabled'} aria-label="角色">${roles.map(r => `<option value="${r.id}" ${r.id === u.role ? 'selected' : ''}>${r.name}</option>`).join('')}</select>`;
  const note = self ? '不能修改自己的角色与权限，避免误把自己锁在外面。' : roleOf(u).id === 'super' ? '超级管理员拥有全部权限，不需要也不能设置个人覆盖。' : !can('role.manage') ? '你没有「管理角色与权限」权限，只能查看。' : '';
  return `<div class="field-row"><div><strong>角色</strong><p class="hint">角色提供基础权限；下方可对单项做「授予」或「收回」的个人覆盖。</p></div>${roleSelect}</div>
    ${note ? `<p class="notice">${ic('info')}${note}</p>` : ''}
    ${PERMISSION_GROUPS.map(g => `<section class="perm-group"><h4>${g.name}</h4>${g.items.map(([key, name, desc]) => {
      const eff = effective(u, key); const o = u.overrides[key] || 'inherit';
      return `<div class="perm-row${o !== 'inherit' ? ' is-override' : ''}"><div class="perm-copy"><strong>${name}</strong><code>${key}</code><p>${desc}</p></div>
        ${seg([['inherit', '继承'], ['grant', '授予'], ['revoke', '收回']], o, 'override', { p: key }, !editable)}
        <span class="eff ${eff.on ? 'is-on' : ''}">${ic(eff.on ? 'check' : 'x')}<span>${eff.on ? '有效' : '无'}<small>${eff.src}</small></span></span></div>`;
    }).join('')}</section>`).join('')}`;
}
function grantTab(u) {
  const editable = can('steam.grant.manage');
  const allAcc = effective(u, 'steam.account.all');
  const head = allAcc.on ? `<p class="notice accent">${ic('shield-check')}该用户拥有「访问全部 Steam 账户」（${allAcc.src}），以<b>完整 · 全部会话</b>访问所有账户，下列设置不生效。</p>`
    : !effective(u, 'chat.use').on ? `<p class="notice warn">${ic('triangle-alert')}该用户没有「使用聊天」权限，Steam 授权暂不生效。</p>` : '';
  const cards = STEAM_ACCOUNTS.map(a => {
    const g = u.grants[a.id] || { level: 'none', scope: 'all', friends: [], expires: '' };
    const off = !editable || allAcc.on;
    const soon = g.expires === '2026-11-09';
    const detail = g.level === 'none' ? '' : `
      <div class="grant-line"><span>会话范围</span>${seg([['all', '全部会话'], ['some', '指定好友']], g.scope, 'scope', { a: a.id }, off)}</div>
      ${g.scope === 'some' ? `<div class="friend-chips">${g.friends.map(id => { const f = byId(id); return `<span class="fchip">${av(f, 'xs', false)}${esc(f.name)}${off ? '' : `<button type="button" data-act="unpick" data-a="${a.id}" data-id="${id}" aria-label="移除 ${esc(f.name)}">${ic('x')}</button>`}</span>`; }).join('')}
        ${off ? '' : `<button type="button" class="fchip add" data-act="modal" data-m="pickFriends" data-a="${a.id}">${ic('plus')}添加好友</button>`}</div>
        <p class="hint">受限用户只能看到这些好友的会话、历史和实时消息，不能按 SteamID 新建会话，也看不到群组。</p>` : ''}
      <div class="grant-line"><span>有效期</span><select data-change="expires" data-a="${a.id}" ${off ? 'disabled' : ''}>${[['', '永久'], ['2026-11-09', '7 天（至 11 月 9 日）'], ['2026-12-02', '30 天（至 12 月 2 日）'], ['2026-12-31', '至 2026-12-31']].map(([v, l]) => `<option value="${v}" ${v === g.expires ? 'selected' : ''}>${l}</option>`).join('')}</select>${soon ? badge('7 天内到期', 'warn') : ''}</div>
      <ul class="caps">${[['查看会话与历史', 'read'], ['发送文字与 Steam 表情', 'chat'], ['图片、贴纸、效果与回应', 'full']].map(([t, l]) => { const on = levelAtLeast(g, l); return `<li class="${on ? 'is-on' : ''}">${ic(on ? 'check' : 'x')}${t}</li>`; }).join('')}</ul>`;
    return `<article class="grant-card${g.level === 'none' ? ' is-none' : ''}${a.enabled ? '' : ' is-disabled'}">
      <header>${accAv(a)}<div><strong>${a.label}</strong><small>${a.enabled ? a.steamId : '账户已禁用，授权暂不生效'}</small></div>
      ${seg(LEVELS.map(([v, l]) => [v, l]), allAcc.on ? 'full' : g.level, 'level', { a: a.id }, off)}</header>${allAcc.on ? '' : detail}</article>`;
  }).join('');
  return `${head}${!editable ? `<p class="notice">${ic('info')}你没有「分配 Steam 授权」权限，只能查看。</p>` : ''}${cards}`;
}
function saveBar() {
  if (!S.snapshot) return '';
  return `<div class="savebar">${ic('circle-alert')}<span>有未保存的更改</span>${btn('撤销', 'undo', {}, 'btn sm ghost')}${btn('保存', 'save', {}, 'btn sm primary')}</div>`;
}

function rolesContent() {
  const view = seg([['role', '按角色'], ['matrix', '权限对照表']], S.roleView, 'roleView');
  if (S.roleView === 'matrix') {
    return `<div class="toolbar">${view}</div><section class="card"><div class="matrix-wrap" data-scroll id="matrixWrap"><table class="matrix"><thead><tr><th>权限点</th>${roles.map(r => `<th>${r.name}${r.builtin ? ic('lock', 'tiny') : ''}</th>`).join('')}</tr></thead>
      <tbody>${PERMISSION_GROUPS.map(g => `<tr class="mg"><td colspan="${roles.length + 1}">${g.name}</td></tr>${g.items.map(([k, n]) => `<tr><td><strong>${n}</strong><code>${k}</code></td>${roles.map(r => `<td><input type="checkbox" data-act="rolePerm" data-r="${r.id}" data-p="${k}" ${r.perms.includes(k) ? 'checked' : ''} ${r.id === 'super' ? 'disabled' : ''} aria-label="${r.name}：${n}"></td>`).join('')}</tr>`).join('')}`).join('')}</tbody></table></div>${saveBar()}</section>`;
  }
  const r = roles.find(x => x.id === S.roleSel) || roles[0];
  const members = users.filter(u => u.role === r.id);
  return `<div class="toolbar">${view}</div><div class="split roles-split" data-mobile-detail="${S.mobileDetail}">
    <section class="card list-pane"><div class="list-tools"><strong class="pane-title">角色</strong>${ib('plus', '新建角色', 'modal', 'data-m="newRole"', 'icon-btn solid')}</div>
      <div class="rows">${roles.map(x => `<button type="button" class="urow${x.id === r.id ? ' is-active' : ''}" data-act="roleSel" data-id="${x.id}"><span class="role-ic">${ic(x.id === 'super' ? 'shield-check' : 'key-round')}</span><span class="urow-body"><span><strong>${x.name}</strong>${x.builtin ? ' ' + badge('内置', 'muted') : ''}</span><small>${users.filter(u => u.role === x.id).length} 名成员 · ${x.perms.length} 项权限</small></span>${ic('chevron-right', 'chev')}</button>`).join('')}</div></section>
    <section class="card detail-pane"><header class="ud-head">${ib('arrow-left', '返回角色列表', 'userBack', '', 'icon-btn mobile-only')}<span class="role-ic lg">${ic(r.id === 'super' ? 'shield-check' : 'key-round')}</span><div class="ud-id"><h2>${r.name}</h2><p>${r.desc}</p></div>
      <div class="ud-actions">${r.builtin ? badge(r.id === 'super' ? '不可修改' : '不可删除', 'muted') : btn('重命名', 'modal', { m: 'newRole' }, 'btn sm', 'pencil') + btn('删除角色', 'confirm', { k: 'deleteRole' }, 'btn sm danger-ghost', 'trash-2')}</div></header>
      <div class="members"><span class="hint">成员</span>${members.map(u => `<button type="button" class="fchip" data-act="gotoUser" data-id="${u.id}">${userAv(u, 'xs')}${esc(u.display)}</button>`).join('') || '<span class="hint">暂无成员</span>'}</div>
      <div class="tab-body" data-scroll id="roleBody">${PERMISSION_GROUPS.map(g => `<section class="perm-group"><h4>${g.name}</h4>${g.items.map(([k, n, d]) => `<label class="perm-row check"><input type="checkbox" data-act="rolePerm" data-r="${r.id}" data-p="${k}" ${r.perms.includes(k) ? 'checked' : ''} ${r.id === 'super' ? 'disabled' : ''}><div class="perm-copy"><strong>${n}</strong><code>${k}</code><p>${d}</p></div></label>`).join('')}</section>`).join('')}
      ${!r.builtin && members.length ? `<p class="hint">删除前需先把 ${members.length} 名成员改为其他角色。</p>` : ''}</div>${saveBar()}</section></div>`;
}

function auditContent() {
  const cats = [['all', '全部'], ['grant', 'Steam 授权'], ['role', '角色与权限'], ['user', '用户'], ['steam', 'Steam'], ['session', '会话']];
  const q = S.auditQuery.trim();
  const list = audit.filter(x => (S.auditCat === 'all' || x.cat === S.auditCat) && (!q || `${x.actor}${x.action}${x.target}${x.ip}`.includes(q)));
  return `<div class="toolbar">${searchBox('搜索操作者、动作、目标、IP', 'auditSearch', 'auditQuery', S.auditQuery)}<select aria-label="时间范围"><option>最近 7 天</option><option>最近 30 天</option><option>全部</option></select></div>
    <div class="chips">${cats.map(([v, l]) => `<button type="button" class="chip${S.auditCat === v ? ' is-on' : ''}" data-act="auditCat" data-v="${v}">${l}</button>`).join('')}</div>
    <section class="card"><div class="audit">${list.map(x => { const i = audit.indexOf(x); const open = S.auditOpen === i; return `<div class="arow${open ? ' is-open' : ''}">
      <button type="button" class="arow-main" data-act="auditOpen" data-i="${i}" aria-expanded="${open}"><span class="cat cat-${x.cat}">${ic({ grant: 'shield-check', role: 'key-round', user: 'users', steam: 'gamepad-2', session: 'log-out' }[x.cat])}</span>
        <span class="arow-body"><strong>${x.action}</strong><small>${esc(x.actor)} → ${esc(x.target)}</small></span><span class="arow-meta"><time>${x.time}</time><small class="mono">${x.ip}</small></span>${ic('chevron-down', 'chev')}</button>
      ${open ? `<table class="diff"><thead><tr><th>字段</th><th>之前</th><th>之后</th></tr></thead><tbody>${x.diff.map(([k, a, b]) => `<tr><td>${k}</td><td class="before">${esc(a) || '—'}</td><td class="after">${esc(b) || '—'}</td></tr>`).join('')}</tbody></table>` : ''}</div>`; }).join('') || '<div class="empty-small">没有匹配的记录</div>'}</div></section>`;
}

function emotesContent() {
  const g = emoteGroups.find(x => x.id === S.emoteGroup) || emoteGroups[0];
  return `<div class="split emote-split" data-mobile-detail="false">
    <section class="card list-pane"><div class="list-tools"><strong class="pane-title">分组</strong>${ib('plus', '新建分组', 'toastClose', 'data-v="原型：新建分组"', 'icon-btn solid')}</div>
      <div class="rows">${emoteGroups.map(x => `<button type="button" class="urow${x.id === g.id ? ' is-active' : ''}" data-act="emoteGroup" data-id="${x.id}"><span class="role-ic">${ic('layout-grid')}</span><span class="urow-body"><strong>${x.name}</strong><small>${x.items.length} 张</small></span></button>`).join('')}</div></section>
    <section class="card detail-pane"><header class="card-head"><div><h3>${g.name}</h3><p>PNG、JPEG、GIF、WebP，每张最多 7 MiB；相同图片共用原文件，动画保留。</p></div>
      <div class="page-actions">${btn('重命名', 'toastClose', { v: '原型：重命名分组' }, 'btn sm', 'pencil')}<span title="${g.items.length ? '分组非空，不能删除' : ''}">${btn('删除分组', 'toastClose', { v: '已删除空分组' }, 'btn sm danger-ghost', 'trash-2').replace('<button', g.items.length ? '<button disabled' : '<button')}</span></div></header>
      <div class="emote-grid"><label class="dropzone">${ic('upload')}<strong>拖入或选择图片</strong><small>可多选</small><input type="file" accept="image/*" multiple hidden></label>
      ${g.items.map(e => `<figure class="emote"><button type="button" data-act="lightbox" data-src="${e.img}"><img src="${e.img}" alt="${e.name}"></button><figcaption><strong>${e.name}</strong><small>${e.size}</small></figcaption>
        <div class="emote-tools">${ib('pencil', '编辑名称与分组', 'toastClose', 'data-v="原型：编辑素材"', 'icon-btn xs')}${ib('trash-2', '删除', 'confirm', 'data-k="deleteEmote"', 'icon-btn xs')}</div></figure>`).join('')}</div></section></div>`;
}

function settingsContent() {
  const u = me();
  const effectivePerms = ALL_PERMISSIONS.filter(p => effective(u, p).on);
  const grants = STEAM_ACCOUNTS.map(a => [a, grantFor(u, a.id)]).filter(([, g]) => g.level !== 'none');
  return `<div class="settings">
    <section class="card"><header class="card-head"><div><h3>${ic('bell')} 消息通知</h3><p>仅保存在当前浏览器；需要浏览器和系统允许通知。通知不显示消息正文。</p></div></header>
      <div class="set-row"><div><strong>桌面通知</strong><small>页面在后台或你在看其他会话时提醒</small></div>${toggle(S.settings.notify, 'set', { k: 'notify' })}</div>
      <div class="set-row"><div><strong>提示音</strong><small>新消息时播放</small></div><div class="inline"><select aria-label="提示音"><option>Steam 消息（默认）</option><option>Steam 聊天室</option><option>Steam 提及</option><option>关闭</option></select>${ib('volume-2', '试听', 'toastClose', 'data-v="♪ 试听提示音"')}</div></div>
      <div class="set-row"><div><strong>仅在页面不在前台时提醒</strong><small>正在查看的会话不重复提醒</small></div>${toggle(S.settings.bgOnly, 'set', { k: 'bgOnly' })}</div></section>
    <section class="card"><header class="card-head"><div><h3>${ic('shield-check')} 我的权限</h3><p>当前登录账号的有效权限与 Steam 授权，由管理员配置。悬停可查看来源。</p></div></header>
      <div class="set-row"><div><strong>角色</strong></div>${badge(roleOf(u).name, 'accent')}</div>
      <div class="perm-tags">${effectivePerms.map(p => `<span class="ptag" title="${effective(u, p).src}">${PERMISSION_GROUPS.flatMap(g => g.items).find(i => i[0] === p)[1]}${effective(u, p).src === '个人授予' ? ic('plus', 'tiny') : ''}</span>`).join('')}</div>
      ${grants.map(([a, g]) => `<div class="set-row"><div><strong>${a.label}</strong><small>${g.all ? '访问全部账户' : g.scope === 'some' ? `指定好友 ${g.friends.length} 人` : '全部会话'}${g.expires ? ` · 至 ${g.expires}` : ''}</small></div>${levelBadge(g)}</div>`).join('') || '<div class="set-row"><small>暂无 Steam 授权</small></div>'}</section>
    <section class="card"><header class="card-head"><div><h3>${ic('lock')} 账号安全</h3><p>修改后台登录密码；其他设备上的会话会保留。</p></div></header>
      ${can('self.password.change') ? `<form class="form-grid" data-act="noop"><label>当前密码<input type="password" autocomplete="current-password"></label><label>新密码<input type="password" autocomplete="new-password" placeholder="至少 8 位"></label><div>${btn('修改密码', 'toastClose', { v: '密码已修改' }, 'btn primary')}</div></form>` : '<p class="hint">你没有修改密码的权限。</p>'}
      <div class="set-row"><div><strong>退出其他设备</strong><small>保留当前浏览器，其他会话立即失效</small></div>${btn('退出其他设备', 'toastClose', { v: '已退出其他设备' }, 'btn sm')}</div></section>
    <section class="card"><header class="card-head"><div><h3>${ic('download')} 安装应用</h3><p>安装到桌面或主屏幕后，可用独立窗口打开 Steam Chat。关闭后不推送消息。</p></div>${btn('安装 Steam Chat', 'toastClose', { v: '原型：触发浏览器安装' }, 'btn')}</header></section>
    <section class="card"><header class="card-head"><div><h3>${ic('hard-drive')} 消息存储</h3><p>历史记录写入状态；异常时聊天顶部也会提示。</p></div></header>
      <div class="set-row"><div><strong>消息归档</strong></div><span class="status is-online"><i></i>正常</span></div><div class="set-row"><div><strong>历史索引</strong></div>${S.storageOk ? '<span class="status is-online"><i></i>正常</span>' : '<span class="status is-warn"><i></i>正在同步 · 32 条待处理</span>'}</div></section>
    </div>`;
}
const PAGE_CONTENT = { accounts: accountsContent, users: usersContent, roles: rolesContent, audit: auditContent, emotes: emotesContent, settings: settingsContent };
function headActions(page) {
  if (page === 'users' && can('user.manage')) return btn('新增用户', 'modal', { m: 'newUser' }, 'btn primary', 'user-plus');
  return '';
}
const allowedAdmin = () => ADMIN.filter(p => PAGES[p].allow());
function steamChip() {
  return `<span class="status ${S.steamOnline ? 'is-online' : 'is-off'}"><i></i>${S.steamOnline ? '在线' : '未连接'}</span>`;
}
function meMenu() {
  const u = me();
  const admin = allowedAdmin();
  return `<div class="menu me-menu"><div class="menu-head">${userAv(u)}<div><strong>${esc(u.display)}</strong><small>@${u.username} · ${roleOf(u).name}</small></div></div>
    ${admin.length ? `<hr>${admin.map(p => btn(PAGES[p].label, 'page', { p }, '', PAGES[p].icon)).join('')}` : ''}<hr>
    ${btn('设置', 'page', { p: 'settings' }, '', 'settings')}${btn('退出后台', 'logout', {}, 'danger', 'log-out')}</div>`;
}

// ---------- Shell ----------
function shell() {
  const conv = activeConv();
  const consoleOpen = S.page !== 'chat';
  const g = myGrant();
  const list = `<aside class="clist" aria-label="会话列表">
    <div class="ctop"><button type="button" class="me-btn" data-act="menu" data-m="me" aria-label="我的账号与控制台">${userAv(me(), 'sm')}</button>
      <button type="button" class="jump" data-act="palette">${ic('search')}<span>搜索</span><kbd>Ctrl K</kbd></button>
      ${canOpenAny() ? ib('square-pen', '新建会话', 'modal', 'data-m="newChat"') : ''}
      ${S.menu === 'me' ? meMenu() : ''}</div>
    ${PAGES.chat.allow() ? `${convTabs([['recent', '全部'], ['unread', '未读'], ['friends', '好友'], ...(g.scope === 'some' ? [] : [['groups', '群组']])])}${scopeNotice()}
      <div class="conv-list" id="convList" data-scroll>${chatBlocked() ? '<div class="empty-small">没有 Steam 授权</div>' : convListBody()}</div>` : '<div class="grow"></div>'}
    <button type="button" class="cstatus" data-act="${PAGES.accounts.allow() ? 'page' : 'noop'}" data-p="accounts">${steamChip()}<span>主号 · Dove</span>${allowedAdmin().length ? `<span class="console-link">控制台 ${ic('chevron-right')}</span>` : ''}</button>
  </aside>`;
  let thread;
  if (!PAGES.chat.allow()) thread = `<main class="cthread">${emptyState('lock', '没有聊天权限', '你的账号没有「使用聊天」权限。可从左上角头像打开控制台。')}</main>`;
  else if (chatBlocked()) thread = `<main class="cthread">${emptyState('lock', '没有可用的 Steam 授权', '你的账号尚未被授权访问当前活动 Steam 账户。请联系管理员在「用户 → Steam 授权」中开通。')}</main>`;
  else if (!conv) thread = `<main class="cthread">${emptyState('messages-square', '选择一个会话', '从左侧列表打开好友会话，或按 Ctrl K 搜索。')}</main>`;
  else thread = `<main class="cthread"><header class="thread-head">${ib('arrow-left', '返回会话列表', 'back', '', 'icon-btn mobile-only')}
      <button type="button" class="thread-name" data-act="details" aria-expanded="${S.details}"><strong>${esc(conv.name)}</strong><span class="presence-text p-${conv.presence || 'group'}">${esc(statusText(conv))}</span></button>
      <div class="thread-actions"><button type="button" class="date-chip" data-act="datePop" aria-expanded="${S.datePop}">${ic('calendar')}<span>${S.detached ? '10 月 26 日' : '今天'}</span>${ic('chevron-down')}</button>${datePopover()}</div>
      ${S.details ? `<div class="popover profile-pop">${profilePanel(conv)}</div>` : ''}</header>
    ${S.storageOk ? '' : `<div class="banner-warn">${ic('triangle-alert')}<span>历史索引正在同步（32 条待处理），新消息仍会实时显示。</span><button type="button" data-act="page" data-p="settings">详情</button></div>`}
    ${messages(conv)}${composer(conv)}
    ${S.dragging && levelAtLeast(g, 'full') ? `<div class="drop-overlay">${ic('image-plus', 'big')}<strong>释放发送图片</strong><span>发送给 ${esc(conv.name)}</span></div>` : ''}</main>`;
  const pages = [...allowedAdmin(), 'settings'];
  const consoleSheet = consoleOpen ? `<div class="sheet-scrim" data-act="closeSheet"></div><section class="sheet" role="dialog" aria-label="控制台">
      <aside class="sheet-nav"><div class="sheet-title"><strong>控制台</strong>${ib('x', '关闭（Esc）', 'closeSheet')}</div>
        <nav class="sheet-links">${pages.map(p => `<button type="button" class="${S.page === p ? 'is-on' : ''}" data-act="page" data-p="${p}">${ic(PAGES[p].icon)}<span>${PAGES[p].label}</span></button>`).join('')}</nav></aside>
      <div class="sheet-main" id="pageBody" data-scroll>${pageHead(S.page, headActions(S.page))}${PAGE_CONTENT[S.page]()}</div></section>` : '';
  return `<div class="shell" data-mobile="${S.mobileThread ? 'thread' : 'list'}">${list}${thread}${consoleSheet}${contextMenu()}</div>`;
}

// ---------- Login ----------
function login() {
  const setup = S.loginMode === 'setup';
  const fields = setup
    ? `<label>管理员账号<input autocomplete="username" placeholder="3–64 位字母、数字或 _ . -"></label><label>后台密码<input type="password" autocomplete="new-password" placeholder="至少 8 位"></label><label>确认密码<input type="password" autocomplete="new-password"></label>`
    : `<label>账号<input autocomplete="username" value="dove"></label><label>密码<input type="password" autocomplete="current-password" value="password"></label>`;
  return `<div class="login"><section class="login-card"><div class="login-logo">${ic('gamepad-2')}</div>
    <h1>${setup ? '初始化 Steam Chat' : '登录 Steam Chat'}</h1><p>${setup ? '创建第一个超级管理员，之后在控制台的「Steam 账户」中连接 Steam。' : '使用后台账号登录。可用的 Steam 账户与会话由管理员授权。'}</p>
    <form class="login-form" data-act="noop">${fields}<p class="form-error" ${S.loginError ? '' : 'hidden'}>${ic('circle-alert')}账号或密码错误，再失败 2 次将锁定 15 分钟。</p>
      <button type="button" class="btn primary block" data-act="loginSubmit"><span>${setup ? '创建管理员并进入' : '登录'}</span></button></form>
    <div class="login-links"><button type="button" class="link" data-act="loginMode">${setup ? '返回登录' : '原型：查看首次初始化页'}</button>${setup ? '' : '<button type="button" class="link" data-act="loginError">原型：查看错误提示</button>'}</div></section></div>`;
}

// ---------- Overlays ----------
function fakeQr() {
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const n = 25; let rects = '';
  const finder = (x, y) => `<rect x="${x}" y="${y}" width="7" height="7" fill="currentColor"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="currentColor"/>`;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if ((x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9)) continue;
    if (rnd() > 0.52) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  return `<svg class="qr" viewBox="-1 -1 ${n + 2} ${n + 2}" role="img" aria-label="示意二维码（非真实）"><g fill="currentColor">${rects}</g>${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`;
}
function modal() {
  const m = S.modal;
  if (!m) return '';
  const u = users.find(x => x.id === S.userSel);
  let title = '', body = '', foot = '';
  const close = btn('取消', 'closeModal', {}, 'btn ghost');
  if (m.type === 'lightbox') return `<div class="lightbox" data-act="closeModal"><img src="${m.src}" alt="">${ib('x', '关闭', 'closeModal', '', 'icon-btn lb-close')}</div>`;
  if (m.type === 'newChat') { title = '新建会话'; body = `<div class="form-grid"><label>SteamID64<input inputmode="numeric" placeholder="7656119…"></label></div><p class="hint">需要对当前 Steam 账户拥有「聊天」及以上授权，且会话范围为「全部会话」。</p>`; foot = close + btn('打开会话', 'toastClose', { v: '原型：打开会话' }, 'btn primary'); }
  if (m.type === 'addSteam') {
    title = '添加 Steam 账户';
    const tabs = seg([['qr', '扫码登录'], ['pwd', '账号密码']], m.tab, 'steamTab');
    if (m.tab === 'qr') {
      const step = m.step;
      body = `${tabs}<div class="qr-box">${step === 'done' ? `<div class="qr-done">${ic('circle-check', 'big')}<strong>已登录：主号 · Dove</strong></div>` : step === 'scanned' ? `<div class="qr-done">${ic('smartphone', 'big')}<strong>已扫码</strong><span>请在手机 Steam App 中确认登录</span></div>` : step === 'expired' ? `<div class="qr-done">${ic('timer-off', 'big')}<strong>二维码已过期</strong><span>请重新生成</span></div>` : step === 'waiting' ? fakeQr() : `<div class="qr-done">${ic('qr-code', 'big')}<span>生成二维码后，用手机 Steam App 扫描</span></div>`}</div>
        <ol class="steps"><li class="${!['idle', 'expired'].includes(step) ? 'is-done' : ''}">生成二维码</li><li class="${['scanned', 'done'].includes(step) ? 'is-done' : ''}">打开 Steam App → Steam 令牌 → 扫描</li><li class="${step === 'done' ? 'is-done' : ''}">在手机上确认</li></ol>`;
      foot = close + ({ idle: btn('生成二维码', 'qrStep', { v: 'waiting' }, 'btn primary'), expired: btn('重新生成', 'qrStep', { v: 'waiting' }, 'btn primary'),
        waiting: btn('模拟：过期', 'qrStep', { v: 'expired' }, 'btn ghost') + btn('模拟：已扫码', 'qrStep', { v: 'scanned' }, 'btn'), scanned: btn('模拟：手机确认', 'qrStep', { v: 'done' }, 'btn primary'), done: btn('完成', 'closeModal', {}, 'btn primary') })[step];
    } else if (m.step === 'guard') {
      body = `${tabs}<div class="guard">${ic('mail', 'big')}<strong>需要 Steam Guard 验证</strong><span>验证码已发送到 d***@example.com</span><div class="otp">${Array.from({ length: 5 }, () => '<input maxlength="1" aria-label="验证码字符">').join('')}</div>
        <p class="hint">若上一次验证码被拒绝，请等待新的验证码后再提交。</p></div>`;
      foot = close + btn('提交验证', 'toastClose', { v: '原型：Steam Guard 已提交' }, 'btn primary');
    } else {
      body = `${tabs}<div class="form-grid"><label>显示名称<input placeholder="例如：客服一号"></label><label>Steam 账号<input autocomplete="username"></label><label>Steam 密码<input type="password" autocomplete="current-password"></label>
        <details><summary>高级选项</summary><label>Logon ID<input inputmode="numeric" placeholder="留空使用后台固定值"></label></details></div><p class="hint">密码只用于本次登录，不会保存。</p>`;
      foot = close + btn('登录', 'qrStep', { v: 'guard' }, 'btn primary');
    }
  }
  if (m.type === 'newUser') {
    title = '新增用户';
    body = `<div class="form-grid two"><label>账号<input placeholder="3–64 位"></label><label>昵称<input></label><label>初始密码<input type="password" placeholder="至少 8 位"></label>
      <label>角色<select ${can('role.manage') ? '' : 'disabled title="指定角色需要「管理角色与权限」"'}>${roles.filter(r => r.id !== 'super' || can('role.manage')).map(r => `<option ${r.id === 'member' ? 'selected' : ''}>${r.name}</option>`).join('')}</select></label><label class="span">备注<input></label>
      <label class="check span"><input type="checkbox" checked> 首次登录后要求修改密码</label></div><p class="hint">创建后可在「Steam 授权」中为该用户开通账户访问。</p>`;
    foot = close + btn('创建', 'toastClose', { v: '原型：用户已创建' }, 'btn primary');
  }
  if (m.type === 'editUser') { title = `编辑 ${u.display}`; body = `<div class="form-grid"><label>昵称<input value="${esc(u.display)}"></label><label>备注<textarea rows="3">${esc(u.note)}</textarea></label></div>`; foot = close + btn('保存', 'toastClose', { v: '资料已保存' }, 'btn primary'); }
  if (m.type === 'editAccount') { title = '编辑 Steam 账户'; body = `<div class="form-grid"><label>显示名称<input value="交易号"></label><label>账号提示<input value="dove_trade"></label></div>`; foot = close + btn('保存', 'toastClose', { v: '已保存' }, 'btn primary'); }
  if (m.type === 'resetPwd') { title = `重置 ${u.display} 的密码`; body = `<div class="form-grid"><label>新密码<input type="password" placeholder="至少 8 位"></label><label class="check"><input type="checkbox" checked> 要求下次登录后修改密码</label><label class="check"><input type="checkbox" checked> 同时踢下线该用户的全部会话</label></div>`; foot = close + btn('重置密码', 'toastClose', { v: '密码已重置' }, 'btn primary'); }
  if (m.type === 'newRole') { title = '角色'; body = `<div class="form-grid"><label>名称<input placeholder="例如：值班客服"></label><label>说明<input></label><label>复制权限自<select>${roles.map(r => `<option>${r.name}</option>`).join('')}<option selected>不复制（空白）</option></select></label></div>`; foot = close + btn('保存', 'toastClose', { v: '原型：角色已保存' }, 'btn primary'); }
  if (m.type === 'pickFriends') {
    const g = u.grants[m.a];
    title = '选择可访问的好友';
    body = `${searchBox('搜索好友', 'pickSearch', 'noop', '')}<div class="pick-list">${FRIENDS.map(f => `<label class="pick">${av(f, 'sm')}<span><strong>${esc(f.name)}</strong><small class="mono">${f.id}</small></span><input type="checkbox" data-act="pick" data-a="${m.a}" data-id="${f.id}" ${g.friends.includes(f.id) ? 'checked' : ''}></label>`).join('')}</div>`;
    foot = btn(`完成（${g.friends.length}）`, 'closeModal', {}, 'btn primary');
  }
  if (m.type === 'confirm') {
    const text = { steamLogout: ['退出 Steam 并删除 token？', '活动账户将下线，所有用户的聊天立即不可用。'], deleteAccount: ['删除这个 Steam 账户？', '账户资料与所有用户授权关系会被删除，历史消息保留。'], deleteUser: [`删除 ${u.display}？`, '该用户的会话立即失效，审计记录保留。'], kickAll: ['踢下线全部会话？', '该用户需要重新登录。'], deleteRole: ['删除这个角色？', '角色下仍有成员时不能删除。'], deleteEmote: ['从素材库删除这张图片？', '已发送的消息不受影响。'] }[m.k];
    title = text[0]; body = `<p>${text[1]}</p>`; foot = close + btn('确认', 'toastClose', { v: '原型：已执行' }, 'btn danger');
  }
  return `<div class="modal-scrim" data-act="closeModal"></div><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${title}</h2>${ib('x', '关闭', 'closeModal')}</header><div class="modal-body">${body}</div><footer>${foot}</footer></section>`;
}
function palette() {
  if (!S.palette) return '';
  const q = S.paletteQuery.trim().toLowerCase();
  const convs = PAGES.chat.allow() && !chatBlocked() ? all.filter(x => scopeOk(x.id) && !(x.group && myGrant().scope === 'some')).filter(x => !q || x.name.toLowerCase().includes(q)).slice(0, 6) : [];
  const pages = Object.keys(PAGES).filter(p => p !== 'chat' && PAGES[p].allow() && (!q || PAGES[p].label.includes(q)));
  const cmds = [['跳转到日期…', 'calendar-search', 'cmdDate'], ['切换主题', 'sun', 'cmdTheme']].filter(([l]) => !q || l.includes(q));
  return `<div class="modal-scrim" data-act="closePalette"></div><section class="palette" role="dialog" aria-label="快速跳转">
    <label class="palette-input">${ic('search')}<input id="paletteInput" placeholder="搜索会话、页面或命令" value="${esc(S.paletteQuery)}" data-input="paletteQuery" autocomplete="off"><kbd>Esc</kbd></label>
    <div class="palette-list">${convs.length ? `<small>会话</small>${convs.map(x => `<button type="button" data-act="palOpen" data-id="${x.id}">${av(x, 'xs')}<span>${esc(x.name)}</span><em>${esc(statusText(x))}</em></button>`).join('')}` : ''}
      ${pages.length ? `<small>控制台</small>${pages.map(p => `<button type="button" data-act="page" data-p="${p}">${ic(PAGES[p].icon)}<span>${PAGES[p].label}</span></button>`).join('')}` : ''}
      ${cmds.length ? `<small>命令</small>${cmds.map(([l, i, a]) => `<button type="button" data-act="${a}">${ic(i)}<span>${l}</span></button>`).join('')}` : ''}</div></section>`;
}

// ---------- Prototype controls (not part of the design) ----------
function controls() {
  return `<div class="pc-row"><strong>身份</strong><select data-change="persona" aria-label="以该身份查看">${Object.entries(PERSONAS).map(([k, p]) => `<option value="${k}" ${S.persona === k ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
      <strong>页面</strong><select data-change="pageSel" aria-label="页面"><option value="login" ${S.page === 'login' ? 'selected' : ''}>登录</option>${Object.keys(PAGES).map(p => `<option value="${p}" ${S.page === p ? 'selected' : ''} ${PAGES[p].allow() ? '' : 'disabled'}>${PAGES[p].label}</option>`).join('')}</select></div>
    <div class="pc-row"><button type="button" class="${S.phone ? 'is-on' : ''}" data-act="phone">${ic('smartphone')}手机</button>
      <button type="button" data-act="cmdTheme">${ic(S.theme === 'dark' ? 'moon' : S.theme === 'light' ? 'sun' : 'monitor')}${{ auto: '跟随系统', light: '浅色', dark: '深色' }[S.theme]}</button>
      <button type="button" class="${S.steamOnline ? '' : 'is-on'}" data-act="steamToggle">${ic(S.steamOnline ? 'wifi' : 'wifi-off')}Steam ${S.steamOnline ? '在线' : '离线'}</button>
      <button type="button" class="${S.storageOk ? '' : 'is-on'}" data-act="storageToggle">${ic('hard-drive')}存储${S.storageOk ? '正常' : '异常'}</button>
      <button type="button" class="${S.dragging ? 'is-on' : ''}" data-act="dragToggle">${ic('image-plus')}拖入图片</button>
      <button type="button" data-act="pcHide" title="收起" aria-label="收起原型工具">${ic('chevron-down')}</button></div>`;
}

// ---------- Render ----------
const root = $('#app');
function render() {
  if (S.page !== 'login' && !PAGES[S.page]?.allow()) S.page = firstAllowed();
  const focus = document.activeElement;
  const focusId = focus && focus.id;
  const caret = focus && 'selectionStart' in focus ? focus.selectionStart : null;
  const scrolls = {};
  document.querySelectorAll('[data-scroll][id]').forEach(n => { scrolls[n.id] = n.scrollTop; });
  const dark = S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#frame').classList.toggle('is-phone', S.phone);
  root.innerHTML = (S.page === 'login' ? login() : shell()) + modal() + palette();
  $('#pc').innerHTML = controls();
  lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  for (const [id, top] of Object.entries(scrolls)) { const n = document.getElementById(id); if (n && id !== 'messages') n.scrollTop = top; }
  const msgs = $('#messages');
  if (msgs) {
    const stick = !S.detached && (S.scrollBottom || scrolls.messages === undefined);
    msgs.scrollTop = S.detached ? 0 : stick ? msgs.scrollHeight : scrolls.messages;
    // Late-loading images must not leave the newest message below the fold.
    if (stick) msgs.querySelectorAll('img').forEach(img => img.complete || img.addEventListener('load', () => { msgs.scrollTop = msgs.scrollHeight; }, { once: true }));
  }
  S.scrollBottom = false;
  const again = focusId && document.getElementById(focusId);
  if (again && again !== document.body) { again.focus(); if (caret !== null && 'setSelectionRange' in again) try { again.setSelectionRange(caret, caret); } catch {} }
  const composerInput = $('#composer');
  if (composerInput) autosize(composerInput);
}
function autosize(t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }
const transient = () => { S.menu = null; S.datePop = false; S.picker = false; S.ctx = null; };

function sendMessage(item) {
  const conv = activeConv();
  (S.sent[conv.id] ||= []).push({ self: true, time: now(), ...item });
  S.detached = false; S.scrollBottom = true;
}
function uploadImage(conv, img) {
  const t = { id: Math.random().toString(36).slice(2), conv, img, name: img.split('/').pop(), pct: 0 };
  S.transfers.push(t);
  const tick = () => {
    if (!S.transfers.includes(t)) return;
    t.pct = Math.min(100, t.pct + 22);
    if (t.pct >= 100) {
      S.transfers = S.transfers.filter(x => x !== t);
      (S.sent[conv] ||= []).push({ self: true, time: now(), t: 'image', img });
      S.scrollBottom = conv === S.active;
    } else setTimeout(tick, 380);
    render();
  };
  setTimeout(tick, 300);
}

const ACT = {
  noop() {},
  page: d => { S.page = d.p; transient(); S.palette = false; S.mobileDetail = false; if (d.p === 'chat') S.scrollBottom = true; },
  open: d => { S.active = d.id; S.page = 'chat'; S.mobileThread = true; S.detached = false; S.details = false; transient(); unread[d.id] = 0; S.closed.delete(d.id); S.scrollBottom = true; },
  palOpen: d => { ACT.open(d); S.palette = false; },
  markRead: d => { unread[d.id] = 0; },
  closeConv: d => { S.closed.add(d.id); if (S.active === d.id) S.mobileThread = false; toast('已关闭会话，收到新消息时会重新出现'); },
  back: () => { S.mobileThread = false; transient(); },
  tab: d => { S.tab = d.t; },
  details: () => { S.details = !S.details; S.datePop = false; },
  datePop: () => { const open = !S.datePop; transient(); S.details = false; S.datePop = open; },
  jump: () => { S.detached = true; S.datePop = false; },
  latest: () => { S.detached = false; S.scrollBottom = true; },
  picker: () => { const open = !S.picker; transient(); S.picker = open; },
  pickerTab: d => { S.pickerTab = d.t; },
  insert: d => { const id = activeConv().id; S.drafts[id] = (S.drafts[id] || '') + d.v; S.picker = false; setTimeout(() => $('#composer')?.focus()); },
  sendRich: d => { S.picker = false; if (d.t === 'image') uploadImage(activeConv().id, d.v); else sendMessage({ t: d.t, text: d.v }); },
  send: () => {
    const id = activeConv().id;
    const text = (S.drafts[id] || '').trim();
    for (const draft of S.imageDrafts[id] || []) uploadImage(id, draft.img);
    S.imageDrafts[id] = [];
    if (text) { S.drafts[id] = ''; sendMessage({ t: 'text', text }); }
    setTimeout(() => $('#composer')?.focus());
  },
  attach: () => { const id = activeConv().id; const list = S.imageDrafts[id] ||= []; list.push({ id: Math.random().toString(36).slice(2), img: DRAFT_IMAGES[list.length % DRAFT_IMAGES.length] }); },
  removeDraft: d => { const id = activeConv().id; S.imageDrafts[id] = S.imageDrafts[id].filter(x => x.id !== d.id); },
  cancelTransfer: d => { S.transfers = S.transfers.filter(t => t.id !== d.id); toast('已取消上传'); },
  retry: () => toast('原型：重新发送中…'),
  react: () => toast('原型：打开表情回应选择'),
  copy: () => toast('已复制'),
  lightbox: d => { S.modal = { type: 'lightbox', src: d.src }; },
  menu: d => { const open = S.menu !== d.m; transient(); S.menu = open ? d.m : null; },
  palette: () => { S.palette = true; S.paletteQuery = ''; transient(); setTimeout(() => $('#paletteInput')?.focus()); },
  closePalette: () => { S.palette = false; },
  cmdDate: () => { S.palette = false; S.page = 'chat'; S.datePop = true; },
  cmdTheme: () => { S.theme = { auto: 'light', light: 'dark', dark: 'auto' }[S.theme]; S.palette = false; },
  modal: d => { transient(); S.modal = { type: d.m, tab: 'qr', step: 'idle', a: d.a ? Number(d.a) : undefined }; },
  closeModal: () => { S.modal = null; },
  steamTab: d => { S.modal.tab = d.v; S.modal.step = 'idle'; },
  qrStep: d => { S.modal.step = d.v; },
  confirm: d => { transient(); S.modal = { type: 'confirm', k: d.k }; },
  toastClose: d => { transient(); S.modal = null; toast(d.v); },
  phone: () => { S.phone = !S.phone; },
  steamToggle: () => { S.steamOnline = !S.steamOnline; },
  storageToggle: () => { S.storageOk = !S.storageOk; },
  dragToggle: () => { S.dragging = !S.dragging; },
  pcHide: () => { $('#pc').classList.toggle('is-min'); },
  logout: () => { S.page = 'login'; transient(); },
  loginMode: () => { S.loginMode = S.loginMode === 'login' ? 'setup' : 'login'; S.loginError = false; },
  loginError: () => { S.loginError = true; },
  loginSubmit: () => { S.page = firstAllowed(); S.scrollBottom = true; S.loginError = false; },
  closeSheet: () => { S.page = 'chat'; },
  set: d => { S.settings[d.k] = !S.settings[d.k]; },
  // Users & authorization
  userSel: d => { S.userSel = Number(d.id); S.mobileDetail = true; transient(); },
  userBack: () => { S.mobileDetail = false; },
  userTab: d => { S.userTab = d.t; },
  userFilter: d => { S.userFilter = d.v; },
  gotoGrant: d => { S.page = 'users'; S.userSel = Number(d.id); S.userTab = 'grant'; S.mobileDetail = true; },
  gotoUser: d => { S.page = 'users'; S.userSel = Number(d.id); S.userTab = 'perm'; S.mobileDetail = true; },
  userStatus: () => { const u = users.find(x => x.id === S.userSel); mutate(() => { u.status = u.status === 'disabled' ? 'enabled' : 'disabled'; }); transient(); },
  kick: d => { const u = users.find(x => x.id === S.userSel); u.sessions.splice(Number(d.i), 1); toast('已踢下线'); },
  override: d => { const u = users.find(x => x.id === S.userSel); mutate(() => { if (d.v === 'inherit') delete u.overrides[d.p]; else u.overrides[d.p] = d.v; }); },
  level: d => { const u = users.find(x => x.id === S.userSel); mutate(() => { const g = u.grants[d.a] ||= { level: 'none', scope: 'all', friends: [], expires: '' }; g.level = d.v; }); },
  scope: d => { const u = users.find(x => x.id === S.userSel); mutate(() => { u.grants[d.a].scope = d.v; }); },
  unpick: d => { const u = users.find(x => x.id === S.userSel); mutate(() => { const g = u.grants[d.a]; g.friends = g.friends.filter(x => x !== d.id); }); },
  pick: (d, el) => { const u = users.find(x => x.id === S.userSel); mutate(() => { const g = u.grants[d.a]; g.friends = el.checked ? [...g.friends, d.id] : g.friends.filter(x => x !== d.id); }); },
  rolePerm: (d, el) => { const r = roles.find(x => x.id === d.r); mutate(() => { r.perms = el.checked ? [...r.perms, d.p] : r.perms.filter(p => p !== d.p); }); },
  roleSel: d => { S.roleSel = d.id; S.mobileDetail = true; },
  roleView: d => { S.roleView = d.v; },
  save: () => { S.snapshot = null; audit.unshift({ time: '刚刚', actor: me().username, cat: 'grant', action: '保存权限与授权更改', target: users.find(x => x.id === S.userSel).display, ip: '192.168.0.12', diff: [['更改', '', '见本次保存']] }); toast('已保存，并写入审计日志'); },
  undo: () => { ({ users, roles } = S.snapshot); S.snapshot = null; },
  auditCat: d => { S.auditCat = d.v; },
  auditOpen: d => { S.auditOpen = S.auditOpen === Number(d.i) ? null : Number(d.i); },
  emoteGroup: d => { S.emoteGroup = d.id; }
};
const CHANGE = {
  persona: v => { S.persona = v; S.snapshot = null; S.scrollBottom = true; S.tab = 'recent'; },
  pageSel: v => { S.page = v; S.mobileThread = false; },
  userRole: v => { const u = users.find(x => x.id === S.userSel); mutate(() => { u.role = v; }); },
  expires: (v, el) => { const u = users.find(x => x.id === S.userSel); mutate(() => { u.grants[el.dataset.a].expires = v; }); }
};
const INPUT = {
  query: v => { S.query = v; return true; },
  userQuery: v => { S.userQuery = v; return true; },
  auditQuery: v => { S.auditQuery = v; return true; },
  paletteQuery: v => { S.paletteQuery = v; return true; },
  draft: (v, el) => { S.drafts[activeConv().id] = v; autosize(el); return false; },
  noop: () => false
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) {
    if (!e.target.closest('.popover, .menu') && (S.menu || S.datePop || S.picker || S.ctx)) { transient(); render(); }
    return;
  }
  if (el.disabled) return;
  if (el.tagName === 'A' || el.tagName === 'FORM') e.preventDefault();
  if (el.classList.contains('lightbox') && e.target.tagName === 'IMG') return;
  if ((el.classList.contains('modal-scrim') || el.classList.contains('sheet-scrim')) && e.target !== el) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  if (!['menu', 'datePop', 'picker'].includes(el.dataset.act) && !el.closest('.popover, .menu')) transient();
  fn(el.dataset, el, e);
  if (el.dataset.act !== 'pcHide') render();
});
document.addEventListener('contextmenu', e => {
  const row = e.target.closest('[data-ctx]');
  if (!row || !row.dataset.ctx) return;
  e.preventDefault();
  const box = root.getBoundingClientRect();
  transient();
  S.ctx = { id: row.dataset.ctx, x: e.clientX - box.left, y: e.clientY - box.top };
  render();
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.change && CHANGE[el.dataset.change]) { CHANGE[el.dataset.change](el.value, el); render(); }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.input && INPUT[el.dataset.input]?.(el.value, el)) render();
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ACT.palette(); render(); return; }
  if (e.key === 'Escape') {
    if (S.palette) S.palette = false;
    else if (S.modal) S.modal = null;
    else if (S.menu || S.datePop || S.picker || S.ctx) transient();
    else if (S.details) S.details = false;
    else if (S.page !== 'chat' && S.page !== 'login') S.page = 'chat';
    else return;
    render();
    return;
  }
  if (e.target.id === 'composer' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ACT.send(); render(); }
  if (e.target.id === 'paletteInput' && e.key === 'Enter') { const first = document.querySelector('.palette-list button'); if (first) first.click(); }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.theme === 'auto') render(); });
render();
