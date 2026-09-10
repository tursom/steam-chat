import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalMessage, normalizeStoredMessage, type StoredMessage } from './history-message';

// An additive, versioned sidecar: the primary JSONL/RocksDB formats stay unchanged.
// Only exact outgoing Steam image identities are indexed, never URL/time candidates.
export class SteamImageAliases {
  constructor(private root: string) {}

  private filename(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid Steam image alias');
    return path.join(this.root, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<StoredMessage | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(this.filename(key), 'utf8'));
      if (value.version !== 1) throw new Error('Unsupported Steam image alias version');
      const item = normalizeStoredMessage(value.item);
      if (!item.echo || canonicalMessage(item) !== canonicalMessage(value.item)) throw new Error('Invalid Steam image alias record');
      return item;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async syncDirectories(filename: string) {
    // Also run on retries: a prior rename may have succeeded before a failed fsync.
    for (const parent of [path.dirname(filename), this.root, path.dirname(this.root)]) {
      const handle = await fs.open(parent, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }

  async put(key: string, item: StoredMessage) {
    const existing = await this.get(key);
    if (existing) {
      if (canonicalMessage(existing) !== canonicalMessage(item)) throw new Error('Steam image alias conflict');
      await this.syncDirectories(this.filename(key));
      return;
    }
    const filename = this.filename(key);
    const directory = path.dirname(filename);
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const file = await fs.open(temporary, 'wx');
      try {
        await file.writeFile(JSON.stringify({ version: 1, item: JSON.parse(canonicalMessage(item)) }));
        await file.sync();
      } finally { await file.close(); }
      await fs.rename(temporary, filename);
      // Persist both the entry and newly created sidecar/shard directories.
      await this.syncDirectories(filename);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
}
