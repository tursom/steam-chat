'use strict';

import type { Context } from 'node:vm';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

type Listener = (event: Record<string, unknown> & { currentTarget: FakeElement; target: FakeElement }) => unknown;

class FakeElement {
  tagName: string;
  className = '';
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  href = '';
  src = '';
  target = '';
  rel = '';
  srcset = '';
  style: Record<string, string> = {};
  title = '';
  type = '';
  alt = '';
  hidden = false;
  disabled = false;
  id = '';
  value = '';
  open = false;
  scrollHeight = 42;
  attributes: Record<string, string> = {};
  private ownText = '';
  private listeners = new Map<string, Listener[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]) {
    this.children = [...nodes];
    this.ownText = '';
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  async dispatch(type: string, init: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) || []) {
      await listener({ preventDefault() {}, ...init, currentTarget: this, target: (init.target as FakeElement) || this });
    }
  }

  focus() {}

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  contains(node: FakeElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  remove() {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = String(value);
    this.children = [];
  }

  findByClass(className: string): FakeElement | null {
    if (this.className.split(/\s+/).includes(className)) return this;
    for (const child of this.children) {
      const found = child.findByClass(className);
      if (found) return found;
    }
    return null;
  }

  findById(id: string): FakeElement | null {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.findById(id);
      if (found) return found;
    }
    return null;
  }

  findAllByClass(className: string): FakeElement[] {
    const matches: FakeElement[] = this.className.split(/\s+/).includes(className) ? [this] : [];
    return matches.concat(...this.children.map((child) => child.findAllByClass(className)));
  }

  findByTag(tagName: string): FakeElement | null {
    if (this.tagName === tagName.toUpperCase()) return this;
    for (const child of this.children) {
      const found = child.findByTag(tagName);
      if (found) return found;
    }
    return null;
  }

  findAllByTag(tagName: string): FakeElement[] {
    const matches: FakeElement[] = this.tagName === tagName.toUpperCase() ? [this] : [];
    return matches.concat(...this.children.map((child) => child.findAllByTag(tagName)));
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.startsWith('#')) return this.findById(selector.slice(1));
    if (selector.startsWith('.')) return this.findByClass(selector.slice(1));
    return this.findByTag(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return selector.split(',').flatMap((part) => this.findAllByTag(part.trim()));
  }

  get classList() {
    return {
      toggle: (name: string, force?: boolean) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !names.has(name) : force;
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(' ');
      }
    };
  }
}

type WebTestApi = {
  pageSubtitle: () => string;
  renderSteamView: () => FakeElement;
  renderMessage: (item: Record<string, unknown>) => FakeElement;
  renderPicker: (container: FakeElement) => void;
  capturePickerSends: () => Array<{ text: string; preview: string }>;
  createElement: (tag: string) => FakeElement;
  setMediaInventory: (emoticons: Record<string, unknown>[], stickers: Record<string, unknown>[]) => void;
  filterChatEntries: (items: Record<string, unknown>[], query: string) => Record<string, unknown>[];
  openConversation: (id: unknown, name?: string) => void;
  showChatList: () => void;
  getChatState: () => { activeId: string; activeName: string; chatPanel: string };
  setChatAvailability: (online: boolean, accessAllowed: boolean, activeId: string) => void;
  renderChatList: (container: FakeElement) => void;
  setChatListState: (recent: Record<string, unknown>[], friends: Record<string, unknown>[], groups: Record<string, unknown>[], tab: string, query: string, activeId: string) => void;
  renderChatView: () => FakeElement;
  mountChatView: () => FakeElement;
  setFriendDetailsOpen: (open: boolean) => void;
  updateSteamStatus: (status: Record<string, unknown>) => void;
  renderFriendDetails: (container: FakeElement) => void;
};

