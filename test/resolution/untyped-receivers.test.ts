import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

/**
 * Calls on receivers whose type the code does not write down (#116): a function's return type
 * inferred from what it returns, a class's own constructor (`cls()`, `self.__class__()`), Ruby's
 * `Foo.new`, and the caller's own class for calls a class node or a local variable holds. Every
 * project has two types with a `save`; only the receiver says which one is called.
 */

let root: string;
/** Caller name → `file::owner of the save it reaches`. */
let calls: Record<string, string[]>;

const files: Record<string, string> = {
  // Python: inferred return types, own-class constructors
  'py/types.py': [
    'class Ledger:',
    '    def save(self): pass',
    '    def clone(self):',
    '        return self.__class__()',
    '    @classmethod',
    '    def create(cls):',
    '        return cls()',
    '',
    'class Journal:',
    '    def save(self): pass',
    '',
    'def make_ledger():',
    '    return Ledger()',
    '',
    'def make_either(flag):',
    '    if flag:',
    '        return Ledger()',
    '    return Journal()',
    '',
  ].join('\n'),
  'py/service.py': [
    'from types import Ledger, make_ledger, make_either',
    '',
    'def py_inferred():',
    '    make_ledger().save()',
    '',
    'def py_chain():',
    '    make_ledger().clone().save()',
    '',
    'def py_cls():',
    '    Ledger.create().save()',
    '',
    'def py_ambiguous():',
    '    make_either(True).save()',
    '',
  ].join('\n'),
  // JavaScript: a function that returns a `new`, without a declared type
  'js/types.js': 'class JLedger { save() {} }\nclass JJournal { save() {} }\nfunction makeJLedger() { return new JLedger(); }\nconst buildJLedger = () => new JLedger();\nmodule.exports = { JLedger, JJournal, makeJLedger, buildJLedger };\n',
  'js/service.js': "const { makeJLedger, buildJLedger } = require('./types');\nfunction jsInferred() { makeJLedger().save(); }\nfunction jsArrow() { buildJLedger().save(); }\n",
  // The caller's own class: a nested class's calls, a local variable that holds a call
  'cls/nested.py': [
    'class Outer:',
    '    def save(self): pass',
    '    class Inner:',
    '        def save(self): pass',
    '        def inner_calls(self):',
    '            self.save()',
    '',
    'class Other:',
    '    def save(self): pass',
    '    def other_local(self):',
    '        done = self.save()',
    '        return done',
    '',
  ].join('\n'),
  // Ruby: locals, instance variables, Foo.new, a method's last expression, Class.new(Base)
  'rb/lib/types.rb': [
    'class RLedger',
    '  def save; end',
    'end',
    'class RJournal',
    '  def save; end',
    'end',
    'module Factory',
    '  def self.new(kind)',
    '    RJournal.new',
    '  end',
    'end',
    '',
  ].join('\n'),
  'rb/lib/service.rb': [
    'class RService',
    '  def initialize',
    '    @ledger = RLedger.new',
    '    @sub = Class.new(RLedger)',
    '  end',
    '  def rb_local',
    '    l = RLedger.new',
    '    l.save',
    '  end',
    '  def rb_ivar',
    '    @ledger.save',
    '  end',
    '  def rb_new',
    '    RLedger.new.save',
    '  end',
    '  def make_ledger',
    '    RLedger.new',
    '  end',
    '  def rb_returned',
    '    make_ledger.save',
    '  end',
    '  def rb_subclass',
    '    @sub.save',
    '  end',
    '  def rb_module_factory',
    '    rledger = Factory.new(:x)',
    '    rledger.save',
    '  end',
    'end',
    '',
  ].join('\n'),
  // Ruby: a type of the same name in another gem of the repository is not the one meant
  'other-gem/lib/client.rb': 'class Client\n  def rb_other_gem\n    l = RLedger.new\n    l.save\n  end\nend\n',
  // Elements of collections, parameters typed by a default or by the file's callers, a field set from a call
  'el/service.py': [
    'from typing import List',
    'from types import Ledger, make_ledger',
    '',
    'class Shelf:',
    '    books: List[Ledger]',
    '    def __init__(self):',
    '        self.made = make_ledger()',
    '    def py_comprehension(self):',
    '        return [b.save() for b in self.books]',
    '    def py_field_from_call(self):',
    '        self.made.save()',
    '    def py_caller_typed(self):',
    '        self._store(Ledger())',
    '    def _store(self, item):',
    '        item.save()',
    '',
    'def py_loop(ledgers: list[Ledger]):',
    '    for ledger in ledgers:',
    '        ledger.save()',
    '',
    'def py_default(ledger=Ledger()):',
    '    ledger.save()',
    '',
  ].join('\n'),
  'el/service.ts': [
    "import { JLedger } from '../js/types';",
    'function tsLoop(xs: JLedger[]) { for (const x of xs) x.save(); }',
    'function tsCallback(xs: Array<JLedger>) { xs.forEach(x => x.save()); }',
    'function tsArrayItself(xs: JLedger[]) { xs.save(); }',
    '',
  ].join('\n'),
  'el/Service.java': [
    'import java.util.List;',
    'class JavaLedger { void save() {} }',
    'class JavaJournal { void save() {} }',
    'class Service {',
    '  void javaVar(List<JavaLedger> xs) { for (var x : xs) x.save(); }',
    '  void javaLambda(List<JavaLedger> xs) { xs.forEach(x -> x.save()); }',
    '}',
    '',
  ].join('\n'),
  // A receiver named for a collection is not an instance of a class that shares its last word
  'coll/records.py': 'class RecordSet:\n    def save(self): pass\n',
  'coll/use.py': 'def py_collection(article_set):\n    article_set.save()\n\ndef py_whole_name(record_set):\n    record_set.save()\n',
  // A parameter called is the function passed in, not one of the project's of its name
  'param/lib.js': 'function save() {}\nfunction jsCallsParameter(save) { save(); }\nmodule.exports = { save, jsCallsParameter };\n',
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-untyped-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const kg = await KiroGraph.init(root);
  try {
    await kg.indexAll();
    const rows = (kg as any).db.getRawDb().all(`
      SELECT s.name AS s, t.file_path || '::' || o.name AS t FROM edges e
      JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      LEFT JOIN edges c ON c.target = t.id AND c.kind = 'contains' LEFT JOIN nodes o ON o.id = c.source
      WHERE e.kind = 'calls' AND t.name = 'save'`);
    calls = {};
    for (const r of rows) (calls[r.s] ??= []).push(r.t);
  } finally { kg.close(); }
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Calls on receivers whose type is inferred', () => {
  it('Python: a function returns what it constructs; cls() and self.__class__() are the own class', () => {
    expect(calls.py_inferred).toEqual(['py/types.py::Ledger']);
    expect(calls.py_chain).toEqual(['py/types.py::Ledger']);
    expect(calls.py_cls).toEqual(['py/types.py::Ledger']);
  });

  it('Python: a function that returns two types types nothing', () => {
    expect(calls.py_ambiguous).toBeUndefined();
  });

  it('JavaScript: a function and an arrow function that return a new', () => {
    expect(calls.jsInferred).toEqual(['js/types.js::JLedger']);
    expect(calls.jsArrow).toEqual(['js/types.js::JLedger']);
  });

  it("a nested class's call reaches the nested class, a local variable's its method's class", () => {
    expect(calls.inner_calls).toEqual(['cls/nested.py::Inner']);
    expect(calls.Inner).toEqual(['cls/nested.py::Inner']);
    // Outer's node holds Inner's call too: still Inner's save, not Outer's
    expect(calls.Outer).toEqual(['cls/nested.py::Inner']);
    expect(calls.done).toEqual(['cls/nested.py::Other']);
  });

  it('Ruby: a local, an instance variable, Foo.new, a method that returns a Foo.new', () => {
    expect(calls.rb_local).toEqual(['rb/lib/types.rb::RLedger']);
    expect(calls.rb_ivar).toEqual(['rb/lib/types.rb::RLedger']);
    expect(calls.rb_new).toEqual(['rb/lib/types.rb::RLedger']);
    expect(calls.rb_returned).toEqual(['rb/lib/types.rb::RLedger']);
  });

  it("Ruby: Class.new(Base) is a Base; a module's own new is no constructor, the receiver's name rules", () => {
    expect(calls.rb_subclass).toEqual(['rb/lib/types.rb::RLedger']);
    expect(calls.rb_module_factory).toEqual(['rb/lib/types.rb::RLedger']);
  });

  it('Ruby: a type of another gem of the repository is not the one meant', () => {
    expect(calls.rb_other_gem).toBeUndefined();
  });

  it('an element of a typed collection: a loop, a comprehension, a callback, Java var and lambdas', () => {
    expect(calls.py_loop).toEqual(['py/types.py::Ledger']);
    expect(calls.py_comprehension).toEqual(['py/types.py::Ledger']);
    expect(calls.tsLoop).toEqual(['js/types.js::JLedger']);
    expect(calls.tsCallback).toEqual(['js/types.js::JLedger']);
    expect(calls.javaVar).toEqual(['el/Service.java::JavaLedger']);
    expect(calls.javaLambda).toEqual(['el/Service.java::JavaLedger']);
    // The array is no JLedger
    expect(calls.tsArrayItself).toBeUndefined();
  });

  it("a parameter typed by its default or by its file's callers; a field set from a call", () => {
    expect(calls.py_default).toEqual(['py/types.py::Ledger']);
    expect(calls._store).toEqual(['py/types.py::Ledger']);
    expect(calls.py_field_from_call).toEqual(['py/types.py::Ledger']);
  });

  it('a receiver named for a collection reaches only a class of its whole name', () => {
    expect(calls.py_collection).toBeUndefined();
    expect(calls.py_whole_name).toEqual(['coll/records.py::RecordSet']);
  });

  it('a parameter called is the function passed in', () => {
    expect(calls.jsCallsParameter).toBeUndefined();
  });
});

