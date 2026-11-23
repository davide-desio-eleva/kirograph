import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

describe('Kotlin', () => {
  it('extracts objects, constructor properties, supertypes, aliased imports and chained calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-kt-'));
    try {
      const file = path.join(root, 'UserService.kt');
      fs.writeFileSync(file, [
        'package app.core',
        'import app.data.Repo as R',
        'class UserService(private val repo: Repo, retries: Int) : Base(), Api {',
        '    fun find(id: Int): User = repo.load(id).also { log(it) }',
        '}',
        'object Registry {',
        '    fun all() = listOf(1)',
        '}',
        '',
      ].join('\n'));
      const r = await extractFile(file, root);
      const symbols = (r?.nodes ?? []).map(n => `${n.kind} ${n.name}`);
      expect(symbols).toEqual(expect.arrayContaining([
        'import app.data.Repo', 'class UserService', 'property repo', 'function find', 'class Registry', 'function all',
      ]));
      // `retries` has no val / var: a parameter, not a property
      expect(symbols).not.toContain('property retries');
      const refs = (r?.unresolvedRefs ?? []).map(x => `${x.refKind} ${x.refName}`);
      expect(refs).toEqual(expect.arrayContaining(['extends Base', 'implements Api', 'function load', 'function also', 'function log']));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
