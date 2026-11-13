import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';
import { getChangedFiles } from '../../src/sync/index';
import { readGitHeads } from '../../src/sync/git-head';
import { createDefaultConfig } from '../../src/config';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-heads-'));
  git(root, 'init', '-q');
  write('src/a.ts', 'export function a() { return 1; }\n');
  write('src/b.ts', 'export function b() { return 1; }\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('commits made since the last sync', () => {
  it('are synced when the tree also has an uncommitted change (a pull with local edits)', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      expect(Object.keys(readGitHeads(root))).toEqual(['.']);

      // As a pull would: a commit that changes b.ts and adds c.ts, then removes nothing
      write('src/b.ts', 'export function b() { return 2; }\nexport function pulled() {}\n');
      write('src/c.ts', 'export function c() {}\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'upstream');
      // and a local edit that is not committed
      write('src/a.ts', 'export function a() { return 3; }\n');

      const result = await kg.sync();
      expect(result.modified.sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.added).toEqual(['src/c.ts']);
      expect(kg.searchNodes('pulled').length).toBeGreaterThan(0);
    } finally {
      kg.close();
    }
  });

  it('include files deleted by a commit', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      git(root, 'rm', '-q', 'src/b.ts');
      git(root, 'commit', '-qm', 'remove b');
      write('src/a.ts', 'export function a() { return 3; }\n'); // keeps the tree dirty
      const result = await kg.sync();
      expect(result.removed).toEqual(['src/b.ts']);
    } finally {
      kg.close();
    }
  });
});

describe('getChangedFiles', () => {
  const config = createDefaultConfig();

  it('is complete only when every repository has a recorded head git can diff', async () => {
    write('src/a.ts', 'export function a() { return 9; }\n');
    const none = await getChangedFiles(root, config, {});
    expect(none.complete).toBe(false);
    expect(none.modified).toEqual([path.join(root, 'src', 'a.ts')]);

    const known = await getChangedFiles(root, config, none.heads);
    expect(known.complete).toBe(true);

    const gone = await getChangedFiles(root, config, { '.': 'f'.repeat(40) });
    expect(gone.complete).toBe(false);
  });

  it('reports the paths of a workspace inside a repository relative to it, and only its own', async () => {
    write('sub/x.ts', 'export const x = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'sub');
    const sub = path.join(root, 'sub');
    const heads = (await getChangedFiles(sub, config, {})).heads;

    write('sub/x.ts', 'export const x = 2;\n');
    write('src/a.ts', 'export function a() { return 9; }\n'); // outside the workspace
    write('sub/y.ts', 'export const y = 1;\n');
    git(root, 'add', 'sub/y.ts');
    git(root, 'commit', '-qm', 'y');

    const changed = await getChangedFiles(sub, config, heads);
    expect(changed.complete).toBe(true);
    expect(changed.modified).toEqual([path.join(sub, 'x.ts')]);
    expect(changed.added).toEqual([path.join(sub, 'y.ts')]);
  });
});
