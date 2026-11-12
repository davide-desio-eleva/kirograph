import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDatabase } from '../../src/db/database';

let root: string;
let db: GraphDatabase;
let sql: string[];

const turn = () => new Promise<void>(r => setImmediate(r));
const insert = (i: number) => db.getRawDb().run('INSERT INTO files (path, content_hash, language, file_size, symbol_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?)', [`f${i}.ts`, 'h', 'typescript', 1, 0, 1]);
const count = () => db.getRawDb().get('SELECT count(*) AS c FROM files').c as number;
const commits = () => sql.filter(s => /^COMMIT$/i.test(s.trim())).length;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-coalesce-'));
  db = new GraphDatabase(root);
  sql = [];
  const raw = (db.getRawDb() as any).raw;
  const exec = raw.exec.bind(raw);
  raw.exec = (...a: unknown[]) => { if (typeof a[0] === 'string') sql.push(a[0]); return exec(...a); };
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('write coalescing', () => {
  it('commits writes made in one tick together', async () => {
    await db.getRawDb().coalesce(async () => {
      for (let i = 0; i < 300; i++) insert(i);
      expect(count()).toBe(300); // visible to the connection that wrote them
    });
    expect(commits()).toBe(1);
    expect(count()).toBe(300);
  });

  it('commits when the event loop turns, so the lock is not held across a wait', async () => {
    await db.getRawDb().coalesce(async () => {
      insert(1); insert(2);
      await turn();
      expect(commits()).toBe(1);
      insert(3);
    });
    expect(commits()).toBe(2);
    expect(count()).toBe(3);
  });

  it('keeps one transaction across awaits that do not wait for I/O', async () => {
    await db.getRawDb().coalesce(async () => {
      insert(1);
      await Promise.resolve();
      await (async () => insert(2))();
      expect(commits()).toBe(0);
    });
    expect(commits()).toBe(1);
  });

  it('does nothing outside coalesce: every write is its own transaction', () => {
    insert(1); insert(2);
    expect(sql.some(s => /^BEGIN/i.test(s))).toBe(false);
    expect(count()).toBe(2);
  });

  it('lets an explicit transaction run, after committing the shared one', async () => {
    await db.getRawDb().coalesce(async () => {
      insert(1);
      expect(() => db.transaction(() => { insert(2); throw new Error('undo'); })).toThrow('undo');
      insert(3);
    });
    const paths = (db.getRawDb().all('SELECT path FROM files ORDER BY path') as Array<{ path: string }>).map(r => r.path);
    expect(paths).toEqual(['f1.ts', 'f3.ts']); // 2 was rolled back, 1 and 3 kept
  });

  it('runs a PRAGMA outside the shared transaction', async () => {
    await db.getRawDb().coalesce(async () => {
      insert(1);
      db.getRawDb().run('PRAGMA synchronous=NORMAL');
      expect(commits()).toBe(1);
    });
  });

  it('nests, and commits when the outermost call ends', async () => {
    await db.getRawDb().coalesce(async () => {
      await db.getRawDb().coalesce(async () => { insert(1); });
      expect(commits()).toBe(0);
      insert(2);
    });
    expect(commits()).toBe(1);
  });

  it('commits what was written when the function throws', async () => {
    await expect(db.getRawDb().coalesce(async () => { insert(1); throw new Error('x'); })).rejects.toThrow('x');
    expect(commits()).toBe(1);
    expect(count()).toBe(1);
  });

  it('is committed by close()', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-coalesce-'));
    const d = new GraphDatabase(other);
    let pending: Promise<void> | null = null;
    try {
      pending = d.getRawDb().coalesce(async () => { d.getRawDb().run('INSERT INTO files (path, content_hash, language, file_size, symbol_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?)', ['x.ts', 'h', 'typescript', 1, 0, 1]); await turn(); await turn(); });
      d.close();
      await pending.catch(() => { /* the connection is closed under it */ });
      const again = new GraphDatabase(other);
      expect(again.getRawDb().get('SELECT count(*) AS c FROM files').c).toBe(1);
      again.close();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
