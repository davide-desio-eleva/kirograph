import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

/** C / C++: a bare call reaches a function of another file only when the file's includes declare it. */

let root: string;
let calls: Record<string, string[]>;
let includes: string[];

const files: Record<string, string> = {
  // jv.h declares what jv.c and jv_print.c define (a header with prototypes only: no node)
  'src/jv.h': 'typedef int jv;\njv jv_null(void);\nvoid jv_dump(jv x);\n',
  'src/jv.c': '#include "jv.h"\njv jv_null(void) { return 0; }\n',
  'src/jv_print.c': '#include "jv.h"\nvoid jv_dump(jv x) { (void)x; }\n',
  'src/main.c': '#include <stdio.h>\n#include "jv.h"\nint run(void) { jv_dump(jv_null()); return 0; }\n',
  // Includes and declares nothing of the project: its `jv_null` is not the project's
  'tools/standalone.c': 'int other(void) { return jv_null(); }\n',
  // An extern prototype in the file declares the project's function (the linker joins them)
  'tools/linked.c': 'extern int jv_null(void);\nint linked(void) { return jv_null(); }\n',
  // A header that declares functions through a token-pasting macro, applied by a list
  'src/builtin.h': [
    '#define BINOPS \\',
    '  BINOP(plus) \\',
    '  BINOP(multiply) \\',
    '',
    '#define BINOP(name) jv binop_ ## name(jv, jv);',
    'BINOPS',
    '#undef BINOP',
    '',
  ].join('\n'),
  'src/builtin.c': '#include "jv.h"\njv binop_multiply(jv a, jv b) { return a * b; }\n',
  'src/parser.c': '#include "jv.h"\n#include "builtin.h"\njv apply(jv a, jv b) { return binop_multiply(a, b); }\n',
  // A source compiled inside others: it sees what its includers see (decNumber's decBasic.c)
  'dec/common.c': 'int dec_zero(int x) { return x * 0; }\n',
  'dec/basic.c': 'int dec_add(int a) { return dec_zero(a) + a; }\n',
  'dec/double.c': '#include "common.c"\n#include "basic.c"\n',
  // A C++ library header with an inline function, and code that includes it by a path suffix
  'include/fmt/format.h': 'namespace fmt {\ninline void copy_bytes(char* d, const char* s) { while ((*d++ = *s++)); }\n}\n',
  'test/uses-fmt.cc': '#include "fmt/format.h"\nvoid a(char* d) { copy_bytes(d, "x"); }\n',
  'test/no-fmt.cc': '#include <cstring>\nvoid b(char* d) { copy_bytes(d, "y"); }\n',
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-cinc-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const kg = await KiroGraph.init(root);
  try {
    await kg.indexAll();
    const db = (kg as any).db.getRawDb();
    const rows = db.all(`
      SELECT s.name AS s, t.file_path || '::' || t.name AS t FROM edges e
      JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'calls' ORDER BY 1, 2`);
    calls = {};
    for (const r of rows) (calls[r.s] ??= []).push(r.t);
    includes = db.all(`
      SELECT s.file_path || ' -> ' || t.file_path AS x FROM edges e
      JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'imports' ORDER BY 1`).map((r: any) => r.x);
  } finally { kg.close(); }
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('C / C++ includes', () => {
  it('a function a header declares and another source defines is reached through the header', () => {
    expect(calls.run).toEqual(['src/jv.c::jv_null', 'src/jv_print.c::jv_dump']);
  });

  it('a file that includes and declares nothing of the project does not reach a project function of the name', () => {
    expect(calls.other).toBeUndefined();
  });

  it('an extern prototype in the file declares the function another source defines', () => {
    expect(calls.linked).toEqual(['src/jv.c::jv_null']);
  });

  it('a function a header declares through a token-pasting macro', () => {
    expect(calls.apply).toEqual(['src/builtin.c::binop_multiply']);
  });

  it('a source compiled inside another sees what its includer sees', () => {
    expect(calls.dec_add).toEqual(['dec/common.c::dec_zero']);
  });

  it('a header found by its path suffix, and its inline function', () => {
    expect(calls.a).toEqual(['include/fmt/format.h::copy_bytes']);
    expect(includes).toContain('test/uses-fmt.cc -> include/fmt/format.h');
  });

  it('code that does not include the header does not reach its function', () => {
    expect(calls.b).toBeUndefined();
  });
});
