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
});
