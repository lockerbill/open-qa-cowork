// Minimal static file server for the E2E fixture (no external deps).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const port = Number(process.env.FIXTURE_PORT ?? 5555);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = url.pathname === '/' ? '/spa.html' : url.pathname;
    // SPA fallback: unknown routes serve the app shell.
    if (!path.endsWith('.html')) path = '/spa.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(port, () => {
  console.log(`fixture server on http://localhost:${port}`);
});
