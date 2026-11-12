import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  workspaceFingerprint, writeSyncState, isUpToDate, clearSyncState, quickIsUpToDate,
  hasTransientErrors, writeSyncErrors, readSyncErrors,
} from '../../src/sync/state';

let root: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const fp = () => workspaceFingerprint(root);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-state-'));
  git('init', '-q');
  write('a.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  fs.mkdirSync(path.join(root, '.kirograph'));
  write('.kirograph/kirograph.db', 'db'); // the state is tied to the database file
  write('.kirograph/config.json', JSON.stringify({ enableSecurity: false, maxFileSize: 100 }));
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
    const same = fp();
    write('.kirograph/config.json', JSON.stringify({ enableSecurity: true, maxFileSize: 100 }));
    expect(fp()).not.toBe(same);
  });

  it('ignores the order of keys and the detected frameworks in the configuration', () => {
    const before = fp();
    write('.kirograph/config.json', JSON.stringify({ maxFileSize: 100, frameworkHints: ['express'], enableSecurity: false }));
    expect(fp()).toBe(before);
  });

  it('reads HEAD from a branch, a packed ref and a detached head, as git reports it', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const onBranch = fp();
    git('pack-refs', '--all');
    expect(fp()).toBe(onBranch);
    git('checkout', '-q', '--detach', sha);
    expect(fp()).toBe(onBranch);
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
      expect(workspaceFingerprint(plain)).toBeNull();
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

describe('quickIsUpToDate', () => {
  it('answers from the state, git and the configuration alone', () => {
    expect(quickIsUpToDate(root)).toBe(false); // no state yet
    writeSyncState(root, fp()!);
    expect(quickIsUpToDate(root)).toBe(true);
    write('a.ts', 'export const a = 9;\n');
    expect(quickIsUpToDate(root)).toBe(false);
  });

  it('is false while the dirty marker is set', () => {
    writeSyncState(root, fp()!);
    write('.kirograph/dirty', '1');
    expect(quickIsUpToDate(root)).toBe(false);
  });

  it('is false when the database file was replaced', () => {
    writeSyncState(root, fp()!);
    fs.unlinkSync(path.join(root, '.kirograph', 'kirograph.db'));
    write('.kirograph/kirograph.db', 'another');
    expect(quickIsUpToDate(root)).toBe(false);
  });

  it('is false when there is no database', () => {
    fs.unlinkSync(path.join(root, '.kirograph', 'kirograph.db'));
    writeSyncState(root, fp()!);
    expect(quickIsUpToDate(root)).toBe(false);
  });

  it('is false for a directory that is not a project', () => {
    expect(quickIsUpToDate(path.join(root, 'nowhere'))).toBe(false);
  });
});

describe('a workspace that is not itself a repository', () => {
  it('has no fingerprint, so a sync is never skipped for it', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-multi-'));
    try {
      for (const name of ['repo-a', 'repo-b']) {
        fs.mkdirSync(path.join(workspace, name));
        execFileSync('git', ['init', '-q'], { cwd: path.join(workspace, name) });
      }
      fs.writeFileSync(path.join(workspace, 'loose.tf'), 'resource "x" "y" {}\n'); // a file git does not know about
      expect(workspaceFingerprint(workspace)).toBeNull();
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('has none for a folder inside a repository either', () => {
    fs.mkdirSync(path.join(root, 'sub'));
    expect(workspaceFingerprint(path.join(root, 'sub'))).toBeNull();
  });
});

describe('errors of a sync', () => {
  it('tells a failure that may pass on its own from one that will repeat', () => {
    expect(hasTransientErrors(['a.yaml: resolved is not a function', 'b.sh: Aborted(). Build with -sASSERTIONS'])).toBe(false);
    expect(hasTransientErrors(['a.ts: Database is locked'])).toBe(true);
    expect(hasTransientErrors(['x: EBUSY: resource busy'])).toBe(true);
    expect(hasTransientErrors(['WASM runtime unrecoverable after crash — aborting sync'])).toBe(true);
    expect(hasTransientErrors([])).toBe(false);
  });

  it('keeps the errors of the last sync to list them, and forgets them when there are none', () => {
    writeSyncErrors(root, ['a.yaml: bad', 'b.sh: worse']);
    expect(readSyncErrors(root)).toMatchObject({ total: 2, errors: ['a.yaml: bad', 'b.sh: worse'] });
    writeSyncErrors(root, []);
    expect(readSyncErrors(root)).toBeNull();
  });
});

describe('quickShouldSyncIfDirty', () => {
  it('syncs for the dirty marker, or a workspace known to have changed', async () => {
    const { quickShouldSyncIfDirty } = await import('../../src/sync/state');
    writeSyncState(root, fp()!);
    expect(quickShouldSyncIfDirty(root)).toBe(false);
    write('.kirograph/dirty', '1');
    expect(quickShouldSyncIfDirty(root)).toBe(true);
    fs.unlinkSync(path.join(root, '.kirograph', 'dirty'));
    write('a.ts', 'export const a = 7;\n');
    expect(quickShouldSyncIfDirty(root)).toBe(true);
  });

  it('leaves a workspace that cannot be fingerprinted to the marker alone', async () => {
    const { quickShouldSyncIfDirty } = await import('../../src/sync/state');
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-plain-'));
    try {
      fs.mkdirSync(path.join(plain, '.kirograph'));
      expect(quickShouldSyncIfDirty(plain)).toBe(false);
      fs.writeFileSync(path.join(plain, '.kirograph', 'dirty'), '1');
      expect(quickShouldSyncIfDirty(plain)).toBe(true);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  });
});
