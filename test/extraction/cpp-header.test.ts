import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

async function extract(name: string, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-h-'));
  try {
    fs.writeFileSync(path.join(root, name), text);
    return await extractFile(path.join(root, name), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('.h files', () => {
  it('a header written in C++ is parsed as C++', async () => {
    const r = await extract('format.h', [
      '#pragma once',
      'namespace fmt {',
      'class formatter {',
      ' public:',
      '  int width() const { return 0; }',
      '};',
      '}',
      '',
    ].join('\n'));
    expect(r?.language).toBe('cpp');
    expect(r?.nodes.map(n => `${n.kind} ${n.name}`)).toContain('class formatter');
  });

  it('a C header, with its extern "C" guard for C++ callers, stays C', async () => {
    const r = await extract('jv.h', [
      '#ifdef __cplusplus',
      'extern "C" {',
      '#endif',
      'typedef struct { int kind; } jv;',
      'jv jv_null(void);',
      '#ifdef __cplusplus',
      '}',
      '#endif',
      '',
    ].join('\n'));
    expect(r?.language).toBe('c');
  });
});
