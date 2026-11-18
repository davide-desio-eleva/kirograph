/**
 * Symbols, calls and imports of the languages whose grammar does not fit the generic extraction:
 * names inside other nodes (R's `x <- function…`, Julia's signature, Pascal's header), calls that are
 * commands (PowerShell) or applications (Nix), imports written as calls (R's `library(x)`, Nix's
 * `import ./x.nix`). The extractor asks a language's spec first; `undefined` leaves a node to the
 * generic rules, `null` says it is not a symbol (or not a call).
 */
import type { Language, NodeKind } from '../types';

export interface Symbol { kind: NodeKind; name: string }
export interface Call { name: string; receiver?: string }

export interface LangSpec {
  /** The node as a symbol, `null` if it is none, `undefined` for the generic rules. */
  symbol?(node: any, source: string): Symbol | null | undefined;
  /** The node as a call, `null` if it is none, `undefined` for the generic rules. */
  call?(node: any, source: string): Call | null | undefined;
  /**
   * The node of the symbol a node continues, when a language spreads one symbol over sibling
   * nodes (a Haskell function written as several equations): its calls are that symbol's.
   */
  continuationOf?(node: any, source: string): any;
  /** The module (or modules: Go's `import ( … )`) a node imports, if it is an import. */
  importOf?(node: any, source: string): string | string[] | undefined;
}

