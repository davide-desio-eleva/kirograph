import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

describe('call resolution by name', () => {
  it('does not resolve a call from code to a CI job or a package.json script', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-data-targets-'));
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      // `test` and `build` are jobs of the workflow, and scripts of package.json
      write('.github/workflows/ci.yml', [
        'name: CI', 'on: push', 'jobs:',
        '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm test',
        '  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm run build', '',
      ].join('\n'));
      write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest', build: 'tsc' } }));
      write('src/check.js', [
        'export function build() { return 1; }',
        'export function check(s) { return /x/.test(s) && build(); }', '',
      ].join('\n'));
      const kg = await KiroGraph.init(root);
      try {
        await kg.indexAll();
        const db = (kg as any).db.getRawDb();
        const calls = db.all(`
          SELECT t.file_path || '::' || t.name AS x FROM edges e
          JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
          WHERE e.kind = 'calls' AND s.name = 'check' ORDER BY 1`).map((r: any) => r.x);
        // build() reaches the function, pattern.test() nothing: no job, no script
        expect(calls).toEqual(['src/check.js::build']);
      } finally { kg.close(); }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
