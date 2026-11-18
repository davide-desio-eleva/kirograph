import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

async function extract(name: string, text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-x-'));
  try {
    fs.writeFileSync(path.join(root, name), text);
    const r = await extractFile(path.join(root, name), root);
    return {
      symbols: (r?.nodes ?? []).map(n => `${n.kind} ${n.name}`),
      calls: (r?.unresolvedRefs ?? []).filter(x => x.refKind === 'function').map(x => `${x.refName}${x.metadata?.receiver ? `(${x.metadata.receiver})` : ''}`),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('Lua', () => {
  it('extracts module functions, methods, locals, function values and calls', async () => {
    const { symbols, calls } = await extract('m.lua', [
      'local M = {}',
      'function M.greet(name) return "hi " .. name end',
      'function M:method(x) self.v = x end',
      'local function helper(a) return M.greet(a) end',
      'M.build = function(o) return helper(o) end',
      'return M',
      '',
    ].join('\n'));
    expect(symbols).toEqual(['variable M', 'function greet', 'function method', 'function helper', 'function build']);
    expect(calls).toEqual(expect.arrayContaining(['greet(M)', 'helper']));
  });
});

describe('OCaml', () => {
  it('extracts opens, modules, types, values, functions and calls through modules', async () => {
    const { symbols, calls } = await extract('server.ml', [
      'open Base',
      'type color = Red | Green',
      'let version = "1.0"',
      'let show h = Cohttp.Header.iter print h',
      'module Server = struct',
      '  let start port = Tcp.listen port',
      'end',
      '',
    ].join('\n'));
    expect(symbols).toEqual(['import Base', 'type_alias color', 'variable version', 'function show', 'namespace Server', 'function start']);
    expect(calls).toEqual(expect.arrayContaining(['iter(Cohttp.Header)', 'listen(Tcp)']));
  });
});

describe('Solidity', () => {
  it('a member call after an operator keeps its own receiver (`a || super.f()`)', async () => {
    const { calls } = await extract('C.sol', [
      'contract C {',
      '  function f(bytes4 id) public view returns (bool) { return id == 0 || super.supportsInterface(id); }',
      '  function g(uint t) public view returns (uint) { return t < 1 ? 0 : super.vesting(t); }',
      '}',
      '',
    ].join('\n'));
    expect(calls).toEqual(expect.arrayContaining(['supportsInterface(super)', 'vesting(super)']));
  });
});
