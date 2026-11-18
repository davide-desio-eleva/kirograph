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
type Known =
  | { type: string }
  /** The value of a call, typed by what the call returns. */
  | { call: any }
  /** A collection of a known element type (`list[Foo]`, `Foo[]`): no type of its own. */
  | { element: string }
  /** An element of a collection: a loop variable, a callback's parameter (`for x in xs`). */
  | { iter: any };

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
  // An array of Foo is no Foo
  if (/\[\s*\]$/.test(t)) return undefined;
  t = t.split(/[<\[]/)[0].trim();
  t = t.slice(t.lastIndexOf('.') + 1);
  return /^[A-Z][\w$]*$/.test(t) ? t : undefined;
}

/** Collections whose type argument is their element's type. */
const COLLECTION = /^(?:typing\.|collections\.abc\.|java\.util\.)?(?:list|List|Sequence|MutableSequence|Iterable|Iterator|Collection|set|Set|MutableSet|frozenset|FrozenSet|AbstractSet|tuple|Tuple|Generator|AsyncIterable|AsyncIterator|AsyncGenerator|Array|ReadonlyArray|ArrayList|LinkedList|HashSet|LinkedHashSet|TreeSet|SortedSet|Deque|ArrayDeque|Queue|Stream)\s*[\[<]/;

/** The element type of a collection type: `list[Foo]`, `Foo[]`, `Array<Foo>`, `List<Foo>` → Foo. */
export function elementName(raw: string): string | undefined {
  let t = raw.trim().replace(/^:\s*/, '').replace(/^readonly\s+/, '');
  const optional = /^(?:typing\.)?Optional\[(.*)\]$/.exec(t);
  if (optional) t = optional[1];
  const array = /^(.*?)\s*\[\s*\]$/.exec(t);
  if (array) return typeName(array[1].replace(/^\((.*)\)$/, '$1'));
  const m = COLLECTION.exec(t);
  if (!m) return undefined;
  // The first type argument, at the top level: `tuple[Foo, ...]`, `Generator[Foo, None, None]`
  const inner = t.slice(m[0].length, -1);
  let depth = 0, end = inner.length;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '[' || c === '<' || c === '(') depth++;
    else if (c === ']' || c === '>' || c === ')') depth--;
    else if (c === ',' && depth === 0) { end = i; break; }
  }
  return typeName(inner.slice(0, end));
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
  if (!type) return undefined;
  const raw = text(type, source);
  const e = elementName(raw);
  if (e) return { element: e };
  const t = typeName(raw);
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
    // cls(…), self.__class__(…), type(self)(…): the enclosing class
    if (fn && /^(cls|self\.__class__|type\(self\)|type\(cls\))$/.test(text(fn, source).replace(/\s+/g, ''))) return ownClassName(value, source, family);
    if (fn && (fn.type === 'identifier' || fn.type === 'attribute')) return typeName(text(fn, source));
  }
  return undefined;
}

/** The name of the class a node is in. */
function ownClassName(node: any, source: string, family: Family): string | undefined {
  const cls = enclosing(node, CLASSES[family]);
  const name = cls?.childForFieldName('name');
  return name ? typeName(text(name, source)) : undefined;
}

