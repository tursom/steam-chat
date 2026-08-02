'use strict';

import type { Context } from 'node:vm';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

type Listener = (event: { currentTarget: FakeElement; target: FakeElement }) => unknown;

class FakeElement {
  tagName: string;
  className = '';
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  href = '';
  src = '';
  target = '';
  rel = '';
  title = '';
  type = '';
  alt = '';
  hidden = false;
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

  async dispatch(type: string) {
    for (const listener of this.listeners.get(type) || []) {
      await listener({ currentTarget: this, target: this });
    }
  }

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
}

type WebTestApi = {
  renderMessage: (item: Record<string, unknown>) => FakeElement;
};

function loadWebTestApi(): WebTestApi & { clipboardWrites: string[] } {
  const appPath = path.resolve(__dirname, '../web/app.js');
  const appSource = fs.readFileSync(appPath, 'utf8');
  const bootstrapIndex = appSource.lastIndexOf('bootstrap().catch');
  assert.notEqual(bootstrapIndex, -1, 'web app bootstrap marker is required by the test harness');

  const appRoot = new FakeElement('div');
  const clipboardWrites: string[] = [];
  const sandbox: Context & { __webTest?: WebTestApi } = {
    console,
    document: {
      querySelector(selector: string) {
        return selector === '#app' ? appRoot : null;
      },
      createElement(tagName: string) {
        return new FakeElement(tagName);
      },
      createTextNode(text: string) {
        const node = new FakeElement('#text');
        node.textContent = text;
        return node;
      },
      addEventListener() {}
    },
    localStorage: { getItem(): null { return null; }, setItem(): void {} },
    navigator: { clipboard: { async writeText(value: string) { clipboardWrites.push(value); } } },
    location: { protocol: 'http:', host: 'localhost' },
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
  const testSource = `${appSource.slice(0, bootstrapIndex)}\n;globalThis.__webTest = { renderMessage };`;
  vm.runInNewContext(testSource, sandbox);
  assert.ok(sandbox.__webTest);
  return { ...sandbox.__webTest, clipboardWrites };
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