function loadWebTestApi(): WebTestApi & {
  clipboardWrites: string[];
  lightbox: FakeElement;
  lightboxImage: FakeElement;
  offlineNote: FakeElement;
  chatControls: FakeElement[];
  dispatchDocument: (type: string, init: Record<string, unknown>) => Promise<void>;
} {
  const appPath = path.resolve(__dirname, '../web/app.js');
  const appSource = fs.readFileSync(appPath, 'utf8');
  const bootstrapIndex = appSource.lastIndexOf('bootstrap().catch');
  assert.notEqual(bootstrapIndex, -1, 'web app bootstrap marker is required by the test harness');

  const appRoot = new FakeElement('div');
  const lightbox = new FakeElement('div');
  lightbox.hidden = true;
  const lightboxImage = new FakeElement('img');
  const offlineNote = new FakeElement('div');
  const chatControls = ['textarea', 'button', 'button', 'button', 'input', 'button'].map((tag) => new FakeElement(tag));
  const documentListeners = new Map<string, Listener[]>();
  const dispatchDocument = async (type: string, init: Record<string, unknown>) => {
    for (const listener of documentListeners.get(type) || []) {
      await listener({ preventDefault() {}, ...init, currentTarget: appRoot, target: (init.target as FakeElement) || appRoot });
    }
  };
  const clipboardWrites: string[] = [];
  const sandbox: Context & { __webTest?: WebTestApi } = {
    console,
    document: {
      querySelector(selector: string) {
        if (selector === '#app') return appRoot;
        if (selector === '#lightbox') return lightbox;
        if (selector === '#lightboxImage') return lightboxImage;
        if (selector === '#offlineNote') return offlineNote;
        return selector.startsWith('#') ? appRoot.findById(selector.slice(1)) : null;
      },
      querySelectorAll(selector: string) {
        return selector === '[data-chat-control]' ? chatControls : [];
      },
      createElement(tagName: string) {
        return new FakeElement(tagName);
      },
      createTextNode(text: string) {
        const node = new FakeElement('#text');
        node.textContent = text;
        return node;
      },
      addEventListener(type: string, listener: Listener) {
        const listeners = documentListeners.get(type) || [];
        listeners.push(listener);
        documentListeners.set(type, listeners);
      },
      removeEventListener(type: string, listener: Listener) {
        documentListeners.set(type, (documentListeners.get(type) || []).filter((item) => item !== listener));
      }
    },
    localStorage: { getItem(): null { return null; }, setItem(): void {} },
    navigator: { clipboard: { async writeText(value: string) { clipboardWrites.push(value); } } },
    location: { protocol: 'http:', host: 'localhost' },
    Node: FakeElement,
    URL,
    Headers,
    FormData,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout(callback: () => void) { callback(); return 0; },
    clearTimeout,
    setInterval,
    clearInterval
  };
  const testSource = `${appSource.slice(0, bootstrapIndex)}\n;globalThis.__webTest = { pageSubtitle: () => { state.view = 'chat'; return pageSubtitle(); }, renderSteamView, renderMessage, renderPicker, capturePickerSends: () => { const calls = []; state.me = {id: 1}; state.view = 'chat'; state.activeId = 'peer'; state.steam.status = 'online'; state.steam.accessAllowed = true; sendText = (text, preview) => { calls.push({text, preview}); return Promise.resolve(true); }; return calls; }, createElement: (tag) => document.createElement(tag), setMediaInventory: (emoticons, stickers) => { state.emoticons = emoticons; state.stickers = stickers; }, filterChatEntries, openConversation, showChatList, getChatState: () => ({ activeId: state.activeId, activeName: state.activeName, chatPanel: state.chatPanel }), setChatAvailability: (online, accessAllowed, activeId) => { state.steam.status = online ? 'online' : 'logged_out'; state.steam.accessAllowed = accessAllowed; state.activeId = activeId; updateChatAvailability(); }, renderChatList: renderChatListSections, setChatListState: (recent, friends, groups, tab, query, activeId) => { state.conversations = recent; state.friends = friends; state.groups = groups; state.chatListTab = tab; state.chatQuery = query; state.activeId = activeId; }, renderChatView, mountChatView: () => { state.view = 'chat'; const view = renderChatView(); document.querySelector('#app').replaceChildren(view); return view; }, setFriendDetailsOpen, updateSteamStatus, renderFriendDetails };`;
  vm.runInNewContext(testSource, sandbox);
  assert.ok(sandbox.__webTest);
  return { ...sandbox.__webTest, clipboardWrites, lightbox, lightboxImage, offlineNote, chatControls, dispatchDocument };
}

