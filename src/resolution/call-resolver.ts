/**
 * Resolution of a call by name: which node of the project a call `name(...)` or `recv.name(...)`
 * reaches, when nothing more precise (an import, a qualified name) answered.
 *
 * The rules follow CodeGraph's name matcher (matchFunctionRef, matchMethodCall), in short:
 *   - a candidate is in the caller's language family and is something a call runs (a function, a
 *     method, a class); nodes of data files (YAML, JSON, …) only from a file of their language;
 *   - a bare call reaches a function of its own file first, then the one function of the name in
 *     a file the caller imports, then the one function of the name in the project; a method only
 *     in the languages where a bare name can be `this`'s, and only in the caller's file;
 *   - a call on `this` / `self` reaches a method of the caller's file, or the one method of the
 *     name;
 *   - a call on another receiver reaches a method or function whose owner (class, module, file
 *     or folder) shares a word with the receiver: `this.userService.find()` a `find` of
 *     `UserService`, never `pattern.test()` a `test` of a test helper;
 *   - when several candidates remain, nothing: an unresolved call is better than a wrong edge.
 */
import type { Node } from '../types';

export interface CallRef {
  name: string;
  receiver?: string;
  /** The receiver's declared type, when the code says it (see extraction/receiver-types). */
  receiverType?: string;
  /** The call the receiver is the value of (`getRepo()` in `getRepo().save()`): typed by its return type. */
  receiverCall?: { name: string; receiver?: string; receiverType?: string; receiverCall?: CallRef['receiverCall'] };
  sourceId: string;
  filePath: string;
}

export interface CallContext {
  byName(name: string): Node[];
  node(id: string): Node | undefined;
  /** Files whose symbols the file imports (resolved import edges). */
  importedFiles(filePath: string): Set<string> | undefined;
  /** The class, struct, module or namespace a node is declared in. */
  owner(id: string): { id: string; name: string; kind: string } | undefined;
  /** The types a type extends or implements (resolved edges). */
  supertypes(id: string): string[];
  /**
   * C / C++: whether a function of another file is visible from a file — in a header it includes,
   * directly or not, or declared by one (`jv.h` declares what `jv_print.c` defines).
   */
  cVisible?(filePath: string, candidate: Node): boolean;
}

const LANGUAGE_FAMILY: Record<string, string> = {
  typescript: 'web', tsx: 'web', javascript: 'web', jsx: 'web', svelte: 'web', vue: 'web', astro: 'web',
  java: 'jvm', kotlin: 'jvm', scala: 'jvm',
  c: 'native', cpp: 'native', objc: 'native', swift: 'native',
  csharp: 'dotnet',
};

const familyOf = (language: string | undefined): string | undefined =>
  language === undefined ? undefined : LANGUAGE_FAMILY[language] ?? language;

/**
 * Languages that describe data or configuration: their nodes (CI jobs, package.json scripts,
 * Terraform blocks, CSS rules) are named like functions but are not what code calls.
 */
const DATA_LANGUAGES = new Set<string>(['yaml', 'json', 'hcl', 'css', 'scss', 'html']);

export function isCallTarget(target: Node, sourceLanguage: string | undefined): boolean {
  if (DATA_LANGUAGES.has(target.language)) return target.language === sourceLanguage;
  return sourceLanguage === undefined || familyOf(target.language) === familyOf(sourceLanguage);
}

/** Kinds a call runs: a function, a method, a constructor. */
const CALLABLE = new Set<string>(['function', 'method', 'class', 'struct', 'component']);
/** In JavaScript and TypeScript a function is often a `const f = () => …`, and a class field. */
const JS_FAMILY = new Set<string>(['typescript', 'tsx', 'javascript', 'jsx', 'svelte', 'vue', 'astro']);
const VALUE_KINDS = new Set<string>(['constant', 'variable', 'property']);
/** Languages where a bare name inside a class can be one of its methods (implicit `this`). */
const IMPLICIT_SELF = new Set<string>(['java', 'kotlin', 'scala', 'swift', 'csharp', 'dart', 'cpp', 'objc', 'ruby', 'rescript', 'elixir']);
/** Receivers that are the object the caller belongs to. */
const SELF_RECEIVERS = /^(?:this|self|super|cls|Self|base|static|\$this|@)$/;
/** Owners whose members are reached through an instance or the type, not by a bare name. */
const TYPE_KINDS = new Set<string>(['class', 'struct', 'interface', 'trait', 'protocol', 'component', 'enum']);
const CONSTRUCTORS = new Set<string>(['class', 'struct']);

