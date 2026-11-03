import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

function localDay(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

/** Owned by one serial writer. Archives are immutable, uncompressed JSONL files. */
export class DailyJsonlWriter {
  private file?: fs.FileHandle;
  private day?: string;
  private readonly filename: string;
  private readonly directory: string;
  private readonly stem: string;
  private readonly extension: string;
  private readonly archivePattern: RegExp;

  constructor(filename: string, private readonly now: () => Date = () => new Date()) {
    this.filename = path.resolve(filename);
    const parsed = path.parse(this.filename);
    this.directory = parsed.dir;
    this.stem = parsed.name;
    this.extension = parsed.ext;
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.archivePattern = new RegExp(`^${escape(this.stem)}-\\d{8}(?:-[a-f0-9]{16})?${escape(this.extension)}$`);
  }

  private async syncDirectory() {
    const directory = await fs.open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async hasPublishedArchive(stat: Awaited<ReturnType<fs.FileHandle['stat']>>): Promise<boolean> {
    if (stat.nlink < 2) return false;
    for (const name of await fs.readdir(this.directory)) {
      if (!this.archivePattern.test(name)) continue;
      try {
        const archived = await fs.stat(path.join(this.directory, name));
        if (archived.dev === stat.dev && archived.ino === stat.ino) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return false;
  }

  private async writingDay(stat: Awaited<ReturnType<fs.FileHandle['stat']>>): Promise<string> {
    const statePath = `${this.filename}.rotation.json`;
    let state: { version: number; dev: string; ino: string; day: string } | undefined;
    try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (state?.version === 1 && state.dev === String(stat.dev) && state.ino === String(stat.ino)) {
      if (!/^\d{8}$/.test(state.day)) throw new Error('Invalid JSONL rotation writing day');
      return state.day;
    }
    const day = stat.size ? localDay(stat.mtime) : localDay(this.now());
    const temporary = `${statePath}.${randomBytes(8).toString('hex')}.tmp`;
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify({ version: 1, dev: String(stat.dev), ino: String(stat.ino), day }));
        await file.sync();
      } finally { await file.close(); }
      await fs.rename(temporary, statePath);
      await this.syncDirectory();
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return day;
  }

  private async open() {
    if (this.file) return;
    await fs.mkdir(this.directory, { recursive: true });
    const file = await fs.open(this.filename, 'a+');
    try {
      const stat = await file.stat();
      // A crash after archive publication but before unlink leaves both names.
      // Finish that rotation before repairing or appending to the sealed inode.
      if (await this.hasPublishedArchive(stat)) {
        await file.close();
        await this.syncDirectory();
        await fs.unlink(this.filename);
        await this.syncDirectory();
        await this.open();
        return;
      }
      // Persist the writing day before tail repair can change mtime. The inode
      // binding makes a stale state harmless when rotation creates a new file.
      this.day = await this.writingDay(stat);
      await this.repairTail(file, stat.size);
      await this.syncDirectory();
      this.file = file;
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    }
  }

  private async repairTail(file: fs.FileHandle, size: number) {
    if (!size) return;
    const tail = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
    await file.read(tail, 0, tail.length, size - tail.length);
    if (tail[tail.length - 1] === 10) return;
    const newline = tail.lastIndexOf(10);
    if (newline < 0 && size > tail.length) throw new Error('JSONL tail exceeds repair limit; offline repair required');
    const partial = tail.subarray(newline + 1);
    const quarantine = await fs.open(`${this.filename}.${randomBytes(8).toString('hex')}.partial`, 'wx');
    try { await quarantine.writeFile(partial); await quarantine.sync(); } finally { await quarantine.close(); }
    await this.syncDirectory();
    await file.truncate(size - partial.length);
    await file.sync();
  }

  private async rotateIfNeeded() {
    const today = localDay(this.now());
    if (this.day === today) return;
    if ((await this.file!.stat()).size) {
      await this.close();
      // link is exclusive: unlike rename, it cannot overwrite an existing archive.
      let archive = path.join(this.directory, `${this.stem}-${this.day}${this.extension}`);
      for (;;) {
        try { await fs.link(this.filename, archive); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          archive = path.join(this.directory, `${this.stem}-${this.day}-${randomBytes(8).toString('hex')}${this.extension}`);
        }
      }
      await this.syncDirectory();
      await fs.unlink(this.filename);
      await this.syncDirectory();
      await this.open();
    } else {
      // A previously empty file may have survived several idle days. Replace its
      // day state before the first append, without generating an empty archive.
      await this.close();
      await fs.unlink(`${this.filename}.rotation.json`);
      await this.open();
    }
    this.day = today;
  }

  async ready() {
    try { await this.open(); await this.rotateIfNeeded(); }
    catch (error) { await this.close().catch(() => {}); throw error; }
  }

  async append(record: string) {
    try {
      await this.ready();
      await this.file!.writeFile(`${record}\n`, 'utf8');
      await this.file!.sync();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  async close() {
    const file = this.file;
    this.file = undefined;
    if (file) {
      try { await file.sync(); } finally { await file.close(); }
    }
  }
}