/** Calls to `save`: caller name → `file::owner of the save it reaches`. */
function saveCalls(kg: any): Record<string, string[]> {
  const rows = kg.db.getRawDb().all(`
    SELECT s.name AS s, t.file_path || '::' || o.name AS t FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    LEFT JOIN edges c ON c.target = t.id AND c.kind = 'contains' LEFT JOIN nodes o ON o.id = c.source
    WHERE e.kind = 'calls' AND t.name = 'save'`);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.s] ??= []).push(r.t);
  return out;
}

describe('Prototype methods, lists, parameters typed by callers of other files, and a sync', () => {
  let dir: string;
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-untyped2-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // JavaScript constructor functions and their prototype methods
    write('proto/repo.js', [
      'function PRepo () {}',
      'PRepo.prototype.save = function () { return this }',
      'function PJournal () {}',
      'PJournal.prototype.save = function () {}',
      'function protoCall () { const r = new PRepo(); r.save() }',
      'function protoChain () { const saved = new PRepo().save(); saved.save() }',
      'module.exports = { PRepo, PJournal }',
      '',
    ].join('\n'));
    write('lists/types.py', 'class Ledger:\n    def save(self): pass\n\nclass Journal:\n    def save(self): pass\n');
    write('lists/use.py', [
      'from types import Ledger',
      '',
      'def make_list():',
      '    return [Ledger(), Ledger()]',
      '',
      'def list_appended():',
      '    out = []',
      '    out.append(Ledger())',
      '    for item in out:',
      '        item.save()',
      '',
      'def list_returned():',
      '    for item in make_list():',
      '        item.save()',
      '',
      'def list_itself():',
      '    make_list().save()',
      '',
    ].join('\n'));
    // Parameters typed by their callers, in other files
    write('params/lib.py', 'def use_one(thing):\n    thing.save()\n\ndef use_mixed(thing):\n    thing.save()\n');
    write('params/a.py', 'from types import PLedger, PJournal\nfrom lib import use_one, use_mixed\n\ndef call_a():\n    use_one(PLedger())\n    use_mixed(PLedger())\n');
    write('params/b.py', 'from types import PLedger, PJournal\nfrom lib import use_one, use_mixed\n\ndef call_b():\n    use_one(thing=PLedger())\n    use_mixed(PJournal())\n');
    write('params/types.py', 'class PLedger:\n    def save(self): pass\n\nclass PJournal:\n    def save(self): pass\n');
    // A receiver typed by what a function of another file returns
    write('prod/types.py', 'class QLedger:\n    def save(self): pass\n\nclass QJournal:\n    def save(self): pass\n');
    write('prod/maker.py', 'from types import QLedger, QJournal\n\ndef make():\n    return QLedger()\n');
    write('prod/user.py', 'from maker import make\n\ndef produced():\n    make().save()\n');
    // A method looked up in a supertype
    write('sup/base.py', 'class Base:\n    def save(self): pass\n');
    write('sup/sub.py', 'from base import Base\n\nclass Sub(Base):\n    pass\n');
    write('sup/user.py', 'from sub import Sub\n\ndef inherited(s: Sub):\n    s.save()\n');
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads them, and a sync gives what a full index gives when a caller or a subclass changes', async () => {
    const kg = await KiroGraph.init(dir);
    try {
      await kg.indexAll();
      let calls = saveCalls(kg);
      expect(calls.protoCall).toEqual(['proto/repo.js::PRepo']);
      // save() returns this: the second save is PRepo's too
      expect(calls.protoChain).toEqual(['proto/repo.js::PRepo', 'proto/repo.js::PRepo']);
      expect(calls.list_appended).toEqual(['lists/types.py::Ledger']);
      expect(calls.list_returned).toEqual(['lists/types.py::Ledger']);
      expect(calls.list_itself).toBeUndefined();
      expect(calls.use_one).toEqual(['params/types.py::PLedger']);
      expect(calls.use_mixed).toBeUndefined();
      expect(calls.inherited).toEqual(['sup/base.py::Base']);
      expect(calls.produced).toEqual(['prod/types.py::QLedger']);

      // A new caller passes another class; Sub gets its own save; make() returns another class
      write('prod/maker.py', 'from types import QLedger, QJournal\n\ndef make():\n    return QJournal()\n');
      write('params/c.py', 'from types import PJournal\nfrom lib import use_one\n\ndef call_c():\n    use_one(PJournal())\n');
      write('sup/sub.py', 'from base import Base\n\nclass Sub(Base):\n    def save(self): pass\n');
      await kg.sync();
      calls = saveCalls(kg);
      expect(calls.use_one).toBeUndefined();
      expect(calls.inherited).toEqual(['sup/sub.py::Sub']);
      expect(calls.produced).toEqual(['prod/types.py::QJournal']);
    } finally { kg.close(); }

    // The same as a full index of the files as they are now
    fs.rmSync(path.join(dir, '.kirograph'), { recursive: true, force: true });
    const full = await KiroGraph.init(dir);
    try {
      await full.indexAll();
      const calls = saveCalls(full);
      expect(calls.use_one).toBeUndefined();
      expect(calls.inherited).toEqual(['sup/sub.py::Sub']);
      expect(calls.produced).toEqual(['prod/types.py::QJournal']);
    } finally { full.close(); }
  });
});

