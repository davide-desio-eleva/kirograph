import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('sync fast path and the dirty marker', () => {
  it('is not taken while the dirty marker is set, and the sync clears it', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      expect((await kg.sync()).skipped).toBe(true);
      kg.markDirty();
      expect(kg.hasPendingChanges()).toBe(true);
      expect((await kg.sync()).skipped).toBeUndefined();
      expect(kg.isDirty()).toBe(false);
      expect((await kg.sync()).skipped).toBe(true);
    } finally {
      kg.close();
    }
  });

  it('does not load the embedding model for a sync that finds nothing to do', async () => {
    // As the CLI does: init once, then every command opens the saved configuration
    (await KiroGraph.init(root)).close();
    const kg0 = await KiroGraph.open(root);
    await kg0.indexAll();
    kg0.close();
    const kg = await KiroGraph.open(root, undefined, { deferVectors: true });
    try {
      const init = vi.spyOn(kg.vectors, 'initialize');
      expect((await kg.sync()).skipped).toBe(true);
      expect(init).not.toHaveBeenCalled();
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() { return 3; }\n');
      expect((await kg.sync()).skipped).toBeUndefined();
      expect(init).toHaveBeenCalledTimes(1);
    } finally {
      kg.close();
    }
  });
});
