/**
 * The declared type of a call's receiver in C#, Kotlin, Swift, Go, Rust, Dart and PHP (see
 * receiver-types for TypeScript, JavaScript, Python and Java, and for what the type is used for).
 *
 * Read from the file's syntax tree only: typed parameters, locals with a type or made by a
 * constructor (`new X()`, `X()`, `X::new()`, `&X{}`, `NewX()`), and the fields of the enclosing type
 * (typed, promoted constructor parameters, `self.x = param` in a constructor). Go and Rust methods are
 * outside their struct: `s.repo` / `self.repo` read the struct's fields when it is declared in the file.
 */
import type { Language } from '../types';
import { typeName } from './receiver-types';

type Lang = 'csharp' | 'kotlin' | 'swift' | 'go' | 'rust' | 'dart' | 'php' | 'ruby';
const LANGS = new Set<string>(['csharp', 'kotlin', 'swift', 'go', 'rust', 'dart', 'php', 'ruby']);

const text = (n: any, s: string): string => s.slice(n.startIndex, n.endIndex);
const kids = (n: any, type: string): any[] => (n?.namedChildren ?? []).filter((c: any) => c.type === type);
const kid = (n: any, type: string): any => kids(n, type)[0] ?? null;
/** A type node's class name (`Repo` for `*Repo`, `&mut Repo`, `Repo?`, `List<Repo>` → List). */
const typeOf = (n: any, s: string): string | undefined => (n ? typeName(text(n, s).replace(/^[&*]+\s*(mut\s+)?/, '').replace(/\?$/, '')) : undefined);

const SCOPES: Record<Lang, Set<string>> = {
  csharp: new Set(['method_declaration', 'constructor_declaration', 'local_function_statement', 'lambda_expression', 'accessor_declaration']),
  kotlin: new Set(['function_declaration', 'secondary_constructor', 'lambda_literal', 'anonymous_function', 'anonymous_initializer']),
  swift: new Set(['function_declaration', 'init_declaration', 'lambda_literal', 'computed_property']),
  go: new Set(['function_declaration', 'method_declaration', 'func_literal']),
  rust: new Set(['function_item', 'closure_expression']),
  dart: new Set(['function_body', 'function_expression']),
  php: new Set(['method_declaration', 'function_definition', 'anonymous_function', 'arrow_function', 'anonymous_function_creation_expression']),
  ruby: new Set(['method', 'singleton_method', 'block', 'do_block', 'lambda']),
};
const CLASSES: Record<Lang, Set<string>> = {
  csharp: new Set(['class_declaration', 'struct_declaration', 'record_declaration']),
  kotlin: new Set(['class_declaration', 'object_declaration']),
  swift: new Set(['class_declaration']),
  go: new Set(),
  rust: new Set(['impl_item']),
  dart: new Set(['class_definition']),
  php: new Set(['class_declaration', 'trait_declaration']),
  ruby: new Set(['class', 'module', 'singleton_class']),
};
/** Languages where a field is named without `this` inside its class. */
const IMPLICIT_SELF = new Set<Lang>(['csharp', 'kotlin', 'swift', 'dart']);

function enclosing(n: any, types: Set<string>): any {
  for (let p = n?.parent; p; p = p.parent) if (types.has(p.type)) return p;
  return null;
}

/** Each node of a scope, without entering nested scopes or types. */
function eachIn(n: any, lang: Lang, visit: (c: any) => void): void {
  for (const c of n?.namedChildren ?? []) {
    if (SCOPES[lang].has(c.type) || CLASSES[lang].has(c.type)) continue;
    visit(c);
    eachIn(c, lang, visit);
  }
}

