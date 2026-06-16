// Default SCHEMA.md content written by `kirograph wiki init`

export const DEFAULT_SCHEMA = `# Wiki Schema

This file tells KiroGraph's LLM how to structure and maintain the project wiki.
Edit it to match your project's conventions.

## Naming convention

- Entities (classes, services, modules): \`<ClassName>.md\` or \`<module-name>.md\`
- Architecture decisions: \`arch/<slug>.md\`
- Recurring patterns: \`pattern/<slug>.md\`
- External integrations: \`ext/<service>.md\`

## Page structure

Every page should follow this template:

\`\`\`markdown
## Summary
One to three sentences describing what this entity is and why it exists.

## Decisions
- YYYY-MM-DD — Decision text (one line per decision, newest first)

## Known Issues / Gotchas
- Bullet points of non-obvious constraints, bugs, or workarounds

## Related
- [[other-page-slug]] — one line description of the relationship

## Sources
- source-name (YYYY-MM-DD)
\`\`\`

## Ingest workflow

When given a source document to ingest:

1. Read the source and identify entities, decisions, and patterns mentioned
2. Check MANIFEST.md to find existing pages for those entities
3. For each existing page: integrate new information into the appropriate sections
4. For each new entity: create a page following the structure above
5. Always update ## Sources with the source name and today's date
6. Update ## Related cross-references in all touched pages
7. If new information contradicts an existing claim, emit a WIKI_DIFF_CONFLICTS block

## WIKI_DIFF format

Produce output using this exact format — one block per page operation:

\`\`\`
WIKI_DIFF_START
{"action":"upsert","page":"PageSlug","section":"Decisions","mode":"append"}
- YYYY-MM-DD — New decision text
WIKI_DIFF_END
\`\`\`

Actions:
- \`create\` — new page (requires \`title\` field, content is full markdown)
- \`upsert\` — update a section in an existing page (mode: \`append\` or \`replace\`)
- \`append\` — append to the end of an existing page

For conflicts:
\`\`\`
WIKI_DIFF_CONFLICTS
{"page":"PageSlug","section":"SectionName","existing":"old claim","incoming":"new claim","source":"ADR-001.md","existingDate":"2025-01-01","incomingDate":"2025-06-15"}
WIKI_DIFF_CONFLICTS_END
\`\`\`
`;

// ── WIKI_DIFF parser ──────────────────────────────────────────────────────────

import type { WikiDiff, WikiDiffEntry, WikiDiffConflict } from './types';

export function parseWikiDiff(raw: string): WikiDiff {
  const entries: WikiDiffEntry[] = [];
  const conflicts: WikiDiffConflict[] = [];

  // Parse WIKI_DIFF_START...WIKI_DIFF_END blocks
  const diffRegex = /WIKI_DIFF_START\n([\s\S]*?)\nWIKI_DIFF_END/g;
  let match: RegExpExecArray | null;

  while ((match = diffRegex.exec(raw)) !== null) {
    const block = match[1].trim();
    const firstNewline = block.indexOf('\n');
    if (firstNewline === -1) continue;

    const headerStr = block.slice(0, firstNewline).trim();
    const content = block.slice(firstNewline + 1);

    let header: Record<string, any>;
    try {
      header = JSON.parse(headerStr);
    } catch {
      continue;
    }

    entries.push({
      action: header.action ?? 'upsert',
      page: header.page ?? '',
      title: header.title,
      section: header.section,
      mode: header.mode ?? 'append',
      content,
    });
  }

  // Parse WIKI_DIFF_CONFLICTS...WIKI_DIFF_CONFLICTS_END blocks
  const conflictRegex = /WIKI_DIFF_CONFLICTS\n([\s\S]*?)\nWIKI_DIFF_CONFLICTS_END/g;

  while ((match = conflictRegex.exec(raw)) !== null) {
    const block = match[1].trim();
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const c = JSON.parse(trimmed);
        conflicts.push({
          page: c.page ?? '',
          section: c.section ?? '',
          existing: c.existing ?? '',
          incoming: c.incoming ?? '',
          source: c.source ?? '',
          existingDate: c.existingDate,
          incomingDate: c.incomingDate,
        });
      } catch {
        continue;
      }
    }
  }

  return { entries, conflicts, rawDiff: raw };
}
