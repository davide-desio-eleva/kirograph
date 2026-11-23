#!/usr/bin/env node
/**
 * Extraction parity: every file of a project that the Rust engine parses is extracted by both
 * engines, and the results are compared field by field (timestamps aside).
 *
 *   node test/rust/extract-parity.js <projectRoot> [--max-diffs N] [--complexity] [--lang a,b]
 *
 * --lang compares those languages (with a grammar compiled in), native or not yet: how a
 * language is checked before it is listed in NATIVE_LANGUAGES (native/kirograph-rust/src/lib.rs).
 *
 * Exits 1 when any file differs. Requires `npm run build` and the native module
 * (cd native/kirograph-rust && npm run build).
 */
const path = require('path');
const fs = require('fs');

const dist = path.join(__dirname, '..', '..', 'dist');
const { extractFile } = require(path.join(dist, 'extraction', 'extractor.js'));
const { detectLanguage } = require(path.join(dist, 'extraction', 'languages.js'));
const { scanDirectory } = require(path.join(dist, 'sync', 'index.js'));
const { loadConfig } = require(path.join(dist, 'config.js'));
const native = require(path.join(__dirname, '..', '..', 'native', 'kirograph-rust'));

const args = process.argv.slice(2);
const root = path.resolve(args[0] ?? '.');
const maxDiffs = Number(args[args.indexOf('--max-diffs') + 1]) || 20;
const complexity = args.includes('--complexity');
const only = args.includes('--lang') ? args[args.indexOf('--lang') + 1].split(',') : null;

function normalize(f) {
  if (!f) return f;
  const strip = o => {
    const c = { ...o };
    delete c.updatedAt;
    // Stored as 0/1: a missing flag and false are the same row
    if ('kind' in c && 'qualifiedName' in c) for (const k of ['isExported', 'isAsync', 'isStatic', 'isAbstract']) c[k] = !!c[k];
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
    return c;
  };
  return {
    filePath: f.filePath, language: f.language, contentHash: f.contentHash, fileSize: f.fileSize,
    nodes: f.nodes.map(strip),
    edges: f.edges.map(strip),
    unresolvedRefs: f.unresolvedRefs.map(strip),
    routeMounts: (f.routeMounts ?? []).map(strip),
  };
}

function firstDiff(a, b, where = '') {
  if (typeof a !== typeof b) return `${where}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) && a.length !== b.length) return `${where}.length: ${a.length} ≠ ${b.length}`;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], `${where}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${where}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
}

(async () => {
  const nativeLangs = new Set(only ?? native.nativeLanguages());
  const config = await loadConfig(root);
  const files = (await scanDirectory(root, config)).filter(f => nativeLangs.has(detectLanguage(f)));
  let same = 0, diffs = 0;
  const byLang = {};
  for (const file of files) {
    const lang = detectLanguage(file);
    const content = fs.readFileSync(file);
    if (content.length > config.maxFileSize) continue;
    let ts, rs;
    try { ts = await extractFile(file, root, content, { enableComplexity: complexity, maxFileSize: config.maxFileSize }); }
    catch (e) { continue; } // the TypeScript engine failed on it: nothing to compare
    const json = native.extractFileJson(file, root, lang, complexity);
    rs = json ? JSON.parse(json) : null;
    const d = firstDiff(normalize(ts), normalize(rs), path.relative(root, file));
    byLang[lang] ??= { same: 0, diff: 0 };
    if (d) {
      diffs++; byLang[lang].diff++;
      if (diffs <= maxDiffs) console.log(`DIFF ${d}`);
    } else { same++; byLang[lang].same++; }
  }
  for (const [lang, c] of Object.entries(byLang)) console.log(`  ${lang.padEnd(12)} ${c.same} same, ${c.diff} different`);
  console.log(`${same} identical, ${diffs} different (${files.length} files)`);
  process.exit(diffs ? 1 : 0);
})();
