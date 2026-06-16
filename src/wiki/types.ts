// ── WikiPage ──────────────────────────────────────────────────────────────────

export interface WikiPage {
  slug: string;
  title: string;
  content: string;
  filePath: string;
  updatedAt: number;
  sourceCount: number;
}

export interface ScoredWikiPage {
  page: WikiPage;
  score: number;
}

// ── WIKI_DIFF types ───────────────────────────────────────────────────────────

export type DiffAction = 'upsert' | 'create' | 'append';
export type DiffMode = 'replace' | 'append';

export interface WikiDiffEntry {
  action: DiffAction;
  page: string;          // slug
  title?: string;        // required for action=create
  section?: string;      // target section heading (e.g. "Decisions")
  mode?: DiffMode;       // for action=upsert: replace section or append to it
  content: string;       // markdown content to write
}

export interface WikiDiffConflict {
  page: string;
  section: string;
  existing: string;
  incoming: string;
  source: string;
  existingDate?: string; // ISO date string
  incomingDate?: string; // ISO date string
}

export interface WikiDiff {
  entries: WikiDiffEntry[];
  conflicts: WikiDiffConflict[];
  rawDiff: string;
}

// ── Lint ─────────────────────────────────────────────────────────────────────

export type LintIssueKind = 'contradiction' | 'orphan' | 'stale' | 'broken_link';

export interface WikiLintIssue {
  kind: LintIssueKind;
  slug: string;
  detail: string;
  relatedSlug?: string;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface WikiStats {
  pageCount: number;
  totalSources: number;
  oldestPage: number | null;
  newestPage: number | null;
}
