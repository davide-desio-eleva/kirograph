/**
 * The declared type of a call's receiver, where the code says it: `userService` in
 * `this.userService.find()` is a `UserService` when the class declares
 * `constructor(private userService: UserService)`; `repo` in `repo.save()` is a `Repo` when it is a
 * parameter `repo: Repo`, a local `const repo = new Repo()`, or a Python `repo = Repo()`.
 *
 * Read from the syntax tree of the file only: parameters with a type, local declarations with a
 * type or a constructor call, and the fields of the enclosing class (typed fields, TypeScript
 * constructor parameter properties, `this.x = …` / `self.x = …` assignments). Nothing is inferred
 * from what a function returns. Resolution looks the method up in that type and its supertypes.
 *
 * TypeScript, JavaScript, Python and Java.
 */
import type { Language } from '../types';

type Family = 'js' | 'python' | 'java';

const FAMILY: Partial<Record<Language, Family>> = {
  typescript: 'js', tsx: 'js', javascript: 'js', jsx: 'js',
  python: 'python',
  java: 'java',
};

const SCOPES: Record<Family, Set<string>> = {
  js: new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition',
    'generator_function_declaration', 'generator_function', 'function', 'program']),
  python: new Set(['function_definition', 'module']),
  java: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
};

const CLASSES: Record<Family, Set<string>> = {
  js: new Set(['class_declaration', 'abstract_class_declaration', 'class']),
  python: new Set(['class_definition']),
  java: new Set(['class_declaration', 'enum_declaration', 'record_declaration']),
};

const SELF: Record<Family, string> = { js: 'this', python: 'self', java: 'this' };

/**
 * A call whose value is the receiver: `getRepo()` in `getRepo().save()`, or in
 * `const repo = getRepo(); repo.save()`. Resolution types the receiver by the declared return
 * type of the function the call reaches.
 */
export interface ReceiverCall {
  name: string;
  receiver?: string;
  receiverType?: string;
  receiverCall?: ReceiverCall;
}

/** What is known of a receiver: its declared type, or the call it is the value of. */
type Known = { type: string } | { call: any };

/** Declarations by scope, for the file being read (keyed by the scope's position). */
let cacheSource: string | null = null;
const scopeCache = new Map<string, Map<string, Known>>();
const classCache = new Map<string, Map<string, Known>>();

const keyOf = (n: any): string => `${n.startIndex}:${n.endIndex}`;
const text = (n: any, source: string): string => source.slice(n.startIndex, n.endIndex);

/**
 * A type's name as written, reduced to the class it names: `Repo<User>` → Repo,
 * `Optional[Foo]` → Foo, `Foo | null` → Foo, `models.Foo` → Foo, `"Foo"` → Foo. Undefined for a
 * union of several types, a primitive or anything that is not a capitalized name.
 */
