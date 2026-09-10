import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { isRecord } from '../types';

export type ImageEmoteGroup = { id: string; name: string };
export type ImageEmote = { id: string; groupId: string; name: string; hash: string; contentType: string; bytes: number; width: number; height: number };
export type ImageEmoteCatalog = { version: number; groups: ImageEmoteGroup[]; images: ImageEmote[] };
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMAGE = 7 * 1024 * 1024;
const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) return fail('名称需要 1–80 个字符');
  return value.trim();
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) return fail('素材或分组 ID 无效');
  return value;
}

/** Single-process library. All reads/mutations serialize; sends get an immutable Buffer snapshot. */
export class ImageEmoteStore {
  private pending: Promise<unknown> = Promise.resolve();
  private catalog: ImageEmoteCatalog | undefined;
  constructor(private directory: string) {}
  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.pending.then(task);
    this.pending = result.catch(() => {});
    return result;
  }
  private async load(): Promise<ImageEmoteCatalog> {
    if (this.catalog) return this.catalog;
    try {
      const catalog = JSON.parse(await fs.readFile(join(this.directory, 'catalog.json'), 'utf8'));
      if (!Number.isSafeInteger(catalog.version) || !Array.isArray(catalog.groups) || !Array.isArray(catalog.images)) throw new Error('Invalid image emote catalog');
      this.catalog = catalog;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      this.catalog = { version: 0, groups: [], images: [] };
    }
    return this.catalog!;
  }
  list(): Promise<ImageEmoteCatalog> { return this.run(async () => structuredClone(await this.load())); }
  read(id: unknown): Promise<{ item: ImageEmote; buffer: Buffer }> {
    return this.run(async () => {
      const key = identifier(id);
      const item = (await this.load()).images.find(image => image.id === key);
      if (!item) return fail('图片表情不存在或已删除', 404);
      return { item: { ...item }, buffer: await fs.readFile(join(this.directory, 'blobs', item.hash)) };
    });
  }
  mutate(input: unknown): Promise<ImageEmoteCatalog> {
    return this.run(async () => {
      if (!isRecord(input)) return fail('无效请求');
      const current = await this.load();
      if (input.version !== current.version) return fail('素材库已更新，请刷新后再试', 409);
      const next = structuredClone(current);
      const group = (value: unknown) => {
        const result = next.groups.find(entry => entry.id === identifier(value));
        if (!result) return fail('分组不存在', 404);
        return result;
      };
      const image = (value: unknown) => {
        const result = next.images.find(entry => entry.id === identifier(value));
        if (!result) return fail('图片表情不存在', 404);
        return result;
      };
      switch (input.action) {
        case 'createGroup':
          if (next.groups.length >= 100) return fail('最多创建 100 个分组');
          next.groups.push({ id: randomUUID(), name: name(input.name) }); break;
        case 'renameGroup': group(input.id).name = name(input.name); break;
        case 'deleteGroup': {
          const id = group(input.id).id;
          if (next.images.some(entry => entry.groupId === id)) return fail('请先移动或删除分组内的图片', 409);
          next.groups = next.groups.filter(entry => entry.id !== id); break;
        }
        case 'addImage': {
          const groupId = group(input.groupId).id;
          const title = name(input.name);
          if (next.images.length >= 1000) return fail('最多保存 1000 张图片表情');
          if (typeof input.data !== 'string') return fail('缺少图片');
          const data = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.data);
          if (!data) return fail('仅支持 PNG、JPEG、GIF、WebP 图片');
          const buffer = Buffer.from(data[1], 'base64');
          if (!buffer.length || buffer.length > MAX_IMAGE) return fail('图片大小必须在 1 字节至 7 MiB 之间', 413);
          let size;
          try { size = imageSize(buffer); } catch { return fail('图片内容无法识别'); }
          const contentType = MIME[size.type || ''];
          if (!contentType || !size.width || !size.height || size.width * size.height > 40_000_000) return fail('图片格式或尺寸不支持（最多 4000 万像素）');
          const hash = createHash('sha256').update(buffer).digest('hex');
          if (next.images.some(entry => entry.groupId === groupId && entry.hash === hash)) return fail('此分组已包含相同图片', 409);
          const unique = new Map(next.images.map(entry => [entry.hash, entry.bytes]));
          unique.set(hash, buffer.length);
          if ([...unique.values()].reduce((a, b) => a + b, 0) > 512 * 1024 * 1024) return fail('素材库大小不能超过 512 MiB', 413);
          await fs.mkdir(join(this.directory, 'blobs'), { recursive: true });
          const blobPath = join(this.directory, 'blobs', hash);
          try { await fs.access(blobPath); }
          catch (error) {
            if (!isRecord(error) || error.code !== 'ENOENT') throw error;
            const temporaryBlob = `${blobPath}-${randomUUID()}.tmp`;
            try {
              const file = await fs.open(temporaryBlob, 'wx', 0o600);
              try { await file.writeFile(buffer); await file.sync(); } finally { await file.close(); }
              await fs.rename(temporaryBlob, blobPath);
            } finally { await fs.rm(temporaryBlob, { force: true }).catch(() => {}); }
          }
          next.images.push({ id: randomUUID(), groupId, name: title, hash, contentType, bytes: buffer.length, width: size.width, height: size.height }); break;
        }
        case 'updateImage': {
          const entry = image(input.id);
          const groupId = group(input.groupId).id;
          if (next.images.some(other => other.id !== entry.id && other.groupId === groupId && other.hash === entry.hash)) return fail('目标分组已包含相同图片', 409);
          entry.name = name(input.name); entry.groupId = groupId; break;
        }
        case 'deleteImage': { const id = image(input.id).id; next.images = next.images.filter(entry => entry.id !== id); break; }
        default: return fail('未知素材操作');
      }
      if (new Set(next.groups.map(entry => entry.name)).size !== next.groups.length) return fail('分组名称不能重复', 409);
      next.version++;
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = join(this.directory, `catalog-${randomUUID()}.tmp`);
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await fs.rename(temporary, join(this.directory, 'catalog.json'));
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      this.catalog = next;
      // No new read can reference a removed entry; in-flight sends already own their Buffer.
      const retained = new Set(next.images.map(entry => entry.hash));
      for (const hash of new Set(current.images.map(entry => entry.hash))) {
        if (!retained.has(hash)) await fs.rm(join(this.directory, 'blobs', hash), { force: true }).catch(() => {});
      }
      return structuredClone(next);
    });
  }
}
