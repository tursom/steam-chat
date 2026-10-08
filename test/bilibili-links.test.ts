import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveBilibiliLink } from '../src/server/bilibili-links';

const bvid = 'BV1xx411c7mD';
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

test('Bilibili direct BV and av links preserve part numbers without any network requests', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; throw new Error('Unexpected fetch'); };
  assert.deepEqual(await resolveBilibiliLink(`https://m.bilibili.com/video/${bvid}/?p=2&share_source=qq`, fetchImpl),
    { url: `https://www.bilibili.com/video/${bvid}?p=2` });
  assert.deepEqual(await resolveBilibiliLink('http://www.bilibili.com/video/av170001', fetchImpl),
    { url: 'https://www.bilibili.com/video/av170001?p=1' });
  assert.equal(calls, 0);
});

test('Bilibili share links use bounded manual redirects and cancel unused bodies', async () => {
  const calls: string[] = [];
  let canceled = false;
  const fetchImpl: typeof fetch = async (input, options) => {
    calls.push(String(input));
    assert.equal(options?.redirect, 'manual'); assert.ok(options?.signal);
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), {
      status: 302, headers: { Location: `https://www.bilibili.com/video/${bvid}?p=3&share_source=qq` }
    });
  };
  const result = await resolveBilibiliLink('https://b23.tv/AbC123?share_source=qq', fetchImpl);
  assert.deepEqual(result, { url: `https://www.bilibili.com/video/${bvid}?p=3` });
  assert.deepEqual(calls, ['https://b23.tv/AbC123']); assert.equal(canceled, true);
});

test('Bilibili resolver never follows non-Bilibili, local, credential or non-video targets', async () => {
  for (const location of ['http://127.0.0.1/private', 'https://example.com/video/av1',
    `https://www.bilibili.com.evil.test/video/${bvid}`, `https://user:pass@www.bilibili.com/video/${bvid}`,
    'https://www.bilibili.com/opus/123', 'https://live.bilibili.com/123', 'http://%invalid']) {
    let calls = 0;
    await assert.rejects(resolveBilibiliLink('https://b23.tv/Share', async () => { calls++; return redirect(location); }));
    assert.equal(calls, 1, `Never fetch the redirect target: ${location}`);
  }
  for (const input of ['file:///tmp/private', 'https://b23.tv.evil.test/Share', 'https://b23.tv:8443/Share',
    'https://b23.tv/foo/bar', `https://www.bilibili.com/video/${bvid}?p=0`, 'https://www.bilibili.com/video/av-1']) {
    let calls = 0;
    await assert.rejects(resolveBilibiliLink(input, async () => { calls++; return redirect('https://example.com'); }));
    assert.equal(calls, 0);
  }
});

test('Bilibili redirect loops, excessively long chains and upstream failures stop without retries', async () => {
  let calls = 0;
  await assert.rejects(resolveBilibiliLink('https://b23.tv/Loop', async () => { calls++; return redirect('/Loop'); }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(resolveBilibiliLink('https://b23.tv/Chain0', async () => { calls++; return redirect(`/Chain${calls}`); }));
  assert.equal(calls, 5);
  calls = 0;
  await assert.rejects(resolveBilibiliLink('https://b23.tv/Failed', async () => { calls++; throw new Error('network error'); }));
  assert.equal(calls, 1);
});
