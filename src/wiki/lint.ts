/**
 * KiroGraph Wiki — Lint
 *
 * Health checks: contradictions (FTS similarity), orphan pages,
 * broken [[slug]] cross-references.
 */

import * as path from 'path';
import type { WikiLintIssue } from './types';
import type { WikiDatabase } from './database';
import type { JevClient } from '../jev/client';
import { extractLinks } from './links';
import { parseFrontmatter, validatePageSchema } from './typed-pages';

export interface LintWikiOptions {
  /** 'heuristic' (default): keyword co-occurrence. 'jev': ask jev to judge each FTS-similar pair. */
  contradictionMode?: 'heuristic' | 'jev';
  /** Confidence (0.0–1.0) above which a jev contradiction judgment is reported. Default: 0.7. */
  contradictionConfidenceThreshold?: number;
  /** Required when contradictionMode is 'jev'. */
  jevClient?: JevClient;
  /**
   * When set, pages declaring `_type` in their frontmatter are validated
   * against `.kirograph/wiki-schemas/<type>.schema.json` (wikiTypedPages).
   */
  wikiSchemasDir?: string;
}

export async function lintWiki(wikiDb: WikiDatabase, opts: LintWikiOptions = {}): Promise<WikiLintIssue[]> {
  const issues: WikiLintIssue[] = [];
  const pages = wikiDb.listPages();
  const slugSet = new Set(pages.map(p => p.slug));

  for (const page of pages) {
    // Typed-page schema validation (opt-in via wikiTypedPages)
    if (opts.wikiSchemasDir) {
      const { type, fields } = parseFrontmatter(page.content);
      if (type) {
        for (const violation of validatePageSchema(fields, type, opts.wikiSchemasDir)) {
          issues.push({
            kind: 'schema_error',
            slug: page.slug,
            detail: `[${type}] ${violation}`,
          });
        }
      }
    }

    // Broken [[slug]] links
    for (const linked of extractLinks(page.content)) {
      if (!slugSet.has(linked)) {
        issues.push({
          kind: 'broken_link',
          slug: page.slug,
          detail: `Broken link to [[${linked}]] — page does not exist`,
          relatedSlug: linked,
        });
      }
    }

    // Orphan: no ## Related section and no incoming links from other pages
    const hasRelated = /^## Related/m.test(page.content);
    const hasIncoming = pages.some(p => p.slug !== page.slug && extractLinks(p.content).includes(page.slug));
    if (!hasRelated && !hasIncoming && pages.length > 1) {
      issues.push({
        kind: 'orphan',
        slug: page.slug,
        detail: 'Page has no ## Related section and no incoming links from other pages',
      });
    }

    // Stale: ## Sources section present but no date found (can't verify freshness)
    const sourcesMatch = page.content.match(/## Sources\n([\s\S]*?)(?=\n## |\n*$)/);
    if (sourcesMatch) {
      const sourcesBlock = sourcesMatch[1];
      const hasDates = /\d{4}-\d{2}-\d{2}/.test(sourcesBlock);
      if (!hasDates) {
        issues.push({
          kind: 'stale',
          slug: page.slug,
          detail: '## Sources section has no dates — cannot verify freshness',
        });
      }
    }

    // Contradictions: FTS similarity with other pages on the same topic
    const similar = wikiDb.search(page.title, 5);
    for (const { page: other } of similar) {
      if (other.slug === page.slug) continue;
      const alreadyReported = issues.some(
        i => i.kind === 'contradiction' && i.detail.includes(other.slug)
      );
      if (alreadyReported) continue;

      if (opts.contradictionMode === 'jev' && opts.jevClient) {
        const { checkContradictionWithJev } = await import('./contradiction-jev');
        const result = await checkContradictionWithJev(opts.jevClient, page.content, other.content);
        const threshold = opts.contradictionConfidenceThreshold ?? 0.7;
        if (result.contradicts && result.confidence >= threshold) {
          issues.push({
            kind: 'contradiction',
            slug: page.slug,
            detail: `Possible contradiction with [[${other.slug}]] — jev confidence: ${result.confidence.toFixed(2)}`,
            relatedSlug: other.slug,
          });
        }
        continue;
      }

      // Heuristic (default): co-occurring negation keywords on both pages
      const contradictionSignals = ['instead of', 'not', 'replaced by', 'superseded', 'deprecated'];
      const bothMentionSignal = contradictionSignals.some(
        sig => page.content.toLowerCase().includes(sig) && other.content.toLowerCase().includes(sig)
      );
      if (bothMentionSignal) {
        issues.push({
          kind: 'contradiction',
          slug: page.slug,
          detail: `Possible contradiction with [[${other.slug}]] — both pages contain negation signals on shared topics`,
          relatedSlug: other.slug,
        });
      }
    }
  }

  return issues;
}
