import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

let root: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-skip-'));
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() { return 1; }\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('sync fast path', () => {
  it('skips when nothing changed, runs after an edit, and --full always runs', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      expect((await kg.sync()).skipped).toBe(true);

      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() { return 2; }\nexport function b() {}\n');
      const edited = await kg.sync();
      expect(edited.skipped).toBeUndefined();
      expect(edited.modified).toEqual(['src/a.ts']);
      expect((await kg.sync()).skipped).toBe(true);

      const full = await kg.sync({ full: true });
      expect(full.skipped).toBeUndefined();
    } finally {
      kg.close();
    }
  });

  it('does not skip an explicit list of files', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      expect((await kg.sync(['src/a.ts'])).skipped).toBeUndefined();
    } finally {
      kg.close();
    }
  });

  it('reports pending changes for sync-if-dirty', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      expect(kg.hasPendingChanges()).toBe(false);
      fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 1;\n');
      expect(kg.hasPendingChanges()).toBe(true);
      expect(await kg.syncIfDirty()).not.toBeNull();
      expect(await kg.syncIfDirty()).toBeNull();
    } finally {
      kg.close();
    }
  });
});
