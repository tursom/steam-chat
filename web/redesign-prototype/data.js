// Mock fixtures for the redesign prototype. Nothing here reaches the real backend.
const A = '../prototype/assets/';
const E = '../android-prototype/assets/';

const FRIENDS = [
  { id: '76561198040000001', name: '林间晚风', nickname: '老林', hue: 162, presence: 'game', game: 'Dota 2', appId: 570, art: A + 'dota.jpg', rich: '排位赛 · 第 23 分钟', preview: '今晚八点？我应该能准时上线', time: '14:32', unread: 2 },
  { id: '76561198040000002', name: 'Morrow', hue: 330, presence: 'game', game: 'Counter-Strike 2', appId: 730, art: A + 'cs2.jpg', rich: '竞技模式 · Mirage 9:7', preview: '[图片]', time: '14:18', unread: 1 },
  { id: '76561198040000003', name: '小岛邮差', hue: 42, presence: 'game', game: 'Stardew Valley', appId: 413150, art: A + 'stardew.jpg', rich: '第 2 年 · 春 14 日', preview: '给你看看我的新农场', time: '13:56' },
  { id: '76561198040000004', name: 'Northstar', hue: 214, presence: 'online', preview: '好，那我们周末再约', time: '12:40' },
  { id: '76561198040000005', name: 'Kite', hue: 18, presence: 'online', preview: '收到 👍', time: '11:02' },
  { id: '76561198040000006', name: '白噪音', hue: 268, presence: 'away', preview: '这次更新终于修好了', time: '昨天' },
  { id: '76561198040000007', name: 'Echo', hue: 8, presence: 'offline', lastOnline: '3 小时前', preview: '下次一起玩！', time: '昨天' },
  { id: '76561198040000008', name: '鲸落', hue: 190, presence: 'offline', lastOnline: '2 天前', preview: '链接我看了', time: '10/29' }
];

const GROUPS = [
  { id: '103582791460000001', name: '周末开黑小队', hue: 120, group: true, preview: '社区群组 · 12 名成员', time: '' },
  { id: '103582791460000002', name: 'Steam 中文交易群', hue: 280, group: true, preview: '社区群组 · 386 名成员', time: '' }
];

// t: text | emote | image | og | sticker. self = sent by the active Steam account.
const THREADS = {
  '76561198040000001': [
    { day: '昨天' },
    { self: false, time: '22:41', t: 'text', text: '今天那把翻盘太离谱了' },
    { self: true, time: '22:43', t: 'text', text: '主要是对面最后一波上高太急了' },
    { self: true, time: '22:43', t: 'emote', text: '下次还这么打', emote: 'steamhappy' },
    { day: '今天' },
    { self: false, time: '14:02', t: 'og', url: 'store.steampowered.com', title: 'Dota 2 on Steam', desc: '每天都有数百万玩家化身为一百余名 Dota 英雄展开大战。', img: A + 'dota.jpg' },
    { self: false, time: '14:02', t: 'text', text: '新版本出了，晚上试试新英雄？', reactions: [{ e: 'steamthumbsup', n: 1, mine: true }] },
    { self: true, time: '14:20', t: 'text', text: '可以，我先把更新下好' },
    { self: true, time: '14:21', t: 'image', img: A + 'dota.jpg' },
    { self: false, time: '14:32', t: 'text', text: '今晚八点？我应该能准时上线' },
    { self: true, time: '14:33', t: 'text', text: '八点见，开语音', state: 'failed' }
  ],
  '76561198040000002': [
    { day: '今天' },
    { self: false, time: '14:15', t: 'text', text: '看看这个准星设置' },
    { self: false, time: '14:18', t: 'image', img: A + 'cs2.jpg' },
    { self: true, time: '14:19', t: 'text', text: '这个准星我也试试', state: 'unknown' },
    { self: true, time: '14:20', t: 'image', img: A + 'cs2.jpg', state: 'retry_wait' }
  ],
  '76561198040000003': [
    { day: '今天' },
    { self: false, time: '13:55', t: 'image', img: A + 'stardew.jpg' },
    { self: false, time: '13:56', t: 'text', text: '给你看看我的新农场' },
    { self: false, time: '13:56', t: 'sticker', text: '🐔' }
  ]
};

// Shown after "jump to date": a detached slice of older history.
const ARCHIVE = [
  { day: '10 月 26 日 周一' },
  { self: false, time: '21:10', t: 'text', text: '周末那个活动还去吗' },
  { self: true, time: '21:12', t: 'text', text: '去，我把票订了' },
  { self: false, time: '21:15', t: 'emote', text: '好耶', emote: 'steamhappy' }
];