/** Parameters with a declared type: name → type. */
function parameters(scope: any, source: string, family: Family): Map<string, Known> {
  const out = new Map<string, Known>();
  const params = scope.childForFieldName('parameters');
  if (!params) return out;
  for (const p of params.namedChildren) {
    let name: any = null;
    let type: any = null;
    let value: any = null;
    if (family === 'js' && (p.type === 'required_parameter' || p.type === 'optional_parameter')) {
      name = p.childForFieldName('pattern');
      type = p.childForFieldName('type');
      value = p.childForFieldName('value');
    } else if (family === 'js' && p.type === 'assignment_pattern') {
      // A default value: `(repo = new Repo())`
      name = p.childForFieldName('left');
      value = p.childForFieldName('right');
    } else if (family === 'python' && p.type === 'default_parameter') {
      name = p.childForFieldName('name');
      value = p.childForFieldName('value');
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
    if (name?.type !== 'identifier') continue;
    const t = typed(type, source);
    const d = !t && value ? constructed(value, source, family) : undefined;
    if (t) out.set(text(name, source), t);
    else if (d) out.set(text(name, source), { type: d });
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
    } else if (family === 'python' && (n.type === 'for_statement' || n.type === 'for_in_clause')) {
      // for x in xs / [… for x in xs]
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left?.type === 'identifier' && right) out.set(text(left, source), { iter: right });
    } else if (family === 'js' && n.type === 'for_in_statement') {
      // for (const x of xs): an element; `for (k in o)` gives keys
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      const of = n.children.some((c: any) => !c.isNamed && c.type === 'of');
      if (of && left?.type === 'identifier' && right) out.set(text(left, source), { iter: right });
    } else if (family === 'java' && n.type === 'enhanced_for_statement') {
      // for (Foo x : xs), for (var x : xs)
      const name = n.childForFieldName('name');
      const type = n.childForFieldName('type');
      const value = n.childForFieldName('value');
      const k = type && text(type, source) !== 'var' ? typed(type, source) : value ? { iter: value } : undefined;
      if (name && k) out.set(text(name, source), k);
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
          const k = typed(p.childForFieldName('type'), source);
          if (modified && name?.type === 'identifier' && k) out.set(text(name, source), k);
        }
      }
      assignedIn(m);
    } else if (family === 'python' && m.type === 'expression_statement') {
      // Class-level annotation: `repo: Repo`
      const a = m.namedChild(0);
      const left = a?.type === 'assignment' ? a.childForFieldName('left') : null;
      const k = a?.type === 'assignment' ? typed(a.childForFieldName('type'), source) : undefined;
      if (left?.type === 'identifier' && k) out.set(text(left, source), k);
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
  // Solidity wraps every expression in an `expression` node
  while (fn?.type === 'expression' && fn.namedChildCount === 1) fn = fn.namedChild(0);
  // and without its C++ scope: `helper` in `ns::helper<int>(1)`
  while (fn && (fn.type === 'generic_function' || fn.type === 'index_expression'
    || fn.type === 'qualified_identifier' || fn.type === 'template_function')) {
    fn = fn.type === 'qualified_identifier' || fn.type === 'template_function'
      ? fn.childForFieldName('name')
      : fn.childForFieldName('function') ?? fn.childForFieldName('operand') ?? fn.namedChild(0);
  }
  return fn;
}

/**
 * The object of a member access, as written. Solidity's grammar wraps expressions in `expression`
 * nodes, and since 1.2.6 reads `a || super.f()` as `(a || super).f()` (and `c ? 0 : super.f()`,
 * `!x.f()` alike): an object that is a binary, conditional or unary expression without parentheses
 * (which would be a node of their own) is always that misreading, and the object is its last operand.
 */
export function memberObject(obj: any): any {
  for (let i = 0; obj && i < 16; i++) {
    if (obj.type === 'expression' && obj.namedChildCount === 1) obj = obj.namedChild(0);
    else if (obj.type === 'binary_expression') obj = obj.childForFieldName('right') ?? obj.lastNamedChild;
    else if (obj.type === 'ternary_expression' || obj.type === 'conditional_expression' || obj.type === 'unary_expression') obj = obj.lastNamedChild;
    else break;
  }
  return obj;
}

/** The receiver expression of a call: `repo` in `repo.save()`, `getRepo()` in `getRepo().save()`. */
function receiverNode(call: any): any {
  const named = call.childForFieldName('object') ?? call.childForFieldName('receiver');
  if (named) return named;
  const fn = calleeOf(call);
  if (!fn) return null;
  if (fn.type === 'member_expression' || fn.type === 'attribute' || fn.type === 'field_expression' || fn.type === 'selector_expression'
    || fn.type === 'navigation_expression' || fn.type === 'dot_index_expression' || fn.type === 'method_index_expression') {
    return memberObject(fn.childForFieldName('object') ?? fn.childForFieldName('operand') ?? fn.childForFieldName('table') ?? fn.namedChild(0));
  }
  return null;
}

