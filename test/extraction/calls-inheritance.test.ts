import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

async function extract(name: string, lines: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-ci-'));
  try {
    fs.writeFileSync(path.join(root, name), lines.join('\n') + '\n');
    const r = await extractFile(path.join(root, name), root);
    const byId = new Map((r?.nodes ?? []).map(n => [n.id, n.name]));
    return {
      language: r?.language,
      symbols: (r?.nodes ?? []).map(n => `${n.kind} ${n.name}`),
      calls: [...new Set((r?.unresolvedRefs ?? []).filter(x => x.refKind === 'function')
        .map(x => `${x.refName}${x.metadata?.receiver ? `(${x.metadata.receiver})` : ''}`))],
      supertypes: (r?.unresolvedRefs ?? []).filter(x => x.refKind === 'extends' || x.refKind === 'implements')
        .map(x => `${byId.get(x.sourceId)} ${x.refKind} ${x.refName}`),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('method calls', () => {
  it('PHP: $this->m(), $o->m(), self::m(), Foo::m(), new X()', async () => {
    const r = await extract('a.php', ['<?php', 'class A {', '  public function go() { $this->run(1); $o->m(); self::make(); Foo::bar(); new X(); helper(); }', '}']);
    expect(r.calls).toEqual(['run(this)', 'm(o)', 'make(self)', 'bar(Foo)', 'X', 'helper']);
  });

  it('Objective-C: messages, by the first part of the selector', async () => {
    const r = await extract('a.m', ['@implementation Foo', '- (void)go { [self run:1 with:2]; [Foo make]; NSLog(@"x"); }', '@end']);
    expect(r.calls).toEqual(['run(self)', 'make(Foo)', 'NSLog']);
  });

  it('Dart: calls, member calls and constructors', async () => {
    const r = await extract('a.dart', ['class A {', '  void go() { run(1); obj.m(2); final x = Foo(); }', '}']);
    expect(r.calls).toEqual(['run', 'm(obj)', 'Foo']);
  });
});

describe('component scripts', () => {
  it('Vue: the <script> block, in its lang', async () => {
    const r = await extract('a.vue', ['<template><div/></template>', '<script setup lang="ts">', 'import { ref } from "vue";', 'const n = ref(0);', 'function inc() { n.value++ }', '</script>']);
    expect(r.symbols).toEqual(['import vue', 'constant n', 'function inc']);
    expect(r.calls).toEqual(['ref']);
  });

  it('Svelte: every <script> block, without a grammar for the markup', async () => {
    const r = await extract('a.svelte', ['<script lang="ts">', '  export let name: string;', '  function greet() { return helper(name); }', '</script>', '<h1>{name}</h1>', '<script context="module">', '  export const prerender = true;', '</script>']);
    expect(r.language).toBe('svelte');
    expect(r.symbols).toEqual(['variable name', 'function greet', 'constant prerender']);
    expect(r.calls).toEqual(['helper']);
  });

  it('Svelte: a component of markup only is a module, what its imports point at', async () => {
    const r = await extract('Button.svelte', ['<button class="btn"><slot /></button>']);
    expect(r.symbols).toEqual(['module Button']);
  });
});

describe('binary files', () => {
  it('a binary file with a source extension is tracked, not parsed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-bin-'));
    try {
      fs.writeFileSync(path.join(root, 'Project.res'), Buffer.from([0, 0, 0, 0, 32, 0, 0, 0, 255, 255, 0, 0, 65, 66]));
      const r = await extractFile(path.join(root, 'Project.res'), root);
      expect(r?.nodes).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('supertypes', () => {
  const cases: Array<[string, string[], string[]]> = [
    ['a.cpp', ['class A : public B, private ns::C<int> {};'], ['A extends B', 'A extends C']],
    ['a.swift', ['class A: B, P1 {}'], ['A extends B', 'A extends P1']],
    ['a.rs', ['impl Display for Point {}', 'trait T: Clone {}'], ['Point implements Display', 'T extends Clone']],
    ['a.go', ['package a', 'type A struct {', '  B', '  *pkg.C', '  name string', '}'], ['A extends B', 'A extends C']],
    ['a.scala', ['class A extends B with T1'], ['A extends B', 'A implements T1']],
    ['a.php', ['<?php', 'class A extends B implements C {}'], ['A extends B', 'A implements C']],
    ['a.rb', ['class A < Mod::B', '  include Comparable', 'end'], ['A extends B', 'A implements Comparable']],
    ['a.dart', ['class A extends B with M implements C {}'], ['A extends B', 'A implements M', 'A implements C']],
    ['a.m', ['@interface Foo : NSObject <Bar>', '@end'], ['Foo extends NSObject', 'Foo implements Bar']],
    ['a.sol', ['contract A is B, C {}'], ['A extends B', 'A extends C']],
    ['a.pas', ['unit U;', 'interface', 'type', '  TA = class(TB, IC)', '  end;', 'implementation', 'end.'], ['TA extends TB', 'TA implements IC']],
  ];
  for (const [file, lines, expected] of cases) {
    it(file.split('.')[1], async () => {
      expect((await extract(file, lines)).supertypes).toEqual(expected);
    });
  }
});