/** The class a constructor expression creates, if it is one. */
function constructed(v: any, s: string, lang: Lang): string | undefined {
  if (!v) return undefined;
  switch (lang) {
    case 'csharp': case 'php':
      if (v.type === 'object_creation_expression') return typeOf(v.childForFieldName('type') ?? kid(v, 'name') ?? kid(v, 'qualified_name'), s);
      return undefined;
    case 'kotlin': case 'swift': {
      // Repo() — a capitalized callee is a constructor
      if (v.type !== 'call_expression') return undefined;
      const callee = v.namedChild(0);
      return callee && (callee.type === 'simple_identifier' || callee.type === 'type_identifier') ? typeOf(callee, s) : undefined;
    }
    case 'rust': {
      // Repo::new(…), Repo { … }
      if (v.type === 'struct_expression') return typeOf(v.childForFieldName('name'), s);
      if (v.type !== 'call_expression') return undefined;
      const fn = v.childForFieldName('function');
      return fn?.type === 'scoped_identifier' ? typeOf(fn.childForFieldName('path'), s) : undefined;
    }
    case 'go': {
      // &Repo{}, Repo{}, NewRepo(), pkg.NewRepo()
      const lit = v.type === 'unary_expression' ? v.childForFieldName('operand') : v;
      if (lit?.type === 'composite_literal') return typeOf(lit.childForFieldName('type'), s);
      if (v.type === 'call_expression') {
        const fn = v.childForFieldName('function');
        const name = fn?.type === 'selector_expression' ? fn.childForFieldName('field') : fn;
        const m = name ? /^New([A-Z]\w*)$/.exec(text(name, s)) : null;
        return m ? m[1] : undefined;
      }
      return undefined;
    }
    case 'ruby': {
      // Ledger.new(…), Mod::Ledger.new
      if (v.type !== 'call') return undefined;
      const method = v.childForFieldName('method');
      const recv = v.childForFieldName('receiver');
      if (!method || text(method, s) !== 'new' || !recv || (recv.type !== 'constant' && recv.type !== 'scope_resolution')) return undefined;
      const cls = recv.type === 'scope_resolution' ? recv.childForFieldName('name') : recv;
      // Class.new(Base): an anonymous subclass of Base
      if (text(cls, s) === 'Class') {
        const parent = v.childForFieldName('arguments')?.namedChild(0);
        if (parent?.type !== 'constant' && parent?.type !== 'scope_resolution') return undefined;
        return typeOf(parent.type === 'scope_resolution' ? parent.childForFieldName('name') : parent, s);
      }
      return typeOf(cls, s);
    }
    case 'dart':
      return undefined;
  }
}

/** Typed parameters of a scope: name → type. */
function params(scope: any, s: string, lang: Lang): Map<string, string> {
  const key = scope ? `params:${scope.startIndex}:${scope.endIndex}:${scope.type}` : '';
  const cached = key ? declared.get(key) : undefined;
  if (cached) return cached;
  const out = paramsUncached(scope, s, lang);
  if (key) declared.set(key, out);
  return out;
}

function paramsUncached(scope: any, s: string, lang: Lang): Map<string, string> {
  const out = new Map<string, string>();
  const set = (name: any, type: string | undefined) => { if (name && type) out.set(text(name, s).replace(/^\$/, ''), type); };
  switch (lang) {
    case 'csharp':
      for (const p of kids(scope.childForFieldName('parameters'), 'parameter')) set(p.childForFieldName('name'), typeOf(p.childForFieldName('type'), s));
      break;
    case 'kotlin':
      for (const p of kids(kid(scope, 'function_value_parameters'), 'parameter')) set(kid(p, 'simple_identifier'), typeOf(kid(p, 'user_type') ?? kid(p, 'nullable_type'), s));
      break;
    case 'swift':
      for (const p of kids(scope, 'parameter')) {
        const names = p.childrenForFieldName?.('name') ?? [];
        const id = names.find((c: any) => c.type === 'simple_identifier');
        const ty = names.find((c: any) => c.type !== 'simple_identifier');
        set(id, typeOf(ty, s));
      }
      break;
    case 'go':
      for (const list of [scope.childForFieldName('receiver'), scope.childForFieldName('parameters')]) {
        for (const p of kids(list, 'parameter_declaration')) {
          const ty = typeOf(p.childForFieldName('type'), s);
          for (const n of p.childrenForFieldName?.('name') ?? []) set(n, ty);
        }
      }
      break;
    case 'rust':
      for (const p of kids(scope.childForFieldName('parameters'), 'parameter')) {
        const pat = p.childForFieldName('pattern');
        if (pat?.type === 'identifier') set(pat, typeOf(p.childForFieldName('type'), s));
      }
      break;
    case 'dart': {
      // A method's body follows its signature
      const sig = scope.previousNamedSibling;
      const fs = sig?.type === 'method_signature' ? kid(sig, 'function_signature') : sig?.type === 'function_signature' ? sig : null;
      for (const p of kids(kid(fs, 'formal_parameter_list'), 'formal_parameter')) set(p.childForFieldName('name') ?? kid(p, 'identifier'), typeOf(kid(p, 'type_identifier'), s));
      break;
    }
    case 'php':
      for (const p of scope.childForFieldName('parameters')?.namedChildren ?? []) {
        if (p.type === 'simple_parameter' || p.type === 'property_promotion_parameter') set(p.childForFieldName('name'), typeOf(p.childForFieldName('type'), s));
      }
      break;
  }
  return out;
}

