/**
 * PixelRAG lifecycle manager.
 *
 * Handles: Python check, pip install, index build (with manifest staleness),
 * server spawn + health poll, cleanup on exit.
 *
 * EXPERIMENTAL: This module is experimental and may change without notice.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { PixelRAGManifestEntry } from './types';

// ── Python detection ───────────────────────────────────────────────────────────

/** Returns the python3 binary name if available and ≥ 3.10, otherwise null. */
export function detectPython(): string | null {
  for (const bin of ['python3', 'python']) {
    try {
      const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0) continue;
      const out = (result.stdout + result.stderr).trim();
      const match = out.match(/Python (\d+)\.(\d+)/);
      if (!match) continue;
      const [, major, minor] = match;
      if (Number(major) >= 3 && Number(minor) >= 10) return bin;
    } catch { /* not found */ }
  }
  return null;
}

export function ensurePython(): string {
  const bin = detectPython();
  if (!bin) {
    throw new Error(
      'PixelRAG (visual PDF search) requires Python 3.10+.\n' +
      'Install from https://python.org, then re-run kirograph index.',
    );
  }
  return bin;
}

// ── WSL2 / platform checks ─────────────────────────────────────────────────────

export function detectWSL2(): boolean {
  try {
    const version = fs.readFileSync('/proc/version', 'utf8');
    return /microsoft|WSL/i.test(version);
  } catch {
    return false;
  }
}

/** Returns free RAM in bytes. */
function freeRam(): number {
  return os.freemem();
}

const WARN_RAM_BYTES   = 4 * 1024 * 1024 * 1024; // 4 GB
const BLOCK_RAM_BYTES  = 2 * 1024 * 1024 * 1024; // 2 GB

export function checkRam(): 'ok' | 'warn' | 'block' {
  const free = freeRam();
  if (free < BLOCK_RAM_BYTES) return 'block';
  if (free < WARN_RAM_BYTES)  return 'warn';
  return 'ok';
}

// ── PixelRAG installation ──────────────────────────────────────────────────────

export function isPixelRAGInstalled(python: string): boolean {
  const result = spawnSync(python, ['-c', 'import pixelrag_serve'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return result.status === 0;
}

export function installPixelRAG(python: string): void {
  console.log('  Installing PixelRAG (pip install pixelrag[index,serve])…');
  const result = spawnSync(python, ['-m', 'pip', 'install', 'pixelrag[index,serve]'], {
    stdio: 'inherit',
    timeout: 300_000,
  });
  if (result.status !== 0) {
    throw new Error('pip install pixelrag[index,serve] failed. Check your Python environment.');
  }
}

export function downloadPixelRAGModel(python: string): void {
  console.log('  Downloading Qwen3-VL-Embedding-2B model (~4 GB)…');
  const result = spawnSync(python, ['-m', 'pixelrag_embed.download'], {
    stdio: 'inherit',
    timeout: 1800_000, // 30 min
  });
  if (result.status !== 0) {
    throw new Error('PixelRAG model download failed.');
  }
}

export function ensurePixelRAGInstalled(python: string): void {
  if (!isPixelRAGInstalled(python)) {
    installPixelRAG(python);
  }
}

// ── Manifest / staleness ───────────────────────────────────────────────────────

function readManifest(manifestPath: string): PixelRAGManifestEntry[] {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
}

function writeManifest(manifestPath: string, entries: PixelRAGManifestEntry[]): void {
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2));
}

function buildManifestEntries(absPaths: string[]): PixelRAGManifestEntry[] {
  return absPaths.map(p => {
    try {
      const st = fs.statSync(p);
      return { path: p, mtime: st.mtimeMs, size: st.size };
    } catch {
      return { path: p, mtime: 0, size: 0 };
    }
  });
}