const text = (n: any, source: string): string => source.slice(n.startIndex, n.endIndex);
const named = (n: any, type: string): any => n?.namedChildren?.find((c: any) => c.type === type) ?? null;
const unquote = (s: string): string => s.replace(/^['"]|['"]$/g, '');
/** The first descendant of one of the types, breadth first. */
function find(n: any, types: Set<string>, limit = 64): any {
  const queue = [...(n?.namedChildren ?? [])];
  for (let i = 0; i < queue.length && i < limit; i++) {
    if (types.has(queue[i].type)) return queue[i];
    queue.push(...queue[i].namedChildren);
  }
  return null;
}

// ── R ────────────────────────────────────────────────────────────────────────

const R_ASSIGN = /^(<<?-|=|:=)$/;
const R_IMPORTS = new Set(['library', 'require', 'requireNamespace']);

const r: LangSpec = {
  symbol(node, source) {
    // An anonymous function is the value of what names it
    if (node.type === 'function_definition') return null;
    if (node.type !== 'binary_operator') return undefined;
    const lhs = node.childForFieldName('lhs');
    const rhs = node.childForFieldName('rhs');
    if (!lhs || !rhs || lhs.type !== 'identifier') return null;
    const op = source.slice(lhs.endIndex, rhs.startIndex).trim();
    if (!R_ASSIGN.test(op)) return null;
    // Only declarations of the file or of a function's body, not every reassignment in a loop
    return { kind: rhs.type === 'function_definition' ? 'function' : 'variable', name: text(lhs, source) };
  },
  call(node, source) {
    if (node.type !== 'call') return undefined;
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return { name: text(fn, source) };
    // pkg::fn(), obj$method()
    if (fn.type === 'namespace_operator' || fn.type === 'extract_operator') {
      const rhs = fn.childForFieldName('rhs');
      const lhs = fn.childForFieldName('lhs');
      return rhs?.type === 'identifier' ? { name: text(rhs, source), receiver: lhs ? text(lhs, source) : undefined } : null;
    }
    return null;
  },
  importOf(node, source) {
    if (node.type !== 'call') return undefined;
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'identifier' || !R_IMPORTS.has(text(fn, source))) return undefined;
    const arg = node.childForFieldName('arguments')?.namedChildren.find((c: any) => c.type === 'argument');
    const value = arg?.childForFieldName('value');
    return value && (value.type === 'identifier' || value.type === 'string') ? unquote(text(value, source)) : undefined;
  },
};

// ── Perl ─────────────────────────────────────────────────────────────────────

const perl: LangSpec = {
  symbol(node, source) {
    if (node.type === 'subroutine_declaration_statement' || node.type === 'method_declaration_statement') {
      const name = node.childForFieldName('name');
      return name ? { kind: 'function', name: text(name, source) } : null;
    }
    if (node.type === 'package_statement') {
      const name = node.childForFieldName('name');
      return name ? { kind: 'module', name: text(name, source) } : null;
    }
    return undefined;
  },
  call(node, source) {
    if (node.type === 'function_call_expression' || node.type === 'ambiguous_function_call_expression') {
      const fn = node.childForFieldName('function');
      if (!fn) return null;
      // Foo::Bar::helper(3): the package is the receiver
      const parts = text(fn, source).replace(/^&/, '').split('::');
      const name = parts.pop()!;
      return /^\w+$/.test(name) ? { name, receiver: parts.length > 0 ? parts.join('::') : undefined } : null;
    }
    if (node.type === 'method_call_expression') {
      const method = node.childForFieldName('method');
      const invocant = node.childForFieldName('invocant');
      const name = method ? text(method, source) : '';
      return /^\w+$/.test(name) ? { name, receiver: invocant ? text(invocant, source) : undefined } : null;
    }
    return undefined;
  },
  importOf(node, source) {
    if (node.type !== 'use_statement' && node.type !== 'require_expression') return undefined;
    const mod = node.childForFieldName('module');
    const name = mod ? text(mod, source) : '';
    // `use strict;`, `use warnings;`: pragmas are lowercase, modules are not
    return name && !/^[a-z][a-z0-9_]*$/.test(name) ? name : undefined;
  },
};

// ── PowerShell ───────────────────────────────────────────────────────────────

const powershell: LangSpec = {
  symbol(node, source) {
    if (node.type === 'function_statement') {
      const name = named(node, 'function_name');
      return name ? { kind: 'function', name: text(name, source) } : null;
    }
    if (node.type === 'class_statement') {
      const name = named(node, 'simple_name');
      return name ? { kind: 'class', name: text(name, source) } : null;
    }
    if (node.type === 'class_method_definition') {
      const name = named(node, 'simple_name');
      return name ? { kind: 'method', name: text(name, source) } : null;
    }
    if (node.type === 'enum_statement') {
      const name = named(node, 'simple_name');
      return name ? { kind: 'enum', name: text(name, source) } : null;
    }
    return undefined;
  },
  call(node, source) {
    // A command: Format-Name $x, Get-ChildItem
    if (node.type === 'command') {
      const name = node.childForFieldName('command_name');
      const value = name ? text(name, source) : '';
      return /^[A-Za-z_][\w-]*$/.test(value) ? { name: value } : null;
    }
    // $obj.Method(1), [Math]::Round(2)
    if (node.type === 'invokation_expression') {
      const member = named(named(node, 'member_name'), 'simple_name');
      const target = node.namedChild(0);
      return member ? { name: text(member, source), receiver: target && target.type !== 'member_name' ? text(target, source) : undefined } : null;
    }
    return undefined;
  },
  importOf(node, source) {
    if (node.type !== 'command') return undefined;
    const name = node.childForFieldName('command_name');
    if (!name || !/^(Import-Module|using)$/i.test(text(name, source))) return undefined;
    const arg = node.childForFieldName('command_elements')?.namedChildren.find((c: any) => c.type === 'generic_token' || c.type === 'string_literal');
    return arg ? unquote(text(arg, source)) : undefined;
  },
};

// ── Julia ────────────────────────────────────────────────────────────────────

const JL_CALL = new Set(['call_expression']);
/** The name a Julia signature or call head gives: `norm` in `norm(p)`, `show` in `Base.show(io)`. */
function jlName(callee: any, source: string): { name: string; receiver?: string } | null {
  if (!callee) return null;
  if (callee.type === 'identifier') return { name: text(callee, source) };
  if (callee.type === 'field_expression') {
    const last = callee.lastNamedChild;
    const value = callee.childForFieldName('value');
    return last?.type === 'identifier' ? { name: text(last, source), receiver: value ? text(value, source) : undefined } : null;
  }
  if (callee.type === 'parametrized_type_expression' || callee.type === 'curly_expression') return jlName(callee.namedChild(0), source);
  return null;
}

const julia: LangSpec = {
  symbol(node, source) {
    if (node.type === 'function_definition' || node.type === 'macro_definition') {
      const call = find(named(node, 'signature'), JL_CALL, 8);
      const head = call ? jlName(call.namedChild(0), source) : null;
      return head ? { kind: 'function', name: head.name } : null;
    }
    if (node.type === 'struct_definition' || node.type === 'abstract_definition') {
      const head = named(node, 'type_head');
      const id = head?.type ? (head.namedChild(0)?.type === 'identifier' ? head.namedChild(0) : find(head, new Set(['identifier']), 8)) : null;
      return id ? { kind: node.type === 'struct_definition' ? 'struct' : 'interface', name: text(id, source) } : null;
    }
    if (node.type === 'module_definition') {
      const name = node.childForFieldName('name');
      return name ? { kind: 'module', name: text(name, source) } : null;
    }
    // `area(r) = π * r^2` is a function; `const x = 1` at the top of a file or module a variable
    if (node.type === 'assignment') {
      const lhs = node.namedChild(0);
      if (lhs?.type === 'call_expression') {
        const head = jlName(lhs.namedChild(0), source);
        return head ? { kind: 'function', name: head.name } : null;
      }
      const top = node.parent?.type === 'source_file' || node.parent?.type === 'module_definition'
        || (node.parent?.type === 'const_statement' && (node.parent.parent?.type === 'source_file' || node.parent.parent?.type === 'module_definition'));
      return top && lhs?.type === 'identifier' ? { kind: 'variable', name: text(lhs, source) } : null;
    }
    return undefined;
  },
  call(node, source) {
    if (node.type !== 'call_expression') return undefined;
    // A function's own signature, and the head of `f(x) = …`, are not calls
    if (node.parent?.type === 'signature') return null;
    if (node.parent?.type === 'assignment' && node.parent.namedChild(0) === node) return null;
    if (node.parent?.type === 'assignment' && node.parent.namedChild(0)?.startIndex === node.startIndex) return null;
    return jlName(node.namedChild(0), source);
  },
  importOf(node, source) {
    // include("helpers.jl") brings a file in
    if (node.type === 'call_expression') {
      const fn = node.namedChild(0);
      if (fn?.type !== 'identifier' || text(fn, source) !== 'include') return undefined;
      const arg = node.namedChild(1)?.namedChild(0);
      return arg?.type === 'string_literal' ? `./${unquote(text(arg, source))}` : undefined;
    }
    if (node.type !== 'using_statement' && node.type !== 'import_statement') return undefined;
    const first = node.namedChild(0);
    const mod = first?.type === 'selected_import' ? first.namedChild(0) : first;
    return mod ? text(mod, source) : undefined;
  },
};

// ── Nix ──────────────────────────────────────────────────────────────────────

const nix: LangSpec = {
  symbol(node, source) {
    if (node.type === 'function_expression') return null;
    if (node.type !== 'binding') return undefined;
    const path = node.childForFieldName('attrpath');
    const attrs = path?.namedChildren ?? [];
    const last = attrs[attrs.length - 1];
    if (!last || last.type !== 'identifier') return null;
    const value = node.childForFieldName('expression');
    const isFunction = value?.type === 'function_expression';
    // A `let` binding is a declaration; in an attribute set, only a function is a symbol (a library's
    // `mkFoo = x: …`): a module's settings (`enable = true;`) are configuration, not declarations
    const inLet = node.parent?.type === 'binding_set' && node.parent.parent?.type === 'let_expression';
    if (!inLet && !isFunction) return null;
    return { kind: isFunction ? 'function' : 'variable', name: text(last, source) };
  },
  call(node, source) {
    if (node.type !== 'apply_expression') return undefined;
    const fn = node.childForFieldName('function');
    // `f a b` is apply(apply(f, a), b): the inner application is the call
    if (!fn || fn.type === 'apply_expression') return null;
    if (fn.type === 'variable_expression') {
      const name = fn.childForFieldName('name');
      return name ? { name: text(name, source) } : null;
    }
    if (fn.type === 'select_expression') {
      const attrs = fn.childForFieldName('attrpath')?.namedChildren ?? [];
      const last = attrs[attrs.length - 1];
      const target = fn.childForFieldName('expression');
      return last?.type === 'identifier' ? { name: text(last, source), receiver: target ? text(target, source) : undefined } : null;
    }
    return null;
  },
  importOf(node, source) {
    if (node.type !== 'apply_expression') return undefined;
    const fn = node.childForFieldName('function');
    const name = fn?.type === 'variable_expression' ? fn.childForFieldName('name') : null;
    const arg = node.childForFieldName('argument');
    if (!name || text(name, source) !== 'import' || !arg) return undefined;
    return arg.type === 'path_expression' || arg.type === 'string_expression' ? unquote(text(arg, source)) : undefined;
  },
};

// ── Pascal ───────────────────────────────────────────────────────────────────

const pascal: LangSpec = {
  symbol(node, source) {
    // A routine as implemented; its interface declaration is a prototype, like C's
    if (node.type === 'declProc') return null;
    if (node.type === 'defProc') {
      const name = node.childForFieldName('header')?.childForFieldName('name');
      if (!name) return null;
      // TFoo.Bar is a method of TFoo
      const parts = text(name, source).split('.');
      return { kind: parts.length > 1 ? 'method' : 'function', name: parts[parts.length - 1].trim() };
    }
    if (node.type === 'declType') {
      const name = node.childForFieldName('name');
      const type = node.childForFieldName('type');
      if (!name || !type) return null;
      const kind: NodeKind | null = type.type === 'declClass' ? 'class' : type.type === 'declIntf' ? 'interface'
        : type.type === 'declEnum' ? 'enum' : type.type === 'declRecord' ? 'struct' : 'type_alias';
      return { kind, name: text(name, source) };
    }
    if (node.type === 'unit' || node.type === 'program' || node.type === 'library') {
      const name = named(node, 'moduleName');
      return name ? { kind: 'module', name: text(name, source) } : null;
    }
    return undefined;
  },
  call(node, source) {
    if (node.type !== 'exprCall') return undefined;
    const entity = node.childForFieldName('entity');
    if (!entity) return null;
    if (entity.type === 'identifier') return { name: text(entity, source) };
    if (entity.type === 'exprDot') {
      const rhs = entity.childForFieldName('rhs') ?? entity.lastNamedChild;
      const lhs = entity.childForFieldName('lhs') ?? entity.namedChild(0);
      return rhs?.type === 'identifier' ? { name: text(rhs, source), receiver: lhs ? text(lhs, source) : undefined } : null;
    }
    return null;
  },
  importOf(node, source) {
    // `uses SysUtils, Classes;`: the first unit (each is recorded by its own moduleName below)
    if (node.type !== 'moduleName' || node.parent?.type !== 'declUses') return undefined;
    return text(node, source);
  },
};

// ── Verilog ──────────────────────────────────────────────────────────────────

const VLOG_ID = new Set(['simple_identifier']);

const verilog: LangSpec = {
  symbol(node, source) {
    if (node.type === 'module_declaration') {
      const id = find(named(node, 'module_header') ?? node, VLOG_ID, 8);
      return id ? { kind: 'module', name: text(id, source) } : null;
    }
    if (node.type === 'function_declaration' || node.type === 'task_declaration') {
      const id = find(node, new Set(['function_identifier', 'task_identifier']), 32);
      const name = id ? find(id, VLOG_ID, 4) ?? id : null;
      return name ? { kind: 'function', name: text(name, source) } : null;
    }
    return undefined;
  },
  call(node, source) {
    // `counter c1(.clk(clk));` uses the module counter
    if (node.type === 'module_instantiation') {
      const id = node.namedChild(0);
      return id?.type === 'simple_identifier' ? { name: text(id, source) } : null;
    }
    if (node.type === 'tf_call' || node.type === 'function_subroutine_call' || node.type === 'subroutine_call') {
      const id = find(node, VLOG_ID, 8);
      return id ? { name: text(id, source) } : null;
    }
    return undefined;
  },
};

// ── SCSS ─────────────────────────────────────────────────────────────────────

const scss: LangSpec = {
  symbol(node, source) {
    // `$primary: #333;` at the top of a stylesheet, or of a mixin / function body
    if (node.type === 'declaration') {
      const prop = named(node, 'property_name');
      const name = prop ? text(prop, source) : '';
      return name.startsWith('$') ? { kind: 'variable', name } : null;
    }
    if (node.type === 'include_statement' || node.type === 'use_statement' || node.type === 'forward_statement' || node.type === 'import_statement') return null;
    // A top-level rule (`.card { … }`), as CSS's are: what its @includes apply to. Nested rules are its
    if (node.type === 'rule_set') {
      for (let p = node.parent; p; p = p.parent) if (p.type === 'rule_set' || p.type === 'mixin_statement') return null;
      const sel = named(node, 'selectors');
      const name = sel ? text(sel, source).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      return name ? { kind: 'class', name } : null;
    }
    return undefined;
  },
  call(node, source) {
    // `@include rounded(4px)` applies the mixin
    if (node.type === 'include_statement') {
      const id = named(node, 'identifier');
      return id ? { name: text(id, source) } : null;
    }
    return undefined;
  },
  importOf(node, source) {
    if (node.type !== 'use_statement' && node.type !== 'forward_statement' && node.type !== 'import_statement') return undefined;
    const value = named(node, 'string_value');
    return value ? unquote(text(value, source)) : undefined;
  },
};

// ── PHP ──────────────────────────────────────────────────────────────────────

const php: LangSpec = {
  call(node, source) {
    // $this->run(), $o->m(), self::make(), Foo::bar(), new X()
    if (node.type === 'member_call_expression' || node.type === 'nullsafe_member_call_expression' || node.type === 'scoped_call_expression') {
      const name = node.childForFieldName('name');
      const on = node.childForFieldName('object') ?? node.childForFieldName('scope');
      const value = name ? text(name, source) : '';
      return /^\w+$/.test(value) ? { name: value, receiver: on ? text(on, source).replace(/^\$/, '') : undefined } : null;
    }
    if (node.type === 'object_creation_expression') {
      const cls = node.namedChildren.find((c: any) => c.type === 'name' || c.type === 'qualified_name');
      const value = cls ? text(cls, source).split('\\').pop()! : '';
      return /^\w+$/.test(value) ? { name: value } : null;
    }
    return undefined;
  },
};

// ── Objective-C ──────────────────────────────────────────────────────────────

const objc: LangSpec = {
  symbol(node) {
    // A method an @interface declares is a prototype of the @implementation's (as a C prototype is):
    // two nodes of one method would make every call to it ambiguous. A @protocol's are the only ones
    if (node.type !== 'method_declaration') return undefined;
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'class_interface' || p.type === 'category_interface') return null;
      if (p.type === 'protocol_declaration') return undefined;
    }
    return undefined;
  },
  call(node, source) {
    // [obj run:1 with:2] is `run` (the selector's first part, as the method is named), on obj
    if (node.type !== 'message_expression') return undefined;
    const method = node.childForFieldName('method');
    const receiver = node.childForFieldName('receiver');
    return method ? { name: text(method, source), receiver: receiver ? text(receiver, source) : undefined } : null;
  },
};

