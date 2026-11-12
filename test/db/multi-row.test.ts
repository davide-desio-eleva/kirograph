import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDatabase } from '../../src/db/database';
import type { Node, Edge } from '../../src/types';

const node = (i: number, extra: Partial<Node> = {}): Node => ({
  id: `function:f.ts:${i}`,
  kind: 'function',
  name: `fn_${i}`,
  qualifiedName: `f.ts::fn_${i}`,
  filePath: 'f.ts',
  language: 'typescript',
  startLine: i,
  endLine: i + 2,
  startColumn: 1,
  endColumn: 9,
  docstring: i % 3 === 0 ? `doc ${i}` : undefined,
  signature: i % 4 === 0 ? `fn_${i}(a: number)` : undefined,
  isExported: i % 2 === 0,
  decorators: i % 5 === 0 ? ['d1', 'd2'] : undefined,
  complexityCyclomatic: i % 7 === 0 ? i : undefined,
  updatedAt: 1000 + i,
  ...extra,
});

const edge = (i: number): Edge => ({
  source: `function:f.ts:${i}`,
  target: `function:f.ts:${(i + 1) % 50}`,
  kind: i % 2 ? 'calls' : 'references',
  metadata: i % 3 === 0 ? { argKind: 'dynamic', n: i } : undefined,
  line: i % 4 === 0 ? undefined : i,
  confidence: i % 5 === 0 ? 'inferred' : undefined,
  confidenceScore: i % 5 === 0 ? 0.8 : undefined,
});

const ref = (i: number) => ({
  sourceId: `function:f.ts:${i}`, refName: `callee_${i}`, refKind: i % 2 ? 'function' : 'import',
  line: i, column: i % 3 === 0 ? undefined : 2, metadata: i % 4 === 0 ? { rootName: 'x' } : undefined,
});

function withDb<T>(fn: (db: GraphDatabase) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-multi-'));
  const db = new GraphDatabase(root);
  try { return fn(db); } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

/** Row content without the rowid, so two databases can be compared. */
const dump = (db: GraphDatabase, sql: string) => JSON.stringify(db.getRawDb().all(sql));

// Counts around the group sizes (powers of two) and around the parameter limit per statement
const COUNTS = [0, 1, 2, 3, 31, 32, 33, 127, 128, 129, 300];

describe('upsertNodes', () => {
  for (const n of COUNTS) {
    it(`stores ${n} nodes exactly as ${n} upsertNode calls do, and indexes them in FTS`, () => {
      const nodes = Array.from({ length: n }, (_, i) => node(i));
      const single = withDb(db => { db.transaction(() => nodes.forEach(x => db.upsertNode(x))); return dump(db, 'SELECT * FROM nodes ORDER BY id'); });
      const multi = withDb(db => {
        db.transaction(() => db.upsertNodes(nodes));
        const raw = db.getRawDb();
        if (n > 0) {
          raw.exec("INSERT INTO nodes_fts(nodes_fts, rank) VALUES('integrity-check', 1)"); // throws if the index is wrong
          expect(raw.all('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?', ['"fn_1"']).length).toBe(n > 1 ? 1 : 0);
        }
        return dump(db, 'SELECT * FROM nodes ORDER BY id');
      });
      // rowids may differ in order; the rows themselves must not
      expect(multi).toBe(single);
    });
  }

  it('keeps the later node when the same id appears twice, like INSERT OR REPLACE', () => {
    withDb(db => {
      db.transaction(() => db.upsertNodes([node(1, { name: 'first' }), node(2), node(1, { name: 'second' })]));
      expect(db.getNode('function:f.ts:1')!.name).toBe('second');
      expect(db.getRawDb().get('SELECT count(*) c FROM nodes').c).toBe(2);
    });
  });
});

describe('insertEdges', () => {
  for (const n of COUNTS) {
    it(`stores ${n} edges exactly as ${n} insertEdge calls do`, () => {
      const edges = Array.from({ length: n }, (_, i) => edge(i));
      const q = 'SELECT source, target, kind, metadata, line, column, confidence, confidence_score FROM edges ORDER BY id';
      const single = withDb(db => { db.transaction(() => edges.forEach(e => db.insertEdge(e))); return dump(db, q); });
      const multi = withDb(db => { db.transaction(() => db.insertEdges(edges)); return dump(db, q); });
      expect(multi).toBe(single);
    });
  }
});

describe('insertUnresolvedRefs', () => {
  for (const n of COUNTS) {
    it(`stores ${n} references exactly as ${n} insertUnresolvedRef calls do`, () => {
      const refs = Array.from({ length: n }, (_, i) => ref(i));
      const q = 'SELECT source_id, ref_name, ref_kind, file_path, line, column, metadata FROM unresolved_refs ORDER BY id';
      const single = withDb(db => {
        db.transaction(() => refs.forEach(r => db.insertUnresolvedRef(r.sourceId, r.refName, r.refKind, 'f.ts', r.line, r.column, r.metadata)));
        return dump(db, q);
      });
      const multi = withDb(db => { db.transaction(() => db.insertUnresolvedRefs('f.ts', refs)); return dump(db, q); });
      expect(multi).toBe(single);
    });
  }
});