function manifestIsStale(current: PixelRAGManifestEntry[], fresh: PixelRAGManifestEntry[]): boolean {
  if (current.length !== fresh.length) return true;
  const map = new Map(current.map(e => [e.path, e]));
  for (const f of fresh) {
    const c = map.get(f.path);
    if (!c || c.mtime !== f.mtime || c.size !== f.size) return true;
  }
  return false;
}

// ── Get flagged PDFs from kirograph DB ────────────────────────────────────────

/**
 * Queries the kirograph data DB for PDF datasets that have at least one page
 * with needs_ocr='true' or has_columns='true' (complex visual layout).
 * Returns absolute paths.
 */
export function getFlaggedPdfs(rawDb: { all: (sql: string, params?: unknown[]) => unknown[] }, projectRoot: string): string[] {
  const datasets = rawDb.all(
    `SELECT id, file_path FROM data_datasets WHERE format = 'pdf'`,
  ) as { id: string; file_path: string }[];

  const flagged: string[] = [];
  for (const ds of datasets) {
    const tableName = `data_rows_${ds.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    try {
      const rows = rawDb.all(
        `SELECT COUNT(*) as cnt FROM "${tableName}" WHERE needs_ocr = 'true' OR has_columns = 'true'`,
      ) as { cnt: number }[];
      if (rows[0]?.cnt > 0) {
        const absPath = path.isAbsolute(ds.file_path)
          ? ds.file_path
          : path.join(projectRoot, ds.file_path);
        flagged.push(absPath);
      }
    } catch { /* table not yet created or no schema yet — skip */ }
  }
  return flagged;
}

// ── Index build ────────────────────────────────────────────────────────────────

interface BuildIndexOptions {
  python: string;
  flaggedPdfs: string[];
  projectRoot: string;
  kirographDir: string;
  force?: boolean;
}

export function buildIndex(opts: BuildIndexOptions): void {
  const { python, flaggedPdfs, kirographDir, force } = opts;
  const indexDir     = path.join(kirographDir, 'pixelrag-index');
  const targetsFile  = path.join(kirographDir, 'pixelrag-targets.txt');
  const manifestFile = path.join(kirographDir, 'pixelrag-manifest.json');

  if (flaggedPdfs.length === 0) {
    console.log('  PixelRAG: no visually complex PDFs found — skipping index build.');
    return;
  }

  const freshEntries = buildManifestEntries(flaggedPdfs);
  const currentEntries = readManifest(manifestFile);
  const indexExists = fs.existsSync(indexDir);

  if (!force && indexExists && !manifestIsStale(currentEntries, freshEntries)) {
    console.log(`  PixelRAG: index up to date (${flaggedPdfs.length} PDF${flaggedPdfs.length > 1 ? 's' : ''}).`);
    return;
  }

  // Estimate build time and warn
  const tileEstimate = flaggedPdfs.length * 40; // rough: 20 pages × 2 tiles
  const cpuMinutes = Math.round(tileEstimate * 10 / 60);
  const mpsMinutes = Math.round(tileEstimate * 2 / 60);
  console.log(
    `  Building PixelRAG index: ~${tileEstimate} tiles` +
    ` (~${cpuMinutes} min on CPU, ~${mpsMinutes} min on MPS)…`,
  );

  // Write targets file
  fs.writeFileSync(targetsFile, flaggedPdfs.join('\n') + '\n');

  const result = spawnSync(
    python,
    ['-m', 'pixelrag_index', 'build', '--source-files', targetsFile, '--output', indexDir, '--device', 'auto'],
    { stdio: 'inherit', timeout: 7200_000 }, // 2h hard limit
  );

  if (result.status !== 0) {
    throw new Error('PixelRAG index build failed. Check Python output above for details.');
  }

  writeManifest(manifestFile, freshEntries);
  console.log(`  ✓ PixelRAG index built (${flaggedPdfs.length} PDF${flaggedPdfs.length > 1 ? 's' : ''}).`);
}

// ── Server lifecycle ───────────────────────────────────────────────────────────

let _serverProcess: ChildProcess | null = null;
let _cleanupRegistered = false;

function registerCleanup(): void {
  if (_cleanupRegistered) return;
  _cleanupRegistered = true;

  const cleanup = (): void => {
    if (_serverProcess) {
      try { _serverProcess.kill('SIGTERM'); } catch { /* best-effort */ }
      // Give it 5s then SIGKILL
      setTimeout(() => {
        try { _serverProcess?.kill('SIGKILL'); } catch { /* best-effort */ }
      }, 5000).unref();
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

async function pollHealth(endpoint: string, maxAttempts: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
      // Non-404 unexpected response — something else is on this port
      if (res.status !== 404 && res.status !== 503) {
        console.warn(`  ⚠ Port ${endpoint}: unexpected response (${res.status}). Another process may be on this port.`);
        return false;
      }
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code && err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET' && err.code !== 'UND_ERR_CONNECT_TIMEOUT') {
        // Not a "not yet up" error
        console.warn(`  ⚠ PixelRAG health check: ${String(e)}`);
      }
    }
    if ((i + 1) % 8 === 0) {
      console.log(`  PixelRAG loading model… ${Math.round((i + 1) * intervalMs / 1000)}s elapsed`);
    }
  }
  return false;
}

export async function startServer(python: string, port: number, kirographDir: string): Promise<void> {
  const endpoint = `http://localhost:${port}`;
  const indexDir = path.join(kirographDir, 'pixelrag-index');

  // RAM check
  const ramState = checkRam();
  if (ramState === 'block') {
    throw new Error(
      `PixelRAG server requires at least 4 GB free RAM.\n` +
      `Current free: ${(freeRam() / 1024 / 1024 / 1024).toFixed(1)} GB.\n` +
      `Close other applications and retry, or disable enableVisualPDF.`,
    );
  }
  if (ramState === 'warn') {
    console.warn(
      `  ⚠ Low RAM: ${(freeRam() / 1024 / 1024 / 1024).toFixed(1)} GB free. ` +
      `PixelRAG may degrade system performance.`,
    );
  }

  // WSL2 warning
  if (detectWSL2()) {
    console.warn(
      '  ⚠ WSL2 detected. Visual PDF search has known limitations:\n' +
      '    • Ensure your project is on the Linux filesystem (/home/...), not /mnt/c/...\n' +
      '    • Allocate at least 8 GB to WSL2 in %USERPROFILE%\\.wslconfig\n' +
      '    • CUDA requires updated NVIDIA drivers with WSL2 support',
    );
  }

  // Check if already running (user may have started it manually)
  try {
    const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log(`  PixelRAG server already running on port ${port}.`);
      return;
    }
  } catch { /* not running */ }

  if (!fs.existsSync(indexDir)) {
    console.warn(
      `  ⚠ PixelRAG index not found at ${indexDir}.\n` +
      `  Run: kirograph index — to build it first.`,
    );
    return;
  }

  console.log(`  Starting PixelRAG server on port ${port}…`);

  _serverProcess = spawn(
    python,
    ['-m', 'pixelrag_serve.api', '--index-dir', indexDir, '--port', String(port), '--device', 'auto'],
    { stdio: ['ignore', 'ignore', 'ignore'], detached: false },
  );

  _serverProcess.on('error', err => {
    console.warn(`  ⚠ PixelRAG server error: ${err.message}`);
  });

  registerCleanup();

  // Poll /health — startup only, 90 attempts × 2s = 3 minutes max
  const ready = await pollHealth(endpoint, 90, 2000);
  if (ready) {
    console.log(`  ✓ PixelRAG server ready on port ${port}.`);
  } else {
    console.warn(
      `  ⚠ PixelRAG server did not respond within 3 minutes.\n` +
      `  Visual PDF search calls will fail until it is ready.`,
    );
  }
}
