import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { workspaceFingerprint, writeSyncState, isUpToDate, clearSyncState } from '../../src/sync/state';
import { createDefaultConfig } from '../../src/config';

let root: string;
const config = createDefaultConfig();
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const fp = () => workspaceFingerprint(root, config);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-state-'));
  git('init', '-q');
  write('a.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  fs.mkdirSync(path.join(root, '.kirograph'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('workspaceFingerprint', () => {
  it('is stable while nothing changes', () => {
    expect(fp()).toBe(fp());
  });

  it('changes when a tracked file is modified, and again when it is edited a second time', () => {
    const clean = fp();
    write('a.ts', 'export const a = 2;\n');
    const first = fp();
    expect(first).not.toBe(clean);
    write('a.ts', 'export const a = 333;\n'); // same status line (" M"), different size
    expect(fp()).not.toBe(first);
  });

  it('sees a file created inside a new directory, and an edit to it', () => {
    const clean = fp();
    write('newdir/b.ts', 'export const b = 1;\n');
    const created = fp();
    expect(created).not.toBe(clean);
    write('newdir/b.ts', 'export const b = 22222;\n');
    expect(fp()).not.toBe(created);
  });

  it('changes with a commit and with the configuration', () => {
    const before = fp();
    git('commit', '-q', '--allow-empty', '-m', 'x');
    expect(fp()).not.toBe(before);
    expect(workspaceFingerprint(root, { ...config, enableSecurity: !config.enableSecurity })).not.toBe(fp());
  });

  it('ignores our own files', () => {
    const before = fp();
    write('.kirograph/sync-state.json', '{}');
    write('.kirograph/other/x.db', 'x');
    expect(fp()).toBe(before);
  });

  it('is null outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-nogit-'));
    try {
      expect(workspaceFingerprint(plain, config)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('sync state', () => {
  it('is up to date only for the fingerprint that was stored', () => {
    const f = fp()!;
    expect(isUpToDate(root, f)).toBe(false); // nothing stored yet
    writeSyncState(root, f);
    expect(isUpToDate(root, f)).toBe(true);
    write('a.ts', 'changed\n');
    expect(isUpToDate(root, fp())).toBe(false);
  });

  it('is never up to date without a fingerprint', () => {
    writeSyncState(root, 'abc');
    expect(isUpToDate(root, null)).toBe(false);
  });

  it('expires', () => {
    const f = fp()!;
    writeSyncState(root, f);
    const file = path.join(root, '.kirograph', 'sync-state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.at = Date.now() - 11 * 60_000;
    fs.writeFileSync(file, JSON.stringify(state));
    expect(isUpToDate(root, f)).toBe(false);
  });

  it('is forgotten by clearSyncState, and a corrupt file counts as none', () => {
    const f = fp()!;
    writeSyncState(root, f);
    clearSyncState(root);
    expect(isUpToDate(root, f)).toBe(false);
    write('.kirograph/sync-state.json', '{not json');
    expect(isUpToDate(root, f)).toBe(false);
  });
});
