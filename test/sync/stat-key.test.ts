import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

let root: string;
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('stat key of indexed files (#89)', () => {
  it('is recorded at index, and a change of the same size with the mtime set back is still seen', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-statkey-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, '.gitignore'), '.kirograph\n');
    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'export function alpha() { return 1; }\n');
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      expect((kg as any).db.getFile('a.ts').statKey).toMatch(/^\d+:/);

      // Nothing changed: the full scan finds nothing to do
      expect((await kg.sync({ full: true })).modified).toEqual([]);

      // Same size, mtime restored: only the ctime tells
      const before = fs.statSync(file);
      await new Promise(r => setTimeout(r, 20));
      fs.writeFileSync(file, 'export function omega() { return 1; }\n');
      fs.utimesSync(file, before.atime, before.mtime);
      const r = await kg.sync({ full: true });
      expect(r.modified).toEqual(['a.ts']);
      expect(kg.searchNodes('omega').length).toBeGreaterThan(0);
    } finally {
      kg.close();
    }
  });
});
