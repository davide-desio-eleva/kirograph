import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

/** Symbols, calls and imports of the languages read through lang-specs (and Astro's frontmatter). */
async function extract(name: string, lines: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-lang-'));
  try {
    fs.writeFileSync(path.join(root, name), lines.join('\n') + '\n');
    const r = await extractFile(path.join(root, name), root);
    return {
      symbols: (r?.nodes ?? []).map(n => `${n.kind} ${n.name}`),
      calls: [...new Set((r?.unresolvedRefs ?? []).filter(x => x.refKind === 'function')
        .map(x => `${x.refName}${x.metadata?.receiver ? `(${x.metadata.receiver})` : ''}`))],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('languages read through their specs', () => {
  it('R', async () => {
    const r = await extract('a.R', ['library(dplyr)', 'greet <- function(name) paste("hi", helper(name))', 'helper = function(x) x', 'n <- pkg::count(1)']);
    expect(r.symbols).toEqual(['import dplyr', 'function greet', 'function helper', 'variable n']);
    expect(r.calls).toEqual(expect.arrayContaining(['paste', 'helper', 'count(pkg)']));
  });

  it('Perl', async () => {
    const r = await extract('a.pm', ['package My::Util;', 'use strict;', 'use Foo::Bar;', 'sub run { my $o = Foo::Bar->new(1); $o->go(2); helper(3); }', 'sub helper { 1 }', '1;']);
    expect(r.symbols).toEqual(['module My::Util', 'import Foo::Bar', 'function run', 'function helper']);
    expect(r.calls).toEqual(expect.arrayContaining(['new(Foo::Bar)', 'go($o)', 'helper']));
  });

  it('PowerShell', async () => {
    const r = await extract('a.ps1', ['Import-Module Pester', 'function Get-Greeting {', '    param($Name)', '    $msg = Format-Name $Name', '    [Math]::Round(2)', '}', 'class Greeter {', '    [string] Hello() { return "x" }', '}']);
    expect(r.symbols).toEqual(['import Pester', 'function Get-Greeting', 'class Greeter', 'method Hello']);
    expect(r.calls).toEqual(expect.arrayContaining(['Format-Name', 'Round([Math])']));
  });

  it('Julia: the signature is not a call', async () => {
    const r = await extract('a.jl', ['module Geo', 'using LinearAlgebra', 'struct Point', '  x::Float64', 'end', 'function norm(p::Point) sqrt(p.x^2) end', 'area(r) = pi * r^2', 'end']);
    expect(r.symbols).toEqual(['module Geo', 'import LinearAlgebra', 'struct Point', 'function norm', 'function area']);
    expect(r.calls).toEqual(['sqrt']);
  });

  it('Nix: let bindings and functions, not configuration', async () => {
    const r = await extract('a.nix', ['{ lib, ... }:', 'let', '  greet = name: "hi ${name}";', '  version = "1.0";', 'in {', '  enable = true;', '  mkHello = x: greet x;', '  helpers = import ./helpers.nix;', '}']);
    expect(r.symbols).toEqual(['function greet', 'variable version', 'function mkHello', 'import ./helpers.nix']);
    expect(r.calls).toEqual(['greet']);
  });

  it('Pascal: implemented routines, not their interface declarations', async () => {
    const r = await extract('util.pas', ['unit Util;', 'interface', 'uses SysUtils;', 'function Greet(Name: string): string;', 'implementation', 'function Greet(Name: string): string;', 'begin', '  Result := Helper(Name);', 'end;', 'end.']);
    expect(r.symbols).toEqual(['module Util', 'import SysUtils', 'function Greet']);
    expect(r.calls).toEqual(['Helper']);
  });

  it('Verilog: an instance uses its module', async () => {
    const r = await extract('top.v', ['module counter(input clk, output reg [3:0] q);', 'endmodule', 'module top;', '  counter c1(.clk(clk), .q(q));', 'endmodule']);
    expect(r.symbols).toEqual(['module counter', 'module top']);
    expect(r.calls).toEqual(['counter']);
  });

  it('SCSS: variables, @use, and @include as a call to the mixin', async () => {
    const r = await extract('a.scss', ['@use "base";', '$primary: #333;', '@mixin rounded($r) { border-radius: $r; }', '@mixin card { @include rounded(4px); }']);
    expect(r.symbols).toEqual(['import base', 'variable $primary', 'function rounded', 'function card']);
    expect(r.calls).toEqual(['rounded']);
  });

  it('Haskell: a function of several equations is one symbol, with every equation\'s calls', async () => {
    const r = await extract('Stack.hs', [
      'module Data.Stack (push) where', 'import qualified Data.Map as M', 'data Stack a = Stack [a]', 'type Pair = (Int, Int)',
      'class Container f where', '  empty :: f a', 'pop (Stack []) = Nothing', 'pop (Stack (x:xs)) = helper x', 'size s = length (M.toList s)',
    ]);
    expect(r.symbols).toEqual(['module Data.Stack', 'import Data.Map', 'struct Stack', 'type_alias Pair', 'interface Container', 'function pop', 'function size']);
    expect(r.calls).toEqual(expect.arrayContaining(['helper', 'length', 'toList(M)']));
  });

  it('Liquid: a template is a component; render / include / section are imports', async () => {
    const r = await extract('product.liquid', ["{% render 'product-card', product: product %}", "{% section 'footer' %}", '{% assign total = cart.total_price | money %}']);
    expect(r.symbols).toEqual(['component product', 'import snippets/product-card', 'import sections/footer', 'variable total']);
  });

  it('a file of code with no symbol is a module, for imports to point at', async () => {
    expect((await extract('empty.js', ['module.exports = {};'])).symbols).toEqual(['module empty']);
    expect((await extract('jv.h', ['int jv_null(void);'])).symbols).toEqual(['module jv']);
  });

  it('SCSS: an @include inside a top-level rule is that rule\'s call', async () => {
    const r = await extract('card.scss', ['@mixin rounded($r) { border-radius: $r; }', '.card { @include rounded(4px); .title { color: red; } }']);
    expect(r.symbols).toEqual(['function rounded', 'class .card']);
    expect(r.calls).toEqual(['rounded']);
  });

  it('Astro: the frontmatter is TypeScript', async () => {
    const r = await extract('a.astro', ['---', "import Card from '../components/Card.astro';", 'function greet(n: string) { return `hi ${n}`; }', 'const title = greet("x");', '---', '<Card title={title} />']);
    expect(r.symbols).toEqual(['import ../components/Card.astro', 'function greet', 'constant title']);
    expect(r.calls).toEqual(['greet']);
  });
});
