import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';
import { zeroMallocInBinary } from '../../src/extraction/libc-shims';

const ROOT = '/proj';

async function extract(relPath: string, content: string) {
  return extractFile(`${ROOT}/${relPath}`, ROOT, content);
}

/**
 * The bash and yaml grammars import C library functions the tree-sitter runtime does not export
 * (isalpha; operator new, delete and abort). Without the shims in libc-shims.ts every file in those
 * languages failed with "resolved is not a function", on every index and sync.
 */
describe('grammars that import libc symbols the runtime lacks', () => {
  it('parses bash and extracts its functions', async () => {
    const r = await extract('scripts/build.sh', [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'build() { echo "building $1"; }',
      'clean() { rm -rf dist; }',
      'build app',
    ].join('\n'));
    expect(r).not.toBeNull();
    const names = r!.nodes.filter(n => n.kind === 'function').map(n => n.name).sort();
    expect(names).toEqual(['build', 'clean']);
  });

  it('parses yaml without throwing', async () => {
    const r = await extract('config/app.yaml', 'name: demo\nitems:\n  - a\n  - b: 1\n');
    expect(r).not.toBeNull();
    expect(r!.language).toBe('yaml');
  });

  it('keeps parsing other languages after loading the shimmed ones', async () => {
    await extract('scripts/a.sh', 'f() { :; }\n');
    const py = await extract('src/a.py', 'def helper():\n    return 1\n');
    expect(py!.nodes.some(n => n.name === 'helper')).toBe(true);
  });
});

/**
 * The Lua scanner reads memory it has not initialised. Once the heap had been used, a parse could
 * fail on comments and lose the first function of the file; the second Lua file in a process was
 * the first to be affected. The grammar's malloc now returns zeroed memory (zeroMallocInBinary).
 */
describe('lua', () => {
  const source = [
    'local M = {}',
    '',
    '-- first: a comment before the first function',
    'function M.run_command(cmd)',
    '  os.execute(cmd)',
    'end',
    '',
    '-- second',
    'function M.read_output(cmd)',
    '  return io.popen(cmd)',
    'end',
    '',
  ].join('\n');

  it('gives the same symbols every time it is parsed, whatever was parsed before', async () => {
    const names: string[][] = [];
    for (let i = 0; i < 6; i++) {
      // other languages in between use and free heap memory
      await extract('src/x.py', 'def f():\n    return [1, 2, 3]\n');
      await extract('scripts/x.sh', 'g() { echo hi; }\n');
      const r = await extract('src/helpers.lua', source);
      names.push(r!.nodes.filter(n => n.kind === 'function').map(n => n.name));
    }
    for (const n of names) expect(n).toEqual(['run_command', 'read_output']);
  });
});

describe('zeroMallocInBinary', () => {
  const lua = fs.readFileSync(require.resolve('tree-sitter-wasms/out/tree-sitter-lua.wasm'));

  it('renames the malloc import and nothing else', () => {
    const out = zeroMallocInBinary(new Uint8Array(lua));
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(out)).filter(i => i.kind === 'function').map(i => i.name);
    expect(imports).toContain('zalloc');
    expect(imports).not.toContain('malloc');
    expect(imports).toContain('free');
    expect(out.length).toBe(lua.length);
    expect([...out].filter((b, i) => b !== lua[i])).toHaveLength(1); // m -> z
  });

  it('returns a binary it cannot read unchanged', () => {
    const junk = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 2, 200, 1, 1, 1]);
    expect(zeroMallocInBinary(junk)).toBe(junk);
    const none = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    expect(zeroMallocInBinary(none)).toBe(none);
  });

  it('leaves every grammar a valid module', () => {
    const dir = path.dirname(require.resolve('tree-sitter-wasms/out/tree-sitter-lua.wasm'));
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.wasm'))) {
      const out = zeroMallocInBinary(new Uint8Array(fs.readFileSync(path.join(dir, f))));
      expect(() => new WebAssembly.Module(out), f).not.toThrow();
    }
  });
});
