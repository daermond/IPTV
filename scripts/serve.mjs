import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.m3u': 'audio/x-mpegurl' };
const port = Number(process.env.IPTV_PORT || 8091);

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!file.startsWith(dist + sep)) { response.writeHead(404).end(); return; }
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': `${types[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': 'no-store',
    }).end(data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Run npm run build first.');
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
