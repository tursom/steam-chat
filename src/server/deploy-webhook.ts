import type { IncomingMessage, ServerResponse } from 'node:http';

// This relay has no deployment credentials or Docker access. The host-side
// receiver authenticates the original signed bytes and owns deployment state.
export async function handleDeployWebhook(req: IncomingMessage, res: ServerResponse, target?: string) {
  const reply = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(JSON.stringify(body));
  };
  if (!target) { reply(404, { error: 'Deployment webhook is disabled' }); return; }
  if (req.method !== 'POST') { reply(405, { error: 'POST required' }); return; }
  const timestamp = req.headers['x-deploy-timestamp'];
  const signature = req.headers['x-deploy-signature'];
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)
    || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
    reply(401, { error: 'Deployment signature required' }); return;
  }
  if (Number(req.headers['content-length']) > 4096) { reply(413, { error: 'Request too large' }); return; }
  try {
    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.setTimeout(10000, () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) { reject(Object.assign(new Error('Request too large'), { statusCode: 413 })); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const response = await fetch(target, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Deploy-Timestamp': timestamp, 'X-Deploy-Signature': signature },
      body: new Uint8Array(body)    });
    const text = await response.text();
    if (text.length > 8192) throw new Error('Invalid deployment response');
    const result: unknown = JSON.parse(text);
    reply(response.status, result);
  } catch (error) {
    reply((error as { statusCode?: number }).statusCode === 413 ? 413 : 502,
      { error: 'Deployment receiver unavailable or request rejected' });
  }
}
