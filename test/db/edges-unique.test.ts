import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDatabase } from '../../src/db/database';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-edges-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const edge = (db: GraphDatabase, source: string, target: string, kind: string, line: number | null = null, column: number | null = null) =>
  db.getRawDb().run('INSERT INTO edges (source, target, kind, line, "column", metadata) VALUES (?, ?, ?, ?, ?, ?)', [source, target, kind, line, column, 'm']);
const count = (db: GraphDatabase, where = '1=1') => db.getRawDb().get(`SELECT count(*) AS c FROM edges WHERE ${where}`).c as number;
const sizeOf = () => fs.statSync(path.join(root, '.kirograph', 'kirograph.db')).size;

/** A database as an older version left it: no unique key, schema version 3 */
function downgrade(db: GraphDatabase): void {
  const raw = db.getRawDb();
  raw.run('DROP INDEX IF EXISTS idx_edges_unique');
  raw.run('DELETE FROM schema_versions WHERE version >= 4');
}

describe('edges unique key', () => {
  it('ignores an edge that is already there, with or without a line', () => {
    const db = new GraphDatabase(root);
    try {
      const e = { source: 'a', target: 'b', kind: 'declared_in' as const };
      db.insertEdge(e); db.insertEdge(e); db.insertEdge(e);
      db.insertEdge({ ...e, kind: 'calls', line: 3, column: 4 });
      db.insertEdge({ ...e, kind: 'calls', line: 3, column: 4 });
      db.insertEdge({ ...e, kind: 'calls', line: 9, column: 4 }); // another call site is another edge
      expect(count(db)).toBe(3);
    } finally { db.close(); }
  });

  it('removes the copies when an older database is opened, and keeps the distinct edges', { timeout: 60_000 }, () => {
    let db = new GraphDatabase(root);
    downgrade(db);
    db.getRawDb().run('BEGIN');
    for (let pass = 0; pass < 40; pass++) {
      for (let i = 0; i < 100; i++) {
        edge(db, `dep${i}`, `manifest${i % 7}`, 'declared_in');   // NULL line: what the security passes add
        edge(db, `dep${i}`, `dep${(i + 1) % 100}`, 'depends_on');
      }
    }
    edge(db, 'f', 'g', 'calls', 10, 2); edge(db, 'f', 'g', 'calls', 20, 2); edge(db, 'f', 'g', 'calls', 10, 2);
    db.getRawDb().run('COMMIT');
    expect(count(db)).toBe(8003);
    db.close();

    db = new GraphDatabase(root);
    try {
      expect(count(db)).toBe(200 + 2);
      expect(count(db, "kind = 'calls'")).toBe(2);
      expect(db.getRawDb().get("SELECT count(*) AS c FROM sqlite_master WHERE name = 'idx_edges_unique'").c).toBe(1);
      expect(db.getRawDb().get('SELECT max(version) AS v FROM schema_versions').v).toBe(4);
    } finally { db.close(); }
  });

  it('leaves other tables alone, and shrinks the file when most of it was copies', { timeout: 120_000 }, () => {
    let db = new GraphDatabase(root);
    db.applyMemorySchema();
    downgrade(db);
    const raw = db.getRawDb();
    raw.run('BEGIN');
    for (let pass = 0; pass < 700; pass++) for (let i = 0; i < 300; i++) edge(db, `dep${i}`, `manifest${i % 7}`, 'declared_in');
    raw.run('COMMIT');
    const memTables = raw.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mem_%'").map((r: any) => r.name as string);
    expect(memTables.length).toBeGreaterThan(0);
    const memRows = new Map<string, number>();
    for (const t of memTables) memRows.set(t, raw.get(`SELECT count(*) AS c FROM ${t}`).c);
    db.close();
    const before = sizeOf();
    expect(before).toBeGreaterThan(20 * 1024 * 1024);

    db = new GraphDatabase(root);
    try {
      expect(count(db)).toBe(300);
      for (const [t, n] of memRows) expect(db.getRawDb().get(`SELECT count(*) AS c FROM ${t}`).c).toBe(n);
      expect(db.getRawDb().all('PRAGMA quick_check')).toEqual([{ quick_check: 'ok' }]);
    } finally { db.close(); }
    expect(sizeOf()).toBeLessThan(before / 10);
  });
});
