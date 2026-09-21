/**
 * KiroGraph Wiki — Link graph
 *
 * Read-only queries over the `[[slug]]` cross-reference graph between wiki
 * pages. Shared by lint.ts (broken-link/orphan detection) and the
 * `kirograph wiki links`/`wiki rename` CLI commands.
 */

import type { WikiDatabase } from './database';

export const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

/** Distinct slugs referenced via `[[slug]]` in `content`, in order of first appearance. */
export function extractLinks(content: string): string[] {
  const seen = new Set<string>();
  const re = new RegExp(WIKI_LINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    seen.add(m[1].trim());
  }
  return [...seen];
}

export interface WikiPageLinks {
  /** Slugs this page links to that exist. */
  outgoing: string[];
  /** Slugs this page links to that don't exist as a page. */
  broken: string[];
  /** Slugs of other pages that link to this one. */
  incoming: string[];
}

/**
 * Outgoing/broken/incoming `[[slug]]` links for one page.
 * Returns null if the slug isn't a known page.
 */
export function getPageLinks(wikiDb: WikiDatabase, slug: string): WikiPageLinks | null {
  const page = wikiDb.getPage(slug);
  if (!page) return null;

  const pages = wikiDb.listPages();
  const slugSet = new Set(pages.map(p => p.slug));

  const linked = extractLinks(page.content);
  const outgoing = linked.filter(s => slugSet.has(s));
  const broken = linked.filter(s => !slugSet.has(s));

  const incoming = pages
    .filter(p => p.slug !== slug && extractLinks(p.content).includes(slug))
    .map(p => p.slug);

  return { outgoing, broken, incoming };
}