test('web chat renders Steam OpenGraph messages as preview cards', async () => {
  const { renderMessage, clipboardWrites } = loadWebTestApi();
  const url = 'https://b23.tv/example?share_medium=android&share_source=qq&ts=1234567890';
  const imageUrl = 'https://community.steamstatic.com/chat/image/example/share_image.jpg@1200w_630h';
  const title = '示例“视频”标题';
  const description = '视频播放量 12345、弹幕量 67、点赞数 890';
  const message = `[og url="${url}" img="${imageUrl}" title="${title}" desc="${description}"]${url}[/og]`;

  const rendered = renderMessage({ id: '1', name: 'tursom', type: 'message', message });
  const card = rendered.findByClass('og-card');

  assert.doesNotMatch(rendered.textContent, /\[\/?og\b/i);
  assert.ok(card);
  assert.match(card.textContent, new RegExp(title));
  assert.match(card.textContent, new RegExp(description));
  assert.equal(card.findByTag('img')?.src, `/proxy/image?url=${encodeURIComponent(imageUrl)}`);
  assert.equal(card.findByClass('og-title')?.href, url);
  assert.equal(card.findByClass('og-domain')?.textContent, 'B23.TV');
  assert.equal(card.findByClass('og-domain')?.href, url);

  const copyButton = card.findByClass('og-copy-button');
  assert.ok(copyButton);
  assert.equal(copyButton.attributes['aria-label'], '复制链接');
  await copyButton.dispatch('click');
  assert.deepEqual(clipboardWrites, [url]);

  const imageLink = card.findByClass('og-image-link');
  assert.ok(imageLink);
  await card.findByTag('img')?.dispatch('error');
  assert.equal(imageLink.hidden, true);
  assert.match(card.textContent, new RegExp(title));
});

test('web chat preserves text around multiple OpenGraph cards', () => {
  const { renderMessage } = loadWebTestApi();
  const message = [
    '前文 ',
    '[og url="https://first.example/video" title="第一张"]https://first.example/video[/og]',
    ' 中间 ',
    "[og url='https://second.example/post' desc='第二张描述']https://second.example/post[/og]",
    ' 后文'
  ].join('');

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });
  const cards = rendered.findAllByClass('og-card');

  assert.equal(cards.length, 2);
  assert.match(rendered.textContent, /前文 第一张FIRST\.EXAMPLE 中间 第二张描述SECOND\.EXAMPLE 后文/);
  assert.equal(cards[0].findByClass('og-image-link'), null);
  assert.equal(cards[1].findByClass('og-title'), null);
});

test('web chat leaves malformed or unsafe OpenGraph markup visible', () => {
  const { renderMessage } = loadWebTestApi();
  const messages = [
    '[og url="https://example.com" title="未闭合"]https://example.com',
    '[og title="缺少 URL"]fallback[/og]',
    '[og url="javascript:alert(1)" title="危险协议"]fallback[/og]',
    '[og url="https://example.com" title=broken]fallback[/og]',
    '[og url="https://example.com" extra="unknown"]fallback[/og]'
  ];

  for (const message of messages) {
    const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });
    assert.equal(rendered.findByClass('og-card'), null);
    assert.equal(rendered.textContent, `Alice${message}`);
  }
});

test('web chat decodes escaped quotes in OpenGraph attributes', () => {
  const { renderMessage } = loadWebTestApi();
  const message = '[og url="https://example.com" title="quoted \\"title\\""]https://example.com[/og]';

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });

  assert.match(rendered.findByClass('og-card')?.textContent || '', /quoted "title"/);
});

test('web chat preserves non-duplicate OpenGraph body text', () => {
  const { renderMessage } = loadWebTestApi();
  const message = '[og url="https://example.com" title="示例"]额外说明[/og]';

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });

  assert.ok(rendered.findByClass('og-card'));
  assert.match(rendered.textContent, /示例EXAMPLE\.COM额外说明/);
});

test('web chat handles long unclosed OpenGraph markup without blocking', () => {
  const { renderMessage } = loadWebTestApi();
  const message = `[og ${'a'.repeat(26)}`;
  const startedAt = performance.now();

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });

  assert.ok(performance.now() - startedAt < 250, 'unclosed markup should be handled in linear time');
  assert.equal(rendered.textContent, `Alice${message}`);
});

test('web chat keeps sticker, emoticon, and plain-link rendering around OpenGraph support', () => {
  const { renderMessage } = loadWebTestApi();
  const message = ':wave: https://example.com [sticker type="happy" limit="0"][/sticker]';

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });

  assert.ok(rendered.findByClass('emoticon'));
  assert.ok(rendered.findByClass('sticker'));
  assert.equal(rendered.findByTag('a')?.href, 'https://example.com');
  assert.equal(rendered.findByClass('og-card'), null);
});