export function typeName(raw: string): string | undefined {
  let t = raw.trim().replace(/^:\s*/, '').replace(/^['"]|['"]$/g, '');
  const optional = /^(?:typing\.)?Optional\[(.*)\]$/.exec(t);
  if (optional) t = optional[1];
  const parts = t.split('|').map(p => p.trim()).filter(p => p && !/^(null|undefined|None)$/.test(p));
  if (parts.length !== 1) return undefined;
  t = parts[0].replace(/^readonly\s+/, '');
  t = t.split(/[<\[]/)[0].trim();
  t = t.slice(t.lastIndexOf('.') + 1);
  return /^[A-Z][\w$]*$/.test(t) ? t : undefined;
}

const CALLS = new Set(['call_expression', 'call', 'method_invocation']);

/** What a value says of its type: a constructor call's class, or the call whose result it is. */
function valueOf(value: any, source: string, family: Family): Known | undefined {
  if (value?.type === 'await_expression') value = value.namedChild(0);
  if (!value) return undefined;
  const t = constructed(value, source, family);
  if (t) return { type: t };
  return CALLS.has(value.type) ? { call: value } : undefined;
}

/** A declared type node, as what is known. */
function typed(type: any, source: string): Known | undefined {
  const t = type ? typeName(text(type, source)) : undefined;
  return t ? { type: t } : undefined;
}

/** The class a constructor call creates: `new Foo()`, `new a.Foo()`, Python `Foo()` / `m.Foo()`. */
function constructed(value: any, source: string, family: Family): string | undefined {
  if (!value) return undefined;
  if (value.type === 'await_expression') value = value.namedChild(0);
  if (!value) return undefined;
  if (value.type === 'new_expression') {
    const ctor = value.childForFieldName('constructor');
    return ctor ? typeName(text(ctor, source)) : undefined;
  }
  if (value.type === 'object_creation_expression') {
    const type = value.childForFieldName('type');
    return type ? typeName(text(type, source)) : undefined;
  }
  if (family === 'python' && value.type === 'call') {
    const fn = value.childForFieldName('function');
    if (fn && (fn.type === 'identifier' || fn.type === 'attribute')) return typeName(text(fn, source));
  }
  return undefined;
}

/** Parameters with a declared type: name → type. */
function parameters(scope: any, source: string, family: Family): Map<string, Known> {
  const out = new Map<string, Known>();
  const params = scope.childForFieldName('parameters');
  if (!params) return out;
  for (const p of params.namedChildren) {
    let name: any = null;
    let type: any = null;
    if (family === 'js' && (p.type === 'required_parameter' || p.type === 'optional_parameter')) {
      name = p.childForFieldName('pattern');
      type = p.childForFieldName('type');
    } else if (family === 'python' && p.type === 'typed_parameter') {
      name = p.namedChildren.find((c: any) => c.type === 'identifier');
      type = p.childForFieldName('type');
    } else if (family === 'python' && p.type === 'typed_default_parameter') {
      name = p.childForFieldName('name');
      type = p.childForFieldName('type');
    } else if (family === 'java' && p.type === 'formal_parameter') {
      name = p.childForFieldName('name');
      type = p.childForFieldName('type');
    }
    if (name?.type === 'identifier' && type) {
      const t = typeName(text(type, source));
      if (t) out.set(text(name, source), { type: t });
    }
  }
  return out;
}

/** Walks a scope's body without entering nested functions or classes. */
function eachInScope(node: any, family: Family, visit: (n: any) => void): void {
  for (const child of node.namedChildren) {
    if (SCOPES[family].has(child.type) || CLASSES[family].has(child.type)) continue;
    visit(child);
    eachInScope(child, family, visit);
  }
}

/** The variables a scope declares with a type it can tell: its typed parameters and locals. */
function declarations(scope: any, source: string, family: Family): Map<string, Known> {
  const key = keyOf(scope);
  const cached = scopeCache.get(key);
  if (cached) return cached;
  const out = parameters(scope, source, family);
  const body = scope.childForFieldName('body') ?? scope;
  eachInScope(body, family, n => {
    if (family === 'js' && n.type === 'variable_declarator') {
      const name = n.childForFieldName('name');
      if (name?.type !== 'identifier') return;
      const k = typed(n.childForFieldName('type'), source) ?? valueOf(n.childForFieldName('value'), source, family);
      if (k) out.set(text(name, source), k);
    } else if (family === 'python' && n.type === 'assignment') {
      const left = n.childForFieldName('left');
      if (left?.type !== 'identifier') return;
      const k = typed(n.childForFieldName('type'), source) ?? valueOf(n.childForFieldName('right'), source, family);
      if (k) out.set(text(left, source), k);
    } else if (family === 'java' && n.type === 'local_variable_declaration') {
      const type = n.childForFieldName('type');
      for (const d of n.namedChildren.filter((c: any) => c.type === 'variable_declarator')) {
        const name = d.childForFieldName('name');
        const k = (type && text(type, source) !== 'var' ? typed(type, source) : undefined) ?? valueOf(d.childForFieldName('value'), source, family);
        if (name && k) out.set(text(name, source), k);
      }
    }
  });
  scopeCache.set(key, out);
  return out;
}

/** The fields of a class with a type it can tell: name → type. */
function fields(cls: any, source: string, family: Family): Map<string, Known> {
  const key = keyOf(cls);
  const cached = classCache.get(key);
  if (cached) return cached;
  const out = new Map<string, Known>();
  const body = cls.childForFieldName('body');
  if (!body) return out;
  const self = SELF[family];

  // `this.x = …` / `self.x = …` in a method: a constructor call, or a typed parameter of the method
  const assignedIn = (method: any) => {
    const params = parameters(method, source, family);
    const methodBody = method.childForFieldName('body');
    if (!methodBody) return;
    eachInScope(methodBody, family, n => {
      if (n.type !== 'assignment_expression' && n.type !== 'assignment') return;
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (!left || !right) return;
      const obj = left.childForFieldName('object');
      const prop = left.childForFieldName('property') ?? left.childForFieldName('attribute') ?? left.childForFieldName('field');
      if (!obj || !prop || text(obj, source) !== self) return;
      const name = text(prop, source);
      if (out.has(name)) return;
      const k = typed(n.childForFieldName('type'), source)
        ?? (right.type === 'identifier' ? params.get(text(right, source)) : valueOf(right, source, family));
      if (k) out.set(name, k);
    });
  };

  for (const m of body.namedChildren) {
    if (family === 'js' && m.type === 'public_field_definition') {
      const name = m.childForFieldName('name');
      const k = typed(m.childForFieldName('type'), source) ?? valueOf(m.childForFieldName('value'), source, family);
      if (name && k) out.set(text(name, source).replace(/^#/, ''), k);
    } else if (family === 'js' && m.type === 'method_definition') {
      // Constructor parameter properties: `constructor(private readonly svc: UserService)`
      if (text(m.childForFieldName('name') ?? m, source) === 'constructor') {
        for (const p of m.childForFieldName('parameters')?.namedChildren ?? []) {
          const modified = p.namedChildren.some((c: any) => c.type === 'accessibility_modifier' || c.type === 'override_modifier')
            || /^\s*readonly\b/.test(text(p, source));
          const name = p.childForFieldName('pattern');
          const type = p.childForFieldName('type');
          const t = type ? typeName(text(type, source)) : undefined;
          if (modified && name?.type === 'identifier' && t) out.set(text(name, source), { type: t });
        }
      }
      assignedIn(m);
    } else if (family === 'python' && m.type === 'expression_statement') {
      // Class-level annotation: `repo: Repo`
      const a = m.namedChild(0);
      const left = a?.type === 'assignment' ? a.childForFieldName('left') : null;
      const type = a?.type === 'assignment' ? a.childForFieldName('type') : null;
      const t = type ? typeName(text(type, source)) : undefined;
      if (left?.type === 'identifier' && t) out.set(text(left, source), { type: t });
    } else if (family === 'python' && (m.type === 'function_definition' || m.type === 'decorated_definition')) {
      const fn = m.type === 'decorated_definition' ? m.childForFieldName('definition') : m;
      if (fn?.type === 'function_definition') assignedIn(fn);
    } else if (family === 'java' && m.type === 'field_declaration') {
      const t = typed(m.childForFieldName('type'), source);
      for (const d of m.namedChildren.filter((c: any) => c.type === 'variable_declarator')) {
        const name = d.childForFieldName('name');
        const k = t ?? valueOf(d.childForFieldName('value'), source, family);
        if (name && k) out.set(text(name, source), k);
      }
    } else if (family === 'java' && m.type === 'constructor_declaration') {
      assignedIn(m);
    }
  }
  classCache.set(key, out);
  return out;
}

function enclosing(node: any, kinds: Set<string>): any {
  for (let n = node.parent; n; n = n.parent) if (kinds.has(n.type)) return n;
  return null;
}

/**
 * The function a call calls, without its type arguments: `getTyped` in Go's `getTyped[bool](c)`,
 * `parse` in Rust's `parse::<u8>(s)`, `x.collect` in `x.collect::<Vec<_>>()`.
 */
export function calleeOf(call: any): any {
  let fn = call.childForFieldName?.('function') ?? call.child(0);
  // and without its C++ scope: `helper` in `ns::helper<int>(1)`
  while (fn && (fn.type === 'generic_function' || fn.type === 'index_expression'
    || fn.type === 'qualified_identifier' || fn.type === 'template_function')) {
    fn = fn.type === 'qualified_identifier' || fn.type === 'template_function'
      ? fn.childForFieldName('name')
      : fn.childForFieldName('function') ?? fn.childForFieldName('operand') ?? fn.namedChild(0);
  }
  return fn;
}

/** The receiver expression of a call: `repo` in `repo.save()`, `getRepo()` in `getRepo().save()`. */
function receiverNode(call: any): any {
  const named = call.childForFieldName('object') ?? call.childForFieldName('receiver');
  if (named) return named;
  const fn = calleeOf(call);
  if (!fn) return null;
  if (fn.type === 'member_expression' || fn.type === 'attribute' || fn.type === 'field_expression' || fn.type === 'selector_expression' || fn.type === 'navigation_expression') {
    return fn.childForFieldName('object') ?? fn.childForFieldName('operand') ?? fn.namedChild(0);
  }
  return null;
}

/** The name a call calls: `save` in `repo.save()`, `getRepo` in `getRepo()`. */
function calledName(call: any, source: string): string | undefined {
  const named = call.childForFieldName('name');
  if (named) return text(named, source);
  const fn = calleeOf(call);
  if (!fn) return undefined;
  const last = fn.childForFieldName('property') ?? fn.childForFieldName('attribute') ?? fn.childForFieldName('field')
    ?? (fn.type === 'navigation_expression'
      ? (fn.lastNamedChild?.type === 'navigation_suffix' ? fn.lastNamedChild.childForFieldName('suffix') ?? fn.lastNamedChild.lastNamedChild : fn.lastNamedChild)
      : fn);
  const name = text(last, source);
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

/** A call described for resolution, with what is known of its own receiver (a chain, three deep). */
function describe(call: any, source: string, language: Language, depth: number): ReceiverCall | undefined {
  const name = calledName(call, source);
  if (!name) return undefined;
  const out: ReceiverCall = { name };
  const recv = receiverNode(call);
  if (recv) {
    out.receiver = text(recv, source).trim();
    const info = depth < 3 ? receiverInfo(call, out.receiver, source, language, depth + 1) : {};
    if (info.type) out.receiverType = info.type;
    if (info.call) out.receiverCall = info.call;
  }
  return out;
}

/**
 * What the code says of the receiver of a call: its declared type, or the call it is the value of
 * (`getRepo().save()`, `const repo = getRepo(); repo.save()`), whose declared return type
 * resolution reads.
 */
export function receiverInfo(call: any, receiver: string, source: string, language: Language, depth = 0): { type?: string; call?: ReceiverCall } {
  const family = FAMILY[language];
  if (!family) return {};
  if (source !== cacheSource) {
    cacheSource = source;
    scopeCache.clear();
    classCache.clear();
  }
  const known = (k: Known | undefined): { type?: string; call?: ReceiverCall } => {
    if (!k) return {};
    if ('type' in k) return { type: k.type };
    const c = depth < 3 ? describe(k.call, source, language, depth + 1) : undefined;
    return c ? { call: c } : {};
  };

  // A call: `getRepo().save()`, `this.repo().find()`
  const recv = receiverNode(call);
  if (recv && CALLS.has(recv.type)) return known({ call: recv });
  if (recv?.type === 'await_expression' || recv?.type === 'parenthesized_expression') {
    const inner = recv.namedChild(0)?.type === 'await_expression' ? recv.namedChild(0).namedChild(0) : recv.namedChild(0);
    if (inner && CALLS.has(inner.type)) return known({ call: inner });
  }

  const r = receiver.replace(/[!?]+$/, '').trim();
  const created = /^new\s+([\w$.]+)\s*(?:<[^>]*>)?\s*\(/.exec(r);
  if (created) {
    const t = typeName(created[1]);
    return t ? { type: t } : {};
  }

  const member = new RegExp(`^${SELF[family]}\\.([A-Za-z_$][\\w$]*)$`).exec(r);
  if (member) {
    const cls = enclosing(call, CLASSES[family]);
    return cls ? known(fields(cls, source, family).get(member[1])) : {};
  }

  if (!/^[A-Za-z_$][\w$]*$/.test(r) || r === SELF[family]) return {};
  // The nearest scope that declares the name: a parameter, a local, then (Java) a field
  for (let scope = enclosing(call, SCOPES[family]); scope; scope = enclosing(scope, SCOPES[family])) {
    const k = declarations(scope, source, family).get(r);
    if (k) return known(k);
  }
  if (family === 'java') {
    const cls = enclosing(call, CLASSES[family]);
    if (cls) return known(fields(cls, source, family).get(r));
  }
  return {};
}

/**
 * The class a function or method declares it returns: `(): Repo`, `(): Promise<Repo>` (the value
 * after `await`), Python `-> Repo`, Java `Repo get()`. For `const f = (): Repo => …` too.
 */
export function declaredReturnType(node: any, source: string, language: Language): string | undefined {
  const family = FAMILY[language];
  if (!family) return undefined;
  let fn = node;
  if (family === 'js' && (node.type === 'lexical_declaration' || node.type === 'variable_declaration')) {
    const value = node.namedChildren.find((c: any) => c.type === 'variable_declarator')?.childForFieldName('value');
    if (!value || (value.type !== 'arrow_function' && value.type !== 'function_expression' && value.type !== 'function')) return undefined;
    fn = value;
  }
  const type = family === 'java' ? fn.childForFieldName('type') : fn.childForFieldName('return_type');
  if (!type) return undefined;
  const raw = text(type, source).replace(/^:\s*/, '').trim();
  const awaited = /^Promise\s*<(.*)>$/.exec(raw);
  return typeName(awaited ? awaited[1] : raw);
}
