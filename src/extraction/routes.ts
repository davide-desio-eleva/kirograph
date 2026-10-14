/**
 * HTTP route extraction for JavaScript / TypeScript servers (Express, Fastify, Koa-style routers).
 *
 * Emits a `route` node per registration and an unresolved `function` reference from the route
 * to its handler, so the resolver links route → handler with a `calls` edge. Without that edge,
 * attack-surface and reachability cannot walk from the route into the dependencies it uses.
 *
 * Recognised forms:
 * - `<receiver>.<httpMethod>('/path', ..., handler)`
 * - `<receiver>.route({ method, url, handler })`  (method may be an array)
 * - `<receiver>.register(target, { prefix })` → a mount. The resolver applies prefixes across
 *   files and through nested plugins. A target is a plugin identifier, a namespace member
 *   (`v1.routes`), a `require('./x')`, or an inline function.
 *
 * Inline handlers (`fastify.get('/x', async (req) => { ... })`) have no name, so every call
 * inside the handler body is attributed to the route node itself.
 */

import type { Node } from '../types';

export interface RouteRef {
  sourceId: string;
  refName: string;
  refKind: 'function';
  line: number;
  column: number;
}

/** What a `register()` call mounts. */
export type MountTarget =
  | { kind: 'name'; name: string }
  | { kind: 'namespace'; object: string; name: string }
  | { kind: 'require'; specifier: string }
  | { kind: 'inline'; startLine: number; endLine: number };

/** A `register(target, { prefix })` call. A missing prefix is '' (the plugin inherits its owner's). */
export interface RouteMount {
  target: MountTarget;
  prefix: string;
  line: number;
}

/** Conventional names of a server or router object. Plugin parameters are added per file. */
const ROUTE_RECEIVERS = new Set(['app', 'router', 'fastify', 'server', 'api']);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

const FUNCTION_NODE_TYPES = new Set(['arrow_function', 'function_expression', 'function']);

export const JS_TS_LANGUAGES = new Set(['javascript', 'typescript', 'tsx', 'jsx']);

interface ParsedRoute {
  method: string;
  path: string;
  handler: any;
}

type ParsedCall =
  | { kind: 'routes'; routes: ParsedRoute[] }
  | { kind: 'mount'; target: MountTarget; prefix: string };

/**
 * Walk the file's AST and collect route nodes, handler references and plugin mounts.
 *
 * `collectCalls` is the extractor's call-reference collector; it is injected so this module
 * does not import the extractor (which imports this module).
 */