test('web chat renders both Steam URL BBCode forms without leaking markup', () => {
  const { renderMessage } = loadWebTestApi();
  const firstUrl = 'https://live.example.com/917818?from=chat&room=main';
  const secondUrl = 'https://video.example.com/watch/1906428959';
  const message = `前文 [url=${firstUrl}]直播间[/url] 中间 [url]${secondUrl}[/url] 后文`;

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });
  const links = rendered.findAllByTag('a');

  assert.doesNotMatch(rendered.textContent, /\[\/?url\b/i);
  assert.match(rendered.textContent, /前文 直播间 中间 https:\/\/video\.example\.com\/watch\/1906428959 后文/);
  assert.deepEqual(links.map((link) => link.href), [firstUrl, secondUrl]);
  assert.ok(links.every((link) => link.target === '_blank' && link.rel === 'noopener noreferrer'));
});

test('web chat renders Steam emoticon BBCode and complete sticker types', () => {
  const { renderMessage } = loadWebTestApi();
  const message = [
    '[emoticon]steamhappy[/emoticon]',
    '[sticker type="show love" limit="0"][/sticker]',
    '[sticker type="伊埃斯跳舞" limit="0"][/sticker]'
  ].join(' ');

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });
  const emoticons = rendered.findAllByClass('emoticon');
  const stickers = rendered.findAllByClass('sticker');

  assert.doesNotMatch(rendered.textContent, /\[\/?(?:emoticon|sticker)\b/i);
  assert.equal(emoticons.length, 1);
  assert.equal(emoticons[0].src, `/proxy/image?url=${encodeURIComponent('https://community.cloudflare.steamstatic.com/economy/emoticon/steamhappy')}`);
  assert.deepEqual(stickers.map((sticker) => sticker.src), [
    '/proxy/sticker/show%20love',
    `/proxy/sticker/${encodeURIComponent('伊埃斯跳舞')}`
  ]);
});

for (const token of [':wave:', '\u02d0wave\u02d0', '[emoticon]wave[/emoticon]', '[emoticon]:wave:[/emoticon]', '[emoticon]\u02d0wave\u02d0[/emoticon]']) {
  test(`emoticon delimiters render without leaking into text: ${token}`, () => {
    const { renderMessage } = loadWebTestApi();
    const rendered = renderMessage({ id: '1', name: 'Alice', message: `before ${token} after` });
    assert.equal(rendered.findAllByClass('emoticon').length, 1);
    assert.equal(rendered.textContent, 'Alicebefore  after');
    assert.equal(rendered.findByClass('emoticon')!.alt, ':wave:');
  });
}

test('emoticon parsing preserves literal surrounding punctuation and ordinary text', () => {
  const { renderMessage } = loadWebTestApi();
  const rendered = renderMessage({ id: '1', name: 'Alice', message: '::wave:: :[emoticon]wave[/emoticon]: 12:30:45 https://example.com/:wave: word:value:tail' });
  assert.equal(rendered.textContent, 'Alice:: :: 12:30:45 https://example.com/:wave: word:value:tail');
  assert.equal(rendered.findAllByClass('emoticon').length, 2);
});

test('sticker picker uses inventory thumbnail but sends the internal type', async () => {
  const api = loadWebTestApi();
  const view = api.mountChatView();
  const sent = api.capturePickerSends();
  view.findById('messageInput')!.value = 'unfinished draft';
  api.setMediaInventory([], [{ name: 'show love', title: 'Localized title', imageUrl: 'https://community.cloudflare.steamstatic.com/economy/image/hash' }]);
  const picker = api.createElement('div');
  picker.dataset.inventoryType = 'stickers';
  api.renderPicker(picker);
  assert.equal(picker.findByTag('img')!.src, `/proxy/image?url=${encodeURIComponent('https://community.cloudflare.steamstatic.com/economy/image/hash')}`);
  await picker.findByClass('picker-grid')!.findByTag('button')!.dispatch('click');
  assert.equal(view.findById('messageInput')!.value, 'unfinished draft');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '/sticker show love');
  assert.equal(sent[0].preview, '[sticker type="show love" limit="0"][/sticker]');
});

test('historical unparsed sticker commands are not labelled as confirmed sends', () => {
  const { renderMessage } = loadWebTestApi();
  const rendered = renderMessage({ id: 'peer', eventId: 'old-command', echo: true, message: '/sticker CatchHeart' });
  assert.equal(rendered.dataset.sendState, 'unknown');
  assert.match(rendered.textContent, /贴纸结果未确认/);
  assert.doesNotMatch(rendered.textContent, /已发送/);
  assert.equal(rendered.findByClass('message-content')!.textContent, '/sticker CatchHeart');
});

