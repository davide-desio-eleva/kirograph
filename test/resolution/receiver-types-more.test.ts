import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

/**
 * A call on a receiver of a declared type, in C#, Kotlin, Swift, Go, Rust, Dart and PHP: every
 * project has two types with a `save`; only the receiver's type says which one is called.
 */

let root: string;
let calls: Record<string, string[]>;
let goLines: Record<string, number[]>;

const files: Record<string, string> = {
  'cs/Types.cs': 'class Ledger { public void Save() {} }\nclass Journal { public void Save() {} }\n',
  'cs/Service.cs': 'class Service {\n  private readonly Ledger _ledger;\n  public void CsField() { _ledger.Save(); }\n  public void CsParam(Journal j) { j.Save(); }\n  public void CsLocal() { var l = new Ledger(); l.Save(); }\n}\n',
  'kt/Types.kt': 'class KLedger { fun save() {} }\nclass KJournal { fun save() {} }\n',
  'kt/Service.kt': 'class KService(private val ledger: KLedger) {\n  fun ktField() { ledger.save() }\n  fun ktParam(j: KJournal) { j.save() }\n  fun ktLocal() { val l = KLedger(); l.save() }\n}\n',
  'swift/Types.swift': 'class SLedger { func save() {} }\nclass SJournal { func save() {} }\n',
  'swift/Service.swift': 'class SService {\n  let ledger: SLedger\n  init(ledger: SLedger) { self.ledger = ledger }\n  func swField() { self.ledger.save() }\n  func swParam(j: SJournal) { j.save() }\n  func swLocal() { let l = SLedger(); l.save() }\n}\n',
  'go/go.mod': 'module example.com/app\n',
  'go/types.go': 'package app\ntype GLedger struct{}\nfunc (g *GLedger) Save() {}\ntype GJournal struct{}\nfunc (g *GJournal) Save() {}\n',
  'go/service.go': 'package app\ntype GService struct { ledger *GLedger }\nfunc (s *GService) GoField() { s.ledger.Save() }\nfunc GoParam(j *GJournal) { j.Save() }\nfunc GoLocal() { l := &GLedger{}; l.Save() }\n',
  'rs/Cargo.toml': '[package]\nname = "app"\n',
  'rs/src/lib.rs': 'pub struct RLedger;\nimpl RLedger { pub fn save(&self) {} pub fn new() -> Self { RLedger } }\npub struct RJournal;\nimpl RJournal { pub fn save(&self) {} }\npub struct RService { ledger: RLedger }\nimpl RService {\n  pub fn rs_field(&self) { self.ledger.save(); }\n  pub fn rs_param(&self, j: &RJournal) { j.save(); }\n  pub fn rs_local(&self) { let l = RLedger::new(); l.save(); }\n}\n',
  'dart/types.dart': 'class DLedger { void save() {} }\nclass DJournal { void save() {} }\n',
  'dart/service.dart': "import 'types.dart';\nclass DService {\n  final DLedger ledger;\n  DService(this.ledger);\n  void dartField() { ledger.save(); }\n  void dartParam(DJournal j) { j.save(); }\n}\n",
  'php/Types.php': '<?php\nclass PLedger { public function save() {} }\nclass PJournal { public function save() {} }\n',
  'php/Service.php': '<?php\nclass PService {\n  public function __construct(private PLedger $ledger) {}\n  public function phpField() { $this->ledger->save(); }\n  public function phpParam(PJournal $j) { $j->save(); }\n  public function phpLocal() { $l = new PLedger(); $l->save(); }\n}\n',
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-recv2-'));
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
      WHERE e.kind = 'calls' AND lower(t.name) = 'save'`);
    calls = {};
    for (const r of rows) (calls[r.s] ??= []).push(r.t);
    goLines = {};
    for (const r of (kg as any).db.getRawDb().all(`
      SELECT s.name AS s, t.start_line AS l FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'calls' AND t.name = 'Save' AND t.language = 'go'`)) (goLines[r.s] ??= []).push(r.l);
  } finally { kg.close(); }
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('typed receivers in seven more languages', () => {
  const owner = (fn: string): string => [...new Set(calls[fn] ?? [])].join(',');
  it('C#: a field without this, a parameter, a local made with new', () => {
    expect(owner('CsField')).toBe('cs/Types.cs::Ledger');
    expect(owner('CsParam')).toBe('cs/Types.cs::Journal');
    expect(owner('CsLocal')).toBe('cs/Types.cs::Ledger');
  });
  it('Kotlin: a constructor property, a parameter, a local made by a constructor call', () => {
    expect(owner('ktField')).toBe('kt/Types.kt::KLedger');
    expect(owner('ktParam')).toBe('kt/Types.kt::KJournal');
    expect(owner('ktLocal')).toBe('kt/Types.kt::KLedger');
  });
  it('Swift: self.field, a parameter, a local', () => {
    expect(owner('swField')).toBe('swift/Types.swift::SLedger');
    expect(owner('swParam')).toBe('swift/Types.swift::SJournal');
    expect(owner('swLocal')).toBe('swift/Types.swift::SLedger');
  });
  it('Go: a field through the method receiver, a parameter, a composite literal (methods owned by their receiver type)', () => {
    // Go methods are outside their type: the method reached is told by its line (GLedger.Save 3, GJournal.Save 5)
    expect(goLines.GoField).toEqual([3]);
    expect(goLines.GoParam).toEqual([5]);
    expect(goLines.GoLocal).toEqual([3]);
  });
  it('Rust: self.field, a parameter, Type::new()', () => {
    expect(owner('rs_field')).toBe('rs/src/lib.rs::RLedger');
    expect(owner('rs_param')).toBe('rs/src/lib.rs::RJournal');
    expect(owner('rs_local')).toBe('rs/src/lib.rs::RLedger');
  });
  it('Dart: a field without this, a parameter', () => {
    expect(owner('dartField')).toBe('dart/types.dart::DLedger');
    expect(owner('dartParam')).toBe('dart/types.dart::DJournal');
  });
  it('PHP: a promoted property, a parameter, a local made with new', () => {
    expect(owner('phpField')).toBe('php/Types.php::PLedger');
    expect(owner('phpParam')).toBe('php/Types.php::PJournal');
    expect(owner('phpLocal')).toBe('php/Types.php::PLedger');
  });
});
