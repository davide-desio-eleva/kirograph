#!/usr/bin/env node
/**
 * Graph parity: indexes a project from scratch with each engine and compares the databases table
 * by table, row by row, in rowid order (the order decides which candidate resolution picks, so it
 * must match too). Timestamps are left out.
 *
 *   node test/rust/db-parity.js <projectRoot> [--keep]
 *
 * The project's .kirograph/kirograph.db is rebuilt; the project must be initialised already.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { Database } = require('node-sqlite3-wasm');

const root = path.resolve(process.argv[2] ?? '.');
const cli = path.join(__dirname, '..', '..', 'dist', 'bin', 'kirograph.js');
const dbFile = path.join(root, '.kirograph', 'kirograph.db');

const QUERIES = {
  files: 'SELECT path, content_hash, language, file_size, symbol_count FROM files ORDER BY path',
  nodes: `SELECT rowid, id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column,
            docstring, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators, type_parameters,
            complexity_cyclomatic, complexity_cognitive, complexity_halstead, maintainability_index, nesting_depth
          FROM nodes ORDER BY rowid`,
  edges: 'SELECT id, source, target, kind, metadata, line, column, confidence, confidence_score FROM edges ORDER BY id',
  unresolved_refs: 'SELECT id, source_id, ref_name, ref_kind, file_path, line, column, metadata, attempted_strategies FROM unresolved_refs ORDER BY id',
  route_mounts: 'SELECT id, file_path, plugin_name, imported_name, specifier, prefix, line, inline_start, inline_end FROM route_mounts ORDER BY id',
  nodes_fts: 'SELECT rowid, id, name, qualified_name, docstring, signature FROM nodes_fts ORDER BY rowid',
};

function index(engine) {
  for (const f of fs.readdirSync(path.dirname(dbFile))) {
    if (f.startsWith('kirograph.db')) fs.rmSync(path.join(path.dirname(dbFile), f), { recursive: true, force: true });
  }
  const t = Date.now();
  execFileSync(process.execPath, [cli, 'index', root, '--force'], { env: { ...process.env, KIROGRAPH_ENGINE: engine }, stdio: 'ignore' });
  const ms = Date.now() - t;
  const db = new Database(dbFile, { readOnly: true });
  const dump = {};
  for (const [table, sql] of Object.entries(QUERIES)) dump[table] = db.all(sql);
  db.close();
  return { dump, ms };
}

const node = index('node');
const rust = index('rust');
let failed = false;
for (const table of Object.keys(QUERIES)) {
  const a = node.dump[table], b = rust.dump[table];
  let diff = a.length !== b.length ? `row count ${a.length} ≠ ${b.length}` : null;
  let shown = 0;
  for (let i = 0; i < Math.min(a.length, b.length) && shown < 5; i++) {
    const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
    if (x !== y) {
      if (shown === 0) console.log(`${table}: first differing rows`);
      console.log(`  node: ${x.slice(0, 400)}\n  rust: ${y.slice(0, 400)}`);
      shown++;
      diff ??= 'rows differ';
    }
  }
  console.log(`${diff ? '✗' : '✓'} ${table.padEnd(16)} ${a.length} rows${diff ? ` — ${diff}` : ''}`);
  if (diff) failed = true;
}
console.log(`index time: node ${node.ms} ms, rust ${rust.ms} ms (${(node.ms / rust.ms).toFixed(1)}×)`);
process.exit(failed ? 1 : 0);
