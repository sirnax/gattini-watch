import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const ASSETS = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const REFRESH_MS = 2000;

function hoursFrom(url, fallback) {
  const value = Number(url.searchParams.get('hours'));
  return Number.isFinite(value) && value > 0 && value <= 24 * 30 ? value : fallback;
}

// Serves the page, a JSON snapshot, and a server-sent event stream that pushes a new
// snapshot whenever the logs change. Binds to loopback only: the logs contain prompts.
export function startServer({ fleet, port, host = '127.0.0.1', hours }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? host}`);
    try {
      if (url.pathname === '/api/snapshot') {
        const body = JSON.stringify(await fleet.snapshot({ hours: hoursFrom(url, hours) }));
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(body);
        return;
      }
      if (url.pathname === '/events') {
        const windowHours = hoursFrom(url, hours);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        let last = '';
        let busy = false;
        const push = async () => {
          if (busy) return;
          busy = true;
          try {
            const snapshot = await fleet.snapshot({ hours: windowHours });
            const body = JSON.stringify({ ...snapshot, generatedAt: 0 });
            if (body !== last) {
              last = body;
              response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
            } else {
              response.write(': keep-alive\n\n');
            }
          } catch (error) {
            response.write(`event: failure\ndata: ${JSON.stringify(String(error?.message ?? error))}\n\n`);
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(push, REFRESH_MS);
        request.on('close', () => clearInterval(timer));
        await push();
        return;
      }
      const asset = ASSETS[url.pathname];
      if (asset) {
        const body = await readFile(join(PUBLIC_DIR, asset));
        response.writeHead(200, { 'content-type': TYPES[extname(asset)], 'cache-control': 'no-store' });
        response.end(body);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error?.message ?? error));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