const EMOTICONS = [
  { name: 'steamhappy', img: E + 'steamhappy.png' },
  { name: 'steamthumbsup', img: E + 'steamthumbsup.png' }
];
const UNICODE = ['😀', '😂', '🥲', '😎', '🤔', '👍', '🙏', '🔥', '🎉', '❤️', '👀', '💤'];
const STICKERS = ['🐔', '🐸', '🦊', '🐱', '🎮', '🏆'];
const EFFECTS = ['🎆 烟花', '🎈 气球', '❄️ 雪花', '💖 爱心'];

const STEAM_ACCOUNTS = [
  { id: 1, label: '主号 · Dove', steamId: '76561198000000001', hint: 'dove_main', enabled: true, active: true, users: 3, lastActive: '刚刚', token: '10 月 30 日' },
  { id: 2, label: '交易号', steamId: '76561198000000002', hint: 'dove_trade', enabled: true, active: false, users: 1, lastActive: '昨天 21:04', token: '10 月 12 日' },
  { id: 3, label: '旧号', steamId: '76561198000000003', hint: '', enabled: false, active: false, users: 0, lastActive: '9 月 2 日', token: '已过期' }
];

// Proposed permission catalogue. `steam.account.all` replaces the hard-coded admin bypass.
const PERMISSION_GROUPS = [
  { name: '用户与安全', items: [
    ['user.view', '查看用户', '查看用户列表、资料和登录状态'],
    ['user.manage', '管理用户', '新增、编辑、禁用、删除用户和重置密码'],
    ['role.manage', '管理角色与权限', '新建角色、编辑权限点、设置个人覆盖'],
    ['session.manage', '管理登录会话', '查看并踢下线其他用户的会话'],
    ['audit.view', '查看审计日志', '查看关键管理动作记录']
  ] },
  { name: 'Steam', items: [
    ['steam.manage', '登录与切换 Steam', '扫码/密码登录、Guard 验证、退出与切换活动账户'],
    ['steam.account.manage', '维护 Steam 账户', '编辑账户资料、启用或禁用账户'],
    ['steam.grant.manage', '分配 Steam 授权', '为用户设置授权等级、会话范围和有效期'],
    ['steam.account.all', '访问全部 Steam 账户', '不受授权表限制，以「完整 · 全部会话」访问所有账户']
  ] },
  { name: '聊天与素材', items: [
    ['chat.use', '使用聊天', '进入聊天界面；具体能力由 Steam 授权等级决定'],
    ['emote.manage', '管理图片表情', '维护共享图片表情分组与素材']
  ] },
  { name: '个人', items: [
    ['self.password.change', '修改自己的密码', '在设置中修改后台登录密码']
  ] }
];
const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap(g => g.items.map(i => i[0]));

const ROLES = [
  { id: 'super', name: '超级管理员', builtin: true, desc: '拥有全部权限，不可修改或删除。', perms: [...ALL_PERMISSIONS] },
  { id: 'member', name: '成员', builtin: true, desc: '新用户的默认角色。权限可调整，不可删除。', perms: ['chat.use', 'self.password.change'] },
  { id: 'cs', name: '客服', desc: '使用被授权的 Steam 账户接待好友消息。', perms: ['chat.use', 'self.password.change'] },
  { id: 'auditor', name: '审计员', desc: '只读查看用户与审计记录。', perms: ['user.view', 'audit.view', 'chat.use', 'self.password.change'] }
];

const LEVELS = [
  ['none', '无', '不可访问'],
  ['read', '只读', '查看会话列表与历史'],
  ['chat', '聊天', '另可发送文字和 Steam 表情'],
  ['full', '完整', '另可发图片、贴纸、效果和表情回应']
];