/** Locals of a scope with a type it can tell: name → type. */
function locals(scope: any, s: string, lang: Lang): Map<string, string> {
  const key = scope ? `locals:${scope.startIndex}:${scope.endIndex}:${scope.type}` : '';
  const cached = key ? declared.get(key) : undefined;
  if (cached) return cached;
  const out = localsUncached(scope, s, lang);
  if (key) declared.set(key, out);
  return out;
}

function localsUncached(scope: any, s: string, lang: Lang): Map<string, string> {
  const out = new Map<string, string>();
  const set = (name: any, type: string | undefined) => { if (name && type && !out.has(text(name, s))) out.set(text(name, s).replace(/^\$/, ''), type); };
  const body = lang === 'dart' ? scope : scope.childForFieldName('body') ?? scope;
  eachIn(body, lang, n => {
    switch (lang) {
      case 'csharp':
        if (n.type === 'variable_declaration') {
          const ty = n.childForFieldName('type');
          for (const d of kids(n, 'variable_declarator')) {
            set(d.childForFieldName('name'), ty && ty.type !== 'implicit_type' ? typeOf(ty, s) : constructed(d.namedChildren[d.namedChildren.length - 1], s, lang));
          }
        }
        break;
      case 'kotlin':
        if (n.type === 'property_declaration') {
          const v = kid(n, 'variable_declaration');
          set(kid(v, 'simple_identifier'), typeOf(kid(v, 'user_type') ?? kid(v, 'nullable_type'), s) ?? constructed(n.namedChildren[n.namedChildren.length - 1], s, lang));
        }
        break;
      case 'swift':
        if (n.type === 'property_declaration') {
          const pat = n.childForFieldName('name');
          const id = pat?.childForFieldName('bound_identifier') ?? kid(pat, 'simple_identifier');
          set(id, typeOf(kid(kid(n, 'type_annotation'), 'user_type') ?? kid(n, 'type_annotation')?.childForFieldName('name'), s) ?? constructed(n.childForFieldName('value'), s, lang));
        }
        break;
      case 'go':
        if (n.type === 'var_spec') {
          const ty = typeOf(n.childForFieldName('type'), s);
          const value = n.childForFieldName('value')?.namedChild(0);
          for (const name of n.childrenForFieldName?.('name') ?? []) set(name, ty ?? constructed(value, s, lang));
        } else if (n.type === 'short_var_declaration') {
          const left = n.childForFieldName('left')?.namedChildren ?? [];
          const right = n.childForFieldName('right')?.namedChildren ?? [];
          left.forEach((l: any, i: number) => set(l, constructed(right[i], s, lang)));
        }
        break;
      case 'rust':
        if (n.type === 'let_declaration') {
          const pat = n.childForFieldName('pattern');
          if (pat?.type === 'identifier') set(pat, typeOf(n.childForFieldName('type'), s) ?? constructed(n.childForFieldName('value'), s, lang));
        }
        break;
      case 'dart':
        if (n.type === 'initialized_variable_definition') {
          const ty = kid(n, 'type_identifier');
          const values = n.childrenForFieldName?.('value') ?? [];
          // `final x = Repo();` is an identifier and a selector with arguments
          const ctor = values[0]?.type === 'identifier' && values[1]?.type === 'selector' && kid(values[1], 'argument_part') ? typeOf(values[0], s) : undefined;
          set(n.childForFieldName('name'), typeOf(ty, s) ?? ctor);
        }
        break;
      case 'php':
        if (n.type === 'assignment_expression') {
          const left = n.childForFieldName('left');
          if (left?.type === 'variable_name') set(left, constructed(n.childForFieldName('right'), s, lang));
        }
        break;
      case 'ruby':
        if (n.type === 'assignment') {
          const left = n.childForFieldName('left');
          if (left?.type === 'identifier') set(left, constructed(n.childForFieldName('right'), s, lang));
        }
        break;
    }
  });
  return out;
}