test('escaped literal markup remains text instead of becoming a fake sticker or emoticon', () => {
  const { renderMessage } = loadWebTestApi();
  for (const markup of ['[sticker type="Show Love" limit="0"][/sticker]', '[emoticon]Khappy[/emoticon]']) {
    const message = markup.replace(/\[/g, '\\[');
    const rendered = renderMessage({ id: '1', message });
    assert.equal(rendered.findByClass('message-content')!.textContent, markup);
    assert.equal(rendered.findAllByTag('img').length, 0);
  }
});

test('web chat proxies emoticon picker thumbnails', () => {
  const { createElement, renderPicker, setMediaInventory } = loadWebTestApi();
  setMediaInventory([{ name: ':steamhappy:' }], []);

  const picker = createElement('div');
  renderPicker(picker);

  assert.equal(
    picker.findByTag('img')?.src,
    `/proxy/image?url=${encodeURIComponent('https://community.cloudflare.steamstatic.com/economy/emoticon/steamhappy')}`
  );
});

test('picker exposes the complete inventory and rejects unsafe sticker markup', () => {
  const api = loadWebTestApi();
  api.setMediaInventory([], [...Array.from({ length: 161 }, (_, i) => ({ name: `sticker${i}` })), { name: 'bad" type="other' }]);
  const picker = api.createElement('div');
  picker.dataset.inventoryType = 'stickers';
  api.renderPicker(picker);
  assert.equal(picker.findByClass('picker-grid')!.findAllByTag('button').length, 161);
});

for (const name of ['steamhappy', ':steamhappy:', '\u02d0steamhappy\u02d0']) {
  test(`picker inserts official client emoticon syntax for ${name}`, async () => {
    const api = loadWebTestApi();
    const view = api.mountChatView();
    api.setMediaInventory([{ name }], []);
    const picker = api.createElement('div');
    api.renderPicker(picker);
    await picker.findByClass('picker-grid')!.findByTag('button')!.dispatch('click');
    assert.equal(view.findById('messageInput')!.value, ':steamhappy:');
  });
}

test('web chat renders HAR-style Steam image BBCode with proxying, aspect ratio, and lightbox', async () => {
  const { renderMessage, lightbox, lightboxImage } = loadWebTestApi();
  const fullUrl = 'https://images.example.com/ugc/full/image/';
  const thumbnailUrl = `${fullUrl}?imw=512&&ima=fit&imcolor=%23000000`;
  const largeUrl = `${fullUrl}?imw=1024&&ima=fit&imcolor=%23000000`;
  const message = [
    '图片前文 ',
    `[img src=${fullUrl} thumbnail_src=${thumbnailUrl} srcset="${largeUrl} 1024w" width=1206 height=1996]`,
    `[url=${fullUrl}]${fullUrl}[/url][/img]`,
    ' 图片后文'
  ].join('');

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });
  const shell = rendered.findByClass('bbcode-image-shell');
  const button = rendered.findByClass('bbcode-image-button');
  const image = rendered.findByClass('bbcode-image');

  assert.doesNotMatch(rendered.textContent, /\[\/?(?:img|url)\b/i);
  assert.match(rendered.textContent, /图片前文\s+图片后文/);
  assert.ok(shell);
  assert.ok(button);
  assert.ok(image);
  assert.equal(image.src, `/proxy/image?url=${encodeURIComponent(thumbnailUrl)}`);
  assert.equal(image.srcset, `/proxy/image?url=${encodeURIComponent(largeUrl)} 1024w`);
  assert.equal(button.style.aspectRatio, '1206 / 1996');
  assert.equal(button.style.width, '253px');

  await button.dispatch('click');
  assert.equal(lightbox.hidden, false);
  assert.equal(lightboxImage.src, `/proxy/image?url=${encodeURIComponent(fullUrl)}`);

  await image.dispatch('error');
  const fallback = shell.findByTag('a');
  assert.ok(fallback);
  assert.equal(fallback.href, fullUrl);
  assert.equal(fallback.textContent, fullUrl);
});