// ── Dart ─────────────────────────────────────────────────────────────────────

const DART_MEMBER = new Set(['unconditional_assignable_selector', 'conditional_assignable_selector']);

const dart: LangSpec = {
  importOf(node, source) {
    // import 'package:http/http.dart' as http;  export 'src/base.dart';
    if (node.type !== 'import_or_export') return undefined;
    const uri = find(node, new Set(['uri']), 16);
    const lit = uri ? named(uri, 'string_literal') ?? uri : null;
    return lit ? unquote(text(lit, source)) : undefined;
  },
  call(node, source) {
    // A call is a selector with arguments after what it calls: `run(1)` is an identifier and a
    // selector, `obj.m(2)` an identifier, a `.m` selector, and a selector with the arguments
    if (node.type !== 'selector' || !named(node, 'argument_part')) return undefined;
    const prev = node.previousNamedSibling;
    if (!prev) return null;
    if (prev.type === 'identifier') return { name: text(prev, source) };
    const member = prev.type === 'selector' ? prev.namedChildren.find((c: any) => DART_MEMBER.has(c.type)) : null;
    const id = member ? named(member, 'identifier') : null;
    if (!id) return null;
    // The receiver: what comes before the `.m` selector in the same expression
    const start = node.parent?.namedChild(0);
    const receiver = start && start.startIndex < prev.startIndex ? source.slice(start.startIndex, prev.startIndex).trim() : undefined;
    return { name: text(id, source), receiver: receiver || undefined };
  },
};

