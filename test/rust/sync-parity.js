#!/usr/bin/env node
/**
 * Sync parity: two copies of a git project are indexed by the TypeScript engine, changed the same
 * way (a file edited, one added, one removed), then synced, one by each engine. The databases
 * must hold the same rows, and the two syncs must report the same changes.
 *
 *   node test/rust/sync-parity.js <gitProjectRoot> <scratchDir>
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const src = path.resolve(process.argv[2]);
const scratch = path.resolve(process.argv[3]);
const cli = path.join(__dirname, '..', '..', 'dist', 'bin', 'kirograph.js');

const QUERIES = {
  files: 'SELECT path, content_hash, language, file_size, symbol_count FROM files ORDER BY path',
  nodes: `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column,
            docstring, signature, visibility, is_exported, is_async, is_static, is_abstract FROM nodes ORDER BY id`,
  edges: 'SELECT source, target, kind, metadata, line, column, confidence, confidence_score FROM edges ORDER BY source, target, kind, line, column',
  unresolved_refs: 'SELECT source_id, ref_name, ref_kind, file_path, line, column, metadata, attempted_strategies FROM unresolved_refs ORDER BY source_id, ref_name, line, column',
  nodes_fts: 'SELECT id, name, qualified_name, docstring, signature FROM nodes_fts ORDER BY id',
};

function run(dir, engine, ...args) {
  return execFileSync(process.execPath, [cli, ...args, dir], { env: { ...process.env, KIROGRAPH_ENGINE: engine }, encoding: 'utf8', maxBuffer: 1 << 30 });
}

function prepare(name) {
  const dir = path.join(scratch, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(src, dir, { recursive: true, filter: p => !p.includes(`${path.sep}.kirograph`) });
  run(dir, 'node', 'init');
  run(dir, 'node', 'index');
  return dir;
}

/** The same changes in each copy: the first source file edited, the second removed, one added. */
function mutate(dir, sources) {
  const [edit, remove] = sources;
  fs.appendFileSync(path.join(dir, edit), '\n\nfunction kirographSyncParityAdded(a) { return helper(a) }\n');
  fs.rmSync(path.join(dir, remove));
  const ext = path.extname(edit);
  fs.writeFileSync(path.join(dir, path.dirname(edit), `kg_parity_new${ext}`), fs.readFileSync(path.join(dir, edit)));
}

function dump(dir) {
  const db = new DatabaseSync(path.join(dir, '.kirograph', 'kirograph.db'), { readOnly: true });
  const out = {};
  for (const [t, sql] of Object.entries(QUERIES)) out[t] = db.prepare(sql).all().map(r => ({ ...r }));
  db.close();
  return out;
}

const sources = execFileSync('git', ['ls-files', '*.js', '*.ts', '*.py', '*.go', '*.java', '*.php', '*.rb'], { cwd: src, encoding: 'utf8' })
  .split('\n').filter(Boolean).slice(0, 2);
if (sources.length < 2) { console.error('need two source files'); process.exit(2); }

const a = prepare('sync-node');
const b = prepare('sync-rust');
mutate(a, sources);
mutate(b, sources);
const outA = run(a, 'node', 'sync');
const outB = run(b, 'rust', 'sync');
// The counts the sync reports (durations and progress lines aside)
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '').split(/[\r\n]+/).filter(l => /^\s+[a-z ]+:\s+\d+$/.test(l)).join('\n');
console.log(`node sync: ${strip(outA).split('\n').slice(-3).join(' | ')}`);
console.log(`rust sync: ${strip(outB).split('\n').slice(-3).join(' | ')}`);

const da = dump(a), db = dump(b);
let failed = strip(outA) !== strip(outB);
if (failed) console.log('✗ sync reports differ');
for (const t of Object.keys(QUERIES)) {
  const x = JSON.stringify(da[t]), y = JSON.stringify(db[t]);
  const ok = x === y;
  if (!ok) {
    failed = true;
    for (let i = 0; i < Math.max(da[t].length, db[t].length); i++) {
      if (JSON.stringify(da[t][i]) !== JSON.stringify(db[t][i])) {
        console.log(`  node: ${JSON.stringify(da[t][i])?.slice(0, 300)}\n  rust: ${JSON.stringify(db[t][i])?.slice(0, 300)}`);
        break;
      }
    }
  }
  console.log(`${ok ? '✓' : '✗'} ${t.padEnd(16)} ${da[t].length} / ${db[t].length} rows`);
}
process.exit(failed ? 1 : 0);
