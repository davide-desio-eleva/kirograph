/**
 * KiroGraph Wiki — Lint
 *
 * Health checks: contradictions (FTS similarity), orphan pages,
 * broken [[slug]] cross-references.
 */

import * as path from 'path';
import type { WikiLintIssue } from './types';
import type { WikiDatabase } from './database';

const LINK_RE = /\[\[([^\]]+)\]\]/g;

export function lintWiki(wikiDb: WikiDatabase): WikiLintIssue[] {
  const issues: WikiLintIssue[] = [];
  const pages = wikiDb.listPages();
  const slugSet = new Set(pages.map(p => p.slug));

  for (const page of pages) {
    // Broken [[slug]] links
    let m: RegExpExecArray | null;
    const re = new RegExp(LINK_RE.source, 'g');
    while ((m = re.exec(page.content)) !== null) {
      const linked = m[1].trim();
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
    const hasIncoming = pages.some(p => p.slug !== page.slug && p.content.includes(`[[${page.slug}]]`));
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
    // Simple heuristic: search for the page title and flag pages with conflicting signals
    const similar = wikiDb.search(page.title, 5);
    for (const { page: other } of similar) {
      if (other.slug === page.slug) continue;
      // Check for negation keywords close to shared terms
      const contradictionSignals = ['instead of', 'not', 'replaced by', 'superseded', 'deprecated'];
      const bothMentionSignal = contradictionSignals.some(
        sig => page.content.toLowerCase().includes(sig) && other.content.toLowerCase().includes(sig)
      );
      if (bothMentionSignal) {
        const key = [page.slug, other.slug].sort().join('|');
        const alreadyReported = issues.some(
          i => i.kind === 'contradiction' && i.detail.includes(other.slug)
        );
        if (!alreadyReported) {
          issues.push({
            kind: 'contradiction',
            slug: page.slug,
            detail: `Possible contradiction with [[${other.slug}]] — both pages contain negation signals on shared topics`,
            relatedSlug: other.slug,
          });
        }
      }
    }
  }

  return issues;
}