// ── Go ───────────────────────────────────────────────────────────────────────

const go: LangSpec = {
  importOf(node, source) {
    // Every spec of `import ( "fmt"; m "github.com/x/y" )`, not the first only
    if (node.type !== 'import_declaration') return undefined;
    const specs = node.namedChildren.flatMap((c: any) => c.type === 'import_spec_list' ? c.namedChildren : [c])
      .filter((c: any) => c.type === 'import_spec');
    const paths = specs.map((s: any) => s.childForFieldName('path')).filter(Boolean).map((p: any) => unquote(text(p, source)));
    return paths.length > 0 ? paths : undefined;
  },
};

// ── Ruby ─────────────────────────────────────────────────────────────────────

const ruby: LangSpec = {
  symbol(node, source) {
    // module Foo / module Foo::Bar: a namespace
    if (node.type !== 'module') return undefined;
    const name = node.childForFieldName('name');
    return name ? { kind: 'module', name: text(name, source).split('::').pop()! } : null;
  },
  importOf(node, source) {
    // require 'json'; require_relative 'lib/helper' (as ./lib/helper: relative to the file)
    if (node.type !== 'call' || node.childForFieldName('receiver')) return undefined;
    const method = node.childForFieldName('method');
    const name = method ? text(method, source) : '';
    if (!/^(require|require_relative|load)$/.test(name)) return undefined;
    const arg = node.childForFieldName('arguments')?.namedChild(0);
    if (arg?.type !== 'string') return undefined;
    const path = unquote(text(arg, source));
    return name === 'require_relative' && !path.startsWith('.') ? `./${path}` : path;
  },
};

