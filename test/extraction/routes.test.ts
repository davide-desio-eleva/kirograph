import { describe, it, expect } from 'vitest';
import { extractFile } from '../../src/extraction/extractor';
import { expressResolver } from '../../src/frameworks/express';
import { fastifyResolver } from '../../src/frameworks/fastify';
import type { ResolutionContext } from '../../src/frameworks/types';

const ROOT = '/proj';

async function extract(relPath: string, content: string) {
  const result = await extractFile(`${ROOT}/${relPath}`, ROOT, content);
  if (!result) throw new Error(`extractFile returned null for ${relPath}`);
  return result;
}

describe('route extraction (JS/TS)', () => {
  it('creates a route node and a handler reference for an Express route', async () => {
    const r = await extract('src/app.ts', [
      'import express from "express";',
      'const app = express();',
      'function list(req: any, res: any) { res.json([]); }',
      'app.get("/users", list);',
    ].join('\n'));

    const route = r.nodes.find(n => n.kind === 'route');
    expect(route?.name).toBe('GET /users');

    const handlerRef = r.unresolvedRefs.find(ref => ref.refName === 'list' && ref.sourceId === route?.id);
    expect(handlerRef).toBeDefined();
    expect(handlerRef?.refKind).toBe('function');
  });

  it('extracts Fastify routes registered on a route plugin, with a named handler', async () => {
    const r = await extract('src/routes/users.ts', [
      'export async function listUsers(req: any) { return []; }',
      'export async function usersRoutes(fastify: any) {',
      '  fastify.get(\'/\', listUsers);',
      '  fastify.post(\'/\', { preHandler: [auth] }, createUser);',
      '}',
      'async function createUser(req: any) { return {}; }',
    ].join('\n'));

    const routes = r.nodes.filter(n => n.kind === 'route').map(n => n.name).sort();
    expect(routes).toEqual(['GET /', 'POST /']);

    const post = r.nodes.find(n => n.name === 'POST /');
    const handler = r.unresolvedRefs.find(ref => ref.sourceId === post?.id);
    expect(handler?.refName).toBe('createUser');
  });

  it('attributes calls inside an inline handler to the route node', async () => {
    const r = await extract('src/server.ts', [
      'import Fastify from "fastify";',
      'const fastify = Fastify();',
      'function run(q: string) { return q; }',
      'fastify.get(\'/search\', async (req: any) => run(req.query.q));',
    ].join('\n'));

    const route = r.nodes.find(n => n.kind === 'route');
    const calls = r.unresolvedRefs.filter(ref => ref.refName === 'run' && ref.sourceId === route?.id);
    expect(calls.length).toBe(1);
  });

  it('ignores lookups that only look like routes', async () => {
    const r = await extract('src/lookup.ts', [
      'const map = new Map();',
      'const v = map.get(\'key\', fallback);',
      'app.get(\'env\');',
      'app.get(\'env\', handler);',
    ].join('\n'));

    // `map.get` is not a route receiver; `app.get('env')` has one argument; `app.get('env', h)`
    // is rejected because the path does not start with `/`.
    expect(r.nodes.filter(n => n.kind === 'route')).toHaveLength(0);
  });
});

