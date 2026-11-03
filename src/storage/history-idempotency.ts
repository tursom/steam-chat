import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { jsonlLines } from './history-jsonl-lines';
import { createHash } from 'node:crypto';
import { canonicalMessage, normalizeStoredMessage, steamReplayIdentity, type StoredMessage } from './history-message';
import type { HistoryRecordInput } from '../types';

/**
 * A rebuildable index owned by ONE serial writer, never a shared admission gate.
 * A deterministic new ID cannot recognize old random IDs. Per-event alias files
 * would add an inode per text message and still leave the append/ACK crash gap.
 * SQLite supplies bounded-memory lookup and durable reservations without changing
 * the primary stores. FULL sync reservations precede primary writes; `present`
 * is only a cache of primary evidence, never proof from a write-ahead intent.
 *
 * Every worker start streams its own primary copy to recover old IDs (including
 * records predating this index). Failed/uncertain appends repeat that scan before
 * retrying. This deliberately favors a simple full scan over rotation-sensitive
 * byte checkpoints. Scans remain local; the parent resolves across healthy lanes
 * before admission, without sharing either primary or this index.
 */
export class HistoryIdempotency {
  private db: DatabaseSync;
  private uncertain = true;

  constructor(filename: string, private records: () => AsyncIterable<StoredMessage>,
    private write: (item: StoredMessage) => Promise<unknown>) {
    this.db = new DatabaseSync(filename);
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported history idempotency index version'); }
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, item TEXT NOT NULL, present INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS identities (identity TEXT PRIMARY KEY, event_id TEXT NOT NULL);
      PRAGMA user_version = 1;`);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private event(id: string): { item: string; present: number } | undefined {
    return this.db.prepare('SELECT item, present FROM events WHERE event_id = ?').get(id) as any;
  }

  private remember(item: StoredMessage & { legacyEventId?: boolean }, present: boolean) {
    const text = canonicalMessage(item);
    const existing = this.event(item.eventId);
    if (existing && existing.item !== text) {
      if (!item.legacyEventId || !this.db.prepare('SELECT 1 FROM legacy_events WHERE event_id = ?').get(item.eventId)) {
        throw new Error(`eventId conflict: ${item.eventId}`);
      }
      // Generated legacy IDs describe the identity, not mutable lookup names.
      // Keep a deterministic payload while leaving every original line intact.
      this.db.prepare('UPDATE events SET item = MIN(item, ?) WHERE event_id = ?').run(text, item.eventId);
    }
    this.db.prepare(`INSERT INTO events VALUES (?, ?, ?) ON CONFLICT(event_id)
      DO UPDATE SET present = MAX(present, excluded.present)`).run(item.eventId, text, Number(present));
    if (item.legacyEventId) this.db.prepare('INSERT OR IGNORE INTO legacy_events VALUES (?)').run(item.eventId);
    const identity = steamReplayIdentity(item);
    // The lowest event ID defines a fixed order independent of archive names,
    // JSONL line order and Rocks ingestion sequence.
    if (identity) this.db.prepare(`INSERT INTO identities VALUES (?, ?) ON CONFLICT(identity)
      DO UPDATE SET event_id = MIN(event_id, excluded.event_id)`).run(identity, item.eventId);
  }

  async ready() {
    if (!this.uncertain) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TEMP TABLE reservations AS SELECT event_id, item FROM events WHERE present = 0;
        CREATE TEMP TABLE legacy_events (event_id TEXT PRIMARY KEY);
        DELETE FROM identities; DELETE FROM events;`);
      for await (const item of this.records()) this.remember(item, true);
      // Actual primary records win over all old intents, including an intent
      // left before a failed write followed by recovery from the other copy.
      this.db.exec(`INSERT OR IGNORE INTO events SELECT event_id, item, 0 FROM reservations;`);
      for (const row of this.db.prepare('SELECT item FROM events WHERE present = 0 ORDER BY event_id').iterate()) {
        const item: StoredMessage = JSON.parse(String(row.item));
        const identity = steamReplayIdentity(item);
        if (identity) this.db.prepare('INSERT OR IGNORE INTO identities VALUES (?, ?)').run(identity, item.eventId);
      }
      this.db.exec('DROP TABLE reservations; DROP TABLE legacy_events');
      this.db.exec('COMMIT');
      this.uncertain = false;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get(identity: string): StoredMessage | undefined {
    const alias = this.db.prepare('SELECT event_id FROM identities WHERE identity = ?').get(identity);
    return alias ? JSON.parse(this.event(String(alias.event_id))!.item) : undefined;
  }

  resolve(identity: string): { item: StoredMessage; present: boolean } | undefined {
    const item = this.get(identity);
    return item ? { item, present: Boolean(this.event(item.eventId)!.present) } : undefined;
  }

  async append(input: StoredMessage, prepare?: (item: StoredMessage) => Promise<unknown>, resolved = false): Promise<StoredMessage> {
    await this.ready();
    const item = this.transaction(() => {
      const identity = steamReplayIdentity(input);
      const alias = identity && this.get(identity);
      if (alias && !resolved) return alias;
      this.remember(input, false);
      if (identity && resolved) this.db.prepare('UPDATE identities SET event_id = ? WHERE identity = ?').run(input.eventId, identity);
      return input;
    });
    try {
      // Image aliases must bind to the resolved old ID, and remain durable even
      // if the primary write has not happened yet. Also run for known records.
      await prepare?.(item);
      if (this.event(item.eventId)!.present) return item;
      await this.write(item);
      this.db.prepare('UPDATE events SET present = 1 WHERE event_id = ?').run(item.eventId);
      return item;
    } catch (error) {
      // Includes a failed primary fsync, an index commit failure, or an ACK lost
      // after this function returns (the next worker starts with uncertain=true).
      this.uncertain = true;
      throw error;
    }
  }

  close() { this.db.close(); }
}

// The writer repairs the active tail before this iterator is used. Sealed
// archives are read-only. Sync complete records before treating them as durable,
// including recovery from a successful append followed by a failed fsync/ACK.
export async function* jsonlRecords(filename: string): AsyncIterable<StoredMessage & { legacyEventId?: boolean }> {
  const parsed = path.parse(filename);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const archive = new RegExp(`^${escape(parsed.name)}-\\d{8}(?:-[a-f0-9]{16})?${escape(parsed.ext)}$`);
  const names = (await fs.readdir(parsed.dir)).filter(name => archive.test(name)).sort();
  names.push(parsed.base);
  for (const name of names) {
    const full = path.join(parsed.dir, name);
    const lines = jsonlLines(full);
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const raw: HistoryRecordInput | null = JSON.parse(line);
        // Legacy, unscoped records cannot be safely attributed to an account.
        if (!raw || !raw.steamAccountId || !raw.id || !(raw.sentAt || raw.date)) continue;
        const legacyEventId = raw.eventId === undefined;
        if (legacyEventId) {
          const identity = steamReplayIdentity(raw);
          if (!identity) continue;
          raw.eventId = createHash('sha256').update(`legacy:${identity}`).digest('hex').slice(0, 32);
        }
        const item = normalizeStoredMessage(raw);
        yield legacyEventId ? { ...item, legacyEventId: true } : item;
      }
    } finally { await lines.return?.(); }
    const file = await fs.open(full, 'r');
    try { await file.sync(); } finally { await file.close(); }
  }
}
