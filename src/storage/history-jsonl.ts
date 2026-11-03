import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** A single serial writer; failed appends are checked before their next retry. */
export class AppendOnlyJsonlWriter {
  private file?: fs.FileHandle;
  constructor(private filename: string) {}

  private async syncDirectory() {
    const directory = await fs.open(path.dirname(this.filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async ready() {
    if (this.file) return;
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const file = await fs.open(this.filename, 'a+');
    try {
      const { size } = await file.stat();
      if (size) {
        const tail = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
        let read = 0;
        while (read < tail.length) {
          const { bytesRead } = await file.read(tail, read, tail.length - read, size - tail.length + read);
          if (!bytesRead) throw new Error('JSONL changed while recovering tail');
          read += bytesRead;
        }
        if (tail[tail.length - 1] !== 10) {
          const newline = tail.lastIndexOf(10);
          if (newline < 0 && size > tail.length) throw new Error('JSONL tail exceeds recovery limit');
          const partial = tail.subarray(newline + 1);
          const backup = await fs.open(`${this.filename}.${randomBytes(8).toString('hex')}.partial`, 'wx', 0o600);
          try { await backup.writeFile(partial); await backup.sync(); } finally { await backup.close(); }
          await this.syncDirectory();
          await file.truncate(size - partial.length);
          await file.sync();
        }
      }
      await this.syncDirectory();
      this.file = file;
    } catch (error) { await file.close().catch(() => {}); throw error; }
  }

  async append(record: string) {
    try {
      await this.ready();
      await this.file!.writeFile(`${record}\n`, 'utf8');
      await this.file!.sync();
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }

  async close() {
    const file = this.file;
    this.file = undefined;
    if (file) { try { await file.sync(); } finally { await file.close(); } }
  }
}