function isCallable(n: Node, language: string | undefined): boolean {
  if (CALLABLE.has(n.kind)) return true;
  if (DATA_LANGUAGES.has(n.language)) return true; // a job, a script: only reached from its own language
  return language !== undefined && JS_FAMILY.has(language) && VALUE_KINDS.has(n.kind);
}

/** Lowercase words of an identifier: `userService` → user, service; `HTTP_client` → http, client. */
function words(name: string): string[] {
  const all = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(w => w.toLowerCase())
    .filter(Boolean);
  // One-letter words say nothing, unless they are the whole name (`new A().go()`)
  return all.length === 1 ? all : all.filter(w => w.length >= 2);
}

/** The last name in a receiver: `userService` in `this.userService`, `path` in `os.path`, `db` in `getDb()`. */
function receiverName(receiver: string): string {
  const m = /([A-Za-z_$][\w$]*)[^\w$]*$/.exec(receiver);
  return m ? m[1] : receiver;
}

const baseName = (filePath: string): string => filePath.replace(/^.*\//, '').replace(/\..*$/, '');
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether a candidate is a member of a type: reached through an instance, never by a bare name. */
function isMember(n: Node, ctx: CallContext): boolean {
  if (n.kind === 'method') return true;
  const owner = ctx.owner(n.id);
  return owner !== undefined && TYPE_KINDS.has(owner.kind);
}

/**
 * Whether the receiver names what the candidate belongs to. The receiver's last word is the
 * thing it is (`userService` is a service, `onResponseHook` a hook): a member is reached when
 * that word is in its type's name (`UserService`), a function of a module or file when it is in
 * the module's, file's or folder's name (`helpers.slugify()`, `models.CharField()`, Go's `strings.Split()`). A value
 * (`const send = …`) only through a receiver that is its file's name (`utils.send()`).
 */
function receiverReaches(receiver: string, candidate: Node, ctx: CallContext): boolean {
  const name = receiverName(receiver);
  const recv = words(name);
  const head = recv[recv.length - 1];
  if (head === undefined) return false;
  const owner = ctx.owner(candidate.id);
  if (VALUE_KINDS.has(candidate.kind)) {
    return squash(owner?.name ?? baseName(candidate.filePath)) === squash(name);
  }
  if (owner) return squash(owner.name) === squash(name) || words(owner.name).includes(head);
  // A function or class of a module: the receiver is the module or one of its packages
  // (`models.CharField()` → django/db/models/fields/__init__.py)
  return candidate.filePath.replace(/\.[^/.]+$/, '').split('/').some(n => words(n).includes(head));
}

const first = (nodes: Node[]): Node =>
  nodes.reduce((a, b) => ((a.startLine ?? 0) <= (b.startLine ?? 0) ? a : b));

/** The one candidate, or null. */
const only = (nodes: Node[]): Node | null => (nodes.length === 1 ? nodes[0] : null);

/** Test code: a test file, or a file in a test folder. */
const TEST_PATH = /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|testing\/fixtures)\/|(^|\/)(test_[^/]*|[^/]*_test\.[^/.]+|[^/]*\.(test|spec)\.[^/]+|conftest\.py)$/;
export const isTestPath = (filePath: string): boolean => TEST_PATH.test(filePath);

/**
 * The member of the name declared nearest to the given types: in the type itself, else in what it
 * extends or implements, breadth first. Null when neither declares it (a library supertype's).
 */
function memberOf(typeIds: string[], candidates: Node[], ctx: CallContext): Node | null {
  const byOwner = new Map<string, Node[]>();
  for (const n of candidates) {
    const owner = ctx.owner(n.id);
    if (!owner) continue;
    const list = byOwner.get(owner.id);
    if (list) list.push(n); else byOwner.set(owner.id, [n]);
  }
  if (byOwner.size === 0) return null;
  const seen = new Set<string>(typeIds);
  let level = [...typeIds];
  for (let depth = 0; level.length > 0 && depth < 8; depth++) {
    const found = level.flatMap(id => byOwner.get(id) ?? []);
    // Overloads of one type are one method; the same name in two unrelated types is a guess
    if (found.length > 0) {
      const owners = new Set(found.map(n => ctx.owner(n.id)!.id));
      return owners.size === 1 ? first(found) : null;
    }
    const next: string[] = [];
    for (const id of level) for (const s of ctx.supertypes(id)) if (!seen.has(s)) { seen.add(s); next.push(s); }
    level = next;
  }
  return null;
}

