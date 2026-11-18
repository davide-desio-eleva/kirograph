import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

async function extract(name: string, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-c-'));
  try {
    fs.writeFileSync(path.join(root, name), text);
    const r = await extractFile(path.join(root, name), root);
    return {
      symbols: (r?.nodes ?? []).filter(n => n.kind !== 'import').map(n => `${n.kind} ${n.name}`),
      calls: (r?.unresolvedRefs ?? []).filter(x => x.refKind === 'function').map(x => x.refName),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('C and C++ declarations', () => {
  it('C: functions by their declarator, structs with a body, enums, typedefs; not prototypes', async () => {
    const { symbols, calls } = await extract('jv.c', [
      'typedef struct { int kind; } jv;',
      'struct node { int v; struct node *next; };',
      'enum color { RED };',
      'jv jv_proto(void);',
      'static jv jv_null(void) { return make(1); }',
      'static int *mk(struct node *n) { return 0; }',
      '',
    ].join('\n'));
    expect(symbols).toEqual(['type_alias jv', 'struct node', 'enum color', 'function jv_null', 'function mk']);
    expect(calls).toEqual(['make']);
  });

  it('C++: namespaces, classes, methods in and out of the class, constructors, operators', async () => {
    const { symbols, calls } = await extract('formatter.cpp', [
      'namespace fmt {',
      'class Formatter {',
      ' public:',
      '  int width() const;',
      '  Formatter();',
      '  ~Formatter();',
      '  bool operator==(const Formatter&) const;',
      '};',
      'int Formatter::width() const { return detail::helper<int>(1); }',
      'template <typename T> T twice(T v) { return v + v; }',
      'FMT_CONSTEXPR20 auto grow(int n) -> void { reserve(n); }',
      '}',
      '',
    ].join('\n'));
    expect(symbols).toEqual([
      'namespace fmt', 'class Formatter', 'method width', 'method Formatter', 'method ~Formatter',
      'method operator==', 'method width', 'function twice', 'function grow',
    ]);
    // `detail::helper<int>(1)` calls helper; the namespace node collects the calls inside it too
    expect(new Set(calls)).toEqual(new Set(['helper', 'reserve']));
  });
});
