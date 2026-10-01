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

// Only loopback names may reach the page. A foreign Host header means another site is
// trying to read the logs through DNS rebinding, so it is refused.
export function allowedHost(header) {
  if (typeof header !== 'string') return false;
  const name = header.toLowerCase().replace(/:\d+$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1' || name === '[::1]';
}

// Serves the page, a JSON snapshot, and a server-sent event stream that pushes a new
// snapshot whenever the logs change. Binds to loopback only: the logs contain prompts.
export function startServer({ fleet, port, hours, hosts = ['127.0.0.1', '::1'], onStop = null }) {
  const server = createServer(async (request, response) => {
    if (!allowedHost(request.headers.host)) {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('Forbidden: open this page at http://gattini-watch.localhost or http://127.0.0.1');
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    // The page's Stop button. The custom header cannot be sent by another site without a
    // CORS preflight, which this server never approves.
    if (url.pathname === '/api/stop' && onStop) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' });
        response.end('Use POST');
      } else if (request.headers['x-gattini-watch'] !== 'stop') {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('Forbidden');
      } else {
        response.writeHead(202, { 'content-type': 'text/plain' });
        response.end('Stopping');
        setImmediate(onStop);
      }
      return;
    }
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

  // One handler, listening on every loopback address the machine has. A machine without
  // IPv6 skips ::1; any other failure, such as a busy port, stops start-up.
  const listen = (host, onPort) =>
    new Promise((resolve, reject) => {
      const listener = host === hosts[0] ? server : createServer(server.listeners('request')[0]);
      listener.once('error', reject);
      listener.listen(onPort, host, () => resolve(listener));
    });
  return (async () => {
    const listeners = [await listen(hosts[0], port)];
    const bound = listeners[0].address().port;
    for (const host of hosts.slice(1)) {
      try {
        listeners.push(await listen(host, bound));
      } catch (error) {
        if (error.code !== 'EADDRNOTAVAIL' && error.code !== 'EAFNOSUPPORT') {
          for (const listener of listeners) listener.close();
          throw error;
        }
      }
    }
    return { close: () => Promise.all(listeners.map((listener) => new Promise((done) => listener.close(done)))), port: bound };
  })();
}
