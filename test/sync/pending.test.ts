import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';
import { getChangedFiles } from '../../src/sync/index';
import { createDefaultConfig } from '../../src/config';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-pending-'));
  git(root, 'init', '-q');
  write('.gitignore', '.kirograph\n');
  write('src/a.ts', 'export function a() { return 1; }\n');
  write('src/b.ts', 'export function b() { return 1; }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('files git reports as changed (#80)', () => {
  it('leave out excluded files', async () => {
    write('dist/out.js', 'export const built = 1;\n');
    write('src/c.ts', 'export const c = 1;\n');
    const changed = await getChangedFiles(root, createDefaultConfig(root));
    expect(changed.added.map(f => path.relative(root, f))).toEqual([path.join('src', 'c.ts')]);
  });

  it('are not indexed by a sync when excluded', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      write('dist/out.js', 'export const built = 1;\n');
      write('src/a.ts', 'export function a() { return 2; }\n');
      const result = await kg.sync();
      expect(result.added).toEqual([]);
      expect(result.modified).toEqual(['src/a.ts']);
      expect((await kg.getStats()).files).toBe(2);
    } finally {
      kg.close();
    }
  });

  it('are not pending once synced, even while the edit is not committed', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      write('src/a.ts', 'export function a() { return 2; }\n');
      expect(await kg.getPendingSyncCount()).toBe(1);
      await kg.sync();
      expect(await kg.getPendingSyncCount()).toBe(0);
      // Still uncommitted, and the fast path is off (as after a file-save hook): counted by hash
      fs.writeFileSync(path.join(root, '.kirograph', 'sync-state.json'), '{}');
      expect(await kg.getPendingSyncCount()).toBe(0);
      write('src/new.ts', 'export const n = 1;\n');
      expect(await kg.getPendingSyncCount()).toBe(1);
    } finally {
      kg.close();
    }
  });
});