/** The name a call calls: `save` in `repo.save()`, `getRepo` in `getRepo()`. */
function calledName(call: any, source: string): string | undefined {
  const named = call.childForFieldName('name');
  if (named) return text(named, source);
  const fn = calleeOf(call);
  if (!fn) return undefined;
  const last = fn.childForFieldName('property') ?? fn.childForFieldName('attribute') ?? fn.childForFieldName('field') ?? fn.childForFieldName('method')
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
    if ('element' in k) return {};
    if ('iter' in k) {
      const e = depth < 3 ? elementOf(k.iter, source, family, depth + 1) : undefined;
      return e ? { type: e } : {};
    }
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

  return known(lookup(call, r, source, family, depth));
}

/** What is known of a name, or of `this.x` / `self.x`, where a node uses it. */
function lookup(at: any, r: string, source: string, family: Family, depth: number): Known | undefined {
  const member = new RegExp(`^${SELF[family]}\\.([A-Za-z_$][\\w$]*)$`).exec(r);
  if (member) {
    const cls = enclosing(at, CLASSES[family]);
    return cls ? fields(cls, source, family).get(member[1]) : undefined;
  }

  if (!/^[A-Za-z_$][\w$]*$/.test(r) || r === SELF[family]) return undefined;
  // The nearest scope that declares the name: a parameter, a local, then (Java) a field
  for (let scope = enclosing(at, SCOPES[family]); scope; scope = enclosing(scope, SCOPES[family])) {
    const k = declarations(scope, source, family).get(r);
    if (k) return k;
    const cb = callbackElement(scope, r, source, family);
    if (cb) return cb;
    if (isParameter(scope, r, source, family)) {
      const t = depth < 3 ? parameterFromCallers(scope, r, source, family, depth + 1) : undefined;
      if (t) return { type: t };
    }
  }
  if (family === 'java') {
    const cls = enclosing(at, CLASSES[family]);
    if (cls) return fields(cls, source, family).get(r);
  }
  return undefined;
}

/** The element type of a collection expression: a name or a field declared `list[Foo]`, `Foo[]`, … */
function elementOf(expr: any, source: string, family: Family, depth: number): string | undefined {
  if (expr.type === 'parenthesized_expression') expr = expr.namedChild(0);
  if (!expr) return undefined;
  const k = lookup(expr, text(expr, source).trim(), source, family, depth);
  return k && 'element' in k ? k.element : undefined;
}

/** Methods whose callback's first parameter is an element of the receiver. */
const ELEMENT_CALLBACKS = new Set(['forEach', 'map', 'filter', 'find', 'findLast', 'findIndex', 'some', 'every', 'flatMap', 'removeIf', 'anyMatch', 'allMatch', 'noneMatch']);

/** `xs.forEach(x => …)`: the callback's first parameter is an element of xs. */
function callbackElement(scope: any, r: string, source: string, family: Family): Known | undefined {
  if (family === 'python') return undefined;
  if (scope.type !== 'arrow_function' && scope.type !== 'function_expression' && scope.type !== 'function' && scope.type !== 'lambda_expression') return undefined;
  const args = scope.parent;
  if (!args || (args.type !== 'arguments' && args.type !== 'argument_list') || args.namedChild(0)?.id !== scope.id) return undefined;
  if (parameterNames(scope, source, family)[0] !== r) return undefined;
  const call = args.parent;
  if (!call || !CALLS.has(call.type)) return undefined;
  const name = calledName(call, source);
  const recv = receiverNode(call);
  return name && ELEMENT_CALLBACKS.has(name) && recv ? { iter: recv } : undefined;
}

