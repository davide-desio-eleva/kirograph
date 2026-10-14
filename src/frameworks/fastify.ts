/**
 * Fastify Framework Resolver
 *
 * Route nodes come from the AST extractor (src/extraction/routes.ts), which recognises
 * `fastify.get('/path', ..., handler)` and the other HTTP methods. This resolver only
 * identifies Fastify projects and reuses the express naming conventions for
 * controllers, services and middleware.
 *
 * Not yet handled: path prefixes from `app.register(plugin, { prefix })`, which apply
 * across files, and `app.route({ method, url, handler })`.
 */

import type { FrameworkResolver, ResolutionContext } from './types';
import { expressResolver } from './express';

export const fastifyResolver: FrameworkResolver = {
  name: 'fastify',

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (!packageJson) return false;
    try {
      const pkg = JSON.parse(packageJson);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return Boolean(deps.fastify);
    } catch {
      return false;
    }
  },

  resolve: expressResolver.resolve,
};
