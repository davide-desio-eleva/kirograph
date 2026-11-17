#!/usr/bin/env node
/**
 * Downloads the grammar sources listed in grammars.json into grammars/<package>/, keeping only the
 * directories the build compiles. Run once before `cargo build` (npm run build does it).
 *
 * Sources come from the npm registry with `npm pack`, at the exact versions the WASM grammars were
 * built from, so the Rust engine parses every file into the same tree as the TypeScript extractor.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'grammars.json'), 'utf8'));
const outRoot = join(root, 'grammars');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

mkdirSync(outRoot, { recursive: true });
for (const pkg of manifest.packages) {
  const dest = join(outRoot, pkg.package.replace(/^@[^/]+\//, ''));
  const stamp = join(dest, '.version');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === pkg.version) continue;

  const work = mkdtempSync(join(tmpdir(), 'kg-grammar-'));
  try {
    const out = execFileSync(npm, ['pack', '--silent', `${pkg.package}@${pkg.version}`], { cwd: work, encoding: 'utf8', shell: process.platform === 'win32' });
    const tarball = out.trim().split('\n').pop();
    execFileSync('tar', ['xzf', tarball], { cwd: work });
    rmSync(dest, { recursive: true, force: true });
    for (const dir of pkg.dirs) {
      cpSync(join(work, 'package', dir), join(dest, dir), { recursive: true });
    }
    writeFileSync(stamp, pkg.version);
    console.log(`  fetched ${pkg.package}@${pkg.version}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
