import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { GraphDatabase } from '../../src/db/database';
import { dbLockTiming } from '../../src/db/db-lock';

const WASM_DRIVER = path.resolve(__dirname, '../../node_modules/node-sqlite3-wasm');

const FILE = { path: 'a.ts', contentHash: 'h', language: 'typescript', fileSize: 1, symbolCount: 0, indexedAt: 1 };

let root: string;
const dbDir = () => path.join(root, '.kirograph');
const lockPath = () => path.join(dbDir(), 'kirograph.db.lock');
const writersDir = () => path.join(dbDir(), 'db-writers');
const agedSeconds = (sec: number) => {
  const t = (Date.now() - sec * 1000) / 1000;
  return t;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-dblock-'));
  fs.mkdirSync(dbDir(), { recursive: true });
  dbLockTiming.staleAfterMs = 5_000;
  dbLockTiming.maxWaitMs = 300;
});

afterEach(() => {
  dbLockTiming.staleAfterMs = 5_000;
  dbLockTiming.maxWaitMs = 8_000;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('database lock recovery', () => {
  it('removes a lock directory left by a process that exited', () => {
    fs.mkdirSync(lockPath());
    fs.utimesSync(lockPath(), agedSeconds(60), agedSeconds(60));

    const db = new GraphDatabase(root);
    expect(fs.existsSync(lockPath())).toBe(false);
    db.close();
  });

  it('refuses to open while a live process holds the lock', () => {
    fs.mkdirSync(lockPath());
    fs.utimesSync(lockPath(), agedSeconds(60), agedSeconds(60));
    fs.mkdirSync(writersDir());
    // process.ppid is alive for the whole test run: it stands for a live writer
    fs.writeFileSync(path.join(writersDir(), String(process.ppid)), String(Date.now()));

    expect(() => new GraphDatabase(root)).toThrow(/locked by another process/);
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  it('waits for a live writer to release the lock, then writes', async () => {
    // Set up the database file first, so the child only holds the lock
    const db = new GraphDatabase(root);

    const holder = spawn(process.execPath, ['-e', `
      const { Database } = require(process.argv[1]);
      const raw = new Database(process.argv[2]);
      raw.exec('BEGIN IMMEDIATE');
      raw.exec("INSERT INTO files (path, content_hash, language, file_size, symbol_count, indexed_at) VALUES ('held', 'h', 'x', 0, 0, 0)");
      console.log('locked');
      setTimeout(() => { raw.exec('COMMIT'); raw.close(); }, 400);
    `, WASM_DRIVER, path.join(dbDir(), 'kirograph.db')]);
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', (d: Buffer) => { if (String(d).includes('locked')) resolve(); });
      holder.on('error', reject);
    });

    dbLockTiming.maxWaitMs = 5_000;
    const started = Date.now();
    db.transaction(() => db.upsertFile(FILE));
    // the holder keeps the lock for 400 ms: the write must have waited for it
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(db.getFile('a.ts')).not.toBeNull();

    await new Promise<void>(resolve => holder.on('exit', () => resolve()));
    db.close();
  });

  it('recovers after a writer is killed while it holds the lock', () => {
    // A writer that dies mid-transaction, the way an IDE that kills a hook leaves it
    const killed = spawnSync(process.execPath, ['-e', `
      const { Database } = require(process.argv[1]);
      const raw = new Database(process.argv[2]);
      raw.exec('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content_hash TEXT, language TEXT, file_size INTEGER, symbol_count INTEGER, indexed_at INTEGER)');
      raw.exec('BEGIN IMMEDIATE');
      raw.exec("INSERT INTO files (path, content_hash, language, file_size, symbol_count, indexed_at) VALUES ('x', 'h', 'x', 0, 0, 0)");
      process.kill(process.pid, 'SIGKILL');
    `, WASM_DRIVER, path.join(dbDir(), 'kirograph.db')]);
    expect(killed.signal).toBe('SIGKILL');
    expect(fs.existsSync(lockPath())).toBe(true);
    fs.utimesSync(lockPath(), agedSeconds(60), agedSeconds(60));

    const db = new GraphDatabase(root);
    db.transaction(() => db.upsertFile(FILE));
    expect(db.getFile('a.ts')).not.toBeNull();
    expect(fs.existsSync(lockPath())).toBe(false);
    db.close();
  });

  it('leaves no writer marker behind after normal use', () => {
    const db = new GraphDatabase(root);
    db.transaction(() => db.upsertFile(FILE));
    db.getFile('a.ts');
    db.close();
    expect(fs.readdirSync(writersDir())).toEqual([]);
  });
});
