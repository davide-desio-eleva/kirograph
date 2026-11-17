import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { GraphDatabase } from '../../src/db/database';
import { Database } from '../../src/db/sqlite';

const FILE = { path: 'a.ts', contentHash: 'h', language: 'typescript', fileSize: 1, symbolCount: 0, indexedAt: 1 };

let root: string;
const dbDir = () => path.join(root, '.kirograph');
const dbPath = () => path.join(dbDir(), 'kirograph.db');
const lockPath = () => path.join(dbDir(), 'kirograph.db.lock');
const writersDir = () => path.join(dbDir(), 'db-writers');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-dblock-'));
  fs.mkdirSync(dbDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Another process that opens the database, starts a write transaction and holds it for `holdMs`. */
function writer(holdMs: number): { child: ChildProcess; locked: Promise<void>; exited: Promise<void> } {
  const child = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO files (path, content_hash, language, file_size, symbol_count, indexed_at) VALUES ('held', 'h', 'x', 0, 0, 0)");
    console.log('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${holdMs});
  `, dbPath()]);
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
  const locked = new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('locked')) resolve(); });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`writer exited (${code})`)));
  });
  return { child, locked, exited };
}

describe('database locking (node:sqlite, WAL)', () => {
  it('opens the database in WAL mode', () => {
    const db = new GraphDatabase(root);
    db.close();
    const raw = new Database(dbPath(), { readOnly: true });
    expect(raw.get('PRAGMA journal_mode').journal_mode).toBe('wal');
    raw.close();
  });

  it('reads while another process holds a write transaction', async () => {
    const db = new GraphDatabase(root);
    db.transaction(() => db.upsertFile(FILE));

    const w = writer(1_500);
    await w.locked;
    const started = Date.now();
    expect(db.getFile('a.ts')).not.toBeNull();
    // The reader sees the last commit, not the writer's open transaction, and does not wait for it
    expect(db.getFile('held')).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);

    await w.exited;
    expect(db.getFile('held')).not.toBeNull();
    db.close();
  });

  it('waits for a busy writer, then writes', async () => {
    const db = new GraphDatabase(root);
    const w = writer(400);
    await w.locked;

    const started = Date.now();
    db.transaction(() => db.upsertFile(FILE));
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(db.getFile('a.ts')).not.toBeNull();
    expect(db.getFile('held')).not.toBeNull();

    await w.exited;
    db.close();
  });

  it('recovers after a writer is killed in the middle of a transaction', () => {
    const db = new GraphDatabase(root);
    db.transaction(() => db.upsertFile(FILE));
    db.close();

    // A writer that dies mid-transaction, the way an IDE that kills a hook leaves it
    const killed = spawnSync(process.execPath, ['--no-warnings', '-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      db.exec("INSERT INTO files (path, content_hash, language, file_size, symbol_count, indexed_at) VALUES ('lost', 'h', 'x', 0, 0, 0)");
      process.kill(process.pid, 'SIGKILL');
    `, dbPath()]);
    expect(killed.signal).toBe('SIGKILL');

    const again = new GraphDatabase(root);
    expect(again.getFile('a.ts')).not.toBeNull();
    expect(again.getFile('lost')).toBeNull();
    again.transaction(() => again.upsertFile({ ...FILE, path: 'b.ts' }));
    expect(again.getFile('b.ts')).not.toBeNull();
    again.close();
  });
});

describe('leaving the database of KiroGraph 1.5', () => {
  it('removes the lock directory and writer markers that 1.5 left behind', () => {
    new GraphDatabase(root).close();
    fs.mkdirSync(lockPath());
    fs.mkdirSync(writersDir());
    fs.writeFileSync(path.join(writersDir(), '2147483000'), String(Date.now())); // a process that is gone

    const db = new GraphDatabase(root);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(fs.existsSync(writersDir())).toBe(false);
    db.close();
  });

  it('refuses to open while a 1.5 process still uses the database', () => {
    new GraphDatabase(root).close();
    fs.mkdirSync(lockPath());
    fs.mkdirSync(writersDir());
    // process.ppid is alive for the whole test run: it stands for a running 1.5 MCP server
    fs.writeFileSync(path.join(writersDir(), String(process.ppid)), String(Date.now()));

    expect(() => new GraphDatabase(root)).toThrow(/1\.5 or older is still using/);
    expect(fs.existsSync(lockPath())).toBe(true);
  });
});
