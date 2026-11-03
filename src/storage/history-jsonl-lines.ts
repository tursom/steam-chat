import { createReadStream } from 'node:fs';

// JSONL uses ASCII LF. Node's readline also recognizes Unicode U+2028/U+2029,
// which are legal characters inside a JSON string and must remain in its body.
export async function* jsonlLines(filename: string): AsyncGenerator<string, void, unknown> {
  const stream = createReadStream(filename, { encoding: 'utf8' });
  let pending = '';
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let offset = 0;
      let newline: number;
      while ((newline = pending.indexOf('\n', offset)) !== -1) {
        yield pending.slice(offset, newline);
        offset = newline + 1;
      }
      pending = pending.slice(offset);
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new Error('JSONL record exceeds scan limit');
    }
    if (pending.trim()) throw new Error('Incomplete JSONL record at end of file');
  } finally { stream.destroy(); }
}
