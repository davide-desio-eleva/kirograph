import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

describe('Elm', () => {
  it('extracts functions and type aliases', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-elm-'));
    try {
      const file = path.join(root, 'Main.elm');
      fs.writeFileSync(file, [
        'module Main exposing (main, update)',
        '',
        'type alias Model = { count : Int }',
        '',
        'update : Int -> Model -> Model',
        'update n model = { model | count = model.count + n }',
        '',
        'main = update 1 { count = 0 }',
        '',
      ].join('\n'));
      const result = await extractFile(file, root);
      const symbols = (result?.nodes ?? []).map(n => `${n.kind} ${n.name}`).sort();
      expect(symbols).toEqual(['function main', 'function update', 'type_alias Model']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