describe('first-argument classification for SQL sinks (argKind)', () => {
  const argKindOf = (refs: Array<{ refName: string; metadata?: Record<string, unknown> }>, name: string) =>
    refs.find(ref => ref.refName === name)?.metadata?.argKind;

  it('marks a Drizzle sql`` template as parameterized', async () => {
    const r = await extract('src/q.ts', [
      'import { sql } from "drizzle-orm";',
      'export function f(db: any, from: string) {',
      '  return db.execute(sql`SELECT * FROM t WHERE d >= ${from}`);',
      '}',
    ].join('\n'));
    expect(argKindOf(r.unresolvedRefs, 'execute')).toBe('parameterized');
  });

  it('marks a string concatenation as dynamic', async () => {
    const r = await extract('src/q.ts', [
      'export function f(db: any, name: string) {',
      '  return db.execute("SELECT * FROM t WHERE n = \'" + name + "\'");',
      '}',
    ].join('\n'));
    expect(argKindOf(r.unresolvedRefs, 'execute')).toBe('dynamic');
  });

  it('marks a literal with no substitutions as static, and a template with one as dynamic', async () => {
    const r = await extract('src/q.ts', [
      'export function a(db: any) { return db.execute(`SELECT 1`); }',
      'export function b(db: any, x: string) { return db.execute(`SELECT ${x}`); }',
    ].join('\n'));
    const kinds = r.unresolvedRefs.filter(ref => ref.refName === 'execute').map(ref => ref.metadata?.argKind);
    expect(kinds).toEqual(['static', 'dynamic']);
  });

  it('treats sql.raw(...) as dynamic, not parameterized', async () => {
    const r = await extract('src/q.ts', [
      'import { sql } from "drizzle-orm";',
      'export function f(db: any, x: string) { return db.execute(sql.raw(x)); }',
    ].join('\n'));
    expect(argKindOf(r.unresolvedRefs, 'execute')).toBe('dynamic');
  });

  it('classifies Python sinks too, so a concatenated query is dynamic', async () => {
    const r = await extract('src/q.py', [
      'def f(cur, name):',
      '    cur.execute("SELECT * FROM t WHERE n = \'" + name + "\'")',
    ].join('\n'));
    const execRef = r.unresolvedRefs.find(ref => ref.refName === 'execute');
    expect(execRef?.metadata?.argKind).toBe('dynamic');
  });
});

describe('framework detection for Fastify vs Express', () => {
  const ctx = (pkg: Record<string, unknown>, files: Record<string, string> = {}): ResolutionContext => ({
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: (p: string) => (p === 'package.json' ? JSON.stringify(pkg) : files[p] ?? null),
    getProjectRoot: () => ROOT,
    getAllFiles: () => Object.keys(files),
  });

  it('detects fastify projects as fastify, not express', () => {
    const c = ctx({ dependencies: { fastify: '4.0.0' } }, { 'routes/users.ts': 'app.get(\'/\', h)' });
    expect(fastifyResolver.detect(c)).toBe(true);
    expect(expressResolver.detect(c)).toBe(false);
  });

  it('still detects express projects as express', () => {
    const c = ctx({ dependencies: { express: '4.18.0' } });
    expect(expressResolver.detect(c)).toBe(true);
    expect(fastifyResolver.detect(c)).toBe(false);
  });
});

describe('route forms beyond the shorthand', () => {
  it('expands app.route({ method: [...], url, handler }) into one route per method', async () => {
    const r = await extract('src/routes.ts', [
      'function save(req: any) { return req; }',
      'export function plugin(fastify: any) {',
      '  fastify.route({ method: [\'PUT\', \'PATCH\'], url: \'/:id\', handler: save });',
      '}',
    ].join('\n'));
    const names = r.nodes.filter(n => n.kind === 'route').map(n => n.name).sort();
    expect(names).toEqual(['PATCH /:id', 'PUT /:id']);
    const handlers = r.unresolvedRefs.filter(ref => ref.refName === 'save');
    expect(handlers).toHaveLength(2);
  });

  it('records register(plugin, { prefix }) as a mount with the plugin\'s module', async () => {
    const r = await extract('src/app.ts', [
      'import { usersRoutes } from \'./routes/users\';',
      'const app: any = {};',
      'app.register(usersRoutes, { prefix: \'/api/v1/users\' });',
    ].join('\n'));
    expect(r.routeMounts).toEqual([
      { pluginName: 'usersRoutes', importedName: 'usersRoutes', specifier: './routes/users', prefix: '/api/v1/users', line: 3 },
    ]);
  });

  it('ignores register calls on non-route receivers', async () => {
    const r = await extract('src/di.ts', [
      'import { Service } from \'./service\';',
      'const container: any = {};',
      'container.register(Service, { prefix: \'/x\' });',
    ].join('\n'));
    expect(r.routeMounts).toEqual([]);
  });
});

