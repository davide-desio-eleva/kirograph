import { describe, it, expect } from 'vitest';
import { extractFile } from '../../src/extraction/extractor';

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