const USERS = [
  { id: 1, username: 'dove', display: 'Dove', role: 'super', status: 'enabled', note: '初始化管理员', created: '2026-03-02', lastLogin: '今天 09:12', ip: '192.168.0.12', seen: '刚刚', pwd: '2026-08-14', failed: 0,
    overrides: {}, grants: {},
    sessions: [{ device: 'Chrome · Linux', ip: '192.168.0.12', seen: '刚刚', current: true }, { device: 'Steam Chat · Android', ip: '10.0.0.4', seen: '2 小时前' }] },
  { id: 2, username: 'kefu01', display: '客服一号', role: 'cs', status: 'enabled', note: '负责主号的日常回复', created: '2026-06-18', lastLogin: '今天 08:55', ip: '192.168.0.31', seen: '5 分钟前', pwd: '2026-06-18', failed: 0,
    overrides: { 'emote.manage': 'grant' },
    grants: { 1: { level: 'chat', scope: 'some', friends: ['76561198040000001', '76561198040000002', '76561198040000004'], expires: '2026-12-31' } },
    sessions: [{ device: 'Edge · Windows', ip: '192.168.0.31', seen: '5 分钟前' }] },
  { id: 3, username: 'audit', display: '审计小王', role: 'auditor', status: 'enabled', note: '', created: '2026-07-01', lastLogin: '10 月 30 日', ip: '192.168.0.40', seen: '10 月 30 日', pwd: '2026-07-01', failed: 0,
    overrides: {}, grants: { 1: { level: 'read', scope: 'all', friends: [], expires: '' } }, sessions: [] },
  { id: 4, username: 'trade', display: '交易助手', role: 'member', status: 'enabled', note: '只用交易号', created: '2026-05-11', lastLogin: '昨天 21:00', ip: '192.168.0.52', seen: '昨天', pwd: '2026-05-11', failed: 0,
    overrides: {}, grants: { 2: { level: 'full', scope: 'all', friends: [], expires: '' } }, sessions: [{ device: 'Safari · iPhone', ip: '10.0.0.9', seen: '昨天' }] },
  { id: 5, username: 'temp', display: '临时访客', role: 'member', status: 'locked', note: '活动期间临时查看', created: '2026-10-28', lastLogin: '10 月 29 日', ip: '203.0.113.7', seen: '10 月 29 日', pwd: '2026-10-28', failed: 5,
    overrides: { 'chat.use': 'grant' }, grants: { 1: { level: 'read', scope: 'some', friends: ['76561198040000003'], expires: '2026-11-09' } }, sessions: [] },
  { id: 6, username: 'old', display: '离职同事', role: 'member', status: 'disabled', note: '2026-09 离职', created: '2026-03-20', lastLogin: '9 月 12 日', ip: '192.168.0.77', seen: '9 月 12 日', pwd: '2026-03-20', failed: 0,
    overrides: {}, grants: {}, sessions: [] }
];

// "View as" personas: how the same UI degrades under the proposed authorization model.
const PERSONAS = {
  admin: { user: 1, label: '超级管理员 · Dove' },
  cs: { user: 2, label: '客服 · 客服一号' },
  auditor: { user: 3, label: '审计员 · 审计小王' }
};

const AUDIT = [
  { time: '今天 14:05', actor: 'dove', cat: 'grant', action: '修改 Steam 授权', target: '客服一号 · 主号', ip: '192.168.0.12', diff: [['等级', '只读', '聊天'], ['会话范围', '全部会话', '指定好友（3）'], ['有效期', '永久', '2026-12-31']] },
  { time: '今天 13:40', actor: 'dove', cat: 'role', action: '编辑角色', target: '客服', ip: '192.168.0.12', diff: [['权限点', '+ chat.use', ''], ['权限点', '− audit.view', '']] },
  { time: '今天 11:22', actor: 'dove', cat: 'role', action: '设置个人权限覆盖', target: '客服一号', ip: '192.168.0.12', diff: [['emote.manage', '继承（无）', '授予']] },
  { time: '今天 09:12', actor: 'dove', cat: 'session', action: '登录后台', target: 'dove', ip: '192.168.0.12', diff: [['设备', '', 'Chrome · Linux']] },
  { time: '昨天 21:00', actor: 'dove', cat: 'steam', action: '连接 Steam 账户', target: '主号 · Dove', ip: '192.168.0.12', diff: [['状态', '未连接', '在线']] },
  { time: '10 月 29 日 18:31', actor: '系统', cat: 'user', action: '锁定用户', target: '临时访客', ip: '203.0.113.7', diff: [['失败次数', '4', '5'], ['锁定至', '', '10 月 29 日 18:46']] },
  { time: '10 月 28 日 10:02', actor: 'dove', cat: 'user', action: '新增用户', target: '临时访客', ip: '192.168.0.12', diff: [['角色', '', '成员'], ['要求改密', '', '是']] },
  { time: '9 月 30 日 17:45', actor: 'dove', cat: 'user', action: '禁用用户', target: '离职同事', ip: '192.168.0.12', diff: [['状态', '启用', '禁用'], ['会话', '1 个', '已全部失效']] }
];

const EMOTE_GROUPS = [
  { id: 'common', name: '常用', items: [
    { id: 'e1', name: '开心', img: E + 'steamhappy.png', size: '64 × 64 · 15 KiB' },
    { id: 'e2', name: '点赞', img: E + 'steamthumbsup.png', size: '18 × 18 · 2 KiB' },
    { id: 'e3', name: '刀塔', img: A + 'dota.jpg', size: '460 × 215 · 37 KiB' }
  ] },
  { id: 'react', name: '反应图', items: [
    { id: 'e4', name: '农场', img: A + 'stardew.jpg', size: '460 × 215 · 57 KiB' },
    { id: 'e5', name: '残局', img: A + 'cs2.jpg', size: '460 × 215 · 33 KiB' }
  ] },
  { id: 'empty', name: '新分组', items: [] }
];
