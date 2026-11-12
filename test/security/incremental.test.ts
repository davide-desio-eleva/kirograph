import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefaultConfig } from '../../src/config';
import {
  manifestSignature, planSecurityRun, writeSecurityState, readSecurityState, securityConfigKey,
} from '../../src/security/incremental';

const DAY = 86_400_000;
let root: string;
const config = createDefaultConfig();
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const sig = () => manifestSignature(root, config);
const record = (enrichedAt = Date.now()) =>
  writeSecurityState(root, { manifests: sig(), config: securityConfigKey(config), enrichedAt });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-secinc-'));
  fs.mkdirSync(path.join(root, '.kirograph'));
  write('package.json', JSON.stringify({ name: 'a', dependencies: { left: '1.0.0' } }));
  write('package-lock.json', '{}');
  write('src/a.ts', 'export const a = 1;\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('manifestSignature', () => {
  it('is stable, and ignores source files', () => {
    const before = sig();
    expect(sig()).toBe(before);
    write('src/a.ts', 'export const a = 22222;\n');
    write('src/b.ts', 'export const b = 1;\n');
    expect(sig()).toBe(before);
  });

  it('changes with a manifest, a lock file, and a new manifest anywhere', () => {
    const base = sig();
    write('package.json', JSON.stringify({ name: 'a', dependencies: { left: '2.0.0', right: '1.0.0' } }));
    const manifest = sig();
    expect(manifest).not.toBe(base);
    write('package-lock.json', '{"lockfileVersion": 3}');
    const lock = sig();
    expect(lock).not.toBe(manifest);
    write('packages/web/package.json', JSON.stringify({ name: 'web' }));
    expect(sig()).not.toBe(lock);
  });

  it('changes when a manifest is removed', () => {
    const base = sig();
    fs.unlinkSync(path.join(root, 'package.json'));
    expect(sig()).not.toBe(base);
  });
});

describe('planSecurityRun', () => {
  it('runs everything without a recorded run', () => {
    expect(planSecurityRun(root, config, false)).toMatchObject({ manifests: true, enrich: true, graph: true, skip: false });
  });

  it('skips when nothing changed and the data is fresh', () => {
    record();
    expect(planSecurityRun(root, config, false)).toMatchObject({ manifests: false, enrich: false, graph: false, skip: true });
  });

  it('redoes only the graph work when source changed', () => {
    record();
    expect(planSecurityRun(root, config, true)).toMatchObject({ manifests: false, enrich: false, graph: true, skip: false });
  });

  it('redoes everything when a manifest or lock file changed', () => {
    record();
    write('package-lock.json', '{"changed": true}');
    expect(planSecurityRun(root, config, false)).toMatchObject({ manifests: true, enrich: true, graph: true, skip: false });
  });

  it('refreshes vulnerability data after securityEnrichMaxAgeDays, even with nothing changed', () => {
    const now = Date.now();
    record(now - 8 * DAY);
    expect(planSecurityRun(root, config, false, now)).toMatchObject({ manifests: false, enrich: true, graph: true, skip: false });
    record(now - 6 * DAY);
    expect(planSecurityRun(root, config, false, now).skip).toBe(true);
    expect(planSecurityRun(root, { ...config, securityEnrichMaxAgeDays: 5 }, false, now).enrich).toBe(true);
  });

  it('runs everything when the security configuration changed', () => {
    record();
    expect(planSecurityRun(root, { ...config, securityDatabases: ['OSV', 'NVD'] as never }, false).manifests).toBe(true);
  });

  it('treats an unreadable state as none', () => {
    write('.kirograph/security-state.json', '{broken');
    expect(readSecurityState(root)).toBeNull();
    expect(planSecurityRun(root, config, false).skip).toBe(false);
  });
});

describe('security phase of a sync', () => {
  it('does not parse manifests again for a source-only change, and does for a manifest change', async () => {
    const { execFileSync } = await import('child_process');
    const { vi } = await import('vitest');
    const { default: KiroGraph } = await import('../../src/index');
    const { ManifestParser } = await import('../../src/security/manifest/parser');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, stdio: 'ignore' });
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'i');

    // No network: auto-enrichment off
    const kg = await KiroGraph.init(root, { enableSecurity: true, enableArchitecture: true, securityAutoEnrich: false });
    const parse = vi.spyOn(ManifestParser.prototype, 'parseAll');
    try {
      await kg.indexAll();
      expect(parse).toHaveBeenCalledTimes(1); // an index runs everything

      write('src/a.ts', 'export const a = 2;\nexport const b = 3;\n');
      await kg.sync();
      expect(parse).toHaveBeenCalledTimes(1); // source change: manifests untouched

      write('package.json', JSON.stringify({ name: 'a', dependencies: { left: '3.0.0' } }));
      await kg.sync();
      expect(parse).toHaveBeenCalledTimes(2); // manifest change: parsed again
    } finally {
      parse.mockRestore();
      kg.close();
    }
  });
});
