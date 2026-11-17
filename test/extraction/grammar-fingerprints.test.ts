import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'grammars', 'grammars.json'), 'utf8'));

describe('tree-sitter grammars (#91)', () => {
  it('every WASM grammar is the one grammars/grammars.json records', async () => {
    // The script measures each grammar in a process of its own (see fingerprint there)
    const { check } = await import(path.join(ROOT, 'scripts', 'grammars.mjs'));
    expect(await check()).toEqual([]);
  }, 120_000);

  it('every WASM grammar in src/extraction/wasm is in the manifest', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src', 'extraction', 'wasm')).filter(f => f.endsWith('.wasm'));
    const listed = new Set(Object.keys(manifest.languages).map(l => `tree-sitter-${l}.wasm`));
    expect(files.filter(f => !listed.has(f))).toEqual([]);
  });

  it('pins every grammar that is not prebuilt to a version', () => {
    for (const [lang, spec] of Object.entries<any>(manifest.languages)) {
      if (spec.prebuilt) continue;
      expect(spec.package ?? spec.github, lang).toBeTruthy();
      expect(spec.version, lang).toBeTruthy();
      expect(spec.symbol, lang).toBeTruthy();
    }
  });
});
