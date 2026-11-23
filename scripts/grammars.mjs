#!/usr/bin/env node
/**
 * Builds the tree-sitter grammars KiroGraph parses with, from the sources listed in
 * grammars/grammars.json, and checks that each built grammar is the one the manifest records.
 *
 *   node scripts/grammars.mjs build [lang...]   fetch the sources, compile the WASM files into
 *                                               src/extraction/wasm/, record their fingerprints
 *   node scripts/grammars.mjs check             compare every WASM file with its fingerprint
 *   node scripts/grammars.mjs sources [lang...] fetch and prepare the sources only (generated parser,
 *                                               shared includes), and list them in
 *                                               grammars/.sources/native.json for the native engine
 *
 * The manifest is shared with the native engine, which compiles the same sources: two builds of
 * the same language have the same fingerprint (ABI, node kinds, fields, parse states), so both
 * engines read every file into the same syntax tree.
 *
 * Compiling to WASM needs emscripten: tree-sitter-cli uses `emcc` when it is installed, otherwise
 * Docker (or Podman) with the emscripten/emsdk image.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'grammars', 'grammars.json');
const cacheDir = join(root, 'grammars', '.sources');
const wasmDir = join(root, 'src', 'extraction', 'wasm');
const require = createRequire(import.meta.url);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cli = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tree-sitter.cmd' : 'tree-sitter');

const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'));
export const wasmPath = (lang) => join(wasmDir, `tree-sitter-${lang}.wasm`);

/** The package's sources at the pinned version, downloaded once into grammars/.sources/. */
async function fetchSources(spec) {
  const key = (spec.github ?? spec.package).replace(/[/@]/g, '_') + '@' + spec.version;
  const dest = join(cacheDir, key);
  if (existsSync(join(dest, '.complete'))) return dest;
  rmSync(dest, { recursive: true, force: true });
  const work = mkdtempSync(join(tmpdir(), 'kg-grammar-'));
  try {
    let top;
    if (spec.github) {
      const res = await fetch(`https://codeload.github.com/${spec.github}/tar.gz/${spec.version}`);
      if (!res.ok) throw new Error(`${spec.github}@${spec.version}: HTTP ${res.status}`);
      writeFileSync(join(work, 'src.tgz'), Buffer.from(await res.arrayBuffer()));
      execFileSync('tar', ['xzf', 'src.tgz'], { cwd: work });
      top = join(work, `${spec.github.split('/')[1]}-${spec.version.replace(/^v/, '')}`);
    } else {
      const out = execFileSync(npm, ['pack', '--silent', `${spec.package}@${spec.version}`], { cwd: work, encoding: 'utf8', shell: process.platform === 'win32' });
      execFileSync('tar', ['xzf', out.trim().split('\n').pop()], { cwd: work });
      top = join(work, 'package');
    }
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(top, dest);
    writeFileSync(join(dest, '.complete'), '');
    return dest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The CLI compiles in Docker with only the grammar's folder mounted, so a scanner that includes a
 * file shared by several grammars of the package (`../../common/scanner.h`, in typescript, php,
 * ocaml) cannot see it. The shared file is copied next to the sources, and the include pointed at
 * the copy. The parse tables are not touched.
 */
function inlineParentIncludes(srcDir) {
  for (const name of readdirSync(srcDir)) {
    if (!/\.(c|h|cc)$/.test(name)) continue;
    const file = join(srcDir, name);
    const text = readFileSync(file, 'utf8');
    const rewritten = text.replace(/#include "((?:\.\.\/)+[^"]+)"/g, (_m, rel) => {
      const copy = 'shared_' + rel.replace(/^(\.\.\/)+/, '').replace(/\//g, '_');
      copyFileSync(join(srcDir, rel), join(srcDir, copy));
      return `#include "${copy}"`;
    });
    if (rewritten !== text) writeFileSync(file, rewritten);
  }
}

/**
 * The WASM runtime gives a scanner a few C library functions only: no stdio, no exit, no strchr.
 * A scanner that reports running out of memory (`fprintf(stderr, …); exit(1);`, Swift's) would not
 * link: in a WASM build that report is dropped and the exit becomes a trap. strchr (Perl's) gets a
 * plain implementation. Nothing else in the scanner changes.
 */
function shimStdio(srcDir) {
  const file = join(srcDir, 'scanner.c');
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  if (text.startsWith('/* kirograph-wasm-shim */')) return;
  const stdio = /\b(stderr|exit\s*\()/.test(text);
  // strchr is not among the C library functions the runtime gives a scanner (Perl's uses it)
  const strchr = /\bstrchr\s*\(/.test(text);
  if (!stdio && !strchr) return;
  writeFileSync(file, [
    '/* kirograph-wasm-shim */',
    '#include <stdio.h>',
    '#include <stdlib.h>',
    '#include <string.h>',
    ...(stdio ? ['#define fprintf(...) ((void)0)', '#define exit(code) __builtin_trap()'] : []),
    ...(strchr ? [
      'static char *kirograph_strchr(const char *s, int c) {',
      '  for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return 0; }',
      '}',
      '#define strchr kirograph_strchr',
    ] : []),
    text,
  ].join('\n'));
}

/**
 * The grammar's folder, ready to compile: the sources at the pinned version, the parser generated
 * by the pinned CLI when the source has none, shared includes copied next to the sources. Both
 * engines compile from it.
 */
async function prepare(lang, spec) {
  const src = await fetchSources(spec);
  const dir = join(src, spec.dir ?? '.');
  // A grammar pinned between releases has no generated parser: the pinned CLI generates it from
  // grammar.js, so the same commit and the same CLI give the same parser
  if (spec.generate && !existsSync(join(dir, 'src', 'parser.c'))) {
    execFileSync(cli, ['generate'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (!existsSync(join(dir, 'src', 'parser.c'))) throw new Error(`${lang}: no generated parser in ${dir}/src`);
  inlineParentIncludes(join(dir, 'src'));
  return dir;
}

/** Compiles one language to its WASM file. */
async function build(lang, spec) {
  const dir = await prepare(lang, spec);
  // Metadata the CLI refuses: a link that is not an absolute URL (Vue's `"repository":
  // "tree-sitter-grammars/tree-sitter-vue"`, which becomes its GitHub URL: the CLI requires a
  // repository). Links do not change the parser
  if (existsSync(join(dir, 'tree-sitter.json'))) {
    const config = JSON.parse(readFileSync(join(dir, 'tree-sitter.json'), 'utf8'));
    let changed = false;
    // The CLI requires a repository link (SQL's has none): the pinned source's
    if (config.metadata && !config.metadata.links?.repository) {
      config.metadata.links = { ...config.metadata.links, repository: spec.github
        ? `https://github.com/${spec.github}` : `https://www.npmjs.com/package/${spec.package}` };
      changed = true;
    }
    const links = config.metadata?.links;
    for (const [k, v] of Object.entries(links ?? {})) {
      if (typeof v !== 'string' || /^[a-z]+:\/\//i.test(v)) continue;
      if (/^[\w.-]+\/[\w.-]+$/.test(v)) links[k] = `https://github.com/${v}`; else delete links[k];
      changed = true;
    }
    if (changed) writeFileSync(join(dir, 'tree-sitter.json'), JSON.stringify(config, null, 2));
  }
  // Grammars older than tree-sitter 0.24 have no tree-sitter.json, which the CLI needs
  if (!existsSync(join(dir, 'tree-sitter.json'))) {
    writeFileSync(join(dir, 'tree-sitter.json'), JSON.stringify({
      grammars: [{ name: spec.symbol, scope: `source.${spec.symbol}`, path: '.' }],
      metadata: { version: '0.0.0' },
    }));
  }
  shimStdio(join(dir, 'src'));
  mkdirSync(wasmDir, { recursive: true });
  execFileSync(cli, ['build', '--wasm', '-o', wasmPath(lang), dir], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** ABI, parse states, node kinds and fields of a WASM grammar, and a hash of the kind and field names. */
async function measure(file) {
  const { Parser, Language } = require('web-tree-sitter');
  await Parser.init();
  const lang = await Language.load(file);
  const kinds = [];
  for (let i = 0; i < lang.nodeTypeCount; i++) kinds.push((lang.nodeTypeIsNamed(i) ? 'N ' : 'a ') + lang.nodeTypeForId(i));
  const fields = [];
  for (let i = 1; i <= lang.fieldCount; i++) fields.push(lang.fieldNameForId(i));
  return {
    abi: lang.abiVersion,
    states: lang.stateCount,
    kinds: lang.nodeTypeCount,
    fields: lang.fieldCount,
    hash: createHash('sha256').update(kinds.join('\n') + '\n\n' + fields.join('\n')).digest('hex').slice(0, 16),
  };
}

/**
 * The fingerprint of a WASM grammar, measured in a process of its own: some grammars (bash, yaml)
 * import C library functions the bare runtime lacks, and loading several in one runtime is not
 * reliable.
 */
export function fingerprint(file) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'fingerprint', file], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** Languages whose WASM file differs from the manifest, with what was found. */
export async function check() {
  const manifest = readManifest();
  const problems = [];
  for (const [lang, spec] of Object.entries(manifest.languages)) {
    if (!existsSync(wasmPath(lang))) { problems.push(`${lang}: ${wasmPath(lang)} missing`); continue; }
    const found = fingerprint(wasmPath(lang));
    if (JSON.stringify(found) !== JSON.stringify(spec.fingerprint)) {
      problems.push(`${lang}: expected ${JSON.stringify(spec.fingerprint)}, found ${JSON.stringify(found)}`);
    }
  }
  return problems;
}

async function main() {
  const [cmd, ...langs] = process.argv.slice(2);
  if (cmd === 'fingerprint') {
    process.stdout.write(JSON.stringify(await measure(langs[0])));
  } else if (cmd === 'build') {
    const manifest = readManifest();
    const todo = langs.length > 0 ? langs : Object.keys(manifest.languages);
    const failed = [];
    for (const lang of todo) {
      const spec = manifest.languages[lang];
      if (!spec) throw new Error(`${lang} is not in grammars/grammars.json`);
      process.stdout.write(`  ${lang} (${spec.github ?? spec.package}@${spec.version})… `);
      if (spec.prebuilt) { console.log('prebuilt, skipped'); continue; }
      try {
        await build(lang, spec);
      } catch (err) {
        failed.push(lang);
        console.log(`failed: ${String(err.message ?? err).split('\n')[0]}`);
        continue;
      }
      const fp = fingerprint(wasmPath(lang));
      const changed = JSON.stringify(fp) !== JSON.stringify(spec.fingerprint);
      spec.fingerprint = fp;
      console.log(changed ? `built, fingerprint changed: ${JSON.stringify(fp)}` : 'built, same fingerprint');
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    if (failed.length > 0) { console.log(`  failed: ${failed.join(', ')}`); process.exit(1); }
  } else if (cmd === 'sources') {
    // The native engine (native/kirograph-rust/build.rs) compiles what this lists
    const manifest = readManifest();
    const todo = langs.length > 0 ? langs : Object.keys(manifest.languages);
    const listPath = join(cacheDir, 'native.json');
    const list = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')) : {};
    const failed = [];
    for (const lang of todo) {
      const spec = manifest.languages[lang];
      if (!spec) throw new Error(`${lang} is not in grammars/grammars.json`);
      try {
        const dir = await prepare(lang, spec);
        list[lang] = { src: relative(root, join(dir, 'src')).split('\\').join('/'), symbol: spec.symbol, fingerprint: spec.fingerprint };
      } catch (err) {
        failed.push(lang);
        console.log(`  ${lang}: ${String(err.message ?? err).split('\n')[0]}`);
      }
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n');
    console.log(`  ${Object.keys(list).length} grammar sources ready (${listPath})`);
    if (failed.length > 0) process.exit(1);
  } else if (cmd === 'check') {
    const problems = await check();
    for (const p of problems) console.log(`  ✗ ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log('  ✓ every grammar matches grammars/grammars.json');
  } else {
    console.log('usage: node scripts/grammars.mjs build [lang...] | sources [lang...] | check');
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => { console.error(err.message ?? err); process.exit(1); });
}
