const UINT64_MAX = 0xffffffffffffffffn;

export function uint64(value: string | bigint, name = 'uint64'): bigint {
  if (typeof value === 'string' && !/^[0-9]+$/.test(value)) throw new Error(`Invalid ${name}`);
  const result = BigInt(value);
  if (result < 0n || result > UINT64_MAX) throw new Error(`Invalid ${name}`);
  return result;
}

export function accountPrefix(type: number, account: string): Buffer {
  const key = Buffer.alloc(9);
  key[0] = type;
  const id = uint64(account, 'steamAccountId');
  if (!id) throw new Error('Invalid steamAccountId');
  key.writeBigUInt64BE(id, 1);
  return key;
}

export function conversationKey(account: string, peer: string, type = 0x20): Buffer {
  const key = Buffer.alloc(17);
  accountPrefix(type, account).copy(key);
  const id = uint64(peer, 'id');
  if (!id) throw new Error('Invalid id');
  key.writeBigUInt64BE(id, 9);
  return key;
}

export function messageKey(account: string, peer: string, time: number, ordinal: number, recordId: bigint): Buffer {
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid message timestamp');
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 0xffffffff) throw new Error('Invalid uint32 ordinal');
  const key = Buffer.alloc(37);
  conversationKey(account, peer, 0x10).copy(key);
  key.writeBigUInt64BE(BigInt(time), 17);
  key.writeUInt32BE(ordinal, 25);
  key.writeBigUInt64BE(uint64(recordId, 'recordId'), 29);
  return key;
}

export function decodeMessageKey(key: Buffer) {
  if (key.length !== 37 || key[0] !== 0x10) throw new Error('Invalid message key');
  return { steamAccountId: key.readBigUInt64BE(1).toString(), id: key.readBigUInt64BE(9).toString(),
    time: key.readBigUInt64BE(17), ordinal: key.readUInt32BE(25), recordId: key.readBigUInt64BE(29) };
}

export function recentKey(account: string, time: number, peer: string): Buffer {
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid message timestamp');
  const key = Buffer.alloc(25);
  accountPrefix(0x21, account).copy(key);
  key.writeBigUInt64BE(BigInt(time), 9);
  key.writeBigUInt64BE(uint64(peer, 'id'), 17);
  return key;
}

export function syncKey(account: string, sequence: bigint): Buffer {
  const key = Buffer.alloc(17);
  accountPrefix(0x22, account).copy(key);
  key.writeBigUInt64BE(uint64(sequence, 'sequence'), 9);
  return key;
}

export function eventKey(eventId: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(eventId)) throw new Error('Invalid eventId');
  return Buffer.concat([Buffer.from([0x40]), Buffer.from(eventId, 'hex')]);
}

export function prefixSuccessor(prefix: Buffer): Buffer | undefined {
  const result = Buffer.from(prefix);
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i] !== 0xff) { result[i]++; return result.subarray(0, i + 1); }
  }
  return undefined;
}

export function encodeCursor(generation: string, key: Buffer): string {
  return Buffer.concat([Buffer.from([1]), Buffer.from(generation, 'hex'), key]).toString('base64url');
}

export function decodeCursor(cursor: string, generation: string, prefix: Buffer, keyLength: number): Buffer {
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor || bytes.length !== 17 + keyLength || bytes[0] !== 1 ||
      bytes.subarray(1, 17).toString('hex') !== generation || !bytes.subarray(17, 17 + prefix.length).equals(prefix)) {
    throw Object.assign(new Error('Invalid cursor: version, generation or account/conversation mismatch'), { statusCode: 400 });
  }
  return bytes.subarray(17);
}