describe('Review cases: shadowing, project generics, arguments, comprehensions, Ruby locals', () => {
  let dir: string;
  let calls: Record<string, string[]>;
  const files: Record<string, string> = {
    'rv/types.ts': 'export class RLedger { save() {} }\nexport class RJournal { save() {} }\nexport class Queue<T> { push(x: T) {} save() {} }\n',
    // An anonymous callback's `item` is not the outer function's `item`
    'rv/shadow.ts': [
      "import { RLedger } from './types';",
      'export function outer(item) { [1].forEach((item) => item.save()); }',
      'export function caller() { outer(new RLedger()); }',
      '',
    ].join('\n'),
    // A project class named Queue keeps its own methods
    'rv/queue.ts': [
      "import { Queue, RLedger } from './types';",
      'export function useQueue(q: Queue<RLedger>) { q.push(new RLedger()); for (const x of q.items) x.save(); }',
      'export function makeQueue(): Queue<RLedger> { return new Queue(); }',
      'export function useMade() { makeQueue().push(new RLedger()); }',
      '',
    ].join('\n'),
    'rv/types.py': 'class PyLedger:\n    def save(self): pass\n\nclass PyJournal:\n    def save(self): pass\n',
    // A keyword passed with an unknown value is passed: the parameter stays untyped
    'rv/kw.py': [
      'from types import PyLedger, PyJournal',
      '',
      'def kw_target(a, x):',
      '    x.save()',
      '',
      'def kw_callers(something):',
      '    kw_target(PyLedger(), x=something)',
      '    kw_target(PyLedger(), PyJournal())',
      '',
      // A caller that passes nothing leaves the default: the others type it
      'def default_target(repo=None):',
      '    repo.save()',
      '',
      'def default_callers():',
      '    default_target()',
      '    default_target(PyLedger())',
      '',
      // A comprehension's variable does not replace the parameter of the name
      'def comprehension(order: PyLedger, history):',
      '    ids = [order.x for order in history]',
      '    order.save()',
      '',
    ].join('\n'),
    // Ruby: locals bound by multiple assignment, ||=, rescue, for: not methods called without parentheses
    'rb2/lib/r.rb': [
      'class RbLedger',
      '  def save; end',
      'end',
      'class Rb',
      '  def user',
      '    RbLedger.new',
      '  end',
      '  def rb_multiple',
      '    user, other = load',
      '    user.save',
      '  end',
      'end',
      '',
    ].join('\n'),
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-review-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    const kg = await KiroGraph.init(dir);
    try {
      await kg.indexAll();
      calls = saveCalls(kg);
      const push = (kg as any).db.getRawDb().all(`SELECT s.name AS s FROM edges e JOIN nodes s ON s.id = e.source
        JOIN nodes t ON t.id = e.target WHERE e.kind = 'calls' AND t.name = 'push'`).map((r: any) => r.s);
      calls.__push = push;
    } finally { kg.close(); }
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("an anonymous callback's parameter is not the outer function's", () => {
    expect(calls.outer).toBeUndefined();
  });

  it("the project's own generic class keeps its methods", () => {
    expect(calls.__push).toContain('useQueue');
    expect(calls.__push).toContain('useMade');
  });

  it('a keyword with an unknown value counts; a caller passing nothing does not', () => {
    expect(calls.kw_target).toBeUndefined();
    expect(calls.default_target).toEqual(['rv/types.py::PyLedger']);
  });

  it("a comprehension's variable leaves the parameter's type", () => {
    expect(calls.comprehension).toEqual(['rv/types.py::PyLedger']);
  });

  it('Ruby: a local bound by multiple assignment is no method call', () => {
    expect(calls.rb_multiple).toBeUndefined();
  });
});
