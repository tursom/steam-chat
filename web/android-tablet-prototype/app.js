/* Disposable, memory-only layout prototype. No backend, credentials or outgoing requests. */
(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const icon = (name) => `<i data-lucide="${name}"></i>`;
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = () => window.lucide?.createIcons();
  const assets = '../prototype/assets/';
  const emotes = '../android-prototype/assets/';
  const contacts = [
    { id: 'wind', name: '林间晚风', letter: '', color: 'landscape', online: true, game: 'Stardew Valley', image: 'stardew.jpg', preview: '好呀，那晚上农场见。', time: '18:32', unread: 0, steamId: '76561198000000001' },
    { id: 'orange', name: '橘子汽水', letter: '橘', color: 'rose', online: true, game: 'Counter-Strike 2', image: 'cs2.jpg', preview: '来不来，再差一个人就能开了', time: '18:26', unread: 2, steamId: '76561198000000002' },
    { id: 'north', name: '北纬三十度', letter: 'N', color: 'blue', online: true, game: 'Dota 2', image: 'dota.jpg', preview: '这局配合真的太好了', time: '18:09', unread: 1, steamId: '76561198000000003' },
    { id: 'moon', name: '月球漫游', letter: '月', color: 'gold', online: false, game: '', preview: '分享给你一首最近在听的歌', time: '17:45', unread: 1, steamId: '76561198000000004' },
    { id: 'pixel', name: '像素旅人', letter: 'P', color: 'lilac', online: true, game: '', preview: '收到，下次一起！', time: '16:20', unread: 0, steamId: '76561198000000005' },
    { id: 'island', name: '无人岛', letter: '岛', color: 'slate', online: false, game: '', preview: '你：周末有空再约', time: '昨天', unread: 0, steamId: '76561198000000006' },
    { id: 'echo', name: 'Echo', letter: 'e', color: 'blue', online: false, game: '', preview: '谢谢你的推荐', time: '星期五', unread: 0, steamId: '76561198000000007' },
  ];
  const threads = new Map(contacts.map((c) => [c.id, [
    { id: `${c.id}-1`, text: '好久不见，最近在玩什么？', self: true, time: '17:40' },
    { id: `${c.id}-2`, text: c.preview.replace(/^你：/, ''), self: false, time: c.time },
  ]]));
  threads.set('wind', [
    { id: 'wind-1', text: '好久没种田了，今晚回星露谷逛逛？', image: assets + 'stardew.jpg', imageLabel: '星露谷物语游戏封面', self: false, time: '18:24' },
    { id: 'wind-2', text: '好呀，上次的存档还留着呢。', self: true, time: '18:27' },
    { id: 'wind-3', text: '等你上线，一起把温室修好？ :steamhappy:', self: false, time: '18:29' },
    { id: 'wind-4', text: '好呀，那晚上农场见。', self: true, time: '18:32' },
  ]);
  threads.set('moon', [
    { id: 'moon-1', text: '分享给你一首最近在听的歌 🎧', self: false, time: '17:44' },
    { id: 'moon-2', text: 'https://www.bilibili.com/video/av990800235', self: false, time: '17:45' },
  ]);
  const state = { selected: 'wind', nav: 'messages', filter: 'all', search: '', online: true, profile: false, emoji: false,
    emojiTab: 'steam', queued: 0, keyboard: false, chatOpen: true, history: new Map(), drafts: new Map(), attachments: new Map(), scrolls: new Map(),
    settings: { background: true, preview: false, notification: true } };
  const objectUrls = new Set();
  let messageSequence = 0;
  let toastTimer;
  const current = () => contacts.find((c) => c.id === state.selected);
  const chatVisible = () => state.nav !== 'settings' && ($('#preview').clientWidth >= 840 || state.chatOpen);
  function markVisibleRead() {
    if (chatVisible() && current().unread) { current().unread = 0; return true; }
    return false;
  }
  const avatar = (contact, extra = '') => `<span class="avatar ${contact.color} ${contact.online ? 'online' : ''} ${extra}" aria-hidden="true"><span>${escape(contact.letter)}</span></span>`;
  function toast(text) {
    clearTimeout(toastTimer);
    $('#toast').textContent = text;
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2600);
  }
  function renderContacts() {
    const friends = state.nav === 'friends';
    $('#list-title').textContent = friends ? '好友' : '消息';
    $('#contact-search').placeholder = friends ? '搜索好友' : '搜索会话';
    $('#filters').hidden = friends;
    $('#friends-caption').hidden = !friends;
    const visible = contacts.filter((c) => (!state.search || `${c.name} ${c.steamId}`.toLowerCase().includes(state.search.toLowerCase())) &&
      (friends || state.filter !== 'unread' || c.unread > 0));
    if (friends) visible.sort((a, b) => Number(b.online) - Number(a.online));
    $('#contact-list').innerHTML = visible.map((c) => `<button class="contact ${c.id === state.selected ? 'active' : ''}" data-contact="${c.id}" aria-label="与${escape(c.name)}聊天${c.unread ? `，${c.unread}条未读` : ''}" aria-current="${c.id === state.selected ? 'true' : 'false'}">
      ${avatar(c)}<span class="contact-copy"><span class="contact-top"><strong>${escape(c.name)}</strong><time>${friends ? '' : escape(c.time)}</time></span>
      <span class="contact-preview"><span>${escape(friends ? (c.game ? '正在玩 ' + c.game : c.online ? '在线' : '离线') : c.preview)}</span>${!friends && c.unread ? `<b class="unread-badge">${c.unread}</b>` : ''}</span></span></button>`).join('') ||
      `<div class="empty">${icon(state.filter === 'unread' ? 'check-check' : 'search')}<p>${state.search ? '没有找到匹配的好友' : '没有未读消息，歇一会儿吧'}</p></div>`;
    $('#all-count').textContent = contacts.length;
    $('#unread-count').textContent = contacts.reduce((sum, c) => sum + c.unread, 0);
    $('#rail-badge').textContent = $('#unread-count').textContent;
    $('#rail-badge').hidden = Number($('#rail-badge').textContent) === 0;
    document.querySelectorAll('[data-filter]').forEach((el) => { el.classList.toggle('active', el.dataset.filter === state.filter); el.setAttribute('aria-pressed', String(el.dataset.filter === state.filter)); });
    document.querySelectorAll('[data-nav]').forEach((el) => { el.classList.toggle('active', el.dataset.nav === state.nav); if (el.dataset.nav === state.nav) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
    icons();
  }
  function messageMarkup(message, contact) {
    let content = escape(message.text || '');
    content = content.replace(/:steamhappy:/g, `<img class="steam-emote" src="${emotes}steamhappy.png" alt=":steamhappy:">`)
      .replace(/:steamthumbsup:/g, `<img class="steam-emote" src="${emotes}steamthumbsup.png" alt=":steamthumbsup:">`);
    if (/^https:\/\/www\.bilibili\.com\/video\/av[0-9]+$/.test(message.text || '')) content = `<a href="${escape(message.text)}" target="_blank" rel="noopener noreferrer">${escape(message.text)}</a>`;
    return `<article class="message ${message.self ? 'self' : ''}" data-message="${message.id}">
      ${message.self ? '' : avatar(contact)}<div class="message-stack">${content ? `<div class="bubble">${content}</div>` : ''}
      ${message.image ? `<button class="message-image" data-full-image="${escape(message.image)}" aria-label="查看${escape(message.imageLabel || '图片')}"><img src="${escape(message.image)}" alt="${escape(message.imageLabel || '已发送的图片')}"><span>${icon('expand')}</span></button>` : ''}
      <div class="message-time"><time>${escape(message.time)}</time>${message.self ? icon(message.pending ? 'clock-3' : 'check-check') : ''}</div></div>${message.self ? '<span class="avatar" aria-hidden="true">o</span>' : ''}</article>`;
  }
  function renderThread(mode = 'keep') {
    const thread = $('#thread');
    const beforeHeight = thread.scrollHeight;
    const beforeTop = thread.scrollTop;
    const contact = current();
    $('#chat-name').textContent = contact.name;
    $('#chat-avatar').innerHTML = avatar(contact);
    $('#chat-presence').innerHTML = `<span class="status-dot ${contact.online ? '' : 'away'}"></span>${contact.online ? '在线' : '离线'}${contact.game ? ' · 正在玩 ' + escape(contact.game) : ''}`;
    const messages = threads.get(contact.id);
    const older = messages.filter((message) => message.time.startsWith('昨天'));
    thread.innerHTML = `<button class="history-button" data-action="history">${icon('chevron-up')}${state.history.get(contact.id) ? '已加载全部演示记录' : '查看更早的消息'}</button>
      ${older.length ? `<div class="date-divider">昨天 · 9 月 26 日</div>${older.map((message) => messageMarkup(message, contact)).join('')}` : ''}
      <div class="date-divider">今天 · 9 月 27 日</div>${messages.filter((message) => !message.time.startsWith('昨天')).map((message) => messageMarkup(message, contact)).join('')}`;
    icons();
    if (mode === 'bottom') { thread.scrollTop = thread.scrollHeight; $('#new-message-jump').hidden = true; }
    else if (mode === 'history') thread.scrollTop = beforeTop + thread.scrollHeight - beforeHeight;
    else thread.scrollTop = beforeTop;
  }
  function renderComposer() {
    const text = state.drafts.get(state.selected) || '';
    $('#message-input').value = text;
    $('#message-input').placeholder = state.online ? `发送消息给 ${current().name}…` : '连接恢复后即可发送，草稿会保留';
    const attachment = state.attachments.get(state.selected);
    $('#attachment').hidden = !attachment;
    $('#attachment').innerHTML = attachment ? `<img src="${attachment.url}" alt="待发送图片"><span title="${escape(attachment.name)}">${escape(attachment.name)}</span><button type="button" class="icon-button" data-action="remove-image" aria-label="移除待发送图片">${icon('x')}</button>` : '';
    updateSendButton(); icons();
  }
  function updateSendButton() { $('#send-button').disabled = !state.online || (!$('#message-input').value.trim() && !state.attachments.has(state.selected)); }
  function selectContact(id) {
    state.scrolls.set(state.selected, $('#thread').scrollTop);
    state.selected = id; state.chatOpen = true; current().unread = 0;
    $('#app').classList.add('chat-open');
    closeEmoji(); renderContacts(); renderThread('bottom'); renderComposer();
    if (state.scrolls.has(id)) $('#thread').scrollTop = state.scrolls.get(id);
    if (state.profile) renderProfile();
    $('#status-popover').hidden = true;
  }
  function changeNav(nav) {
    state.nav = nav; state.search = ''; $('#contact-search').value = '';
    $('#app').classList.toggle('settings', nav === 'settings');
    $('#settings-pane').hidden = nav !== 'settings';
    $('#status-popover').hidden = true;
    closeProfile(); closeEmoji(); hideKeyboard();
    if (nav === 'settings') renderSettings();
    else { state.chatOpen = false; $('#app').classList.remove('chat-open'); }
    markVisibleRead();
    renderContacts();
  }
  function renderProfile() {
    const c = current();
    $('#details-pane').innerHTML = `<header class="details-header"><span>好友资料</span><button class="icon-button" data-action="close-profile" aria-label="关闭好友资料">${icon('x')}</button></header>
      <div class="profile-hero">${avatar(c)}<h3>${escape(c.name)}</h3><p>${c.online ? '当前在线' : '当前离线'}</p></div>
      ${c.game ? `<section class="profile-section"><h3>正在游玩</h3><div class="game-card"><img src="${assets + c.image}" alt="${escape(c.game)}"><strong>${escape(c.game)}</strong><span>Steam 好友状态</span></div></section>` : ''}
      <section class="profile-section"><h3>好友信息</h3><div class="profile-field"><span>Steam ID</span><code>${c.steamId}</code></div><button class="text-button" data-action="copy-id">${icon('copy')}复制 Steam ID</button></section>
      <div class="profile-bottom">与好友的聊天，只在这里接续。</div>`;
    icons(); updateProfileRole();
  }
  function updateProfileRole() {
    const overlay = $('#preview').clientWidth < 1200;
    $('#details-pane').setAttribute('role', overlay ? 'dialog' : 'complementary');
    if (overlay && state.profile) $('#details-pane').setAttribute('aria-modal', 'true'); else $('#details-pane').removeAttribute('aria-modal');
  }
  function closeProfile() {
    state.profile = false; $('#details-pane').hidden = true; $('#details-backdrop').hidden = true;
    $('#app').classList.remove('details-open'); $('#profile-toggle').setAttribute('aria-expanded', 'false');
  }
  function toggleProfile() {
    if (state.profile) { closeProfile(); return; }
    hideKeyboard();
    state.profile = true; $('#details-pane').hidden = false; $('#details-backdrop').hidden = false;
    $('#app').classList.add('details-open'); $('#profile-toggle').setAttribute('aria-expanded', 'true');
    renderProfile(); closeEmoji();
    if ($('#preview').clientWidth < 1200) $('#details-pane button').focus();
  }
  function closeEmoji() { state.emoji = false; $('#emoji-popover').hidden = true; $('#emoji-toggle').setAttribute('aria-expanded', 'false'); }
  function renderEmoji() {
    $('#emoji-popover').hidden = !state.emoji;
    $('#emoji-toggle').setAttribute('aria-expanded', String(state.emoji));
    document.querySelectorAll('[data-emoji-tab]').forEach((el) => el.classList.toggle('active', el.dataset.emojiTab === state.emojiTab));
    $('#emoji-grid').innerHTML = state.emojiTab === 'steam' ?
      ['steamhappy', 'steamthumbsup'].map((name) => `<button type="button" data-emote=":${name}:" aria-label="${name}"><img src="${emotes + name}.png" alt="${name}"></button>`).join('') :
      ['😀', '😊', '🥳', '🥹', '😎', '🤔', '🎮', '🌱', '✨', '❤️', '👍', '🙌', '🍊', '🌙', '🎧', '☕', '🌿', '👌'].map((e) => `<button type="button" data-emote="${e}" aria-label="插入${e}">${e}</button>`).join('');
  }
  function insertText(text) {
    const input = $('#message-input');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + text.length;
    state.drafts.set(state.selected, input.value); updateSendButton();
  }
  function send() {
    if (!state.online) { toast('连接已断开，草稿已保留'); return; }
    const text = $('#message-input').value.trim();
    const attachment = state.attachments.get(state.selected);
    if (!text && !attachment) return;
    const contact = current();
    const id = contact.id;
    const message = { id: `local-${++messageSequence}`, text, image: attachment?.url, imageLabel: attachment?.name, self: true, time: '18:33', pending: true };
    threads.get(id).push(message);
    contact.preview = text || '[图片]'; contact.time = '18:33';
    state.drafts.delete(id); state.attachments.delete(id);
    renderContacts(); renderThread('bottom'); renderComposer(); closeEmoji();
    setTimeout(() => { message.pending = false; if (state.selected === id) renderThread('keep'); }, 320);
  }
  function receive() {
    if (!state.online) { state.queued++; updateConnection(); toast('来信将在连接恢复后补收'); return; }
    const contact = contacts[0];
    const copy = ['对了，记得带上你的钓鱼竿 🎣', '我已经上线啦，随时都可以。', '这次一定能钓到传说鱼 :steamthumbsup:'][messageSequence++ % 3];
    const atBottom = $('#thread').scrollHeight - $('#thread').scrollTop - $('#thread').clientHeight < 50;
    const visible = state.selected === contact.id && chatVisible();
    threads.get(contact.id).push({ id: `incoming-${messageSequence}`, text: copy, self: false, time: '18:34' });
    contact.preview = copy; contact.time = '18:34'; if (!visible) contact.unread++;
    renderContacts();
    if (state.selected === contact.id) { renderThread(atBottom ? 'bottom' : 'keep'); if (!atBottom && visible) $('#new-message-jump').hidden = false; }
    if (!visible) toast(`林间晚风发来一条消息`);
  }
  function updateConnection() {
    $('#list-status').textContent = state.online ? '所有消息已同步' : state.queued ? `等待重连 · ${state.queued} 条来信待同步` : '连接已断开，等待重连';
    $('#offline-banner').hidden = state.online;
    $('.connection-indicator').classList.toggle('offline', !state.online);
    $('.connection-indicator').innerHTML = icon(state.online ? 'circle-check' : 'cloud-off');
    $('#connection-chip').innerHTML = `<span class="status-dot ${state.online ? '' : 'away'}"></span>${state.online ? '实时连接' : '等待重连'}`;
    $('#network-demo').innerHTML = `${icon(state.online ? 'wifi-off' : 'wifi')}<span>${state.online ? '断开网络' : '恢复连接'}</span>`;
    renderComposer(); if (state.nav === 'settings') renderSettings();
    if (!$('#status-popover').hidden) renderStatus();
    icons();
  }
  function renderStatus() {
    $('#status-popover').innerHTML = `<h3>${state.online ? '连接正常' : '正在等待网络恢复'}</h3><p>消息同步<span>${state.online ? '已完成' : '等待重连'}</span></p><p>实时通道<span>${state.online ? '已连接' : '已断开'}</span></p><p>Steam 账户<span>在线</span></p><button data-action="refresh">${state.online ? '立即同步' : '检查连接'}</button>`;
  }
  function renderSettings() {
    const setting = (key, title, description) => `<label class="setting-row"><span><strong>${title}</strong><small>${description}</small></span><input type="checkbox" data-setting="${key}" aria-label="${title}" ${state.settings[key] ? 'checked' : ''}></label>`;
    $('#settings-pane').innerHTML = `<header class="settings-header"><h2>设置</h2><p>让聊天保持连接，按你的方式接收提醒。</p></header><div class="settings-body"><div class="settings-account"><div class="my-avatar">o<span></span></div><div><h3>orbit</h3><p>当前登录账户 · Steam Chat</p></div></div><h3>消息通知</h3><div class="settings-card">
      ${setting('notification', '消息提醒', '接收新消息时，在此设备上提醒')}${setting('preview', '通知显示消息内容', '关闭后只显示“收到一条新消息”')}${setting('background', '后台接收消息', '通过前台服务保持连接，仍受系统后台限制')}
      </div><h3>连接与设备</h3><div class="settings-card"><div class="setting-row"><span><strong>连接状态</strong><small>消息同步与实时通道</small></span><span class="setting-value">${state.online ? '已连接 · 同步完成' : '已断开 · 等待恢复'}</span></div><div class="setting-row"><span><strong>后端地址</strong><small>HTTPS 安全连接</small></span><span class="setting-value">chat.example.test</span></div></div><h3>显示</h3><div class="settings-card"><div class="setting-row"><span><strong>跟随窗口布局</strong><small>横屏双栏，竖屏与窄分屏自动切换</small></span><span class="setting-value">自动</span></div></div></div>`;
  }
  function hideKeyboard() {
    state.keyboard = false;
    $('#app').classList.remove('keyboard-open');
    $('#virtual-keyboard').hidden = true;
    $('#keyboard-demo').setAttribute('aria-pressed', 'false');
  }
  function toggleKeyboard() {
    if (state.keyboard) { hideKeyboard(); return; }
    if (state.nav === 'settings') changeNav('messages');
    state.keyboard = true;
    $('#app').classList.add('keyboard-open');
    $('#virtual-keyboard').hidden = false;
    $('#keyboard-demo').setAttribute('aria-pressed', 'true');
    state.chatOpen = true; $('#app').classList.add('chat-open');
    if (markVisibleRead()) renderContacts();
    $('#virtual-keyboard').innerHTML = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map((row) => `<div class="keyboard-row">${[...row].map((letter) => `<button data-key="${letter}">${letter}</button>`).join('')}</div>`).join('') +
      `<div class="keyboard-row"><button data-action="keyboard" aria-label="收起模拟键盘">${icon('chevron-down')}</button><button class="wide-key" data-key=" ">空格</button><button data-action="backspace" aria-label="退格">${icon('delete')}</button><button class="enter-key" data-action="send">发送</button></div>`;
    icons();
    $('#thread').scrollTop = $('#thread').scrollHeight;
  }
  const actions = {
    back: () => { state.chatOpen = false; $('#app').classList.remove('chat-open'); closeEmoji(); closeProfile(); hideKeyboard(); },
    'new-chat': () => changeNav('friends'), account: () => changeNav('settings'), profile: toggleProfile,
    'close-profile': () => { closeProfile(); $('#profile-toggle').focus(); },
    emoji: () => { state.emoji = !state.emoji; renderEmoji(); }, 'close-emoji': closeEmoji,
    image: () => $('#image-input').click(),
    'remove-image': () => { const attachment = state.attachments.get(state.selected); if (attachment) { URL.revokeObjectURL(attachment.url); objectUrls.delete(attachment.url); } state.attachments.delete(state.selected); renderComposer(); },
    'close-image': () => $('#image-dialog').close(),
    'jump-bottom': () => { $('#thread').scrollTop = $('#thread').scrollHeight; $('#new-message-jump').hidden = true; },
    history: () => {
      if (state.history.get(state.selected)) { toast('演示中的早期记录已全部加载'); return; }
      state.history.set(state.selected, true);
      threads.get(state.selected).unshift({ id: `old-${++messageSequence}`, text: '上次一起玩的存档还在，今天继续吧。', self: false, time: '昨天 21:10' }, { id: `old-${++messageSequence}`, text: '好，我先把游戏更新好。', self: true, time: '昨天 21:12' });
      renderThread('history'); toast('已补充 2 条早期记录');
    },
    receive,
    network: () => { state.online = !state.online; updateConnection(); if (state.online) { const count = state.queued; state.queued = 0; for (let i = 0; i < count; i++) receive(); updateConnection(); toast(count ? `连接已恢复，已补收 ${count} 条消息` : '连接已恢复，草稿可继续发送'); } },
    refresh: () => { $('#status-popover').hidden = true; toast(state.online ? '已同步到最新消息' : '暂无网络，连接恢复后继续同步'); },
    connection: () => { $('#status-popover').hidden = !$('#status-popover').hidden; renderStatus(); },
    'copy-id': async () => { try { await navigator.clipboard.writeText(current().steamId); toast('Steam ID 已复制'); } catch { toast(`Steam ID：${current().steamId}`); } },
    keyboard: toggleKeyboard, send,
    backspace: () => { const input = $('#message-input'); const end = input.selectionStart; if (end > 0 && end === input.selectionEnd) input.selectionStart = end - 1; insertText(''); },
  };
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button?.dataset.action) actions[button.dataset.action]?.();
    if (button?.dataset.nav) changeNav(button.dataset.nav);
    if (button?.dataset.contact) selectContact(button.dataset.contact);
    if (button?.dataset.filter) { state.filter = button.dataset.filter; renderContacts(); }
    if (button?.dataset.emojiTab) { state.emojiTab = button.dataset.emojiTab; renderEmoji(); }
    if (button?.dataset.emote) { insertText(button.dataset.emote); $('#message-input').focus(); }
    if (button?.dataset.key != null) insertText(button.dataset.key);
    if (button?.dataset.fullImage) { $('#full-image').src = button.dataset.fullImage; $('#image-dialog').showModal(); }
    if (!event.target.closest('.status-popover, .connection-indicator')) $('#status-popover').hidden = true;
    if (state.emoji && !event.target.closest('#emoji-popover, #emoji-toggle')) closeEmoji();
  });
  $('#contact-search').addEventListener('input', (e) => { state.search = e.target.value; renderContacts(); });
  $('#message-input').addEventListener('input', (e) => { state.drafts.set(state.selected, e.target.value); updateSendButton(); });
  $('#message-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#thread').addEventListener('scroll', () => { if ($('#thread').scrollHeight - $('#thread').scrollTop - $('#thread').clientHeight < 35) $('#new-message-jump').hidden = true; });
  $('#settings-pane').addEventListener('change', (e) => { if (e.target.dataset.setting) state.settings[e.target.dataset.setting] = e.target.checked; });
  $('#image-input').addEventListener('change', (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) { toast('请选择 10 MB 以内的图片'); return; }
    const previous = state.attachments.get(state.selected);
    if (previous) { URL.revokeObjectURL(previous.url); objectUrls.delete(previous.url); }
    const url = URL.createObjectURL(file); objectUrls.add(url);
    state.attachments.set(state.selected, { url, name: file.name }); renderComposer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#image-dialog').open) { e.preventDefault(); $('#image-dialog').close(); }
      else if (state.profile) { closeProfile(); $('#profile-toggle').focus(); }
      else if (state.emoji) closeEmoji();
      else if (document.body.classList.contains('immersive')) toggleImmersive();
      $('#status-popover').hidden = true;
    }
    if (e.key === 'Tab' && state.profile && $('#preview').clientWidth < 1200) {
      const buttons = [...$('#details-pane').querySelectorAll('button')];
      const first = buttons[0], last = buttons.at(-1);
      if (e.shiftKey && (document.activeElement === first || !$('#details-pane').contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !$('#details-pane').contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });
  const sizes = { landscape: [1280, 800], compact: [1024, 768], portrait: [800, 1024], split: [640, 800], phone: [390, 844] };
  function setSize(value) { const [width, height] = sizes[value] || sizes.landscape; $('#preview').style.width = `${width}px`; $('#preview').style.height = `${height}px`; $('#device-size').value = value in sizes ? value : 'landscape'; }
  $('#device-size').addEventListener('change', (e) => setSize(e.target.value));
  function toggleImmersive() { const active = document.body.classList.toggle('immersive'); $('#exit-fullscreen').hidden = !active; }
  $('#fullscreen').addEventListener('click', toggleImmersive); $('#exit-fullscreen').addEventListener('click', toggleImmersive);
  new ResizeObserver(() => {
    const width = $('#preview').clientWidth;
    $('#layout-label').textContent = `${width} × ${$('#preview').clientHeight} · ${width >= 840 ? '双栏' : '单栏'}`;
    updateProfileRole();
    if (markVisibleRead()) renderContacts();
  }).observe($('#preview'));
  window.addEventListener('pagehide', () => objectUrls.forEach((url) => URL.revokeObjectURL(url)));
  const params = new URLSearchParams(location.search);
  setSize(params.get('device') || 'landscape');
  $('#app').classList.add('chat-open');
  renderContacts(); renderThread('bottom'); renderComposer(); updateConnection();
  if (params.get('details') === '1') toggleProfile();
  if (params.get('immersive') === '1') toggleImmersive();
  icons();
})();