test('web chat falls back from invalid optional image attributes without rejecting the image', () => {
  const { renderMessage } = loadWebTestApi();
  const fullUrl = 'https://images.example.com/ugc/full/image/';
  const message = `[img src=${fullUrl} thumbnail_src=javascript:alert(1) srcset="javascript:alert(1) 2x" width=0 height=bad][url=${fullUrl}]${fullUrl}[/url][/img]`;

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });
  const button = rendered.findByClass('bbcode-image-button');
  const image = rendered.findByClass('bbcode-image');

  assert.ok(button);
  assert.ok(image);
  assert.equal(image.src, `/proxy/image?url=${encodeURIComponent(fullUrl)}`);
  assert.equal(image.srcset, '');
  assert.equal(button.style.aspectRatio, undefined);
});

test('web chat accepts the empty image srcset emitted by Steam', () => {
  const { renderMessage } = loadWebTestApi();
  const fullUrl = 'https://images.example.com/ugc/full/image/';
  const message = `[img src=${fullUrl} thumbnail_src=${fullUrl} srcset="" width=704 height=245][url=${fullUrl}]${fullUrl}[/url][/img]`;

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });
  const image = rendered.findByClass('bbcode-image');

  assert.ok(image);
  assert.equal(image.srcset, '');
  assert.doesNotMatch(rendered.textContent, /\[\/?(?:img|url)\b/i);
});

test('web chat preserves malformed, unsafe, or unsupported Steam BBCode', () => {
  const { renderMessage } = loadWebTestApi();
  const messages = [
    '[url=javascript:alert(1)]危险[/url]',
    '[url]not a URL[/url]',
    '[url=https://example.com]未闭合',
    '[emoticon]bad name[/emoticon]',
    '[sticker limit="0"][/sticker]',
    '[sticker type="happy" limit="0"]正文[/sticker]',
    '[img src=javascript:alert(1)][url=javascript:alert(1)]bad[/url][/img]',
    '[img src=https://images.example.com/full][url=https://images.example.com/other]other[/url][/img]',
    '[spoiler]未知标签[/spoiler]'
  ];

  for (const message of messages) {
    const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });
    assert.equal(rendered.textContent, `Alice${message}`);
    assert.equal(rendered.findByClass('bbcode-image'), null);
  }
});

test('web chat handles long unclosed supported BBCode without blocking', () => {
  const { renderMessage } = loadWebTestApi();
  const message = `[img src=https://example.com/${'a'.repeat(100_000)}`;
  const startedAt = performance.now();

  const rendered = renderMessage({ id: '1', name: 'Alice', type: 'message', message });

  assert.ok(performance.now() - startedAt < 250, 'unclosed markup should be handled in linear time');
  assert.equal(rendered.textContent, `Alice${message}`);
});

test('recent list and selected header use current peer identity instead of the outgoing sender', async () => {
  const api = loadWebTestApi();
  const id = '76561198000000001';
  const recent = [{ id, name: 'tursom', preview: 'outgoing preview', updatedAt: '2026-01-01T12:42:00Z' }];
  const friends = [{ id, name: 'Current friend', avatar: 'https://example.com/peer.png', online: true }];
  api.setChatListState(recent, friends, [], 'recent', '', id);
  const view = api.mountChatView();
  const row = view.findByClass('list-item')!;
  assert.match(row.findByClass('item-title')!.textContent, /Current friend/);
  assert.doesNotMatch(row.findByClass('item-title')!.textContent, /tursom/);
  assert.equal(row.findByClass('item-preview')!.textContent, 'outgoing preview');
  assert.equal(row.findByTag('img')!.src, friends[0].avatar);
  await row.dispatch('click');
  assert.equal(api.getChatState().activeName, 'Current friend');
  assert.match(view.findByClass('thread-identity')!.textContent, /Current friend/);
  const results = api.createElement('div');
  api.setChatListState(recent, friends, [], 'recent', 'Current friend', id);
  api.renderChatList(results);
  assert.equal(results.findAllByClass('list-item').length, 1);
  assert.equal(recent[0].name, 'tursom', 'display enrichment must not mutate source records');
});

test('unavailable live names retain the known peer name', () => {
  const api = loadWebTestApi();
  const id = '76561198000000001';
  api.setChatListState([{ id, name: 'Known friend', preview: 'preview' }], [{ id, name: id }], [], 'recent', '', id);
  const view = api.mountChatView();
  assert.match(view.findByClass('item-title')!.textContent, /Known friend/);
  assert.match(view.findByClass('thread-identity')!.textContent, /Known friend/);
});

