import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { spawn } from 'child_process';
import { dim, reset, violet, bold, green } from '../ui';
import { extractTarGzFromUrl } from './archive';

// ── Constants ──────────────────────────────────────────────────────────────────

const SERVER_STATE_FILE  = 'typesense-server.json';
const DASHBOARD_TARBALL  = 'https://github.com/bfritscher/typesense-dashboard/archive/refs/heads/gh-pages.tar.gz';
const STRIP_TAR_PREFIX   = 'typesense-dashboard-gh-pages/'; // prefix inside the tarball
const STRIP_URL_PREFIX   = '/typesense-dashboard';          // base path baked into the built app

interface ServerState { pid: number; apiPort: number; }

// ── Browser open ───────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'start'
            : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch { /* best-effort */ }
}

// ── Dashboard download ─────────────────────────────────────────────────────────

function downloadDashboard(cacheDir: string): Promise<void> {
  return extractTarGzFromUrl(DASHBOARD_TARBALL, cacheDir, {
    stripPrefix: STRIP_TAR_PREFIX,
  }).then(() => {});
}

// ── Local HTTP server ──────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript',
  '.mjs':   'application/javascript',
  '.css':   'text/css',
  '.json':  'application/json',
  '.png':   'image/png',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.map':   'application/json',
};

function serveDashboard(cacheDir: string, port: number): http.Server {
  return http.createServer((req, res) => {
    let urlPath = (req.url ?? '/').split('?')[0]!;

    // Strip the GitHub Pages base path baked into the built app
    if (urlPath.startsWith(STRIP_URL_PREFIX)) {
      urlPath = urlPath.slice(STRIP_URL_PREFIX.length) || '/';
    }
    if (urlPath === '' || urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(cacheDir, urlPath);

    // Prevent path traversal
    if (!filePath.startsWith(cacheDir)) {
      res.writeHead(403); res.end(); return;
    }

    let target = filePath;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      // SPA fallback
      target = path.join(cacheDir, 'index.html');
    }

    if (!fs.existsSync(target)) {
      res.writeHead(404); res.end('Not found'); return;
    }

    const ext  = path.extname(target).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(target).pipe(res);
  }).listen(port, '127.0.0.1');
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    }).on('error', reject);
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function openTypesenseDashboard(projectRoot: string): Promise<http.Server | null> {
  const kirographDir = path.join(projectRoot, '.kirograph');
  const cacheDir     = path.join(kirographDir, 'typesense', 'dashboard');

  // Read Typesense server connection details
  const stateFile = path.join(kirographDir, SERVER_STATE_FILE);
  let apiPort: number | null = null;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as ServerState;
    apiPort = state.apiPort;
  } catch { /* server not started or state missing */ }

  // Download dashboard if not cached
  const indexHtml = path.join(cacheDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    process.stdout.write(`  Downloading Typesense Dashboard (first time only)…\n`);
    try {
      await downloadDashboard(cacheDir);
      process.stdout.write(`  Dashboard ready.\n`);
    } catch (err) {
      process.stdout.write(`  Dashboard download failed: ${String(err)}\n`);
      return null;
    }
  }

  const dashboardPort = await getFreePort();
  const server = serveDashboard(cacheDir, dashboardPort);

  const url = `http://127.0.0.1:${dashboardPort}`;

  console.log(`\n  ${violet}${bold}Typesense Dashboard${reset}  ${dim}(local)${reset}`);
  console.log(`  ${green}✓${reset} Serving at ${violet}${url}${reset}`);
  console.log();
  console.log(`  Connect with:`);
  console.log(`  ${dim}Node URL${reset}  ${violet}http://127.0.0.1:${apiPort ?? '???'}${reset}`);
  console.log(`  ${dim}API Key ${reset}  ${violet}kirograph-local${reset}`);
  console.log();

  openBrowser(url);
  return server;
}
