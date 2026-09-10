import { strict as assert } from 'node:assert';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ImageEmoteStore } from '../src/storage/image-emotes';
const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('grouped emotes persist, deduplicate blobs, move and delete without losing in-flight image bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'image-emotes-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ImageEmoteStore(dir);
  let catalog = await store.mutate({ version: 0, action: 'createGroup', name: '猫猫' });
  const firstGroup = catalog.groups[0].id;
  catalog = await store.mutate({ version: catalog.version, action: 'createGroup', name: '日常' });
  const secondGroup = catalog.groups[1].id;
  catalog = await store.mutate({ version: catalog.version, action: 'addImage', groupId: firstGroup, name: '开心', data });
  const firstImage = catalog.images[0];
  await assert.rejects(store.mutate({ version: catalog.version, action: 'addImage', groupId: firstGroup, name: '重复', data }), /相同图片/);
  catalog = await store.mutate({ version: catalog.version, action: 'addImage', groupId: secondGroup, name: '另一分组', data });
  assert.equal((await readdir(join(dir, 'blobs'))).length, 1);
  await assert.rejects(store.mutate({ version: catalog.version, action: 'deleteGroup', id: firstGroup }), /先移动/);
  await assert.rejects(store.mutate({ version: catalog.version, action: 'updateImage', id: firstImage.id, groupId: secondGroup, name: '移动' }), /相同图片/);
  const snapshot = await store.read(firstImage.id);
  catalog = await store.mutate({ version: catalog.version, action: 'deleteImage', id: catalog.images[1].id });
  catalog = await store.mutate({ version: catalog.version, action: 'updateImage', id: firstImage.id, groupId: secondGroup, name: '新名称' });
  catalog = await store.mutate({ version: catalog.version, action: 'deleteGroup', id: firstGroup });
  assert.deepEqual(await new ImageEmoteStore(dir).list(), catalog);
  assert.equal(catalog.images[0].groupId, secondGroup);
  assert.equal(catalog.images[0].name, '新名称');
  catalog = await store.mutate({ version: catalog.version, action: 'deleteImage', id: firstImage.id });
  assert.equal((await readdir(join(dir, 'blobs'))).length, 0);
  assert.ok(snapshot.buffer.length > 0);
  await assert.rejects(store.read(firstImage.id), /不存在/);
  assert.equal(catalog.images.length, 0);
});

test('animated GIF data is stored and returned without re-encoding', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'image-emotes-gif-')); t.after(() => rm(dir, { recursive: true, force: true }));
  // Two 1x1 GIF frames, each with a delay. Preserve both frames and the loop extension.
  const header = Buffer.from('47494638396101000100800000000000ffffff', 'hex');
  const loop = Buffer.from('21ff0b4e45545343415045322e300301000000', 'hex');
  const frame = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
  const buffer = Buffer.concat([header, loop, frame, frame, Buffer.from([0x3b])]);
  const store = new ImageEmoteStore(dir);
  const group = (await store.mutate({ version: 0, action: 'createGroup', name: '动画' })).groups[0];
  const catalog = await store.mutate({ version: 1, action: 'addImage', groupId: group.id, name: '动画', data: `data:image/gif;base64,${buffer.toString('base64')}` });
  const result = await store.read(catalog.images[0].id);
  assert.equal(result.item.contentType, 'image/gif');
  assert.deepEqual(result.buffer, buffer);
});

test('concurrent edits reject stale versions, validate image content and isolate returned catalogs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'image-emotes-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ImageEmoteStore(dir);
  const edits = await Promise.allSettled([
    store.mutate({ version: 0, action: 'createGroup', name: 'A' }),
    store.mutate({ version: 0, action: 'createGroup', name: 'B' })
  ]);
  assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1);
  const catalog = await store.list(); const id = catalog.groups[0].id;
  catalog.groups[0].name = 'outside mutation';
  assert.equal((await store.list()).groups[0].name, 'A');
  for (const invalid of ['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,YWJj', data.replace('image/png', 'text/html')]) {
    await assert.rejects(store.mutate({ version: 1, action: 'addImage', groupId: id, name: 'bad', data: invalid }));
  }
  await assert.rejects(store.mutate({ version: 1, action: 'addImage', groupId: id, name: 'large', data: 'data:image/png;base64,' + Buffer.alloc(7 * 1024 * 1024 + 1).toString('base64') }), /7 MiB/);
  await assert.rejects(store.read('../../secret'));
  assert.equal((await store.list()).images.length, 0);
  const renamed = await store.mutate({ version: 1, action: 'renameGroup', id, name: 'Renamed' });
  assert.equal(renamed.groups[0].name, 'Renamed');
});
