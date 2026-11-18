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

/** Declarations by scope, for the file being read (keyed by the scope's position). */
let cacheSource: string | null = null;
const scopeCache = new Map<string, Map<string, string>>();
const classCache = new Map<string, Map<string, string>>();

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
function parameters(scope: any, source: string, family: Family): Map<string, string> {
  const out = new Map<string, string>();
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
      if (t) out.set(text(name, source), t);
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
function declarations(scope: any, source: string, family: Family): Map<string, string> {
  const key = keyOf(scope);
  const cached = scopeCache.get(key);
  if (cached) return cached;
  const out = parameters(scope, source, family);
  const body = scope.childForFieldName('body') ?? scope;
  eachInScope(body, family, n => {
    if (family === 'js' && n.type === 'variable_declarator') {
      const name = n.childForFieldName('name');
      if (name?.type !== 'identifier') return;
      const type = n.childForFieldName('type');
      const t = type ? typeName(text(type, source)) : constructed(n.childForFieldName('value'), source, family);
      if (t) out.set(text(name, source), t);
    } else if (family === 'python' && n.type === 'assignment') {
      const left = n.childForFieldName('left');
      if (left?.type !== 'identifier') return;
      const type = n.childForFieldName('type');
      const t = type ? typeName(text(type, source)) : constructed(n.childForFieldName('right'), source, family);
      if (t) out.set(text(left, source), t);
    } else if (family === 'java' && n.type === 'local_variable_declaration') {
      const type = n.childForFieldName('type');
      for (const d of n.namedChildren.filter((c: any) => c.type === 'variable_declarator')) {
        const name = d.childForFieldName('name');
        const t = type && text(type, source) !== 'var' ? typeName(text(type, source)) : constructed(d.childForFieldName('value'), source, family);
        if (name && t) out.set(text(name, source), t);
      }
    }
  });
  scopeCache.set(key, out);
  return out;
}

/** The fields of a class with a type it can tell: name → type. */
function fields(cls: any, source: string, family: Family): Map<string, string> {
  const key = keyOf(cls);
  const cached = classCache.get(key);
  if (cached) return cached;
  const out = new Map<string, string>();
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
      const type = n.childForFieldName('type');
      const t = type ? typeName(text(type, source))
        : right.type === 'identifier' ? params.get(text(right, source))
        : constructed(right, source, family);
      if (t) out.set(name, t);
    });
  };

  for (const m of body.namedChildren) {
    if (family === 'js' && m.type === 'public_field_definition') {
      const name = m.childForFieldName('name');
      const type = m.childForFieldName('type');
      const t = type ? typeName(text(type, source)) : constructed(m.childForFieldName('value'), source, family);
      if (name && t) out.set(text(name, source).replace(/^#/, ''), t);
    } else if (family === 'js' && m.type === 'method_definition') {
      // Constructor parameter properties: `constructor(private readonly svc: UserService)`
      if (text(m.childForFieldName('name') ?? m, source) === 'constructor') {
        for (const p of m.childForFieldName('parameters')?.namedChildren ?? []) {
          const modified = p.namedChildren.some((c: any) => c.type === 'accessibility_modifier' || c.type === 'override_modifier')
            || /^\s*readonly\b/.test(text(p, source));
          const name = p.childForFieldName('pattern');
          const type = p.childForFieldName('type');
          const t = type ? typeName(text(type, source)) : undefined;
          if (modified && name?.type === 'identifier' && t) out.set(text(name, source), t);
        }
      }
      assignedIn(m);
    } else if (family === 'python' && m.type === 'expression_statement') {
      // Class-level annotation: `repo: Repo`
      const a = m.namedChild(0);
      const left = a?.type === 'assignment' ? a.childForFieldName('left') : null;
      const type = a?.type === 'assignment' ? a.childForFieldName('type') : null;
      const t = type ? typeName(text(type, source)) : undefined;
      if (left?.type === 'identifier' && t) out.set(text(left, source), t);
    } else if (family === 'python' && (m.type === 'function_definition' || m.type === 'decorated_definition')) {
      const fn = m.type === 'decorated_definition' ? m.childForFieldName('definition') : m;
      if (fn?.type === 'function_definition') assignedIn(fn);
    } else if (family === 'java' && m.type === 'field_declaration') {
      const type = m.childForFieldName('type');
      const t = type ? typeName(text(type, source)) : undefined;
      for (const d of m.namedChildren.filter((c: any) => c.type === 'variable_declarator')) {
        const name = d.childForFieldName('name');
        const ft = t ?? constructed(d.childForFieldName('value'), source, family);
        if (name && ft) out.set(text(name, source), ft);
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

/** The declared type of the receiver of a call, or undefined when the code does not say it. */
export function receiverType(call: any, receiver: string, source: string, language: Language): string | undefined {
  const family = FAMILY[language];
  if (!family) return undefined;
  if (source !== cacheSource) {
    cacheSource = source;
    scopeCache.clear();
    classCache.clear();
  }
  const r = receiver.replace(/[!?]+$/, '').trim();

  const created = /^new\s+([\w$.]+)\s*(?:<[^>]*>)?\s*\(/.exec(r);
  if (created) return typeName(created[1]);

  const member = new RegExp(`^${SELF[family]}\\.([A-Za-z_$][\\w$]*)$`).exec(r);
  if (member) {
    const cls = enclosing(call, CLASSES[family]);
    return cls ? fields(cls, source, family).get(member[1]) : undefined;
  }

  if (!/^[A-Za-z_$][\w$]*$/.test(r) || r === SELF[family]) return undefined;
  // The nearest scope that declares the name: a parameter, a local, then (Java) a field
  for (let scope = enclosing(call, SCOPES[family]); scope; scope = enclosing(scope, SCOPES[family])) {
    const t = declarations(scope, source, family).get(r);
    if (t) return t;
  }
  if (family === 'java') {
    const cls = enclosing(call, CLASSES[family]);
    if (cls) return fields(cls, source, family).get(r);
  }
  return undefined;
}