/** The fields of a type with a type it can tell: name → type. */
function fields(cls: any, s: string, lang: Lang, root: any): Map<string, string> {
  // Go names the type (a string): its fields are the struct's of that name
  const key = typeof cls === 'string' ? `fields:name:${cls}` : cls ? `fields:${cls.startIndex}:${cls.endIndex}:${cls.type}` : '';
  const cached = key ? declared.get(key) : undefined;
  if (cached) return cached;
  const out = fieldsUncached(cls, s, lang, root);
  if (key) declared.set(key, out);
  return out;
}

function fieldsUncached(cls: any, s: string, lang: Lang, root: any): Map<string, string> {
  const out = new Map<string, string>();
  const set = (name: any, type: string | undefined) => { if (name && type && !out.has(text(name, s).replace(/^\$/, ''))) out.set(text(name, s).replace(/^\$/, ''), type); };
  // A constructor parameter assigned to a field: `_repo = repo`, `self.repo = repo`, `$this->repo = $r`
  const assigned = (ctor: any) => {
    const ps = params(ctor, s, lang);
    eachIn(ctor.childForFieldName('body') ?? ctor, lang, n => {
      if (n.type !== 'assignment_expression' && n.type !== 'assignment') return;
      const left = n.childForFieldName('left') ?? n.childForFieldName('target');
      const right = n.childForFieldName('right') ?? n.childForFieldName('result');
      if (!left || !right) return;
      const name = text(left, s).replace(/^(this\.|self\.|\$this->)/, '');
      const value = text(right, s).replace(/^\$/, '');
      if (/^\w+$/.test(name) && ps.has(value) && !out.has(name)) out.set(name, ps.get(value)!);
    });
  };
  switch (lang) {
    case 'csharp':
      for (const m of cls.childForFieldName('body')?.namedChildren ?? []) {
        if (m.type === 'field_declaration') {
          const v = kid(m, 'variable_declaration');
          const ty = typeOf(v?.childForFieldName('type'), s);
          for (const d of kids(v, 'variable_declarator')) set(d.childForFieldName('name'), ty);
        } else if (m.type === 'property_declaration') set(m.childForFieldName('name'), typeOf(m.childForFieldName('type'), s));
        else if (m.type === 'constructor_declaration') assigned(m);
      }
      // Primary constructor parameters (C# 12)
      for (const p of kids(cls.childForFieldName('parameters') ?? kid(cls, 'parameter_list'), 'parameter')) set(p.childForFieldName('name'), typeOf(p.childForFieldName('type'), s));
      break;
    case 'kotlin':
      for (const p of kids(kid(cls, 'primary_constructor'), 'class_parameter')) set(kid(p, 'simple_identifier'), typeOf(kid(p, 'user_type') ?? kid(p, 'nullable_type'), s));
      for (const m of kid(cls, 'class_body')?.namedChildren ?? []) {
        if (m.type === 'property_declaration') {
          const v = kid(m, 'variable_declaration');
          set(kid(v, 'simple_identifier'), typeOf(kid(v, 'user_type') ?? kid(v, 'nullable_type'), s) ?? constructed(m.namedChildren[m.namedChildren.length - 1], s, lang));
        }
      }
      break;
    case 'swift':
      for (const m of cls.childForFieldName('body')?.namedChildren ?? []) {
        if (m.type === 'property_declaration') {
          const pat = m.childForFieldName('name');
          const id = pat?.childForFieldName('bound_identifier') ?? kid(pat, 'simple_identifier');
          set(id, typeOf(kid(kid(m, 'type_annotation'), 'user_type'), s) ?? constructed(m.childForFieldName('value'), s, lang));
        } else if (m.type === 'init_declaration') assigned(m);
      }
      break;
    case 'dart':
      for (const m of cls.childForFieldName('body')?.namedChildren ?? []) {
        if (m.type !== 'declaration') continue;
        const ty = typeOf(kid(m, 'type_identifier'), s);
        for (const init of kids(kid(m, 'initialized_identifier_list'), 'initialized_identifier')) {
          const ids = kids(init, 'identifier');
          const sel = kid(init, 'selector');
          set(ids[0], ty ?? (ids[1] && sel && kid(sel, 'argument_part') ? typeOf(ids[1], s) : undefined));
        }
      }
      break;
    case 'php':
      for (const m of cls.childForFieldName('body')?.namedChildren ?? []) {
        if (m.type === 'property_declaration') {
          const ty = typeOf(m.childForFieldName('type'), s);
          for (const el of kids(m, 'property_element')) set(el.childForFieldName('name') ?? kid(el, 'variable_name'), ty);
        } else if (m.type === 'method_declaration' && text(m.childForFieldName('name') ?? m, s) === '__construct') {
          for (const p of kids(m.childForFieldName('parameters'), 'property_promotion_parameter')) set(p.childForFieldName('name'), typeOf(p.childForFieldName('type'), s));
          assigned(m);
        }
      }
      break;
    case 'ruby': {
      // @cache = Cache.new in any method of the class
      const visit = (n: any) => {
        for (const c of n.namedChildren ?? []) {
          if (CLASSES[lang].has(c.type)) continue;
          if (c.type === 'assignment' && c.childForFieldName('left')?.type === 'instance_variable') {
            const name = text(c.childForFieldName('left'), s).replace(/^@/, '');
            const ty = constructed(c.childForFieldName('right'), s, lang);
            if (ty && !out.has(name)) out.set(name, ty);
          }
          visit(c);
        }
      };
      visit(cls.childForFieldName('body') ?? cls);
      break;
    }
    case 'rust': case 'go': {
      // The struct declared in the file: `impl S` (Rust), the method's receiver type (Go)
      const name = lang === 'rust' ? typeOf(cls.childForFieldName('type'), s) : cls;
      if (typeof name !== 'string') break;
      const find = (n: any): any => {
        for (const c of n.namedChildren) {
          if (lang === 'rust' && c.type === 'struct_item' && text(c.childForFieldName('name') ?? c, s) === name) return c;
          if (lang === 'go' && c.type === 'type_declaration') {
            for (const spec of kids(c, 'type_spec')) if (text(spec.childForFieldName('name') ?? spec, s) === name) return spec.childForFieldName('type');
          }
        }
        return null;
      };
      const decl = find(root);
      const list = lang === 'rust' ? decl?.childForFieldName('body') : decl?.type === 'struct_type' ? kid(decl, 'field_declaration_list') : null;
      for (const f of kids(list, 'field_declaration')) {
        const ty = typeOf(f.childForFieldName('type'), s);
        for (const n of (f.childrenForFieldName?.('name') ?? [])) set(n, ty);
      }
      break;
    }
  }
  return out;
}

