import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDatabase } from '../../src/db/database';
import type { Node } from '../../src/types';

let root: string;
let db: GraphDatabase;

const node = (file: string, i: number): Node => ({
  id: `function:${file}:${i}`,
  kind: 'function',
  name: `fn_${file.replace(/\W/g, '_')}_${i}`,
  qualifiedName: `${file}::fn${i}`,
  filePath: file,
  language: 'typescript',
  startLine: i,
  endLine: i + 1,
  startColumn: 0,
  endColumn: 1,
  updatedAt: 1,
});

const writeFile = (file: string, count: number) => {
  db.transaction(() => {
    db.deleteNodesByFile(file);
    for (let i = 0; i < count; i++) db.upsertNode(node(file, i));
  });
};

const matchRowids = (term: string): number[] =>
  db.getRawDb().all('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?', [`"${term}"`]).map((r: any) => r.rowid);

/**
 * State of the FTS index. nodes_fts is an external-content table, so SELECTing its columns reads
 * the nodes table and says nothing about the index. Two checks do: FTS5's own integrity-check
 * against the content table, and a MATCH for every node that must return that node's rowid.
 */
const ftsState = () => {
  const raw = db.getRawDb();
  let integrity = 'ok';
  try { raw.exec("INSERT INTO nodes_fts(nodes_fts, rank) VALUES('integrity-check', 1)"); } catch (e: any) { integrity = e.message; }
  const nodes: Array<{ rowid: number; name: string }> = raw.all('SELECT rowid, name FROM nodes');
  const wrong = nodes.filter(n => {
    const hits = matchRowids(n.name);
    return !(hits.length === 1 && hits[0] === n.rowid);
  }).length;
  return { nodes: nodes.length, indexedWrongly: wrong, integrity };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-fts-'));
  db = new GraphDatabase(root);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nodes_fts', () => {
  it('indexes every node under its own rowid after files are written and rewritten', () => {
    writeFile('a.ts', 5);
    writeFile('b.ts', 7);
    writeFile('a.ts', 3); // a file that changed: its old nodes go, new ones come
    writeFile('c.ts', 4);
    writeFile('b.ts', 9);

    const s = ftsState();
    expect(s.nodes).toBe(3 + 9 + 4);
    expect(s.indexedWrongly).toBe(0);
    expect(s.integrity).toBe('ok');
  });

  it('removes the FTS entries of a deleted file and only those', () => {
    writeFile('a.ts', 4);
    writeFile('b.ts', 4);
    expect(matchRowids('fn_a_ts_1')).toHaveLength(1);

    db.transaction(() => db.deleteNodesByFile('a.ts'));

    expect(matchRowids('fn_a_ts_1')).toHaveLength(0);
    expect(matchRowids('fn_b_ts_1')).toHaveLength(1);
    const s = ftsState();
    expect(s.nodes).toBe(4);
    expect(s.indexedWrongly).toBe(0);
    expect(s.integrity).toBe('ok');
  });

  it('stays consistent through many rewrites of the same files', () => {
    for (let round = 0; round < 15; round++) {
      writeFile('a.ts', 6 + (round % 3));
      writeFile('b.ts', 5 + (round % 4));
    }
    const s = ftsState();
    expect(s.indexedWrongly).toBe(0);
    expect(s.integrity).toBe('ok');
  });
});

describe('FTS migration', () => {
  it('rebuilds an index whose entries were not under the node rowids, once', () => {
    writeFile('a.ts', 4);
    writeFile('b.ts', 4);

    // What an older version could leave behind: index entries under other rowids, no migration 3
    const raw = db.getRawDb();
    raw.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all')");
    raw.exec(`INSERT INTO nodes_fts (rowid, id, name, qualified_name, docstring, signature)
              SELECT rowid + 1000, id, name, qualified_name, COALESCE(docstring, ''), COALESCE(signature, '') FROM nodes`);
    raw.run('DELETE FROM schema_versions WHERE version = 3');
    const broken = ftsState();
    expect(broken.indexedWrongly).toBeGreaterThan(0);
    expect(broken.integrity).not.toBe('ok');
    db.close();

    db = new GraphDatabase(root); // opening runs the migration

    const s = ftsState();
    expect(s.indexedWrongly).toBe(0);
    expect(s.integrity).toBe('ok');
    expect(db.getRawDb().get('SELECT max(version) v FROM schema_versions').v).toBe(3);
  });
});
