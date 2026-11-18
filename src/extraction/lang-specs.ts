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
  /** The module a node imports, if it is an import. */
  importOf?(node: any, source: string): string | undefined;
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

export const LANG_SPECS: Partial<Record<Language, LangSpec>> = { r, perl, powershell, julia, nix, pascal, verilog, scss };
