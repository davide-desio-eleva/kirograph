import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { GraphDatabase } from '../../src/db/database';
import { clearStaleDbLock, dbLockTiming } from '../../src/db/db-lock';

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
});

afterEach(() => {
  dbLockTiming.staleAfterMs = 5_000;
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

  it('does not remove a lock while a live process holds it', () => {
    fs.mkdirSync(lockPath());
    fs.utimesSync(lockPath(), agedSeconds(60), agedSeconds(60));
    fs.mkdirSync(writersDir());
    // process.ppid is alive for the whole test run: it stands for a live writer
    fs.writeFileSync(path.join(writersDir(), String(process.ppid)), String(Date.now()));

    expect(clearStaleDbLock(dbDir(), lockPath())).toBe(false);
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

    const started = Date.now();
    db.transaction(() => db.upsertFile(FILE));
    // the holder keeps the lock for 400 ms: the write must have waited for it
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(db.getFile('a.ts')).not.toBeNull();

    await new Promise<void>(resolve => holder.on('exit', () => resolve()));
    db.close();
  });

  it('opens after a live writer releases a lock held for longer than 8 seconds', async () => {
    const holder = spawn(process.execPath, ['-e', `
      const { Database } = require(process.argv[1]);
      const raw = new Database(process.argv[2]);
      raw.exec('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content_hash TEXT, language TEXT, file_size INTEGER, symbol_count INTEGER, indexed_at INTEGER)');
      raw.exec('BEGIN IMMEDIATE');
      console.log('locked');
      setTimeout(() => { raw.exec('COMMIT'); raw.close(); }, 9000);
    `, WASM_DRIVER, path.join(dbDir(), 'kirograph.db')]);
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', (d: Buffer) => { if (String(d).includes('locked')) resolve(); });
      holder.on('error', reject);
    });

    const started = Date.now();
    const db = new GraphDatabase(root);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8000);
    db.transaction(() => db.upsertFile(FILE));
    expect(db.getFile('a.ts')).not.toBeNull();
    db.close();

    await new Promise<void>(resolve => holder.on('exit', () => resolve()));
  }, 30_000);

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

describe('a lock that appears after the database was opened', () => {
  // These need their own imports: the file above predates them
  it('is cleared when the process that left it is gone, without waiting the full timeout', async () => {
    const { GraphDatabase } = await import('../../src/db/database');
    const fsx = await import('fs'); const pathx = await import('path'); const osx = await import('os');
    const { dbLockTiming } = await import('../../src/db/db-lock');
    const saved = { ...dbLockTiming };
    dbLockTiming.busyMs = 200; dbLockTiming.maxWaitMs = 20_000;
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'kg-late-'));
    const db = new GraphDatabase(dir);
    try {
      const lock = pathx.join(dir, '.kirograph', 'kirograph.db.lock');
      fsx.mkdirSync(lock);
      const old = new Date(Date.now() - 180_000);
      fsx.utimesSync(lock, old, old); // left by a process that died a minute ago
      const started = Date.now();
      expect(db.getRawDb().get('SELECT count(*) AS c FROM files').c).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fsx.existsSync(lock)).toBe(false);
    } finally {
      Object.assign(dbLockTiming, saved);
      db.close(); fsx.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is waited for while a live process holds it, and then reported', async () => {
    const { GraphDatabase } = await import('../../src/db/database');
    const fsx = await import('fs'); const pathx = await import('path'); const osx = await import('os');
    const { dbLockTiming } = await import('../../src/db/db-lock');
    const saved = { ...dbLockTiming };
    dbLockTiming.busyMs = 200; dbLockTiming.maxWaitMs = 1_000;
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'kg-late-'));
    const db = new GraphDatabase(dir);
    try {
      const kg = pathx.join(dir, '.kirograph');
      fsx.mkdirSync(pathx.join(kg, 'kirograph.db.lock'));
      fsx.mkdirSync(pathx.join(kg, 'db-writers'), { recursive: true });
      fsx.writeFileSync(pathx.join(kg, 'db-writers', String(process.ppid)), String(Date.now())); // a live writer
      const old = new Date(Date.now() - 180_000);
      fsx.utimesSync(pathx.join(kg, 'kirograph.db.lock'), old, old);
      expect(() => db.getRawDb().get('SELECT count(*) AS c FROM files')).toThrow(/locked/i);
      expect(fsx.existsSync(pathx.join(kg, 'kirograph.db.lock'))).toBe(true); // not taken from a live holder
    } finally {
      Object.assign(dbLockTiming, saved);
      fsx.rmSync(pathx.join(dir, '.kirograph', 'kirograph.db.lock'), { recursive: true, force: true });
      db.close(); fsx.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('asks for a restart when the dead process left a journal, which this connection cannot replay', async () => {
    const { GraphDatabase } = await import('../../src/db/database');
    const fsx = await import('fs'); const pathx = await import('path'); const osx = await import('os');
    const { dbLockTiming } = await import('../../src/db/db-lock');
    const saved = { ...dbLockTiming };
    dbLockTiming.busyMs = 200; dbLockTiming.maxWaitMs = 20_000;
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'kg-late-'));
    const db = new GraphDatabase(dir);
    try {
      const kg = pathx.join(dir, '.kirograph');
      fsx.mkdirSync(pathx.join(kg, 'kirograph.db.lock'));
      const old = new Date(Date.now() - 180_000);
      fsx.utimesSync(pathx.join(kg, 'kirograph.db.lock'), old, old);
      fsx.writeFileSync(pathx.join(kg, 'kirograph.db-journal'), 'half written');
      expect(() => db.getRawDb().get('SELECT count(*) AS c FROM files')).toThrow(/Restart KiroGraph/);
    } finally {
      Object.assign(dbLockTiming, saved);
      fsx.rmSync(pathx.join(dir, '.kirograph', 'kirograph.db-journal'), { force: true });
      db.close(); fsx.rmSync(dir, { recursive: true, force: true });
    }
  });
});
