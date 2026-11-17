#!/usr/bin/env node
/**
 * kirograph and kirograph-rust are released together, at the same version: kirograph depends on
 * kirograph-rust at its own version, and kirograph-rust on its platform packages at it too.
 *
 *   node scripts/sync-native-version.mjs           sets native/kirograph-rust and the dependency
 *                                                   to the version in package.json
 *   node scripts/sync-native-version.mjs --check   exits 1 when they differ (release preflight)
 *
 * `npm version <x>` runs it (the "version" script), so a bump made that way needs nothing else.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPath = join(root, 'package.json');
const nativePath = join(root, 'native', 'kirograph-rust', 'package.json');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2) + '\n');

const pkg = read(rootPath);
const nativePkg = read(nativePath);
const version = pkg.version;
const dep = pkg.optionalDependencies?.['kirograph-rust'];

if (process.argv.includes('--check')) {
  const problems = [];
  if (nativePkg.version !== version) problems.push(`native/kirograph-rust/package.json is ${nativePkg.version}`);
  if (dep !== version) problems.push(`optionalDependencies["kirograph-rust"] is ${dep}`);
  if (problems.length > 0) {
    console.error(`kirograph is ${version}, but ${problems.join(' and ')}. Run: node scripts/sync-native-version.mjs`);
    process.exit(1);
  }
  process.exit(0);
}

nativePkg.version = version;
pkg.optionalDependencies = { ...pkg.optionalDependencies, 'kirograph-rust': version };
write(nativePath, nativePkg);
write(rootPath, pkg);
console.log(`kirograph-rust set to ${version}`);
