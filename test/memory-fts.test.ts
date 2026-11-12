import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDatabase } from '../src/db/database';
import { MemoryDatabase, ftsMatchQuery } from '../src/memory/database';

describe('ftsMatchQuery', () => {
  it('quotes each word and makes the last a prefix', () => {
    expect(ftsMatchQuery('terraform state lock')).toBe('"terraform" "state" "lock"*');
  });
  it('drops punctuation that is not part of a word, and bare operators', () => {
    expect(ftsMatchQuery('a#b <c> | d; e=f AND g OR h NOT i')).toBe('"a" "b" "c" "d" "e" "f" "g" "h" "i"*');
  });
  it('keeps non-ASCII letters and underscores', () => {
    expect(ftsMatchQuery('città module_name')).toBe('"città" "module_name"*');
  });
  it('is null when there is no word', () => {
    expect(ftsMatchQuery('#<>|;= ')).toBeNull();
    expect(ftsMatchQuery('')).toBeNull();
  });
});

describe('MemoryDatabase.searchFTS', () => {
  let root: string; let db: GraphDatabase; let mem: MemoryDatabase;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-memfts-'));
    db = new GraphDatabase(root);
    mem = new MemoryDatabase(db.getRawDb());
    mem.initialize();
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  it('does not fail on characters that are not words, and finds the observation', () => {
    mem.insertObservation('helm release uses values.yaml with replicas=3 # see ticket <INFRA-12>', { kind: 'note' });
    for (const q of ['replicas=3 #', 'ticket <INFRA', 'values.yaml | helm', 'helm; DROP TABLE x', "it's helm", '"helm"', 'helm*']) {
      expect(() => mem.searchFTS(q), q).not.toThrow();
    }
    expect(mem.searchFTS('replicas=3 # see').length).toBeGreaterThan(0);
  });
});

describe('stale sessions', () => {
  let root: string; let db: GraphDatabase; let mem: MemoryDatabase;
  const HOUR = 3_600_000;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-memsess-'));
    db = new GraphDatabase(root);
    mem = new MemoryDatabase(db.getRawDb());
    mem.initialize();
    const raw = db.getRawDb();
    const now = Date.now();
    raw.run('INSERT INTO mem_sessions (id, started_at) VALUES (?, ?)', ['in-use', now - 5 * HOUR]);   // long, but still active
    raw.run('INSERT INTO mem_sessions (id, started_at) VALUES (?, ?)', ['abandoned', now - 5 * HOUR]);
    raw.run('INSERT INTO mem_sessions (id, started_at) VALUES (?, ?)', ['fresh', now - 60_000]);
    raw.run('INSERT INTO mem_observations (id, session_id, content, kind, created_at) VALUES (?, ?, ?, ?, ?)', ['o1', 'in-use', 'recent work', 'note', now - 60_000]);
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = () => (db.getRawDb().all('SELECT id FROM mem_sessions WHERE ended_at IS NULL ORDER BY id') as Array<{ id: string }>).map(r => r.id);

  it('counts a session that nobody has used for the timeout, and not one that is in use', () => {
    expect(mem.countStaleSessionsOlderThan(2 * HOUR)).toBe(1);
    expect(open()).toEqual(['abandoned', 'fresh', 'in-use']); // counting closed nothing
  });

  it('closes only the abandoned one', () => {
    expect(mem.closeStaleSessionsOlderThan(2 * HOUR)).toBe(1);
    expect(open()).toEqual(['fresh', 'in-use']);
  });
});
