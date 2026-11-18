import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

/**
 * A call on a receiver whose type the code declares reaches the method of that type, or of its
 * supertypes. Every type below has a `save` and a `find`: only the type says which one is called.
 */

let root: string;
let calls: Record<string, string[]>;

const files: Record<string, string> = {
  'src/base-repo.ts': 'export class BaseRepo {\n  find(id: string) { return id; }\n}\n',
  'src/user-repo.ts': 'import { BaseRepo } from "./base-repo";\nexport class UserRepo extends BaseRepo {\n  save(u: unknown) { return u; }\n}\n',
  'src/order-store.ts': 'export class OrderStore {\n  save(o: unknown) { return o; }\n  find(id: string) { return id; }\n}\n',
  'src/service.ts': [
    'import { UserRepo } from "./user-repo";',
    'import { Client } from "some-library";',
    'export class Service {',
    '  constructor(private readonly users: UserRepo, private client: Client) {}',
    '  persist(u: unknown) { return this.users.save(u); }',   // constructor parameter property
    '  lookup(id: string) { return this.users.find(id); }',   // inherited from BaseRepo
    '  remote(id: string) { return this.client.find(id); }',  // a library type: not the project's
    '}',
    'export function viaParam(repo: UserRepo) { return repo.save(1); }',
    'export function viaLocal() { const store = new OrderStore(); return store.save(1); }',
    '',
  ].join('\n'),
  'app/models.py': 'class Repo:\n    def save(self, x):\n        return x\n\nclass Store:\n    def save(self, x):\n        return x\n',
  'app/service.py': [
    'from app.models import Repo, Store',
    '',
    'class PyService:',
    '    def __init__(self, repo: Repo):',
    '        self.repo = repo',
    '',
    '    def persist_py(self, x):',
    '        return self.repo.save(x)',
    '',
    'def keep(x):',
    '    store = Store()',
    '    return store.save(x)',
    '',
  ].join('\n'),
  'src/main/java/app/Ledger.java': 'package app;\npublic class Ledger {\n  public void save(Object o) {}\n}\n',
  'src/main/java/app/Journal.java': 'package app;\npublic class Journal {\n  public void save(Object o) {}\n}\n',
  'src/main/java/app/Bookkeeper.java': [
    'package app;',
    'public class Bookkeeper {',
    '  private Ledger ledger;',
    '  public void book(Object o) { ledger.save(o); }',
    '  public void note(Journal journal, Object o) { journal.save(o); }',
    '}',
    '',
  ].join('\n'),
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-recv-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.writeFileSync(path.join(root, 'app/__init__.py'), '');
  const kg = await KiroGraph.init(root);
  try {
    await kg.indexAll();
    const rows = (kg as any).db.getRawDb().all(`
      SELECT s.name AS s, t.file_path || '::' || t.name AS t FROM edges e
      JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'calls' ORDER BY 1, 2`);
    calls = {};
    for (const r of rows) (calls[r.s] ??= []).push(r.t);
  } finally { kg.close(); }
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('receivers with a declared type', () => {
  it('TypeScript: a constructor parameter property', () => {
    expect(calls.persist).toEqual(['src/user-repo.ts::save']);
  });

  it('TypeScript: a method the type inherits', () => {
    expect(calls.lookup).toEqual(['src/base-repo.ts::find']);
  });

  it('TypeScript: a type from a library is not a project type with the method', () => {
    expect(calls.remote).toBeUndefined();
  });

  it('TypeScript: a typed parameter and a local made with new', () => {
    expect(calls.viaParam).toEqual(['src/user-repo.ts::save']);
    expect(calls.viaLocal).toEqual(['src/order-store.ts::save']);
  });

  it('Python: self.x assigned a typed parameter, and a local made by a constructor call', () => {
    expect(calls.persist_py).toEqual(['app/models.py::save']);
    expect(calls.keep).toEqual(['app/models.py::Store', 'app/models.py::save']);
  });

  it('Java: a field and a typed parameter', () => {
    expect(calls.book).toEqual(['src/main/java/app/Ledger.java::save']);
    expect(calls.note).toEqual(['src/main/java/app/Journal.java::save']);
  });
});
