import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

type ImageFile = { name: string; type: string; size: number };
class Element {
  id = '';
  value = '';
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  listeners = new Map<string, (event: any) => void>();
  constructor(public tagName: string) {}
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; }
  setAttribute() {}
  addEventListener(name: string, handler: (event: any) => void) { this.listeners.set(name, handler); }
  querySelector(): null { return null; }
  querySelectorAll(): Element[] { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
}

function harness() {
  const readers: Reader[] = [];
  class Reader {
    result: string | null = null;
    file?: ImageFile;
    aborted = false;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    constructor() { readers.push(this); }
    readAsDataURL(file: ImageFile) { this.file = file; }
    abort() { this.aborted = true; this.onabort?.(); }
    finish() { this.result = `data:${this.file?.type};base64,YWJj`; this.onload?.(); }
  }
  const root = new Element('main');
  const elements: Element[] = [root];
  const requests: Array<{ url: string; body: Record<string, string> }> = [];
  const sandbox = {
    document: {
      querySelector: (selector: string) => selector === '#app' ? root : elements.find(element => `#${element.id}` === selector) || null,
      querySelectorAll: (): Element[] => [], addEventListener() {}, removeEventListener() {},
      createElement: (tag: string) => { const element = new Element(tag); elements.push(element); return element; }
    },
    localStorage: { getItem: (): null => null, setItem() {} },
    FileReader: Reader, URL, URLSearchParams, Headers, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (url: string, init: { body?: string }) => {
      requests.push({ url, body: JSON.parse(init?.body || '{}') });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    __test: undefined as unknown
  };
  const source = readFileSync(resolve(__dirname, '../web/app.js'), 'utf8');
  runInNewContext(`${source.slice(0, source.lastIndexOf('bootstrap().catch'))}
    state.me = {id:1}; state.view = 'chat'; state.activeId = '76561198000000002';
    state.steam = {...state.steam, status:'online', accessAllowed:true, steamId:'76561198000000001'};
    renderComposer();
    globalThis.__test = {state, resetHistory, sendFiles, pending: () => pendingImageReaders.size};`, sandbox);
  const api = sandbox.__test as {
    state: { me: unknown; view: string; activeId: string; feedback: string; steam: { status: string; accessAllowed: boolean; steamId: string } };
    resetHistory: () => void; sendFiles: (files: ImageFile[]) => void; pending: () => number;
  };
  const input = elements.find(element => element.id === 'messageInput')!;
  function paste(files: ImageFile[], options: { onlyFiles?: boolean; nullItem?: boolean; text?: boolean } = {}) {
    let prevented = false;
    const items = options.onlyFiles ? [] : files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => options.nullItem ? null : file }));
    if (options.text) items.push({ kind: 'string', type: 'text/plain', getAsFile: () => null });
    input.listeners.get('paste')?.({ clipboardData: { items, files }, preventDefault() { prevented = true; } });
    return prevented;
  }
  return { ...api, input, elements, requests, readers, paste };
}
const image = (name = 'clipboard.png'): ImageFile => ({ name, type: 'image/png', size: 3 });

async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test('composer paste uploads an image once, preserving draft text and binding its Steam account', async () => {
  const h = harness();
  h.input.value = 'draft text';
  assert.equal(h.paste([image()], { text: true }), true);
  assert.equal(h.readers.length, 1);
  h.readers[0].finish();
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/image');
  assert.deepEqual(h.requests[0].body, { id: '76561198000000002', img: 'data:image/png;base64,YWJj', steamAccountId: '76561198000000001' });
  assert.equal(h.input.value, 'draft text');
  assert.equal(h.pending(), 0);
  assert.equal(h.elements.filter(element => element.listeners.has('paste')).length, 1);
});

test('text and video pastes retain the default browser behavior and do not upload', () => {
  const h = harness();
  assert.equal(h.paste([], { text: true }), false);
  assert.equal(h.paste([{ name: 'clip.mp4', type: 'video/mp4', size: 100 }]), false);
  assert.equal(h.readers.length, 0);
  assert.equal(h.requests.length, 0);
});

test('multiple images, files-only clipboard and null item fallbacks do not duplicate uploads', async () => {
  for (const options of [{}, { onlyFiles: true }, { nullItem: true }]) {
    const h = harness();
    assert.equal(h.paste([image('one.png'), image('two.png')], options), true);
    assert.equal(h.readers.length, 2);
    h.readers.forEach(reader => reader.finish());
    await settle();
    assert.equal(h.requests.length, 2);
  }
});

test('offline, unauthorized, logged-out and unselected conversations cannot paste images', () => {
  const changes = [
    (h: ReturnType<typeof harness>) => { h.state.steam.status = 'logged_out'; },
    (h: ReturnType<typeof harness>) => { h.state.steam.accessAllowed = false; },
    (h: ReturnType<typeof harness>) => { h.state.activeId = ''; },
    (h: ReturnType<typeof harness>) => { h.state.me = null; },
    (h: ReturnType<typeof harness>) => { h.state.view = 'users'; }
  ];
  for (const change of changes) {
    const h = harness(); change(h);
    assert.equal(h.paste([image()]), false);
    assert.equal(h.readers.length, 0);
  }
});

test('conversation reset aborts pending readers and late callbacks cannot send to a new target', async () => {
  const h = harness();
  h.paste([image()]);
  h.state.activeId = '76561198000000003';
  h.resetHistory();
  assert.equal(h.readers[0].aborted, true);
  assert.equal(h.pending(), 0);
  h.state.activeId = '76561198000000002';
  h.readers[0].finish();
  await settle();
  assert.equal(h.requests.length, 0);
});

test('account or availability changes while reading never send the queued image', async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.state.steam.steamId = '76561198000000004'; },
    (h: ReturnType<typeof harness>) => { h.state.steam.accessAllowed = false; }
  ]) {
    const h = harness(); h.paste([image()]); change(h); h.readers[0].finish(); await settle();
    assert.equal(h.requests.length, 0);
  }
});

test('oversized, empty and unreadable images are rejected with feedback and no upload', async () => {
  const h = harness();
  h.paste([{ ...image(), size: 8 * 1024 * 1024 }]);
  assert.match(h.state.feedback, /7 MiB/);
  h.paste([{ ...image(), size: 0 }]);
  assert.match(h.state.feedback, /空图片/);
  assert.equal(h.readers.length, 0);
  h.paste([image()]); h.readers[0].onerror?.(); await settle();
  assert.match(h.state.feedback, /读取图片失败/);
  assert.equal(h.pending(), 0);
  assert.equal(h.requests.length, 0);
});