test('web chat filters the selected conversation group by name, SteamID, and preview', () => {
  const { filterChatEntries } = loadWebTestApi();
  const entries = [
    { id: '76561198000000001', name: 'Alice', preview: '今晚开黑' },
    { id: '76561198000000002', name: 'Bob', preview: 'Trade offer received' },
    { id: '103582791429000001', name: 'CS2 Group', preview: '赛事通知' }
  ];

  assert.deepEqual(filterChatEntries(entries, 'alice').map((item) => item.id), ['76561198000000001']);
  assert.deepEqual(filterChatEntries(entries, '00000002').map((item) => item.id), ['76561198000000002']);
  assert.deepEqual(filterChatEntries(entries, 'trade OFFER').map((item) => item.id), ['76561198000000002']);
  assert.deepEqual(filterChatEntries(entries, '  赛事  ').map((item) => item.id), ['103582791429000001']);
  assert.deepEqual(filterChatEntries(entries, '').map((item) => item.id), entries.map((item) => item.id));
});

test('web chat renders the selected conversation group, empty results, and active state', () => {
  const { renderChatList, setChatListState } = loadWebTestApi();
  const recent = [{ id: 'recent-1', name: 'Recent Alice', preview: '最近消息' }];
  const friends = [{ id: 'friend-1', name: 'Friend Bob', preview: '好友消息' }];
  const groups = [{ id: 'group-1', name: 'Group CS2', preview: '群组消息' }];
  const container = new FakeElement('div');

  for (const [tab, expected] of [['recent', 'Recent Alice'], ['friends', 'Friend Bob'], ['groups', 'Group CS2']]) {
    setChatListState(recent, friends, groups, tab, '', tab === 'friends' ? 'friend-1' : '');
    renderChatList(container);
    assert.equal(container.children.length, 1);
    assert.match(container.textContent, new RegExp(expected));
    if (tab === 'friends') {
      assert.match(container.children[0].className, /\bis-active\b/);
      assert.equal(container.children[0].attributes['aria-current'], 'true');
    }
  }

  setChatListState(recent, friends, groups, 'groups', 'not-found', '');
  renderChatList(container);
  assert.equal(container.textContent, '没有匹配的会话');
});

test('web chat enters a conversation and returns to the list without losing the selection', () => {
  const { openConversation, showChatList, getChatState } = loadWebTestApi();

  openConversation('76561198000000001', 'Alice');
  assert.equal(getChatState().activeId, '76561198000000001');
  assert.equal(getChatState().activeName, 'Alice');
  assert.equal(getChatState().chatPanel, 'thread');

  showChatList();
  assert.equal(getChatState().activeId, '76561198000000001');
  assert.equal(getChatState().activeName, 'Alice');
  assert.equal(getChatState().chatPanel, 'list');
});

test('web chat disables composer controls until a usable conversation is selected', () => {
  const { setChatAvailability, chatControls, offlineNote } = loadWebTestApi();
  const controls = chatControls;

  setChatAvailability(true, true, '76561198000000001');
  assert.ok(controls.every((node) => !node.disabled));
  assert.equal(offlineNote.hidden, true);

  setChatAvailability(true, true, '');
  assert.ok(controls.every((node) => node.disabled));
  assert.equal(offlineNote.hidden, true);

  setChatAvailability(false, true, '76561198000000001');
  assert.ok(controls.every((node) => node.disabled));
  assert.equal(offlineNote.hidden, false);
  assert.match(offlineNote.textContent, /Steam 未在线/);

  setChatAvailability(true, false, '76561198000000001');
  assert.ok(controls.every((node) => node.disabled));
  assert.equal(offlineNote.hidden, false);
  assert.match(offlineNote.textContent, /未被授权/);
});

test('web chat shows disconnected status instead of denied access without a Steam session', () => {
  const { setChatAvailability, chatControls, offlineNote, pageSubtitle, renderSteamView } = loadWebTestApi();
  setChatAvailability(false, false, '76561198000000001');
  assert.ok(chatControls.every((node) => node.disabled));
  assert.equal(offlineNote.hidden, false);
  assert.match(offlineNote.textContent, /Steam 未在线/);
  assert.doesNotMatch(offlineNote.textContent, /未被授权/);
  assert.match(pageSubtitle(), /Steam 未在线/);
  assert.doesNotMatch(renderSteamView().textContent, /未被授权/);

  setChatAvailability(true, false, '76561198000000001');
  assert.match(pageSubtitle(), /未被授权/);
  assert.match(renderSteamView().textContent, /未被授权/);
});

