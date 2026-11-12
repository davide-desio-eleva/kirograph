import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { requireEngine, resolveEngine, enginesDir } from '../src/shared/engines';

let dir: string;
const saved = process.env.KIROGRAPH_ENGINES_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-engines-'));
  process.env.KIROGRAPH_ENGINES_DIR = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.KIROGRAPH_ENGINES_DIR; else process.env.KIROGRAPH_ENGINES_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

const fake = (name: string, body: string) => {
  const pkg = path.join(dir, 'node_modules', name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), body);
};

describe('optional packages', () => {
  it('live in a folder of their own, not in the project', () => {
    delete process.env.KIROGRAPH_ENGINES_DIR;
    expect(enginesDir()).toBe(path.join(os.homedir(), '.kirograph', 'engines'));
  });

  it('are loaded from the engines folder when KiroGraph itself does not have them', () => {
    fake('kg-fake-engine', 'module.exports = { where: "engines" };');
    expect(requireEngine('kg-fake-engine')).toEqual({ where: 'engines' });
    expect(resolveEngine('kg-fake-engine')).toContain(path.join('kg-fake-engine', 'index.js'));
  });

  it('are found when KiroGraph has them', () => {
    expect(requireEngine('commander')).toBeTruthy();
  });

  it('report a missing package as missing, and a broken one as broken', () => {
    expect(() => requireEngine('kg-not-installed-anywhere')).toThrow(/Cannot find module/);
    expect(resolveEngine('kg-not-installed-anywhere')).toBeNull();
    fake('kg-broken-engine', 'throw new Error("native module built for another Node");');
    expect(() => requireEngine('kg-broken-engine')).toThrow(/another Node/);
  });
});
