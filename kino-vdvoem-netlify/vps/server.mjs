import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import room from '../netlify/functions/api.mjs';
import account from '../netlify/functions/account.mjs';

if (!process.env.RAVETYPE_DATA_DIR) throw Error('RAVETYPE_DATA_DIR is required');
const root = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(root, '../public/index.html'));
const port = Number(process.env.PORT || 3907);
const host = process.env.HOST || '127.0.0.1';

createServer(async (incoming, outgoing) => {
  try {
    const origin = process.env.PUBLIC_ORIGIN || 'http://' + incoming.headers.host;
    const url = new URL(incoming.url, origin);
    if (incoming.method === 'GET' && url.pathname === '/healthz') {
      outgoing.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); outgoing.end('ok'); return;
    }
    if (incoming.method === 'GET' && (url.pathname === '/' || /^\/r\/[a-f0-9]{32}\/?$/.test(url.pathname))) {
      outgoing.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); outgoing.end(html); return;
    }
    if (incoming.method !== 'POST' || !/^\/api\/(?:room\/[a-f0-9]{32}\/[a-z-]+|account\/[a-z-]+)\/?$/.test(url.pathname)) {
      outgoing.writeHead(404); outgoing.end(); return;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > 65000) { outgoing.writeHead(413); outgoing.end(); return; }
      chunks.push(chunk);
    }
    const request = new Request(url, {
      method: 'POST',
      headers: incoming.headers,
      body: Buffer.concat(chunks)
    });
    const response = url.pathname.startsWith('/api/account/') ? await account(request) : await room(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}).listen(port, host, () => console.log('Ravetype listening on ' + host + ':' + port));