/** A function's parameter names, in order (`self` / `cls` left out), untyped ones included. */
function parameterNames(scope: any, source: string, family: Family): string[] {
  const single = scope.childForFieldName('parameter');
  if (single) return single.type === 'identifier' ? [text(single, source)] : [];
  const params = scope.childForFieldName('parameters');
  if (!params) return [];
  if (params.type === 'identifier') return [text(params, source)];
  const out: string[] = [];
  for (const p of params.namedChildren) {
    let name: any = null;
    if (p.type === 'identifier') name = p;
    else if (p.type === 'required_parameter' || p.type === 'optional_parameter') name = p.childForFieldName('pattern');
    else if (p.type === 'assignment_pattern') name = p.childForFieldName('left');
    else if (p.type === 'default_parameter' || p.type === 'typed_default_parameter' || p.type === 'formal_parameter') name = p.childForFieldName('name');
    else if (p.type === 'typed_parameter') name = p.namedChildren.find((c: any) => c.type === 'identifier');
    else if (p.type === 'inferred_parameters') { for (const c of p.namedChildren) out.push(text(c, source)); continue; }
    else if (p.type === 'keyword_separator' || p.type === 'positional_separator') continue;
    else { out.push(''); continue; }   // *args, **kwargs, a destructuring pattern
    out.push(name?.type === 'identifier' ? text(name, source) : '');
  }
  if (family === 'python' && (out[0] === 'self' || out[0] === 'cls')) out.shift();
  return out;
}

/**
 * Whether a bare call calls a parameter of an enclosing function (`done()`, `resolve(true)`,
 * `cb(err)`): the function passed in, never one of the project's.
 */
export function callsParameter(call: any, name: string, source: string, language: Language): boolean {
  const family = FAMILY[language];
  if (!family || family === 'java') return false;
  for (let scope = enclosing(call, SCOPES[family]); scope; scope = enclosing(scope, SCOPES[family])) {
    if (parameterNames(scope, source, family).includes(name)) return true;
  }
  return false;
}

function isParameter(scope: any, r: string, source: string, family: Family): boolean {
  return family !== 'java' && parameterNames(scope, source, family).includes(r);
}

/** Calls of the file by the name they call, for the file being read. */
let callsSource: string | null = null;
let callsByName = new Map<string, any[]>();
const inferredParams = new Map<string, string | null>();

function callsNamed(root: any, name: string, source: string): any[] {
  if (callsSource !== source) {
    callsSource = source;
    callsByName = new Map();
    inferredParams.clear();
    const visit = (n: any) => {
      if (CALLS.has(n.type)) {
        const c = calledName(n, source);
        if (c) { const list = callsByName.get(c); if (list) list.push(n); else callsByName.set(c, [n]); }
      }
      for (const child of n.namedChildren) visit(child);
    };
    visit(root);
  }
  return callsByName.get(name) ?? [];
}

/**
 * An untyped parameter typed by the calls of its function in the same file, when every one of
 * them passes the same class (`helper(Query())`, `self.helper(query)` with a known `query`). Only
 * the file's own calls, so that a sync of another file cannot change it.
 */
function parameterFromCallers(scope: any, r: string, source: string, family: Family, depth: number): string | undefined {
  const key = `${keyOf(scope)}:${r}`;
  const cachedHere = callsSource === source ? inferredParams.get(key) : undefined;
  if (cachedHere !== undefined) return cachedHere ?? undefined;
  let fnName: any = scope.childForFieldName('name');
  if (!fnName && scope.parent?.type === 'variable_declarator') fnName = scope.parent.childForFieldName('name');
  if (!fnName) return undefined;
  const index = parameterNames(scope, source, family).indexOf(r);
  if (index < 0) return undefined;
  let root = scope;
  while (root.parent) root = root.parent;
  const sites = callsNamed(root, text(fnName, source), source);
  // A method is called on the own instance (`self.helper(x)`); a function bare
  const around = enclosing(scope, new Set([...SCOPES[family], ...CLASSES[family]]));
  const method = !!around && CLASSES[family].has(around.type);
  const types = new Set<string>();
  inferredParams.set(key, null);
  for (const site of sites) {
    if (site.startIndex >= scope.startIndex && site.endIndex <= scope.endIndex) continue;   // recursion
    const recv = receiverNode(site);
    if (method ? !(recv && text(recv, source).trim() === SELF[family]) : recv) continue;
    const args = site.childForFieldName('arguments');
    if (!args) return undefined;
    const keyword = args.namedChildren.find((a: any) => a.type === 'keyword_argument' && text(a.childForFieldName('name') ?? a, source) === r);
    const positional = args.namedChildren.filter((a: any) => a.type !== 'keyword_argument' && a.type !== 'comment');
    if (positional.some((a: any) => a.type === 'list_splat' || a.type === 'dictionary_splat' || a.type === 'spread_element')) return undefined;
    const arg = keyword ? keyword.childForFieldName('value') : positional[index];
    if (!arg) continue;   // the default
    const t = argumentType(arg, source, family, depth);
    if (!t) { inferredParams.set(key, null); return undefined; }
    types.add(t);
  }
  const out = types.size === 1 ? [...types][0] : undefined;
  inferredParams.set(key, out ?? null);
  return out;
}

