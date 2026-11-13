import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';
import { DocsVectorManager } from '../../src/docs/vectors';
import { listWorkspaceFiles, withWorkspaceFileCache } from '../../src/sync/files';
import { createDefaultConfig } from '../../src/config';

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

async function project(config: Record<string, unknown>): Promise<KiroGraph> {
  (await KiroGraph.init(root)).close();
  const configPath = path.join(root, '.kirograph', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), ...config }));
  return KiroGraph.open(root, undefined, { skipVectors: true });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-phases-'));
  git(root, 'init', '-q');
  write('src/a.ts', 'import { b } from "./b";\nexport function a() { return b(); }\n');
  write('src/b.ts', 'export function b() { return 1; }\n');
  write('package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }));
  write('README.md', '# Demo\n\nIntro.\n\n## Usage\n\nCall a.\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('architecture analysis', () => {
  it('runs again only when the graph, a manifest or the configuration changed', async () => {
    const kg = await project({ enableArchitecture: true });
    try {
      const analyze = vi.spyOn((kg as any).arch, 'analyze');
      await kg.indexAll();
      expect(analyze).toHaveBeenCalledTimes(1);

      await kg.sync({ full: true }); // every phase runs, nothing changed
      expect(analyze).toHaveBeenCalledTimes(1);

      write('src/b.ts', 'export function b() { return 2; }\n');
      await kg.sync();
      expect(analyze).toHaveBeenCalledTimes(2);

      // A manifest edit changes no source file
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(root, 'package.json'), later, later);
      await kg.sync({ full: true });
      expect(analyze).toHaveBeenCalledTimes(3);
    } finally {
      kg.close();
    }
  });
});

describe('documentation embeddings', () => {
  it('are made for new and rewritten sections only, and removed with their file', async () => {
    const kg = await project({ enableDocs: true, enableEmbeddings: true });
    try {
      const embed = vi.spyOn(DocsVectorManager.prototype as any, 'embed').mockResolvedValue(new Float32Array([1, 0]));
      const db = (kg as any).db.getRawDb();
      const vectors = () => (db.get('SELECT COUNT(*) AS n FROM doc_vectors') as { n: number }).n;

      await kg.indexAll();
      const first = embed.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      expect(vectors()).toBe(first);

      await kg.sync({ full: true });
      expect(embed.mock.calls.length).toBe(first); // nothing changed: no model call

      write('README.md', '# Demo\n\nIntro, longer.\n\n## Usage\n\nCall a.\n');
      await kg.sync();
      expect(embed.mock.calls.length).toBeGreaterThan(first);

      fs.rmSync(path.join(root, 'README.md'));
      await kg.sync();
      expect(vectors()).toBe(0);
    } finally {
      kg.close();
    }
  });
});

describe('workspace file list', () => {
  it('lists what git lists in each repository and the files outside them, without excluded folders', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-files-'));
    try {
      const repo = path.join(workspace, 'infra');
      fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'docs', 'README.md'), '# infra\n');
      fs.writeFileSync(path.join(repo, '.gitignore'), '.terraform/\n');
      fs.mkdirSync(path.join(repo, '.terraform', 'modules', 'vpc'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.terraform', 'modules', 'vpc', 'README.md'), '# ignored\n');
      fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'README.md'), '# dependency\n');
      git(repo, 'init', '-q');
      fs.writeFileSync(path.join(workspace, 'NOTES.md'), '# outside\n');
      fs.mkdirSync(path.join(workspace, 'node_modules', 'y'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'node_modules', 'y', 'README.md'), '# dependency\n');

      const files = listWorkspaceFiles(workspace, createDefaultConfig()).sort();
      expect(files).toEqual(['NOTES.md', 'infra/.gitignore', 'infra/docs/README.md']);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('is listed once within a sync, and again for the next', async () => {
    const config = createDefaultConfig();
    const outside = listWorkspaceFiles(root, config);
    expect(listWorkspaceFiles(root, config)).not.toBe(outside);
    await withWorkspaceFileCache(async () => {
      const first = listWorkspaceFiles(root, config);
      write('NEW.md', '# new\n');
      expect(listWorkspaceFiles(root, config)).toBe(first);
    });
    expect(listWorkspaceFiles(root, config)).toContain('NEW.md');
  });
});
