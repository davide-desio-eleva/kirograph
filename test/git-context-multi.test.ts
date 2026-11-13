import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../src/index';
import { getChangedSymbols, getCommitContext, getCommitLog, getPRContext, repositoriesOf } from '../src/graph/git-context';

let ws: string;
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: path.join(ws, repo), stdio: 'ignore' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
};

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-multirepo-'));
  for (const repo of ['infra', 'charts']) {
    fs.mkdirSync(path.join(ws, repo));
    git(repo, 'init', '-q', '-b', 'main');
  }
  write('infra/net.ts', 'export function openPort() { return 80; }\n');
  write('charts/app.ts', 'export function renderChart() { return 1; }\n');
  git('infra', 'add', '-A'); git('infra', 'commit', '-qm', 'first infra');
  git('charts', 'add', '-A'); git('charts', 'commit', '-qm', 'first charts');
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

describe('git tools in a folder that holds several repositories', () => {
  it('lists the repositories with the prefix of their files', () => {
    expect(repositoriesOf(ws).map(r => r.prefix).sort()).toEqual(['charts/', 'infra/']);
    expect(repositoriesOf(path.join(ws, 'infra'))).toEqual([{ cwd: path.join(ws, 'infra'), prefix: '' }]);
  });

  it('finds the changed symbols of every repository, with workspace-relative paths', async () => {
    const kg = await KiroGraph.init(ws);
    try {
      await kg.indexAll();
      write('infra/net.ts', 'export function openPort() { return 8080; }\n');
      write('charts/app.ts', 'export function renderChart() { return 2; }\n');
      const db = (kg as any).db;
      const result = getChangedSymbols(ws, db);
      expect(result.changedSymbols.map(s => s.filePath).sort()).toEqual(['charts/app.ts', 'infra/net.ts']);
      expect(result.hunks.map(h => h.filePath).sort()).toEqual(['charts/app.ts', 'infra/net.ts']);
    } finally { kg.close(); }
  });

  it('describes staged changes, the commit log and a ref diff across repositories', async () => {
    const kg = await KiroGraph.init(ws);
    try {
      await kg.indexAll();
      const db = (kg as any).db;
      write('infra/net.ts', 'export function openPort() { return 443; }\n');
      git('infra', 'add', '-A');
      const staged = getCommitContext(ws, db);
      expect(staged.stagedFiles).toEqual(['infra/net.ts']);
      expect(staged.diffStat).toContain('# infra');

      git('infra', 'commit', '-qm', 'second infra');
      write('charts/app.ts', 'export function renderChart() { return 3; }\n');
      git('charts', 'add', '-A'); git('charts', 'commit', '-qm', 'second charts');
      const log = getCommitLog(ws, 'HEAD~1', 'HEAD');
      expect(log.map(e => e.subject).sort()).toEqual(['[charts] second charts', '[infra] second infra']);
      const pr = getPRContext(ws, db, 'HEAD~1', 'HEAD');
      expect(pr.hunks.map(h => h.filePath).sort()).toEqual(['charts/app.ts', 'infra/net.ts']);
    } finally { kg.close(); }
  });
});

describe('refs from a tool call', () => {
  it('are never run as a command, and cannot be taken for options', () => {
    const marker = path.join(ws, 'pwned');
    for (const bad of [`main; touch ${marker}`, `$(touch ${marker})`, '--output=' + marker]) {
      expect(() => getCommitLog(path.join(ws, 'infra'), bad, 'HEAD')).toThrow();
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
});