/** The class of an argument: a constructor call, `this` / `self`, a name of a known type. */
function argumentType(arg: any, source: string, family: Family, depth: number): string | undefined {
  const c = constructed(arg, source, family);
  if (c) return c;
  const t = text(arg, source).trim();
  if (t === SELF[family]) return ownClassName(arg, source, family);
  const k = lookup(arg, t, source, family, depth);
  return k && 'type' in k ? k.type : undefined;
}

/**
 * The class a function or method declares it returns: `(): Repo`, `(): Promise<Repo>` (the value
 * after `await`), Python `-> Repo`, Java `Repo get()`. For `const f = (): Repo => …` too.
 */
export function declaredReturnType(node: any, source: string, language: Language): string | undefined {
  const family = FAMILY[language];
  if (!family) return undefined;
  if (source !== cacheSource) {
    cacheSource = source;
    scopeCache.clear();
    classCache.clear();
  }
  let fn = node;
  if (family === 'js' && (node.type === 'lexical_declaration' || node.type === 'variable_declaration')) {
    const value = node.namedChildren.find((c: any) => c.type === 'variable_declarator')?.childForFieldName('value');
    if (!value || (value.type !== 'arrow_function' && value.type !== 'function_expression' && value.type !== 'function')) return undefined;
    fn = value;
  }
  const type = family === 'java' ? fn.childForFieldName('type') : fn.childForFieldName('return_type');
  if (!type) return family === 'java' ? undefined : inferredReturnType(fn, source, family);
  const raw = text(type, source).replace(/^:\s*/, '').trim();
  const awaited = /^Promise\s*<(.*)>$/.exec(raw);
  return typeName(awaited ? awaited[1] : raw);
}

/**
 * The class a function that declares no return type returns, when every `return` says the same:
 * a constructor (`new X()`, `X()`), `this` / `self`, `cls()` / `self.__class__()`, or a local whose
 * type is known (`obj = Query(); …; return obj`). `return None` and a bare `return` do not count.
 * An arrow function's expression body is its return.
 */
function inferredReturnType(fn: any, source: string, family: Family): string | undefined {
  const body = fn.childForFieldName('body');
  if (!body) return undefined;
  const values: any[] = [];
  if (family === 'js' && fn.type === 'arrow_function' && body.type !== 'statement_block') values.push(body);
  else {
    const visit = (n: any) => {
      for (const c of n.namedChildren) {
        if (SCOPES[family].has(c.type) || CLASSES[family].has(c.type)) continue;
        if (c.type === 'return_statement') { const v = c.namedChild(0); if (v) values.push(v); continue; }
        visit(c);
      }
    };
    visit(body);
  }
  const types = new Set<string>();
  for (let v of values) {
    if (v.type === 'await_expression') v = v.namedChild(0);
    if (v.type === 'parenthesized_expression') v = v.namedChild(0);
    if (!v || v.type === 'none' || v.type === 'null' || v.type === 'undefined') continue;
    let t: string | undefined;
    if (v.type === 'this' || (family === 'python' && v.type === 'identifier' && text(v, source) === 'self')) t = ownClassName(v, source, family);
    else if (v.type === 'identifier') {
      const k = declarations(fn, source, family).get(text(v, source));
      t = k && 'type' in k ? k.type : undefined;
    } else t = constructed(v, source, family);
    if (!t) return undefined;
    types.add(t);
  }
  return types.size === 1 ? [...types][0] : undefined;
}
