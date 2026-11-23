import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

describe('ReScript', () => {
  it('extracts functions, variables, types and modules', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-rescript-'));
    try {
      const file = path.join(root, 'Counter.res');
      fs.writeFileSync(file, [
        'type state = {count: int}',
        '',
        'let initial = {count: 0}',
        '',
        'let increment = (s, n) => {count: s.count + n}',
        '',
        'module View = {',
        '  let render = s => Js.log(s.count)',
        '}',
        '',
      ].join('\n'));
      const result = await extractFile(file, root);
      const symbols = (result?.nodes ?? []).map(n => `${n.kind} ${n.name}`).sort();
      expect(symbols).toEqual(['function increment', 'function render', 'module View', 'type_alias state', 'variable initial']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