/** Ruby: the class a method returns, by its last expression or its `return`s (`Ledger.new`). */
export function rubyReturnType(node: any, s: string): string | undefined {
  if (node.type !== 'method' && node.type !== 'singleton_method') return undefined;
  const body = node.childForFieldName('body');
  const values: any[] = [];
  const last = body?.lastNamedChild;
  if (last && last.type !== 'return') values.push(last);
  eachIn(body, 'ruby', n => { if (n.type === 'return') { const v = n.namedChild(0)?.namedChild?.(0) ?? n.namedChild(0); if (v) values.push(v); } });
  const types = new Set(values.map(v => constructed(v, s, 'ruby')));
  if (types.size !== 1) return undefined;
  return [...types][0];
}

/** Ruby: the names a node binds as locals: `x = …`, `a, b = …`, `x ||= …`, `rescue => e`, `for x in`. */
function rubyBinds(n: any, name: string, s: string): boolean {
  const is = (id: any) => id?.type === 'identifier' && text(id, s) === name;
  if (n.type === 'assignment' || n.type === 'operator_assignment') {
    const left = n.childForFieldName('left');
    if (is(left)) return true;
    if (left?.type === 'left_assignment_list') return left.namedChildren.some((c: any) => is(c) || (c.type === 'rest_assignment' && is(c.namedChild(0))));
    return false;
  }
  if (n.type === 'exception_variable') return n.namedChildren.some(is);
  if (n.type === 'for') return is(n.childForFieldName('pattern'));
  return false;
}

