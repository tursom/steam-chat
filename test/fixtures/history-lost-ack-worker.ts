import { existsSync, writeFileSync } from 'node:fs';

// Exercise the real writer, but kill exactly once after a durable JSONL append
// and before the parent receives its acknowledgement.
let kind: string;
let marker: string;
const appends = new Set<number>();
process.on('message', (message: any) => {
  if (message.method === 'init') { kind = message.value.kind; marker = `${message.value.path}.lost-ack`; }
  if (message.method === 'append') appends.add(message.id);
});
const send = process.send!.bind(process);
process.send = ((message: any, ...args: any[]) => {
  if (kind === 'jsonl' && appends.delete(message.id) && message.result?.eventId && !existsSync(marker)) {
    writeFileSync(marker, 'ACK deliberately lost');
    process.exit(1);
  }
  return (send as any)(message, ...args);
}) as typeof process.send;
require('../../src/storage/history-worker');
