import { DailyJsonlWriter } from './daily-jsonl';
import { SteamImageAliases } from './history-steam-alias';
import { serializeStoredMessage, type StoredMessage } from './history-message';
import { HistoryIdempotency, jsonlRecords } from './history-idempotency';

// This module is loaded only by the forked writer, never by the HTTP process.
let database: any;
let log: DailyJsonlWriter | undefined;
let aliases: SteamImageAliases;
let idempotency: HistoryIdempotency;
let serial = Promise.resolve();

async function run(method: string, value: any): Promise<any> {
  if (method === 'init') {
    aliases = new SteamImageAliases(`${value.path}.steam-image-aliases-v1`);
    if (value.kind === 'jsonl') { log = new DailyJsonlWriter(value.path); await log.ready(); }
    else {
      const { RocksHistoryStore } = require('./rocks-history');
      database = new RocksHistoryStore(value.path);
      await database.ready();
    }
    idempotency = new HistoryIdempotency(`${value.path}.idempotency-v1.sqlite`,
      () => log ? jsonlRecords(value.path) : database.all({ durable: true }),
      async item => {
        if (log) await log.append(serializeStoredMessage(item));
        else await database.put(item);
      });
    await idempotency.ready();
    return true;
  }
  if (method === 'imageAlias') return (await aliases.get(value)) || idempotency.get(value);
  if (method === 'resolve') { if (log) await log.ready(); await idempotency.ready(); return idempotency.resolve(value); }
  if (method === 'append') {
    const item: StoredMessage = value;
    // Reopen/repair an uncertain JSONL tail before consulting actual records.
    if (log) await log.ready();
    return idempotency.append(item, value.steamImageEventKey
      ? resolved => aliases.put(value.steamImageEventKey, resolved) : undefined, value.canonicalResolved === true);
  }
  if (method === 'sync') return database.sync(value);
  if (method === 'history') return database.history(value);
  if (method === 'conversations') return database.conversations(value);
  if (method === 'close') {
    if (log) await log.close();
    if (database) await database.close();
    idempotency.close();
    return true;
  }
  throw new Error('Unknown storage worker method');
}

process.on('message', (message: { id: number; method: string; value: unknown }) => {
  serial = serial.then(async () => {
    try {
      const result = await run(message.method, message.value);
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error),
        statusCode: (error as { statusCode?: number }).statusCode,
        resetRequired: (error as { resetRequired?: boolean }).resetRequired });
    }
  });
});
// A vanished parent cannot drain or acknowledge requests; do not leave an orphan holding the DB lock.
process.on('disconnect', () => process.exit(1));
