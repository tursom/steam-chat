import test from 'node:test';
import assert from 'node:assert/strict';
import { settleMetadata } from '../src/steam/metadata';

test('optional metadata settles on success, rejection or deadline', async () => {
  assert.equal(await settleMetadata(Promise.resolve('name'), 'fallback', 10), 'name');
  assert.equal(await settleMetadata(Promise.reject(new Error('offline')), 'fallback', 10), 'fallback');
  assert.equal(await settleMetadata(new Promise<string>(() => {}), 'fallback', 10), 'fallback');
});