export function resolveCall(ref: CallRef, ctx: CallContext): Node | null {
  // A receiver that a call returns: the declared return type of the function that call reaches
  if (ref.receiverType === undefined && ref.receiverCall) {
    const producer = resolveCall({ ...ref.receiverCall, sourceId: ref.sourceId, filePath: ref.filePath }, ctx);
    if (producer?.returnType) ref = { ...ref, receiverType: producer.returnType };
  }
  const source = ctx.node(ref.sourceId);
  const language = source?.language;
  // Code that is not a test never calls into a test: a stub or a fixture of the name is not it
  const fromTest = isTestPath(ref.filePath);
  const candidates = ctx.byName(ref.name).filter(n =>
    isCallTarget(n, language) && isCallable(n, language) && (fromTest || !isTestPath(n.filePath)));
  if (candidates.length === 0) return null;
  const sameFile = (nodes: Node[]) => nodes.filter(n => n.filePath === ref.filePath);
  const imported = ctx.importedFiles(ref.filePath);
  const inImported = (nodes: Node[]) => (imported ? nodes.filter(n => imported.has(n.filePath)) : []);

  // A receiver whose type the code declares: the method of that type, or of its supertypes
  if (ref.receiverType !== undefined) {
    const types = ctx.byName(ref.receiverType).filter(n => TYPE_KINDS.has(n.kind) &&
      isCallTarget(n, language) && (fromTest || !isTestPath(n.filePath)));
    // A type outside the project (a library's): its methods are not the project's
    if (types.length === 0) return null;
    const local = sameFile(types);
    const fromImports = inImported(types);
    const pool = local.length > 0 ? local : fromImports.length > 0 ? fromImports : types;
    return memberOf(pool.map(n => n.id), candidates, ctx);
  }

  // A call on `this` / `self`: a member of the caller's own type, or the one member of the name
  if (ref.receiver !== undefined && SELF_RECEIVERS.test(ref.receiver.trim())) {
    // The caller's class and its supertypes
    const callerType = ctx.owner(ref.sourceId);
    if (callerType && TYPE_KINDS.has(callerType.kind)) {
      const inherited = memberOf([callerType.id], candidates, ctx);
      if (inherited) return inherited;
    }
    const members = candidates.filter(n => isMember(n, ctx));
    const own = sameFile(members);
    if (own.length > 0) {
      const owner = ctx.owner(ref.sourceId)?.name;
      const ofOwner = owner ? own.filter(n => ctx.owner(n.id)?.name === owner) : [];
      return first(ofOwner.length > 0 ? ofOwner : own);
    }
    return only(members);
  }

  // A call on another receiver: a member or function of what the receiver names
  if (ref.receiver !== undefined) {
    // A function or class of a module only in a module the file imports, when its imports are known
    // (`copy.deepcopy()` is the standard library's, not a project's copy.py)
    const inScope = (n: Node) => isMember(n, ctx) || !imported || imported.size === 0 || imported.has(n.filePath) || n.filePath === ref.filePath;
    const reached = candidates.filter(n => receiverReaches(ref.receiver!, n, ctx) && inScope(n));
    if (reached.length === 0) {
      // A class through its module (`models.CharField(…)`), in the languages where a module is a
      // value: the one of the name the file imports, or the one in the project
      if (language === undefined || !(language === 'python' || JS_FAMILY.has(language))) return null;
      const types = candidates.filter(n => CONSTRUCTORS.has(n.kind) && !isMember(n, ctx));
      const importedTypes = inImported(types);
      return importedTypes.length > 0 ? only(importedTypes) : only(types);
    }
    if (reached.length === 1) return reached[0];
    const exact = reached.filter(n => squash(ctx.owner(n.id)?.name ?? baseName(n.filePath)) === squash(receiverName(ref.receiver!)));
    if (exact.length === 1) return exact[0];
    return only(inImported(exact.length > 0 ? exact : reached));
  }

  // A bare call: a function in scope. A member only where a bare name can be `this`'s, in its file.
  // In C / C++, only what the file's includes declare: gtest's `memcpy` is the C library's, not
  // fmt's `memcpy` in a header gtest never includes
  const cFamily = language === 'c' || language === 'cpp';
  const bare = candidates.filter(n => (!isMember(n, ctx) ||
    (language !== undefined && IMPLICIT_SELF.has(language) && n.filePath === ref.filePath)) &&
    (!cFamily || n.filePath === ref.filePath || !ctx.cVisible || ctx.cVisible(ref.filePath, n)));
  if (bare.length === 0) return null;
  const local = sameFile(bare);
  if (local.length > 0) return first(local);
  const fromImports = inImported(bare);
  if (fromImports.length > 0) return only(fromImports);
  // Anywhere in the project: the one function or class of the name. A value (`const next = …`)
  // of another file is not in scope without an import: a bare `next()` is a parameter's.
  return only(bare.filter(n => !VALUE_KINDS.has(n.kind)));
}