/** Ruby: whether a bare name is a parameter or a local of the scope (not a method called without parentheses). */
export function rubyIsLocal(call: any, name: string, s: string): boolean {
  let top = call;
  for (let scope = enclosing(call, SCOPES.ruby); scope; scope = enclosing(scope, SCOPES.ruby)) {
    top = scope;
    const ps = scope.childForFieldName('parameters') ?? kid(scope, 'block_parameters');
    if (ps && ps.namedChildren.some((p: any) => text(p.type === 'identifier' ? p : (p.childForFieldName('name') ?? p), s) === name)) return true;
    let found = false;
    eachIn(scope.childForFieldName('body') ?? scope, 'ruby', n => { if (!found && rubyBinds(n, name, s)) found = true; });
    if (found) return true;
    // A method's scope ends there: the file's locals are not visible in it
    if (scope.type === 'method' || scope.type === 'singleton_method') return false;
  }
  // A script's or a Rakefile's top level
  while (top.parent) top = top.parent;
  let found = false;
  eachIn(top, 'ruby', n => { if (!found && rubyBinds(n, name, s)) found = true; });
  return found;
}

/** The declared type of a call's receiver, or undefined when the code does not say it. */
/** What params(), locals() and fields() read, for the tree being read (see resetMoreReceiverCaches). */
const declared = new Map<string, Map<string, string>>();

/** Forgets what was read from a tree, when the tree is deleted. */
export function resetMoreReceiverCaches(): void {
  declared.clear();
}

export function moreReceiverType(call: any, receiver: string, s: string, language: Language): string | undefined {
  if (!LANGS.has(language)) return undefined;
  const lang = language as Lang;
  const r = receiver.replace(/[!?]+$/, '').replace(/^\$/, '').trim();
  const root = (() => { let n = call; while (n.parent) n = n.parent; return n; })();

  // Ruby: Store.new.put(), @cache.get()
  if (lang === 'ruby') {
    const created = /^([A-Z][\w:]*)\.new(?:\([^()]*\))?$/.exec(r);
    if (created) return typeName(created[1].split('::').pop()!);
  }
  // this.x / self.x / $this->x (PHP's receiver comes as `this->x`), Ruby's @x
  const member = /^(?:this|self)(?:\.|->)(\w+)$/.exec(r) ?? (lang === 'ruby' ? /^@(\w+)$/.exec(r) : null);
  if (member) {
    const cls = enclosing(call, CLASSES[lang]);
    if (cls) return fields(cls, s, lang, root).get(member[1]);
    return undefined;
  }

  // Go: `s.repo` on the method's receiver
  const goField = lang === 'go' ? /^(\w+)\.(\w+)$/.exec(r) : null;
  if (goField) {
    const method = enclosing(call, new Set(['method_declaration']));
    const recv = method ? kids(method.childForFieldName('receiver'), 'parameter_declaration')[0] : null;
    const recvName = recv?.childForFieldName('name');
    if (recvName && text(recvName, s) === goField[1]) return fields(typeOf(recv.childForFieldName('type'), s), s, lang, root).get(goField[2]);
    return undefined;
  }

  if (!/^\w+$/.test(r) || r === 'this' || r === 'self') return undefined;
  // The nearest scope that declares it: a parameter, a local
  for (let scope = enclosing(call, SCOPES[lang]); scope; scope = enclosing(scope, SCOPES[lang])) {
    const t = params(scope, s, lang).get(r) ?? locals(scope, s, lang).get(r);
    if (t) return t;
  }
  // A field named without `this`
  if (IMPLICIT_SELF.has(lang)) {
    const cls = enclosing(call, CLASSES[lang]);
    if (cls) return fields(cls, s, lang, root).get(r);
  }
  return undefined;
}
