import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

type ImageFile = { name: string; type: string; size: number };
class Element {
  id = '';
  className = '';
  src = '';
  textContent = '';
  style = { height: '' };
  scrollHeight = 20;
  value = '';
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  listeners = new Map<string, (event: any) => void>();
  constructor(public tagName: string) {}
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; }
  removeAttribute() {}
  setAttribute() {}
  addEventListener(name: string, handler: (event: any) => void) { this.listeners.set(name, handler); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector = '*'): Element[] {
    return this.children.flatMap(child => [
      ...(selector.split(',').some(part => {
        const s = part.trim();
        return s === '*' || (s.startsWith('#') ? child.id === s.slice(1) : s.startsWith('.') ? child.className.split(' ').includes(s.slice(1)) : child.tagName === s);
      }) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
}

const batchEpoch = 'e'.repeat(32);
type BatchOperation = { id: string; peerId: string; steamAccountId: string; batchId: string; batchIndex: number;
  batchSize: number; state: string; version: number; waitingForOperationId?: string };
type BatchReply = { batchId: string; operations: BatchOperation[] };
function harness(options: { batch?: boolean; holdBatch?: boolean; holdStart?: boolean; cancelError?: boolean; batchError?: string; mutateBatch?: (reply: BatchReply) => void } = {}) {
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
    finish(data = 'YWJj') { this.result = `data:${this.file?.type};base64,${data}`; this.onload?.(); }
  }
  const root = new Element('main');
  const elements: Element[] = [root];
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  const operations = new Map<string, BatchOperation>();
  let releaseBatch = () => {};
  let releaseStart = () => {};
  const metadata = new Map<string, string>();
  class FetchXHR {
    upload = { onprogress: null as ((event: unknown) => void) | null, onload: null as (() => void) | null };
    onload?: () => void;
    onerror?: () => void;
    status = 0;
    responseText = '';
    method = '';
    path = '';
    headers: Record<string, string> = {};
    open(method: string, path: string) { this.method = method; this.path = path; }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    getResponseHeader(_name: string): string | null { return null; }
    send(body: string) {
      void sandbox.fetch(this.path, { body }).then(async response => {
        this.upload.onload?.();
        this.status = 'status' in response ? Number(response.status) : 200;
        this.responseText = JSON.stringify(await response.json());
        this.onload?.();
      }, () => this.onerror?.());
    }
  }
  const created: Array<{ file: ImageFile; url: string }> = [];
  const revoked: string[] = [];
  const textRequests: Array<{ body: Record<string, string>; resolve: () => void; reject: (error: Error) => void }> = [];
  class SandboxURL extends URL {
    static createObjectURL(file: any) { const url = `blob:draft-${created.length + 1}`; created.push({ file, url }); return url; }
    static revokeObjectURL(url: string) { revoked.push(url); }
  }
  const sandbox = {
    document: {
      querySelector: (selector: string) => selector === '#app' ? root : root.querySelector(selector),
      querySelectorAll: (): Element[] => [], addEventListener() {}, removeEventListener() {},
      createElement: (tag: string) => { const element = new Element(tag); elements.push(element); return element; }
    },
    localStorage: { getItem: (): null => null, setItem() {} },
    sessionStorage: { getItem: (key: string) => metadata.get(key) ?? null, setItem(key: string, value: string) { metadata.set(key, value); } },
    FileReader: Reader, XMLHttpRequest: FetchXHR, URL: SandboxURL, URLSearchParams, Headers, AbortController, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (url: string, init: { body?: string }) => {
      if (url === '/message') await new Promise<void>((resolve, reject) => textRequests.push({ body: JSON.parse(init?.body || '{}'), resolve, reject }));
      requests.push({ url, body: JSON.parse(init?.body || '{}') });
      if (url === '/api/send-operations/batch') {
        const body = JSON.parse(init.body!);
        if (options.holdBatch) await new Promise<void>(resolve => { releaseBatch = resolve; });
        if (options.batchError) return { ok: false, status: 503, json: async () => ({ error: options.batchError }) };
        const batchId = 'b'.repeat(32);
        const reply: BatchReply = { batchId, operations: body.names.map((_: string, index: number) => ({
          id: (index + 1).toString(16).padStart(32, '0'), peerId: body.id, steamAccountId: body.steamAccountId,
          batchId, batchIndex: index, batchSize: body.names.length, state: 'prepared', version: 1
        })) };
        options.mutateBatch?.(reply);
        for (const op of reply.operations) operations.set(op.id, op);
        return { ok: true, json: async () => JSON.parse(JSON.stringify(reply)) as BatchReply };
      }
      const match = /^\/api\/send-operations\/([a-f0-9]{32})(?:\/(start|cancel))?$/.exec(url);
      if (match) {
        const op = operations.get(match[1])!;
        if (match[2] === 'cancel' && options.cancelError) return { ok: false, status: 503, json: async () => ({ error: 'cancel unavailable' }) };
        if (match[2] === 'start' && options.holdStart) await new Promise<void>(resolve => { releaseStart = resolve; });
        if (match[2] === 'start' && op.state === 'cancelled') return { ok: false, status: 409, json: async () => ({ error: 'task cancelled' }) };
        if (match[2]) {
          op.state = match[2] === 'start' ? 'queued' : 'cancelled'; op.version++;
          if (op.batchIndex) op.waitingForOperationId = [...operations.keys()][0];
        }
        return { ok: true, json: async () => ({ ...op }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    __test: undefined as unknown
  };
  const source = readFileSync(resolve(__dirname, '../web/app.js'), 'utf8');
  runInNewContext(`${source.slice(0, source.indexOf('\nbootstrap().catch'))}
    state.me = {id:1}; state.permissions = ['chat.use', 'self.password.change']; state.view = 'chat'; state.activeId = '76561198000000002';
    state.steam = {...state.steam, status:'online', accessAllowed:true, steamId:'76561198000000001', steamGrant: {level:'full', scope:'all', peerCount:0, expiresAt:null}};
    state.sendOperations = ${Boolean(options.batch)}; state.imageBatchEpoch = ${JSON.stringify(options.batch ? batchEpoch : '')};
    root.append(renderComposer());
    loadHistory = async () => {};
    globalThis.__test = {state, resetHistory, invalidateChat, sendFiles, imageOperationLabel, saveImageOperationMetadata,
      cancel: (index) => imageOperationAction(Array.from(outgoingMessages.values())[index], 'cancel'),
      outgoing: () => Array.from(outgoingMessages.values()),
      drafts: () => Array.from(imageDrafts.values()), currentDrafts: getImageDrafts, pending: () => pendingImageReaders.size};`, sandbox);
  const api = sandbox.__test as {
    state: { me: unknown; view: string; activeId: string; feedback: string; sendOperations: boolean; imageBatchEpoch: string;
      steam: { status: string; accessAllowed: boolean; steamId: string } };
    imageOperationLabel: (op: BatchOperation) => string;
    cancel: (index: number) => Promise<void>;
    saveImageOperationMetadata: () => void;
    outgoing: () => Array<{ operation?: BatchOperation; imageReading?: boolean; error?: string; state: string;
      transfer: { name: string; stage: string }; imagePayload?: { img: string } }>;
    invalidateChat: () => void;
    drafts: () => Array<{ id: number; peerId: string; context: string; file: ImageFile; url: string }>;
    currentDrafts: () => Array<{ id: number; file: ImageFile }>;
    resetHistory: () => void; sendFiles: (files: ImageFile[]) => boolean | Promise<boolean>; pending: () => number;
  };
  const input = elements.find(element => element.id === 'messageInput')!;
  function paste(files: ImageFile[], options: { onlyFiles?: boolean; nullItem?: boolean; text?: boolean } = {}) {
    let prevented = false;
    const items = options.onlyFiles ? [] : files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => options.nullItem ? null : file }));
    if (options.text) items.push({ kind: 'string', type: 'text/plain', getAsFile: () => null });
    input.listeners.get('paste')?.({ clipboardData: { items, files }, preventDefault() { prevented = true; } });
    return prevented;
  }
  const send = () => root.querySelector('#sendButton')!.listeners.get('click')!({});
  const enter = (shiftKey = false) => {
    let prevented = false;
    input.listeners.get('keydown')!({ key: 'Enter', shiftKey, preventDefault() { prevented = true; } });
    return prevented;
  };
  return { ...api, root, input, elements, requests, readers, paste, send, enter, created, revoked, textRequests,
    releaseBatch: () => releaseBatch(), releaseStart: () => releaseStart(), metadata,
    starts: () => requests.filter(request => request.url.endsWith('/start')) };
}
const image = (name = 'clipboard.png'): ImageFile => ({ name, type: 'image/png', size: 3 });

async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

for (const action of ['send', 'enter'] as const) {
  test(`${action} sends images-only drafts once with the captured account`, async () => {
    const h = harness();
    h.paste([image()]);
    h[action]();
    h[action]();
    assert.equal(h.readers.length, 1);
    assert.equal(h.drafts().length, 0);
    assert.deepEqual(h.revoked, [h.created[0].url]);
    h.readers[0].finish();
    await settle();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/image');
    assert.deepEqual(h.requests[0].body, { id: '76561198000000002', img: 'data:image/png;base64,YWJj', steamAccountId: '76561198000000001' });
  });

  test(`${action} sends text before images and guards duplicate submissions`, async () => {
    const h = harness();
    h.input.value = 'caption';
    h.paste([image('first.png')]);
    h[action]();
    h.send(); h.enter();
    assert.equal(h.textRequests.length, 1);
    assert.equal(h.textRequests[0].body.msg, 'caption');
    assert.equal(h.readers.length, 0);
    assert.equal(h.drafts().length, 1);
    h.paste([image('later.png')]);
    h.textRequests[0].resolve();
    await settle();
    assert.equal(h.input.value, '');
    assert.equal(h.readers.length, 1);
    assert.equal(h.readers[0].file?.name, 'first.png');
    assert.deepEqual(Array.from(h.drafts(), draft => draft.file.name), ['later.png']);
    assert.deepEqual(h.revoked, [h.created[0].url]);
  });
}

test('Shift+Enter leaves image drafts untouched', () => {
  const h = harness(); h.paste([image()]);
  assert.equal(h.enter(true), false);
  assert.equal(h.drafts().length, 1);
  assert.equal(h.readers.length, 0);
});

test('individual remove buttons revoke only the selected draft and send the remaining images', async () => {
  const h = harness({ batch: true }); h.paste([image('one.png'), image('two.png'), image('three.png')]);
  h.root.querySelectorAll('.image-draft-remove')[1].listeners.get('click')!({});
  assert.deepEqual(Array.from(h.drafts(), draft => draft.file.name), ['one.png', 'three.png']);
  assert.equal(h.root.querySelectorAll('.image-draft').length, 2);
  assert.deepEqual(h.revoked, [h.created[1].url]);
  h.send();
  await settle();
  assert.deepEqual(h.readers.map(reader => reader.file?.name), ['one.png', 'three.png']);
  assert.equal(new Set(h.revoked).size, 3);
});

test('uncertain text keeps images but is not automatically retried on the next send', async () => {
  const h = harness({ batch: true }); h.input.value = 'keep caption'; h.paste([image()]); h.send();
  h.paste([image('new.png')]);
  h.textRequests[0].reject(new Error('text rejected'));
  await settle();
  assert.equal(h.input.value, '');
  assert.equal(h.drafts().length, 2);
  assert.equal(h.revoked.length, 0);
  assert.equal(h.readers.length, 0);
  h.send();
  assert.equal(h.textRequests.length, 1);
  await settle();
  assert.equal(h.readers.length, 2);
});

test('removing a captured draft while text is pending prevents its dispatch', async () => {
  const h = harness(); h.input.value = 'caption'; h.paste([image()]); h.send();
  h.root.querySelector('.image-draft-remove')!.listeners.get('click')!({});
  h.textRequests[0].resolve(); await settle();
  assert.equal(h.readers.length, 0);
  assert.equal(h.revoked.length, 1);
});

test('peer switching preserves separate drafts and never dispatches a pending caption to another peer', async () => {
  const h = harness();
  h.input.value = 'A caption'; h.paste([image('A.png')]); h.send();
  h.state.activeId = 'peer-B'; h.resetHistory(); h.input.value = '';
  assert.equal(h.currentDrafts().length, 0);
  assert.equal(h.root.querySelectorAll('.image-draft').length, 0);
  h.paste([image('B.png')]);
  h.send();
  assert.equal(h.readers.length, 1);
  assert.equal(h.readers[0].file?.name, 'B.png');
  h.readers[0].finish(); await settle();
  assert.equal(h.requests[0].body.id, 'peer-B');
  h.textRequests[0].resolve(); await settle();
  assert.equal(h.readers.length, 1);
  h.state.activeId = '76561198000000002'; h.resetHistory();
  assert.equal(h.currentDrafts()[0].file.name, 'A.png');
  assert.equal(h.root.querySelectorAll('.image-draft').length, 1);
  h.send();
  assert.equal(h.readers[1].file?.name, 'A.png');
});

test('account invalidation revokes drafts from every conversation and cancels pending composer dispatch', async () => {
  const h = harness(); h.paste([image('A.png')]);
  h.state.activeId = 'peer-B'; h.resetHistory(); h.paste([image('B.png')]);
  h.input.value = 'caption'; h.send();
  h.state.steam.steamId = 'new-account';
  assert.equal(h.currentDrafts().length, 0);
  h.invalidateChat();
  assert.equal(h.drafts().length, 0);
  assert.equal(h.root.querySelectorAll('.image-draft').length, 0);
  assert.deepEqual(new Set(h.revoked), new Set(h.created.map(entry => entry.url)));
  h.textRequests[0].resolve(); await settle();
  assert.equal(h.readers.length, 0);
  assert.equal(h.revoked.length, 2);
});

test('draft count is limited to ten per conversation without reading rejected files', () => {
  const h = harness();
  h.paste(Array.from({ length: 10 }, (_, i) => image(`${i}.png`)));
  assert.equal(h.drafts().length, 10);
  h.paste([image('overflow.png')]);
  assert.equal(h.drafts().length, 10);
  assert.equal(h.created.length, 10);
  assert.match(h.state.feedback, /10/);
  h.state.activeId = 'peer-B'; h.resetHistory(); h.paste([image('B.png')]);
  assert.equal(h.currentDrafts().length, 1);
  assert.equal(h.drafts().length, 11);
  assert.equal(h.readers.length, 0);
});

test('draft bytes accept exactly 32 MiB, reject overflow, and recover capacity after removal', () => {
  const h = harness();
  h.paste([7, 7, 7, 7, 4].map((mib, i) => ({ ...image(`${i}.png`), size: mib * 1024 * 1024 })));
  assert.equal(h.drafts().length, 5);
  h.paste([image('overflow.png')]);
  assert.equal(h.drafts().length, 5);
  assert.equal(h.created.length, 5);
  assert.match(h.state.feedback, /32 MiB/);
  h.root.querySelector('.image-draft-remove')!.listeners.get('click')!({});
  h.paste([{ ...image('replacement.png'), size: 7 * 1024 * 1024 }]);
  assert.equal(h.drafts().length, 5);
  assert.equal(h.readers.length, 0);
});

test('successful caption send preserves text edited during the pending request', async () => {
  const h = harness(); h.input.value = 'original'; h.paste([image()]); h.send();
  h.input.value = 'next message'; h.paste([image('next.png')]);
  h.textRequests[0].resolve(); await settle();
  assert.equal(h.input.value, 'next message');
  assert.equal(h.readers.length, 1);
  assert.deepEqual(Array.from(h.drafts(), draft => draft.file.name), ['next.png']);
});

test('the total byte budget includes drafts belonging to other peers', () => {
  const h = harness();
  h.paste([7, 7, 7, 7].map((mib, i) => ({ ...image(`${i}.png`), size: mib * 1024 * 1024 })));
  h.state.activeId = 'peer-B'; h.resetHistory();
  h.paste([{ ...image('fits.png'), size: 4 * 1024 * 1024 }]);
  h.paste([image('overflow.png')]);
  assert.equal(h.currentDrafts().length, 1);
  assert.equal(h.drafts().length, 5);
  assert.equal(h.created.length, 5);
  assert.match(h.state.feedback, /32 MiB/);
});

test('file chooser still starts reading immediately without creating drafts', () => {
  const h = harness();
  const chooser = h.root.querySelectorAll('input').find(node => node.listeners.has('change'))!;
  (chooser as Element & { files: ImageFile[] }).files = [image()];
  chooser.listeners.get('change')!({});
  assert.equal(h.readers.length, 1);
  assert.equal(h.drafts().length, 0);
  assert.equal(h.created.length, 0);
});

test('composer paste queues a thumbnail without reading or uploading and preserves text', () => {
  const h = harness();
  h.input.value = 'draft text';
  assert.equal(h.paste([image()], { text: true }), true);
  assert.equal(h.readers.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.created.length, 1);
  assert.equal(h.drafts()[0].peerId, '76561198000000002');
  const tray = h.root.querySelector('.composer-box')!.querySelector('#imageDrafts')!;
  const row = tray.querySelector('.image-draft')!;
  assert.equal(row.dataset.draftId, String(h.drafts()[0].id));
  assert.equal(row.querySelector('img')!.src, h.created[0].url);
  assert.ok(row.querySelector('.image-draft-remove'));
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
    const h = harness({ batch: true });
    assert.equal(h.paste([image('one.png'), image('two.png')], options), true);
    assert.equal(h.readers.length, 0);
    assert.equal(h.drafts().length, 2);
    h.send();
    await settle();
    assert.equal(h.readers.length, 2);
    h.readers.forEach(reader => reader.finish());
    await settle();
    assert.equal(h.requests.filter(request => request.url === '/api/send-operations/batch').length, 1);
    assert.equal(h.starts().length, 2);
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
  h.sendFiles([image()]);
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
    const h = harness(); h.sendFiles([image()]); change(h); h.readers[0].finish(); await settle();
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
  h.paste([image()]); h.send(); h.readers[0].onerror?.(); await settle();
  assert.match(h.state.feedback, /读取图片失败/);
  assert.equal(h.pending(), 0);
  assert.equal(h.requests.length, 0);
});

test('batch reserves input order before reading and reverse reads activate only their fixed IDs', async () => {
  const h = harness({ batch: true, holdBatch: true });
  h.paste([image('first.png'), image('second.png'), image('third.png')]); h.send(); h.send();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0], { url: '/api/send-operations/batch', body: {
    kind: 'image', id: '76561198000000002', names: ['first.png', 'second.png', 'third.png'],
    steamAccountId: '76561198000000001', instanceId: batchEpoch
  } });
  assert.equal(h.readers.length, 0);
  assert.equal(h.drafts().length, 3);
  h.paste([image('later.png')]);
  h.releaseBatch(); await settle();
  assert.deepEqual(Array.from(h.drafts(), draft => draft.file.name), ['later.png']);
  const entries = h.outgoing();
  assert.deepEqual(Array.from(entries, entry => entry.transfer.name), ['first.png', 'second.png', 'third.png']);
  assert.ok(entries.every(entry => entry.imageReading && !entry.error && entry.transfer.stage === 'reading'));
  assert.equal(h.starts().length, 0, 'registration never activates unread images');
  for (const index of [2, 1, 0]) { h.readers[index].finish(`file-${index}`); await settle(); }
  assert.deepEqual(h.starts().map(request => request.url), [2, 1, 0].map(index => `/api/send-operations/${entries[index].operation!.id}/start`));
  assert.deepEqual(h.starts().map(request => request.body.img), [2, 1, 0].map(index => `data:image/png;base64,file-${index}`));
  assert.equal(h.requests.some(request => ['/image', '/api/send-operations', '/api/send-operations/upload'].includes(request.url)), false);
  assert.match(h.imageOperationLabel(entries[1].operation!), /等待前一张/);
});

test('batch creation failure retains captured and later drafts without reading or activation', async () => {
  const h = harness({ batch: true, holdBatch: true, batchError: 'batch unavailable' });
  h.paste([image('first.png'), image('second.png')]); h.send();
  h.paste([image('later.png')]); h.releaseBatch(); await settle();
  assert.equal(h.drafts().length, 3); assert.equal(h.revoked.length, 0);
  assert.equal(h.readers.length, 0); assert.equal(h.starts().length, 0);
  assert.match(h.state.feedback, /batch unavailable/);
});

test('missing or invalid batch capability retains drafts and never falls back to unordered sends', async () => {
  for (const [enabled, epoch] of [[false, batchEpoch], [true, ''], [true, 'bad-epoch']] as const) {
    const h = harness({ batch: true }); h.state.sendOperations = enabled; h.state.imageBatchEpoch = epoch;
    h.paste([image('first.png'), image('second.png')]); h.send(); await settle();
    assert.equal(h.drafts().length, 2); assert.equal(h.requests.length, 0); assert.equal(h.readers.length, 0);
    assert.match(h.state.feedback, /按序发送/);
  }
});

for (const change of ['peer', 'account', 'permission'] as const) {
  test(`${change} change during registration prevents all batch activation`, async () => {
    const h = harness({ batch: true, holdBatch: true });
    h.paste([image('first.png'), image('second.png')]); h.send();
    if (change === 'peer') { h.state.activeId = '76561198000000003'; h.resetHistory(); }
    if (change === 'account') { h.state.steam.steamId = '76561198000000004'; h.invalidateChat(); }
    if (change === 'permission') h.state.steam.accessAllowed = false;
    h.releaseBatch(); await settle();
    assert.equal(h.readers.length, 0); assert.equal(h.starts().length, 0);
    assert.equal(h.requests.filter(request => request.url === '/api/send-operations/batch').length, 1);
    assert.equal(h.requests.filter(request => request.url.endsWith('/cancel')).length, 2);
    const stored = JSON.parse(h.metadata.get('steam-chat.send-operations.1.76561198000000001') || '[]');
    assert.equal(stored.length, 2, 'late identities remain recoverable under their original account');
    if (change !== 'account') assert.equal(h.drafts().length, 2);
  });
}

test('malformed batch order is rejected atomically before any reader or activation', async () => {
  for (const mutateBatch of [
    (reply: BatchReply) => { reply.operations.reverse(); },
    (reply: BatchReply) => { reply.operations[1].id = reply.operations[0].id; },
    (reply: BatchReply) => { reply.operations.pop(); },
    (reply: BatchReply) => { reply.operations[1].steamAccountId = 'wrong-account'; }
  ]) {
    const h = harness({ batch: true, mutateBatch });
    h.paste([image('first.png'), image('second.png')]); h.send(); await settle();
    assert.equal(h.drafts().length, 2); assert.equal(h.revoked.length, 0);
    assert.equal(h.readers.length, 0); assert.equal(h.starts().length, 0);
    assert.ok(h.outgoing().every(entry => !entry.operation));
    assert.match(h.state.feedback, /批次未开始/);
  }
});

test('head read error keeps its prepared operation and does not cancel or bypass it', async () => {
  const h = harness({ batch: true });
  await h.sendFiles([image('head.png'), image('tail.png')]);
  h.readers[0].onerror?.(); h.readers[1].finish(); await settle();
  const [head, tail] = h.outgoing();
  assert.equal(head.state, 'failed'); assert.equal(head.operation!.state, 'prepared');
  assert.equal(head.imageReading, false); assert.match(head.error!, /读取图片失败/);
  assert.equal(h.starts().length, 1);
  assert.equal(h.starts()[0].url, `/api/send-operations/${tail.operation!.id}/start`);
  assert.equal(tail.operation!.waitingForOperationId, head.operation!.id);
  assert.match(h.imageOperationLabel(tail.operation!), /等待前一张/);
  assert.equal(h.requests.some(request => request.url.endsWith('/cancel')), false);
});

test('switching peer before a ten-image reservation replies cancels every received slot', async () => {
  const h = harness({ batch: true, holdBatch: true });
  const pending = h.sendFiles(Array.from({ length: 10 }, (_, index) => image(`${index}.png`)));
  h.state.activeId = '76561198000000003'; h.resetHistory();
  h.releaseBatch();
  assert.equal(await pending, false); await settle();
  assert.equal(h.readers.length, 0); assert.equal(h.starts().length, 0);
  assert.equal(h.requests.filter(request => request.url.endsWith('/cancel')).length, 10);
  assert.ok(h.outgoing().every(entry => entry.operation?.state === 'cancelled'));
});

test('explicit cancellation reaches the server while a member start upload is still pending', async () => {
  const h = harness({ batch: true, holdStart: true });
  await h.sendFiles([image('head.png'), image('tail.png')]);
  h.readers[0].finish(); await settle();
  assert.equal(h.starts().length, 1);
  await h.cancel(0); await settle();
  assert.equal(h.requests.filter(request => request.url.endsWith('/cancel')).length, 1);
  assert.equal(h.outgoing()[0].operation!.state, 'cancelled');
  h.releaseStart(); await settle();
  assert.equal(h.outgoing()[0].operation!.state, 'cancelled', 'late start response cannot revive the cancelled slot');
  assert.equal(h.outgoing()[0].state, 'failed');
});

test('late reservation after account context restoration survives failed cancels and another metadata save', async () => {
  const h = harness({ batch: true, holdBatch: true, cancelError: true });
  const pending = h.sendFiles(Array.from({ length: 10 }, (_, index) => image(`${index}.png`)));
  h.state.steam.steamId = '76561198000000004'; h.invalidateChat();
  h.state.steam.steamId = '76561198000000001'; h.invalidateChat();
  h.releaseBatch(); assert.equal(await pending, false); await settle();
  h.saveImageOperationMetadata();
  const stored = JSON.parse(h.metadata.get('steam-chat.send-operations.1.76561198000000001') || '[]');
  assert.equal(stored.length, 10, 'normal saves cannot erase the received reservation identities');
  assert.equal(new Set(stored.map((item: { operationId: string }) => item.operationId)).size, 10);
  assert.equal(h.outgoing().length, 10, 'the restored account can query and cancel the late batch');
  assert.ok(h.outgoing().every(entry => entry.operation?.state === 'prepared'));
  assert.equal(h.starts().length, 0); assert.equal(h.readers.length, 0);
});