// ── Lua ──────────────────────────────────────────────────────────────────────

const lua: LangSpec = {
  importOf(node, source) {
    // require("telescope.utils"), require "plenary.async"
    if (node.type !== 'function_call') return undefined;
    const name = node.childForFieldName('name');
    if (name?.type !== 'identifier' || text(name, source) !== 'require') return undefined;
    const arg = find(node.childForFieldName('arguments') ?? node, new Set(['string']), 4);
    const content = arg ? named(arg, 'string_content') : null;
    return content ? text(content, source) : undefined;
  },
};

// ── JavaScript / TypeScript ──────────────────────────────────────────────────

const js: LangSpec = {
  importOf(node, source) {
    // CommonJS `require('./x')` and dynamic `import('./x')` (ES `import` statements are read as such)
    if (node.type !== 'call_expression') return undefined;
    const fn = node.childForFieldName('function');
    const callee = fn ? text(fn, source) : '';
    if (callee !== 'require' && callee !== 'import') return undefined;
    const arg = node.childForFieldName('arguments')?.namedChild(0);
    return arg?.type === 'string' ? unquote(text(arg, source)) : undefined;
  },
};

// ── Haskell ──────────────────────────────────────────────────────────────────

const hsName = (n: any, s: string): string | null => {
  const name = n?.childForFieldName('name');
  return name ? text(name, s) : null;
};