export function extractRoutes(
  root: any,
  source: string,
  filePath: string,
  now: number,
  collectCalls: (node: any, sourceId: string, refs: RouteRef[]) => void,
): { nodes: Node[]; refs: RouteRef[]; mounts: RouteMount[] } {
  const nodes: Node[] = [];
  const refs: RouteRef[] = [];
  const mounts: RouteMount[] = [];

  const text = (n: any): string => source.slice(n.startIndex, n.endIndex);

  // A plugin receives its server as the first parameter (`async function plugin(f) { f.get(...) }`),
  // so that name is a receiver too, whatever it is called.
  const receivers = new Set([...ROUTE_RECEIVERS, ...pluginParameterNames(root, text)]);

  const walk = (node: any): void => {
    if (node.type === 'call_expression') {
      const call = parseCall(node, text, receivers);
      if (call?.kind === 'mount') {
        mounts.push({ target: call.target, prefix: call.prefix, line: node.startPosition.row + 1 });
      } else if (call?.kind === 'routes') {
        for (const route of call.routes) addRoute(route, node);
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  };

  const addRoute = (route: ParsedRoute, callNode: any): void => {
    const line = callNode.startPosition.row + 1;
    const id = `route:${filePath}:${route.method}:${route.path}:${line}`;
    nodes.push({
      id,
      kind: 'route',
      name: `${route.method} ${route.path}`,
      qualifiedName: `${filePath}::${route.method}:${route.path}`,
      filePath,
      startLine: line,
      endLine: callNode.endPosition.row + 1,
      startColumn: callNode.startPosition.column,
      endColumn: callNode.endPosition.column,
      language: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
      updatedAt: now,
    });

    const handler = route.handler;
    if (!handler) return;
    if (FUNCTION_NODE_TYPES.has(handler.type)) {
      collectCalls(handler, id, refs);
      return;
    }
    const refName = handlerName(handler, text);
    if (refName) {
      refs.push({ sourceId: id, refName, refKind: 'function', line, column: handler.startPosition.column });
    }
  };

  walk(root);
  return { nodes, refs, mounts };
}

/**
 * Classifies a call as a route registration, a plugin mount, or neither.
 * Requires a route receiver, so `map.get('key')` and `container.register(X)` are ignored.
 */
function parseCall(node: any, text: (n: any) => string, receivers: Set<string>): ParsedCall | null {
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return null;

  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  if (!obj || obj.type !== 'identifier' || !prop) return null;
  if (!receivers.has(text(obj))) return null;

  const method = text(prop).toLowerCase();
  const argsNode = node.childForFieldName('arguments');
  if (!argsNode) return null;
  const args = (argsNode.namedChildren as any[]).filter(a => a.type !== 'comment');

  if (method === 'register') return parseMount(args, text);
  if (method === 'route') return parseRouteObject(args, text);
  if (HTTP_METHODS.has(method)) {
    const route = parseShorthand(method, args, text);
    return route ? { kind: 'routes', routes: [route] } : null;
  }
  return null;
}

/** Names of the first parameter of every function in the file: the plugin's server object. */
function pluginParameterNames(root: any, text: (n: any) => string): Set<string> {
  const names = new Set<string>();
  const visit = (node: any): void => {
    if (node.type === 'arrow_function') {
      const single = node.childForFieldName('parameter');
      if (single?.type === 'identifier') names.add(text(single));
    }
    if (node.type === 'formal_parameters') {
      const first = (node.namedChildren as any[]).find(c => c.type !== 'comment');
      if (first?.type === 'identifier') names.add(text(first));
      if (first && (first.type === 'required_parameter' || first.type === 'optional_parameter')) {
        const pattern = first.childForFieldName('pattern');
        if (pattern?.type === 'identifier') names.add(text(pattern));
      }
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  };
  visit(root);
  return names;
}

/** `app.get('/path', ..., handler)`: at least a path and a handler, path starting with `/`. */
function parseShorthand(method: string, args: any[], text: (n: any) => string): ParsedRoute | null {
  if (args.length < 2) return null;
  const pathNode = args[0];
  if (pathNode.type !== 'string') return null;
  const path = text(pathNode).slice(1, -1);
  if (!path.startsWith('/')) return null;
  return { method: method.toUpperCase(), path, handler: args[args.length - 1] };
}

/** `app.route({ method, url, handler })`, where method is a string or an array of strings. */
function parseRouteObject(args: any[], text: (n: any) => string): { kind: 'routes'; routes: ParsedRoute[] } | null {
  if (args.length !== 1 || args[0].type !== 'object') return null;
  const obj = args[0];
  const methodNode = objectValue(obj, 'method', text);
  const urlNode = objectValue(obj, 'url', text);
  const handler = objectValue(obj, 'handler', text);
  if (!methodNode || !urlNode) return null;

  const path = stringContent(urlNode, text);
  if (!path || !path.startsWith('/')) return null;

  const methodNodes = methodNode.type === 'array' ? (methodNode.namedChildren as any[]) : [methodNode];
  const routes: ParsedRoute[] = [];
  for (const m of methodNodes) {
    const method = stringContent(m, text)?.toLowerCase();
    if (!method || !HTTP_METHODS.has(method)) continue;
    routes.push({ method: method.toUpperCase(), path, handler });
  }
  return routes.length > 0 ? { kind: 'routes', routes } : null;
}

/**
 * `app.register(target, { prefix? })`. The target is a plugin identifier, a namespace member,
 * a `require('./x')`, or an inline function. Anything else is not a plugin mount.
 */
function parseMount(args: any[], text: (n: any) => string): { kind: 'mount'; target: MountTarget; prefix: string } | null {
  if (args.length < 1) return null;
  const target = parseMountTarget(args[0], text);
  if (!target) return null;

  let prefix = '';
  if (args[1]?.type === 'object') {
    const prefixNode = objectValue(args[1], 'prefix', text);
    const value = prefixNode ? stringContent(prefixNode, text) : null;
    if (value !== null) {
      if (!value.startsWith('/')) return null;
      prefix = value;
    }
  }
  return { kind: 'mount', target, prefix };
}

function parseMountTarget(node: any, text: (n: any) => string): MountTarget | null {
  if (FUNCTION_NODE_TYPES.has(node.type)) {
    return { kind: 'inline', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
  }
  if (node.type === 'identifier') return { kind: 'name', name: text(node) };
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    if (obj?.type === 'identifier' && prop) return { kind: 'namespace', object: text(obj), name: text(prop) };
    return null;
  }
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    const arg = (node.childForFieldName('arguments')?.namedChildren as any[] | undefined)?.[0];
    if (fn && text(fn) === 'require' && arg?.type === 'string') {
      return { kind: 'require', specifier: text(arg).slice(1, -1) };
    }
  }
  return null;
}

/** Value node of `key` in an object literal, including the shorthand form `{ key }`. */
function objectValue(obj: any, key: string, text: (n: any) => string): any | null {
  for (const prop of obj.namedChildren as any[]) {
    if (prop.type === 'pair') {
      const k = prop.childForFieldName('key');
      if (k && stripQuotes(text(k)) === key) return prop.childForFieldName('value');
    } else if (prop.type === 'shorthand_property_identifier' && text(prop) === key) {
      return prop;
    }
  }
  return null;
}

/** Content of a string literal, or null for any other node. */
function stringContent(node: any, text: (n: any) => string): string | null {
  return node.type === 'string' ? text(node).slice(1, -1) : null;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

/** Name of a handler reference: `list` or `UserController.list`. Anything else yields null. */
function handlerName(handler: any, text: (n: any) => string): string | null {
  if (handler.type === 'identifier' || handler.type === 'shorthand_property_identifier' || handler.type === 'member_expression') {
    const name = text(handler);
    return /^[A-Za-z_$][\w$.]*$/.test(name) ? name : null;
  }
  return null;
}
