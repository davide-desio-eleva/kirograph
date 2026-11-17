import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

/**
 * After any sync, the graph must be the one a full index of the same files gives (#101).
 * Edges and unresolved references are compared by what they connect, not by row ids.
 */

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

function snapshot(kg: any): { edges: string[]; refs: string[] } {
  const db = kg.db.getRawDb();
  const edges = db.all(`SELECT s.file_path || '::' || s.name AS s, e.kind AS k, t.file_path || '::' || t.name AS t, e.line AS l
                        FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target`)
    .map((r: any) => `${r.s} -${r.k}@${r.l}-> ${r.t}`).sort();
  const refs = db.all(`SELECT n.file_path || '::' || n.name AS s, u.ref_kind AS k, u.ref_name AS r, u.line AS l
                       FROM unresolved_refs u JOIN nodes n ON n.id = u.source_id`)
    .map((r: any) => `${r.s} ${r.k} ${r.r}@${r.l}`).sort();
  return { edges, refs };
}

async function fullIndexOf(): Promise<{ edges: string[]; refs: string[] }> {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-full-'));
  try {
    for (const f of execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)) {
      if (!fs.existsSync(path.join(root, f))) continue;
      fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(copy, f));
    }
    const kg = await KiroGraph.init(copy);
    try {
      await kg.indexAll();
      return snapshot(kg);
    } finally {
      kg.close();
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-sync-eq-'));
  git('init', '-q');
  write('.gitignore', '.kirograph\n');
  write('src/base.ts', 'export abstract class Base { run() { return 1; } }\nexport function helper() { return 2; }\n');
  write('src/a.ts', 'import { Base, helper } from "./base";\nexport class A extends Base { go() { return helper() + this.run(); } }\n');
  write('src/b.ts', 'import { A } from "./a";\nimport { helper } from "./base";\nexport function b() { return new A().go() + helper(); }\n');
  write('src/c.ts', 'import { b } from "./b";\nexport const c = () => b();\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('a sync gives the graph of a full index (#101)', () => {
  const cases: Array<[string, () => void]> = [
    ['a file other files call into is edited', () => write('src/base.ts', '// edited\nexport abstract class Base { run() { return 1; } }\nexport function helper() { return 2; }\n')],
    ['a called function is renamed', () => write('src/base.ts', 'export abstract class Base { run() { return 1; } }\nexport function helper2() { return 2; }\n')],
    ['a file other files import is removed', () => fs.rmSync(path.join(root, 'src/b.ts'))],
    ['a calling file is edited', () => write('src/c.ts', 'import { b } from "./b";\nexport const c = () => b() + b();\n')],
    ['a file is added that defines a called name', () => write('src/d.ts', 'export function helper() { return 3; }\n')],
  ];
  for (const [name, change] of cases) {
    it(name, async () => {
      const kg = await KiroGraph.init(root);
      try {
        await kg.indexAll();
        change();
        await kg.sync();
        expect(snapshot(kg)).toEqual(await fullIndexOf());
      } finally {
        kg.close();
      }
    });
  }
});