const haskell: LangSpec = {
  symbol(node, source) {
    switch (node.type) {
      case 'header': {
        const mod = node.childForFieldName('module');
        return mod ? { kind: 'module', name: text(mod, source) } : null;
      }
      case 'data_type': case 'newtype': { const n = hsName(node, source); return n ? { kind: 'struct', name: n } : null; }
      case 'type_synomym': case 'type_family': { const n = hsName(node, source); return n ? { kind: 'type_alias', name: n } : null; }
      case 'class': { const n = hsName(node, source); return n ? { kind: 'interface', name: n } : null; }
      case 'signature': case 'instance': return null;
      case 'function': case 'bind': {
        const n = hsName(node, source);
        if (!n) return null;
        // The later equations of a function are the first one's (see continuationOf)
        if (haskell.continuationOf!(node, source)) return null;
        return { kind: node.type === 'bind' && !node.childForFieldName('patterns') && node.parent?.type === 'declarations' ? 'variable' : 'function', name: n };
      }
    }
    return undefined;
  },
  continuationOf(node, source) {
    if (node.type !== 'function' && node.type !== 'bind') return undefined;
    const name = hsName(node, source);
    let first: any = null;
    for (let p = node.previousNamedSibling; p; p = p.previousNamedSibling) {
      if (p.type === 'signature') continue;
      if ((p.type === 'function' || p.type === 'bind') && hsName(p, source) === name) { first = p; continue; }
      break;
    }
    return first;
  },
  call(node, source) {
    if (node.type !== 'apply') return undefined;
    const fn = node.childForFieldName('function');
    // `f a b` is apply(apply(f, a), b): the innermost application is the call
    if (!fn || fn.type === 'apply') return null;
    if (fn.type === 'variable') return { name: text(fn, source) };
    if (fn.type === 'qualified') {
      const id = fn.childForFieldName('id') ?? fn.lastNamedChild;
      const mod = fn.childForFieldName('module');
      return id?.type === 'variable' ? { name: text(id, source), receiver: mod ? text(mod, source).replace(/\.$/, '') : undefined } : null;
    }
    return null;
  },
  importOf(node, source) {
    if (node.type !== 'import') return undefined;
    const mod = node.childForFieldName('module');
    return mod ? text(mod, source) : undefined;
  },
};