test('friend details merge live friend data with recent conversation and collapse without losing selection', async () => {
  const api = loadWebTestApi();
  const id = '76561198000000001';
  api.setChatAvailability(true, true, id);
  api.setChatListState([{ id, name: 'Old name', preview: 'Hello' }], [{ id, name: 'Alice', avatar: 'https://example.com/avatar.png', online: true, gameName: 'Dota 2' }], [], 'recent', '', id);
  const view = api.mountChatView();
  const details = view.findById('friendDetails');
  const toggle = view.findById('friendDetailsToggle');
  assert.ok(details);
  assert.ok(toggle);
  assert.equal(details.hidden, true);
  await toggle.dispatch('click');
  assert.equal(details.hidden, false);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.match(details.textContent, /Alice/);
  assert.match(details.textContent, /Dota 2/);
  assert.doesNotMatch(details.textContent, /Old name/);
  assert.equal(details.findByTag('img')?.src, 'https://example.com/avatar.png');
  assert.equal(details.findByTag('a')?.href, `https://steamcommunity.com/profiles/${id}`);
  assert.equal(details.findByTag('a')?.rel, 'noopener noreferrer');
  await api.dispatchDocument('keydown', { key: 'Escape' });
  assert.equal(details.hidden, true);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(api.getChatState().activeId, id);
  await toggle.dispatch('click');
  await view.findById('friendDetailsBackdrop')?.dispatch('click');
  assert.equal(details.hidden, true);
});

test('friend details follow conversation selection, clear on permission loss and never invent unknown status', () => {
  const api = loadWebTestApi();
  const first = '76561198000000001';
  const second = '76561198000000002';
  api.setChatAvailability(true, true, first);
  api.setChatListState([{ id: first, name: 'Alice' }, { id: second, name: 'Bob' }], [], [], 'recent', '', first);
  const view = api.mountChatView();
  api.setFriendDetailsOpen(true);
  const details = view.findById('friendDetails');
  assert.ok(details);
  assert.match(details.textContent, /状态未知/);
  api.openConversation(second, 'Bob');
  assert.match(details.textContent, /Bob/);
  assert.doesNotMatch(details.textContent, /Alice/);
  api.updateSteamStatus({ status: 'online', accessAllowed: false });
  assert.equal(details.hidden, true);
  assert.doesNotMatch(details.textContent, /Bob/);
  assert.equal(view.findById('friendDetailsToggle')?.disabled, true);
});

test('friend details omit profile links for invalid identifiers and close on returning to the list', () => {
  const api = loadWebTestApi();
  api.setChatAvailability(true, true, 'not-a-steamid');
  const view = api.mountChatView();
  api.setFriendDetailsOpen(true);
  assert.equal(view.findById('friendDetails')?.findByTag('a'), null);
  api.showChatList();
  assert.equal(view.findById('friendDetails')?.hidden, true);
  assert.equal(api.getChatState().chatPanel, 'list');
});

test('web chat opens and closes the new conversation dialog', async () => {
  const { renderChatView } = loadWebTestApi();
  const view = renderChatView();
  const openButton = view.findByClass('new-chat-btn');
  const dialog = view.findByClass('new-chat-dialog');
  const closeButton = view.findByClass('dialog-close');

  assert.ok(openButton);
  assert.ok(dialog);
  assert.ok(closeButton);
  assert.equal(dialog.open, false);
  await openButton.dispatch('click');
  assert.equal(dialog.open, true);
  await closeButton.dispatch('click');
  assert.equal(dialog.open, false);
});

test('web chat closes the attachment menu with Escape or an outside click', async () => {
  const { renderChatView, dispatchDocument } = loadWebTestApi();
  const view = renderChatView();
  const trigger = view.findById('attachmentToggle');
  const menu = view.findById('attachmentMenu');

  assert.ok(trigger);
  assert.ok(menu);
  await trigger.dispatch('click');
  assert.equal(menu.hidden, false);
  await dispatchDocument('keydown', { key: 'Escape', target: trigger });
  assert.equal(menu.hidden, true);

  await trigger.dispatch('click');
  assert.equal(menu.hidden, false);
  await dispatchDocument('pointerdown', { target: new FakeElement('div') });
  assert.equal(menu.hidden, true);
});
