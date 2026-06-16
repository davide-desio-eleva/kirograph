#!/usr/bin/env tsx
/**
 * KiroGraph build script — esbuild-based transpiler.
 *
 * Strategy: transpile only (no bundling), all node_modules external.
 * This avoids issues with optional native dependencies (better-sqlite3,
 * lancedb, qdrant-local, sqlite-vec, etc.) that cannot be bundled.
 *
 * Asset pipeline runs after transpilation:
 *   - src/db/schema.sql        → dist/db/schema.sql
 *   - src/db/memory-schema.sql → dist/db/memory-schema.sql
 *   - src/extraction/wasm/*.wasm → dist/extraction/wasm/
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const isWatch = process.argv.includes('--watch');

// ── Collect all .ts entry points ─────────────────────────────────────────────

function collectEntries(dir: string): string[] {
  const entries: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectEntries(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      entries.push(full);
    }
  }
  return entries;
}

// ── Asset copy ────────────────────────────────────────────────────────────────

function copyAssets(): void {
  // schema.sql
  fs.mkdirSync(path.join(dist, 'db'), { recursive: true });
  fs.copyFileSync(path.join(src, 'db', 'schema.sql'), path.join(dist, 'db', 'schema.sql'));
  fs.copyFileSync(path.join(src, 'db', 'memory-schema.sql'), path.join(dist, 'db', 'memory-schema.sql'));
  fs.copyFileSync(path.join(src, 'db', 'docs-schema.sql'), path.join(dist, 'db', 'docs-schema.sql'));
  fs.copyFileSync(path.join(src, 'db', 'data-schema.sql'), path.join(dist, 'db', 'data-schema.sql'));
  fs.copyFileSync(path.join(src, 'db', 'security-schema.sql'), path.join(dist, 'db', 'security-schema.sql'));
  fs.copyFileSync(path.join(src, 'db', 'patterns-schema.sql'), path.join(dist, 'db', 'patterns-schema.sql'));
  fs.copyFileSync(path.join(src, 'db', 'wiki-schema.sql'), path.join(dist, 'db', 'wiki-schema.sql'));

  // patterns library yaml files
  const patternLibSrc = path.join(src, 'patterns', 'library');
  const patternLibDst = path.join(dist, 'patterns', 'library');
  fs.mkdirSync(patternLibDst, { recursive: true });
  if (fs.existsSync(patternLibSrc)) {
    for (const f of fs.readdirSync(patternLibSrc).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      fs.copyFileSync(path.join(patternLibSrc, f), path.join(patternLibDst, f));
    }
  }

  // tree-sitter wasm files
  const wasmSrc = path.join(src, 'extraction', 'wasm');
  const wasmDst = path.join(dist, 'extraction', 'wasm');
  fs.mkdirSync(wasmDst, { recursive: true });
  if (fs.existsSync(wasmSrc)) {
    for (const f of fs.readdirSync(wasmSrc).filter(f => f.endsWith('.wasm'))) {
      fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmDst, f));
    }
  }

  // logo (used by export command)
  const assetsSrc = path.join(__dirname, '..', 'assets');
  const assetsDst = path.join(dist, 'assets');
  fs.mkdirSync(assetsDst, { recursive: true });
  const logoSrc = path.join(assetsSrc, 'logo.png');
  if (fs.existsSync(logoSrc)) {
    fs.copyFileSync(logoSrc, path.join(assetsDst, 'logo.png'));
  }

  console.log('Assets copied.');
}

// ── Mark bin executable ───────────────────────────────────────────────────────

function markExecutable(): void {
  const bin = path.join(dist, 'bin', 'kirograph.js');
  if (fs.existsSync(bin)) {
    fs.chmodSync(bin, 0o755);
  }
}

// ── Plugins ───────────────────────────────────────────────────────────────────

/**
 * Rewrites relative dynamic import() to Promise.resolve().then(() => require()) in CJS output.
 * This avoids the double-default wrapping that Node applies when import()-ing a CJS module:
 *   - `await import('./foo')` in CJS → Node wraps as `{ default: module.exports }` → `.default` gives wrong value
 *   - `require('./foo')` accesses module.exports directly → `.default` gives the actual export
 * Also appends .js to extensionless relative specifiers.
 */
const fixDynamicImportsPlugin: esbuild.Plugin = {
  name: 'fix-dynamic-imports',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async args => {
      const contents = await fs.promises.readFile(args.path, 'utf8');
      const fixed = contents.replace(
        /\bawait\s+import\s*\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g,
        (_, quote, specifier) => {
          const withExt = specifier.endsWith('.js') || specifier.endsWith('.json')
            ? specifier
            : specifier + '.js';
          return `await Promise.resolve().then(() => require(${quote}${withExt}${quote}))`;
        },
      );
      return { contents: fixed, loader: 'ts' };
    });
  },
};

// ── esbuild config ────────────────────────────────────────────────────────────

const sharedOptions: esbuild.BuildOptions = {
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  // All node_modules stay external — no bundling of optional native deps
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  define: { __CLI_VERSION__: JSON.stringify(version) },
  plugins: [fixDynamicImportsPlugin],
};

const binEntry = path.join(src, 'bin', 'kirograph.ts');
const otherEntries = collectEntries(src).filter(e => e !== binEntry);

const binOptions: esbuild.BuildOptions = {
  ...sharedOptions,
  entryPoints: [binEntry],
  outdir: dist,
  outbase: src,
};

const libOptions: esbuild.BuildOptions = {
  ...sharedOptions,
  entryPoints: otherEntries,
  outdir: dist,
  outbase: src,
};


// ── Run ───────────────────────────────────────────────────────────────────────

const onRebuildPlugin: esbuild.Plugin = {
  name: 'on-rebuild',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length === 0) {
        copyAssets();
        markExecutable();
      }
    });
  },
};

async function main(): Promise<void> {
  if (isWatch) {
    const [binCtx, libCtx] = await Promise.all([
      esbuild.context({ ...binOptions, plugins: [fixDynamicImportsPlugin, onRebuildPlugin] }),
      esbuild.context({ ...libOptions, plugins: [fixDynamicImportsPlugin, onRebuildPlugin] }),
    ]);
    copyAssets();
    markExecutable();
    await Promise.all([binCtx.watch(), libCtx.watch()]);
    console.log('Watching for changes…');
  } else {
    await Promise.all([
      esbuild.build(binOptions),
      esbuild.build(libOptions),
    ]);
    copyAssets();
    markExecutable();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