// ── Liquid ───────────────────────────────────────────────────────────────────

const liquid: LangSpec = {
  symbol(node, source) {
    if (node.type === 'assignment_statement') {
      const n = node.childForFieldName('variable_name');
      return n ? { kind: 'variable', name: text(n, source) } : null;
    }
    if (node.type === 'capture_statement') {
      const n = node.childForFieldName('variable');
      return n ? { kind: 'variable', name: text(n, source) } : null;
    }
    return undefined;
  },
  importOf(node, source) {
    // {% render 'product-card' %}, {% include 'header' %}, {% section 'footer' %}
    const kind = { render_statement: 'snippets', include_statement: 'snippets', section_statement: 'sections' }[node.type as string];
    if (!kind) return undefined;
    const file = node.childForFieldName('file') ?? named(node, 'string');
    return file ? `${kind}/${unquote(text(file, source))}` : undefined;
  },
};

// ── Elm ──────────────────────────────────────────────────────────────────────

const elm: LangSpec = {
  symbol(node, source) {
    // A value declaration is the function (its left side has only the name and the parameters,
    // its body is a sibling of that); a type alias stays to the generic rules
    if (node.type === 'function_declaration_left') return null;
    if (node.type !== 'value_declaration') return undefined;
    const left = node.childForFieldName('functionDeclarationLeft') ?? named(node, 'function_declaration_left');
    const id = left ? named(left, 'lower_case_identifier') : null;
    return id ? { kind: 'function', name: text(id, source) } : null;
  },
  call(node, source) {
    // helper 1, String.fromInt n
    if (node.type !== 'function_call_expr') return undefined;
    const target = node.childForFieldName('target');
    const qid = target?.type === 'value_expr' ? target.childForFieldName('name') : null;
    if (!qid) return null;
    const ids = qid.namedChildren;
    const last = ids[ids.length - 1];
    if (last?.type !== 'lower_case_identifier') return null;
    const mod = ids.slice(0, -1).map((c: any) => text(c, source)).join('.');
    return { name: text(last, source), receiver: mod || undefined };
  },
  importOf(node, source) {
    if (node.type !== 'import_clause') return undefined;
    const mod = node.childForFieldName('moduleName');
    return mod ? text(mod, source) : undefined;
  },
};

// ── Solidity ─────────────────────────────────────────────────────────────────

const solidity: LangSpec = {
  importOf(node, source) {
    // import "./IERC20.sol";  import {Math} from "../utils/math/Math.sol";
    if (node.type !== 'import_directive') return undefined;
    const src = node.childForFieldName('source');
    return src ? unquote(text(src, source)) : undefined;
  },
};

export const LANG_SPECS: Partial<Record<Language, LangSpec>> = {
  solidity, haskell, liquid, elm,
  r, perl, powershell, julia, nix, pascal, verilog, scss, php, objc, dart, go, ruby, lua,
  javascript: js, typescript: js, tsx: js, jsx: js,
};