describe('package bindings link to their import node', () => {
  it('adds a references edge from a call through a package binding to the import node', async () => {
    const r = await extract('src/users.ts', [
      'import { sql } from \'drizzle-orm\';',
      'export async function listUsers(db: any, from: string) {',
      '  return db.execute(sql`SELECT * FROM t WHERE d >= ${from}`);',
      '}',
    ].join('\n'));
    const importNode = r.nodes.find(n => n.kind === 'import' && n.name === 'drizzle-orm');
    const listUsers = r.nodes.find(n => n.name === 'listUsers');
    expect(importNode).toBeDefined();
    const edge = r.edges.find(e => e.kind === 'references' && e.target === importNode?.id);
    expect(edge?.source).toBe(listUsers?.id);
  });

  it('does not link relative imports, which point at project files', async () => {
    const r = await extract('src/users.ts', [
      'import { db } from \'../db\';',
      'export function listUsers() { return db.execute("SELECT 1"); }',
    ].join('\n'));
    expect(r.edges.filter(e => e.kind === 'references')).toHaveLength(0);
  });
});

describe('mount targets', () => {
  it('keeps the exported name of an aliased named import', async () => {
    const r = await extract('src/app.ts', [
      'import { usersRoutes as ur } from \'./routes/users\';',
      'const app: any = {};',
      'app.register(ur, { prefix: \'/u\' });',
    ].join('\n'));
    expect(r.routeMounts).toEqual([
      { pluginName: 'ur', importedName: 'usersRoutes', specifier: './routes/users', prefix: '/u', line: 3 },
    ]);
  });

  it('records require() and inline plugins', async () => {
    const r = await extract('src/app.ts', [
      'const app: any = {};',
      'app.register(require(\'./legacy\'), { prefix: \'/legacy\' });',
      'app.register(async (f: any) => {',
      '  f.get(\'/x\', async () => 1);',
      '}, { prefix: \'/inline\' });',
    ].join('\n'));
    expect(r.routeMounts?.[0]).toMatchObject({ specifier: './legacy', prefix: '/legacy' });
    expect(r.routeMounts?.[1]).toMatchObject({ pluginName: '<inline>', prefix: '/inline', inlineStart: 3, inlineEnd: 5 });
  });

  it('treats a register without a prefix as a mount with an empty prefix', async () => {
    const r = await extract('src/app.ts', [
      'const app: any = {};',
      'app.register(child);',
    ].join('\n'));
    expect(r.routeMounts).toEqual([
      { pluginName: 'child', importedName: null, specifier: null, prefix: '', line: 2 },
    ]);
  });

  it('reads routes registered on a plugin parameter with any name', async () => {
    const r = await extract('src/plugin.ts', [
      'export async function plugin(instance: any) {',
      '  instance.get(\'/ping\', async () => \'pong\');',
      '}',
    ].join('\n'));
    expect(r.nodes.filter(n => n.kind === 'route').map(n => n.name)).toEqual(['GET /ping']);
  });
});

describe('first-argument classification outside JS', () => {
  const kindOf = async (relPath: string, content: string, name: string) => {
    const r = await extract(relPath, content);
    return r.unresolvedRefs.find(ref => ref.refName === name)?.metadata?.argKind;
  };

  it('classifies Java string concatenation as dynamic and a literal as static', async () => {
    const dyn = await kindOf('src/Q.java', [
      'class Q { void f(Statement st, String n) { st.execute("SELECT " + n); } }',
    ].join('\n'), 'execute');
    const stat = await kindOf('src/Q.java', [
      'class Q { void f(Statement st) { st.execute("SELECT 1"); } }',
    ].join('\n'), 'execute');
    expect(dyn).toBe('dynamic');
    expect(stat).toBe('static');
  });

  it('classifies Go literal and fmt.Sprintf arguments', async () => {
    const stat = await kindOf('src/q.go', [
      'package main',
      'func f(db DB) { db.Query("SELECT 1") }',
    ].join('\n'), 'Query');
    const dyn = await kindOf('src/q.go', [
      'package main',
      'func f(db DB, n string) { db.Query(fmt.Sprintf("SELECT %s", n)) }',
    ].join('\n'), 'Query');
    expect(stat).toBe('static');
    expect(dyn).toBe('dynamic');
  });

  it('leaves languages without a shape table unclassified', async () => {
    const kind = await kindOf('src/q.lua', 'function f(db, n) db:execute("SELECT " .. n) end', 'execute');
    expect(kind).toBeUndefined();
  });
});
