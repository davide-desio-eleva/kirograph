import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

/** Which node each call reaches, by name: a call resolved to the wrong function is worse than none. */

let root: string;
let calls: Record<string, string[]>;

const files: Record<string, string> = {
  // `test` and `build` are jobs of the workflow and scripts of package.json
  '.github/workflows/ci.yml': [
    'name: CI', 'on: push', 'jobs:',
    '  test:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm test',
    '  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm run build', '',
  ].join('\n'),
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest', build: 'tsc' } }),
  'test/helper.js': 'export function test(name, fn) { return fn(); }\nexport const next = () => 0;\n',
  'src/user-service.js': 'export class UserService {\n  find(id) { return this.load(id); }\n  load(id) { return id; }\n}\n',
  'src/order-service.js': 'export class OrderService {\n  find(id) { return id; }\n}\n',
  'src/format.js': 'export function format(x) { return x; }\n',
  'src/other-format.js': 'export function format(x) { return String(x); }\n',
  'src/app.js': [
    'import { format } from "./format";',
    'export function build() { return 1; }',
    'export function check(s) { return /x/.test(s) && build(); }',
    'export function show(userService, x) { return userService.find(x) + format(x); }',
    'export function later(next) { return next(); }',
    '',
  ].join('\n'),
  'src/loose.js': 'export function shown(x) { return format(x); }\n',
  // A non-test file never calls into a test: `src/storage.js` seeks its own file, not the stub
  'src/storage.js': 'export function rewind(file) { return file.seek(0); }\n',
  'test/fake-file.test.js': 'export class FakeFile {\n  seek(n) { return n; }\n}\n',
  // Python: a class re-exported by its package, a submodule, and a standard library name
  'pkg/__init__.py': '',
  'pkg/template/__init__.py': 'from .base import Template\n',
  'pkg/template/base.py': 'class Template:\n    pass\n',
  'pkg/backends/django.py': 'class Template:\n    pass\n',
  'pkg/db/__init__.py': '',
  'pkg/db/models/__init__.py': 'from pkg.db.models.fields import CharField\n',
  'pkg/db/models/fields.py': 'class CharField:\n    pass\n',
  'pkg/forms/__init__.py': '',
  'pkg/forms/fields.py': 'class CharField:\n    pass\n',
  'pkg/utils/__init__.py': '',
  'pkg/utils/copy.py': 'def deepcopy(x):\n    return x\n',
  'app/views.py': [
    'import copy',
    'from pkg.template import Template',
    'from pkg.db import models',
    'from pkg.forms import fields',
    '',
    'def render():',
    '    return Template()',
    '',
    'def field():',
    '    return models.CharField()',
    '',
    'def clone(x):',
    '    return copy.deepcopy(x)',
    '',
  ].join('\n'),
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-calls-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
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

describe('call resolution by name', () => {
  it('a method of some object is not a function or a CI job of the same name', () => {
    // `pattern.test()` is a RegExp's: not the test helper, not the `test` job, not the script
    expect(calls.check).toEqual(['src/app.js::build']);
  });

  it('a call on a receiver reaches the method of the type the receiver names', () => {
    expect(calls.show).toContain('src/user-service.js::find');
    expect(calls.show).not.toContain('src/order-service.js::find');
  });

  it('a call on this reaches the method of its own class', () => {
    expect(calls.find).toEqual(['src/user-service.js::load']);
  });

  it('a bare call reaches the function the file imports, among several of the name', () => {
    expect(calls.show).toContain('src/format.js::format');
    expect(calls.show).not.toContain('src/other-format.js::format');
  });

  it('a bare call with several candidates and no import stays unresolved', () => {
    expect(calls.shown).toBeUndefined();
  });

  it('a bare call does not reach a value of another file (a parameter of the name)', () => {
    expect(calls.later).toBeUndefined();
  });

  it('code that is not a test does not call into a test', () => {
    expect(calls.rewind).toBeUndefined();
  });

  it('a Python call reaches the class its package re-exports', () => {
    expect(calls.render).toEqual(['pkg/template/base.py::Template']);
  });

  it('a Python call through a module reaches the class of that module', () => {
    // `from pkg.db import models` imports a submodule; `fields` is imported too, from forms
    expect(calls.field).toEqual(['pkg/db/models/fields.py::CharField']);
  });

  it('a Python standard library module is not a project file of the same name', () => {
    expect(calls.clone).toBeUndefined();
  });
});
