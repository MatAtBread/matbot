// Convenience static server for local use. The artifact (dist/matbot.html) is self-contained and
// opens fine from a file:// URL; this server is only needed to exercise the runtime *remote* plugin
// loader (which fetches raw .ts over http — blocked under file://). Serves the repo root so both the
// built page and the live plugin sources are reachable.

import { createServer } from 'node:http';
import { readFile }     from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here     = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const port     = Number(process.env.PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.ts':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = url.pathname === '/' ? '/apps/web-bundle/dist/matbot.html' : decodeURIComponent(url.pathname);
    const abs = path.join(repoRoot, rel);
    if (!abs.startsWith(repoRoot)) { res.writeHead(403); res.end('forbidden'); return; }
    const body = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'text/plain; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => {
  console.log(`matbot web → http://localhost:${port}/  (serving repo root ${repoRoot})`);
});
