import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDatabase } from '../../src/db/database';
import { recoverHotJournal, replayJournal } from '../../src/db/journal-recovery';

let work: string;
beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-journal-')); });
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

const ins = (db: GraphDatabase, tag: string, i: number, blob = '') =>
  db.getRawDb().run('INSERT INTO edges (source, target, kind, metadata) VALUES (?, ?, ?, ?)', [`${tag}${i}`, `t${i}`, 'calls', blob]);
const edgeCount = (db: GraphDatabase) => db.getRawDb().get('SELECT count(*) AS c FROM edges').c as number;

/**
 * The state a kill -9 leaves: the files of a database in the middle of a transaction, copied while
 * it is open, without the lock directory the dead process would have left or its marker.
 */
function crashedProject(baseline: number, uncommitted: number): string {
  const live = path.join(work, 'live');
  const db = new GraphDatabase(live);
  const raw = db.getRawDb();
  raw.run('BEGIN');
  for (let i = 0; i < baseline; i++) ins(db, 'base', i);
  raw.run('COMMIT');
  raw.run('PRAGMA cache_size=20'); // a tiny cache: modified pages are written to the file while the journal holds the originals
  raw.run('BEGIN');
  for (let i = 0; i < uncommitted; i++) ins(db, 'new', i, 'x'.repeat(200));
  const crashed = path.join(work, 'crashed');
  fs.mkdirSync(path.join(crashed, '.kirograph'), { recursive: true });
  for (const f of ['kirograph.db', 'kirograph.db-journal']) {
    fs.copyFileSync(path.join(live, '.kirograph', f), path.join(crashed, '.kirograph', f));
  }
  raw.run('ROLLBACK');
  db.close();
  return crashed;
}

describe('hot journal recovery', () => {
  it('rolls back a transaction a killed process left half written', { timeout: 60_000 }, () => {
    const dir = crashedProject(500, 30000);
    const kg = path.join(dir, '.kirograph');
    expect(fs.existsSync(path.join(kg, 'kirograph.db-journal'))).toBe(true);
    expect(fs.statSync(path.join(kg, 'kirograph.db')).size).toBeGreaterThan(1_000_000); // new pages did reach the file

    const db = new GraphDatabase(dir); // would wait for the busy timeout without recovery
    try {
      expect(edgeCount(db)).toBe(500);
      expect(db.getRawDb().all('PRAGMA quick_check')).toEqual([{ quick_check: 'ok' }]);
      expect(fs.existsSync(path.join(kg, 'kirograph.db-journal'))).toBe(false);
      // The state it found is kept
      const backups = fs.readdirSync(path.join(kg, 'recovery'));
      expect(backups).toHaveLength(1);
      expect(fs.existsSync(path.join(kg, 'recovery', backups[0], 'kirograph.db-journal'))).toBe(true);
    } finally { db.close(); }
  });

  it('leaves a journal alone while a process holds the lock', { timeout: 60_000 }, () => {
    const dir = crashedProject(100, 20000);
    const kg = path.join(dir, '.kirograph');
    fs.mkdirSync(path.join(kg, 'kirograph.db.lock'));
    expect(recoverHotJournal(path.join(kg, 'kirograph.db'), path.join(kg, 'kirograph.db.lock'))).toBeNull();
    expect(fs.existsSync(path.join(kg, 'kirograph.db-journal'))).toBe(true);
  });

  it('does nothing without a journal', () => {
    const db = new GraphDatabase(path.join(work, 'plain'));
    db.close();
    const kg = path.join(work, 'plain', '.kirograph');
    expect(recoverHotJournal(path.join(kg, 'kirograph.db'), path.join(kg, 'kirograph.db.lock'))).toBeNull();
  });

  it('removes a journal whose header was never written', () => {
    const dir = crashedProject(50, 10);
    const kg = path.join(dir, '.kirograph');
    fs.writeFileSync(path.join(kg, 'kirograph.db-journal'), Buffer.alloc(512));
    const before = fs.readFileSync(path.join(kg, 'kirograph.db'));
    const result = recoverHotJournal(path.join(kg, 'kirograph.db'), path.join(kg, 'kirograph.db.lock'));
    expect(result?.pagesRestored).toBe(0);
    expect(fs.readFileSync(path.join(kg, 'kirograph.db')).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(kg, 'kirograph.db-journal'))).toBe(false);
  });

  it('refuses a journal it does not understand, changes nothing, and says what to do', () => {
    const dir = crashedProject(50, 10);
    const kg = path.join(dir, '.kirograph');
    fs.writeFileSync(path.join(kg, 'kirograph.db-journal'), Buffer.from('this is not a journal, but it is not empty'));
    const before = fs.readFileSync(path.join(kg, 'kirograph.db'));
    expect(() => new GraphDatabase(dir)).toThrow(/could not roll it back.*sqlite3/s);
    expect(fs.readFileSync(path.join(kg, 'kirograph.db')).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(kg, 'kirograph.db.lock'))).toBe(false); // not left behind
    expect(fs.readdirSync(path.join(kg, 'recovery'))).toHaveLength(1);
  });

  it('replays nothing for an empty journal', () => {
    const file = path.join(work, 'x.db');
    fs.writeFileSync(file, Buffer.alloc(4096));
    expect(replayJournal(file, Buffer.alloc(0))).toBe(0);
  });
});
