import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';
import { ToolHandler } from '../../src/mcp/handler';
import { watchProject } from '../../src/mcp/watcher';
import { createDefaultConfig } from '../../src/config';

let root: string;
const setup = () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-stale-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), '.kirograph\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), 'export function alphaHelper() { return 1; }\n');
};
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('staleness notice in tool responses (#90)', () => {
  it('names a file the response mentions once it changed after the sync, and not before', async () => {
    setup();
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      const handler = new ToolHandler(kg);
      const fresh = await handler.handle('kirograph_search', { query: 'alphaHelper' });
      expect(fresh.content[0].text).toContain('src/alpha.ts');
      expect(fresh.content[0].text).not.toContain('⚠️');

      await new Promise(r => setTimeout(r, 20));
      fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), 'export function alphaHelper() { return 2; }\nexport function more() {}\n');
      const stale = await handler.handle('kirograph_search', { query: 'alphaHelper' });
      expect(stale.content[0].text.startsWith('⚠️ Changed since the graph last read it: `src/alpha.ts`')).toBe(true);

      await kg.sync();
      const synced = await handler.handle('kirograph_search', { query: 'alphaHelper' });
      expect(synced.content[0].text).not.toContain('⚠️');

      fs.rmSync(path.join(root, 'src', 'alpha.ts'));
      const gone = await handler.handle('kirograph_search', { query: 'alphaHelper' });
      expect(gone.content[0].text).toContain('⚠️ Deleted since the graph last read it: `src/alpha.ts`');
    } finally {
      kg.close();
    }
  });
});

describe('watch (#90)', () => {
  it('syncs the files that change, together, after the last change', async () => {
    setup();
    const calls: string[][] = [];
    const stop = watchProject(root, createDefaultConfig(root), async files => { calls.push(files.sort()); }, 150);
    if (!stop) return; // a platform that cannot watch a tree
    try {
      await new Promise(r => setTimeout(r, 100));
      fs.writeFileSync(path.join(root, 'src', 'beta.ts'), 'export const b = 1;\n');
      fs.writeFileSync(path.join(root, 'src', 'gamma.ts'), 'export const g = 1;\n');
      fs.writeFileSync(path.join(root, 'notes.bin'), 'not source');
      fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), 'module.exports = 1;\n');
      await new Promise(r => setTimeout(r, 1000));
      expect(calls.flat()).toContain('src/beta.ts');
      expect(calls.flat()).toContain('src/gamma.ts');
      expect(calls.flat().some(f => f.includes('node_modules') || f.endsWith('.bin'))).toBe(false);
      expect(calls.length).toBe(1);
    } finally {
      stop();
    }
  });
});
