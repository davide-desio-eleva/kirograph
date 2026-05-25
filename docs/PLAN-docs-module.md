# Documentation Module — Implementation Plan

## Overview

A new `src/docs/` module that brings structured documentation navigation into kirograph's knowledge graph. Inspired by [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp), but implemented natively in TypeScript and fully integrated with kirograph's existing architecture: same DB, same embeddings pipeline, same MCP tool surface, same installer flow.

The core idea: index documentation by **heading hierarchy and section structure**, then let agents retrieve exactly the section they need instead of reading entire files. Because kirograph already knows about code symbols, we can cross-reference docs ↔ code automatically.

---

## Design Principles

1. **Same patterns as existing modules** — follows the `enableArchitecture` / `enableMemory` precedent: config flag, installer toggle, conditional tool registration, gated CLI commands.
2. **Section as the unit of access** — not files, not paragraphs, not chunks. Sections preserve the author's intended structure.
3. **Code-aware** — unlike standalone doc tools, kirograph can link doc sections to code symbols (functions, classes, types) via backtick references, import paths, and heading matches.
4. **Zero external dependencies** — parsing is done with simple heading-based splitting (no tree-sitter needed for docs). Embeddings reuse the existing vector pipeline.
5. **Incremental** — re-indexes only changed files on `kirograph sync`. Uses content hashes for drift detection.
6. **Strictly local-first** — no GitHub API, no remote fetching. Only indexes documentation files present on disk within the project.
7. **Separate search** — doc search is its own tool (`kirograph_docs_search`), not mixed into `kirograph_search`. Code search and doc search stay independent.
8. **Local summarization** — section summaries are generated via the embedding model (same local model already downloaded for code embeddings), no external API keys required.

---

## What Documentation Is Considered

### jDocMunch scope

jDocMunch indexes **any documentation set** — local folders or remote GitHub repos. It supports:
- Markdown (.md, .mdx)
- reStructuredText (.rst)
- AsciiDoc (.adoc)
- Plain text (.txt)
- HTML (.html)
- Jupyter Notebooks (.ipynb) — markdown cells as sections
- OpenAPI/Swagger (.yaml, .yml, .json) — operations grouped by tag
- JSON/JSONC (.json, .jsonc) — top-level keys as sections
- XML/SVG/XHTML (.xml, .svg, .xhtml) — element hierarchy

It treats documentation as a standalone concern, disconnected from code.

### Kirograph docs module scope

We focus on **project-local documentation that lives alongside code**. This means:

| Category | Examples | Included |
|----------|----------|----------|
| Project docs | `README.md`, `docs/`, `CONTRIBUTING.md`, `ARCHITECTURE.md` | ✅ |
| API docs (authored) | `docs/api.md`, `docs/endpoints.md` | ✅ |
| Guides & tutorials | `docs/getting-started.md`, `docs/migration-guide.rst` | ✅ |
| ADRs (Architecture Decision Records) | `docs/adr/`, `decisions/` | ✅ |
| Inline code docs (docstrings) | Already handled by kirograph's `extractDocstrings` | ❌ (no duplication) |
| Auto-generated API docs | `docs/generated/`, typedoc output | ❌ (excluded by default) |
| Changelogs | `CHANGELOG.md` | ❌ (excluded by default — too noisy) |
| License files | `LICENSE`, `LICENSE.md` | ❌ (excluded by default) |
| OpenAPI specs | `openapi.yaml`, `swagger.json` | ✅ (Phase 4 — structured parsing) |
| Jupyter notebooks | `.ipynb` | ❌ (out of scope — not typical project docs) |
| JSON/XML as docs | `.json`, `.xml` | ❌ (out of scope — these are data, not docs) |

**Key difference from jDocMunch:** we don't index remote repos or arbitrary doc sets. We index the documentation that ships with the project, because that's what's relevant when an agent is working on the code. The value proposition is the **code ↔ docs cross-reference** — knowing that `docs/auth.md#token-refresh` documents the `refreshToken()` function.

### Supported formats by ecosystem

Kirograph indexes 33 programming languages. Each ecosystem has its own documentation conventions. We cover the formats that actually appear alongside code in those ecosystems:

| Format | Extensions | Ecosystems | Parsing strategy |
|--------|-----------|------------|-----------------|
| **Markdown** | `.md`, `.mdx` | All (universal) | ATX (`#`) + setext headings |
| **reStructuredText** | `.rst` | Python (Sphinx), PHP (Symfony) | Adornment-based heading detection |
| **AsciiDoc** | `.adoc`, `.asciidoc` | Java/Kotlin (Spring), Ruby | `=` heading hierarchy |
| **RDoc** | `.rdoc` | Ruby | `=` heading hierarchy (similar to AsciiDoc) |
| **Org-mode** | `.org` | Elixir, OCaml, Rust, Emacs-heavy projects | `*` heading hierarchy |
| **HTML** | `.html`, `.htm` | Java (Javadoc output), C# (.NET), multi-language | `<h1>`–`<h6>` headings |
| **Plain text** | `.txt` | Python (`docs/`), legacy projects | Paragraph-block splitting |
| **Cheatmd** | `.cheatmd` | Elixir (ExDoc) | Markdown-compatible (`##` sections) |
| **OpenAPI/Swagger** | `.yaml`, `.yml`, `.json` | Any REST API project | Operations grouped by tag (Phase 4) |

**Formats explicitly excluded:**

| Format | Why |
|--------|-----|
| `.ipynb` (Jupyter) | Data science notebooks, not project documentation |
| `.json` / `.xml` as docs | These are data/config, not authored documentation |
| `.tex` / LaTeX | Academic papers, not project docs |
| `.man` / manpages | System-level docs, not project docs |
| `.pod` (Perl) | Perl isn't in kirograph's language list |
| `.wiki` (MediaWiki) | Not shipped with code projects |
| `.textile` | Nearly extinct; not worth the parser effort |
| `.docc` bundles | Apple-specific; the Markdown inside them is already covered by `**/*.md` |

### Default include/exclude patterns

```
docsInclude: [
  '**/*.md',
  '**/*.mdx',
  '**/*.rst',
  '**/*.adoc',
  '**/*.asciidoc',
  '**/*.rdoc',
  '**/*.org',
  '**/*.cheatmd',
  'docs/**/*.txt',
  'docs/**/*.html'
]

docsExclude: [
  'node_modules/**',
  '**/CHANGELOG*',
  '**/LICENSE*',
  '**/CHANGES*',
  'dist/**',
  'build/**',
  'coverage/**',
  '.git/**',
  '**/generated/**',
  '**/auto-generated/**',
  '**/vendor/**',
  '_build/**'
]
```

Users can override these in `.kirograph/config.json` to include/exclude whatever makes sense for their project.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     WRITE PATH (indexing)                         │
│                                                                  │
│  kirograph sync ──→ scan docsInclude/docsExclude                │
│                 ──→ detect format (extension → parser)           │
│                 ──→ parse headings → section hierarchy           │
│                 ──→ generate stable IDs                          │
│                 ──→ compute content_hash (SHA-256)               │
│                 ──→ upsert doc_sections (skip if hash unchanged) │
│                 ──→ [if docsLinkCode] detect code refs           │
│                      → upsert doc_code_refs (qualified_name)     │
│                 ──→ [if enableEmbeddings] embed summaries        │
│                      → doc_vectors (same semantic engine)        │
│                 ──→ [if docsSummarization='embedding']           │
│                      → extractive summary via local model        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     READ PATH (MCP + CLI)                         │
│                                                                  │
│  kirograph_docs_toc     ──→ doc_sections (ordered by position)  │
│  kirograph_docs_search  ──→ FTS5 + vector hybrid on sections    │
│  kirograph_docs_section ──→ byte-range read from original file  │
│  kirograph_docs_outline ──→ doc_sections WHERE file_path = X    │
│  kirograph_docs_refs    ──→ doc_code_refs JOIN nodes             │
│                                                                  │
│  kirograph_context (if docsContextLimit > 0)                    │
│    ──→ find symbols → JOIN doc_code_refs → top N sections       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Module Structure

```
src/docs/
├── types.ts              # DocSection, DocIndex, DocCodeRef interfaces
├── section-id.ts         # Stable section ID generation
├── indexer.ts            # Orchestrator: scan → parse → persist
├── linker.ts             # Code ↔ doc cross-reference detection
├── formats/
│   ├── index.ts          # Format registry + dispatcher
│   ├── markdown.ts       # .md, .mdx, .cheatmd — ATX/setext headings
│   ├── rst.ts            # .rst — adornment-based headings
│   ├── asciidoc.ts       # .adoc, .asciidoc — = heading hierarchy
│   ├── rdoc.ts           # .rdoc — Ruby doc format (= headings)
│   ├── org.ts            # .org — Org-mode (* headings)
│   ├── html.ts           # .html, .htm — <h1>–<h6>
│   ├── openapi.ts        # .yaml/.json — operations grouped by tag (Phase 4)
│   └── plaintext.ts      # .txt — paragraph-block splitting
└── queries.ts            # Read-side helpers for MCP tools
```

---

## Data Model

### New DB tables (applied when `enableDocs: true`)

```sql
-- Sections extracted from documentation files
CREATE TABLE IF NOT EXISTS doc_sections (
  id            TEXT PRIMARY KEY,   -- stable section ID (see below)
  file_path     TEXT NOT NULL,      -- relative path to doc file
  title         TEXT NOT NULL,      -- heading text
  level         INTEGER NOT NULL,   -- heading depth (1–6, 0 for root)
  parent_id     TEXT,               -- parent section ID (NULL for top-level)
  summary       TEXT,               -- one-line summary (auto-generated or first sentence)
  byte_start    INTEGER NOT NULL,   -- byte offset in original file
  byte_end      INTEGER NOT NULL,   -- byte offset end
  content_hash  TEXT NOT NULL,      -- SHA-256 of section content (drift detection)
  tags          TEXT,               -- JSON array of extracted tags/refs
  position      INTEGER NOT NULL DEFAULT 0,  -- ordering among siblings
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_sections_file ON doc_sections(file_path);
CREATE INDEX IF NOT EXISTS idx_doc_sections_parent ON doc_sections(parent_id);

-- Cross-references between doc sections and code symbols
CREATE TABLE IF NOT EXISTS doc_code_refs (
  section_id      TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,      -- stable across reindex (e.g. "src/auth/service.ts::validateToken")
  ref_type        TEXT NOT NULL,      -- 'mentions' | 'documents' | 'example' | 'configures'
  confidence      REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (section_id, qualified_name, ref_type)
);

CREATE INDEX IF NOT EXISTS idx_doc_code_refs_qname ON doc_code_refs(qualified_name);
```

### Stable Section IDs

Format: `{file_path}::{ancestor-chain/slug}#{level}`

Examples:
- `docs/install.md::installation#1`
- `docs/install.md::installation/prerequisites#2`
- `README.md::usage/configuration/advanced-options#3`

IDs remain stable across re-indexing when file path, heading text, heading level, and parent chain don't change.

---

## Configuration

New fields in `KiroGraphConfig`:

```typescript
/** Enable documentation indexing and navigation. Default: false. */
enableDocs: boolean;

/** Glob patterns for documentation files to include. */
docsInclude: string[];
// default: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', '**/*.asciidoc',
//           '**/*.rdoc', '**/*.org', '**/*.cheatmd', 'docs/**/*.txt', 'docs/**/*.html']

/** Glob patterns for documentation files to exclude. */
docsExclude: string[];
// default: ['node_modules/**', '**/CHANGELOG*', '**/LICENSE*', '**/CHANGES*',
//           'dist/**', 'build/**', '**/generated/**', '**/vendor/**', '_build/**']

/** Enable auto-linking of doc sections to code symbols. Default: true (when enableDocs is true). */
docsLinkCode: boolean;

/**
 * Max doc sections to include in kirograph_context results.
 * 0 = disabled (docs never appear in kirograph_context, agent must use kirograph_docs_* tools explicitly).
 * When > 0, only sections above docsContextThreshold are included.
 * Asked during install only when enableDocs is true.
 * Default: 0 (disabled — opt-in via installer).
 */
docsContextLimit: number;

/** Min relevance score to include a doc section in kirograph_context. Default: 0.3. */
docsContextThreshold: number;

/** Max file size for doc files (bytes). Default: 1MB (1_048_576). */
docsMaxFileSize: number;

/**
 * Summarization strategy for section summaries.
 * - 'embedding': use the local embedding model to generate extractive summaries (requires enableEmbeddings)
 * - 'first-sentence': use the first sentence of the section content (no model needed)
 * - 'off': no summaries, only heading text
 * Default: 'embedding' when enableEmbeddings is true, otherwise 'first-sentence'.
 */
docsSummarization: 'embedding' | 'first-sentence' | 'off';
```

Added to `KNOWN_FIELDS` set and `validateConfig()`.

**Summarization via embedding model:** When `docsSummarization: 'embedding'`, we use the same local model already loaded for code embeddings to produce extractive summaries. The model scores sentences by relevance to the heading, picking the most representative one. This gives better summaries than first-sentence extraction without requiring any external API key.

---

## MCP Tools

Five dedicated tools, following the `kirograph_mem_*` naming pattern:

| Tool | Description | Args |
|------|-------------|------|
| `kirograph_docs_toc` | Table of contents for a file or the whole project | `{ file?: string, tree?: boolean }` |
| `kirograph_docs_search` | Search sections by query (FTS on title + summary + content) | `{ query: string, file?: string, limit?: number }` |
| `kirograph_docs_section` | Retrieve full content of a section by stable ID | `{ id: string, context?: boolean }` |
| `kirograph_docs_outline` | Heading hierarchy for a single document | `{ file: string }` |
| `kirograph_docs_refs` | Code ↔ doc cross-references (bidirectional) | `{ sectionId?: string, nodeId?: string }` |

All tools gated behind `enableDocs: true` — return a helpful error message when disabled.

**`kirograph_docs_section` with `context: true`** returns the section content plus ancestor heading chain and child summaries (similar to jDocMunch's `get_section_context`), giving the agent orientation without reading the full file.

**`kirograph_docs_search`** is independent from `kirograph_search`. Code search stays for code, doc search stays for docs. No mixing.

---

## Installer Integration

### Opt-in behavior

The docs module is **optional and off by default**, exactly like `enableArchitecture` and `enableMemory`. It is:
- **Not enabled** unless the user explicitly toggles it during `kirograph install`
- **Not enabled** on existing projects unless the user manually sets `"enableDocs": true` in `.kirograph/config.json`
- **Gated at every entry point**: MCP tools return a helpful error, CLI commands exit with a message, the sync pipeline skips doc indexing — all when `enableDocs` is `false`

This ensures zero overhead for users who don't need documentation navigation.

### Config prompt (`src/bin/installer/config-prompt.ts`)

New section after "Graph Features", before "Agent Behavior":

```
📖 Documentation

  Documentation indexing:
  Indexes docs by heading structure for section-level retrieval.
  Enables kirograph_docs_toc, kirograph_docs_search, kirograph_docs_section,
  kirograph_docs_outline, kirograph_docs_refs.
```

Toggle: `enableDocs` (default: `false`)

**If `enableDocs` is toggled on**, a follow-up prompt appears:

```
  Include doc sections in kirograph_context results?
  When enabled, relevant doc sections are automatically surfaced alongside
  code symbols in kirograph_context. Set to 0 to keep docs separate (use
  kirograph_docs_* tools explicitly).

  Max doc sections in context (0 = disabled): [0]
```

Arrow-key select or numeric input. Default: `0` (disabled). Suggested values: `0`, `3`, `5`, `10`.

When `docsContextLimit` is `0`, `kirograph_context` never includes doc sections — the agent must explicitly call `kirograph_docs_search` or `kirograph_docs_section`. This avoids flooding context with documentation the agent didn't ask for.

When `docsContextLimit > 0`, `kirograph_context` queries `doc_code_refs` for the symbols it found and includes up to N relevant doc sections (above `docsContextThreshold` score).

When the user has an existing `.kirograph/config.json`, the installer prints the current state:
```
  • enableDocs: false
```

### ConfigPatch type

Add `enableDocs` to the `ConfigPatch` type:
```typescript
export type ConfigPatch = Pick<KiroGraphConfig, 
  'enableEmbeddings' | ... | 'enableMemory' | 'enableDocs'
> & { embeddingModel?: string; embeddingDim?: number };
```

### Installer late phase (`installLate`)

Pass `enableDocs` to `writeHooks` and `writeSteering` so:
- Steering file mentions doc tools when enabled
- No additional hooks needed (docs re-index on `kirograph sync` like code)
- MCP `autoApprove` list includes `kirograph_docs_*` tools when enabled

### CLI command (`src/bin/commands/docs.ts`)

```
kirograph docs toc [file]         — print table of contents
kirograph docs search <query>     — search sections
kirograph docs section <id>       — print section content
kirograph docs outline <file>     — print heading hierarchy
kirograph docs refs <id>          — show code ↔ doc links
kirograph docs reindex            — force re-index all docs
kirograph docs lint               — find broken refs, stale sections, FTS desync
kirograph docs reembed            — re-embed all sections with current model
```

All commands check `enableDocs` and exit with:
```
  ✖ Documentation indexing is not enabled. Set enableDocs: true in .kirograph/config.json
  Then re-run: kirograph index
```

---

## Integration with Existing Features

### `kirograph_context`

When building context for a code symbol, optionally query `doc_code_refs` and include relevant doc section summaries. **This is opt-in and disabled by default** (`docsContextLimit: 0`).

Behavior:
- `docsContextLimit: 0` (default) → `kirograph_context` never includes doc sections. The agent uses `kirograph_docs_*` tools explicitly when it needs documentation.
- `docsContextLimit: N` (user-configured via installer) → `kirograph_context` includes up to N doc sections that reference the symbols found, filtered by `docsContextThreshold` (default: 0.3). Each section is truncated to its summary + heading chain.

This avoids the problem of flooding context with documentation the agent didn't ask for. Projects with dense docs (e.g., 50+ doc files) would overwhelm `kirograph_context` if docs were always included. The user knows their project best and can tune the cap accordingly.

### Embeddings / Semantic Search

Section titles and summaries are embedded into the vector index (same pipeline as code symbols). However, `kirograph_docs_search` queries only doc embeddings, and `kirograph_search` queries only code embeddings. The two remain independent — no mixing.

### Architecture Layer

Doc files are auto-assigned to a `docs` layer when architecture analysis is enabled.

### Sync Pipeline

`IndexPipeline` gains a docs indexing step:
1. Scan for doc files matching `docsInclude` / `docsExclude`
2. Parse sections from changed files
3. Compute content hashes, detect drift
4. Upsert sections, remove stale ones
5. Run linker to update `doc_code_refs`

### Memory

Doc exploration patterns (which sections were retrieved) can be captured as memory observations when `enableMemory` is also active.

---

## Implementation Phases

### Phase 1 — Core (MVP)

- [ ] `src/docs/types.ts` — interfaces
- [ ] `src/docs/section-id.ts` — ID generation
- [ ] `src/docs/formats/markdown.ts` — Markdown parser (ATX + setext, also handles `.mdx` and `.cheatmd`)
- [ ] `src/docs/formats/index.ts` — format registry
- [ ] `src/docs/indexer.ts` — orchestrator
- [ ] `src/docs/queries.ts` — read helpers
- [ ] DB schema migration (new tables, applied when `enableDocs: true`)
- [ ] Config: `enableDocs`, `docsInclude`, `docsExclude`, `docsMaxFileSize`, `docsSummarization`
- [ ] MCP tools: `kirograph_docs_toc`, `kirograph_docs_section`, `kirograph_docs_outline`
- [ ] Naive cost heuristics in `src/compression/naive-cost.ts` for all 5 docs tools
- [ ] Token tracker: new `'docs'` source category in `TokenSavingsRecord.source`
- [ ] Installer toggle in `config-prompt.ts` (opt-in, default `false`)
- [ ] `ConfigPatch` type updated with `enableDocs`
- [ ] `installLate` signature extended with `enableDocs` parameter
- [ ] MCP `autoApprove` list updated with 5 new `kirograph_docs_*` tools
- [ ] `KIROGRAPH_TOOL_NAMES` array updated in `src/mcp/tool-names.ts`
- [ ] CLI: `kirograph docs toc`, `kirograph docs section`, `kirograph docs outline`
- [ ] Sync pipeline integration (incremental re-index on `kirograph sync`)
- [ ] Steering file updated: mentions docs tools when `enableDocs` is enabled
- [ ] **README.md** updated:
  - New "Documentation indexing (opt-in)" section under "How Indexing Works"
  - 5 new MCP tool entries in the "MCP Tools" section
  - `kirograph docs` commands in "CLI Reference"
  - `enableDocs` in config table
  - Tool count updated (24 → 29)
- [ ] **CHANGELOG.md** updated: new `[0.16.0]` entry documenting the full feature
- [ ] **docs/index.html** updated:
  - New feature card: "Documentation Navigation" with description
  - "Three indexing layers" → "Four indexing layers" (add Documentation layer)
  - Tool count badge updated
- [ ] **docs/docs.html** updated:
  - New sidebar link: "Documentation" under "Advanced"
  - New "Documentation indexing (opt-in)" section under "How Indexing Works"
  - New `enableDocs` row in configuration table
  - Quick Start installer prompt list updated
- [ ] **docs/mcp-tools.html** updated: 5 new tool cards with descriptions and parameters

### Phase 2 — Search + Formats

- [ ] FTS index on `doc_sections.title` + `doc_sections.summary`
- [ ] MCP tool: `kirograph_docs_search`
- [ ] CLI: `kirograph docs search`
- [ ] `src/docs/formats/rst.ts` — reStructuredText (Python/Sphinx ecosystem)
- [ ] `src/docs/formats/asciidoc.ts` — AsciiDoc (Java/Spring, Ruby)
- [ ] `src/docs/formats/rdoc.ts` — RDoc (Ruby)
- [ ] `src/docs/formats/org.ts` — Org-mode (Elixir, OCaml, multi-ecosystem)
- [ ] `src/docs/formats/html.ts` — HTML (Javadoc, .NET, multi-language)
- [ ] `src/docs/formats/plaintext.ts` — Plain text (Python docs/, legacy)
- [ ] Embed section titles/summaries into vector index
- [ ] Local summarization via embedding model (`docsSummarization: 'embedding'`)

### Phase 3 — Code Linking

- [ ] `src/docs/linker.ts` — detect backtick references, import paths, heading→symbol matches
- [ ] `doc_code_refs` population during indexing
- [ ] MCP tool: `kirograph_docs_refs`
- [ ] CLI: `kirograph docs refs`
- [ ] Enrich `kirograph_context` with relevant doc sections
- [ ] Config: `docsLinkCode`

### Phase 4 — Advanced

- [ ] `src/docs/formats/openapi.ts` — OpenAPI/Swagger structured parsing
- [ ] Drift detection: warn when content hash changes without re-index
- [ ] `kirograph_docs_toc` tree mode (nested hierarchy output)
- [ ] Architecture layer auto-assignment for doc files
- [ ] Memory integration (doc exploration observations)
- [ ] Steering file updates (teach agent about doc tools)
- [ ] Stale docs detection (`kirograph_docs_stale` or surfaced in `kirograph_status`)
- [ ] Doc coverage metrics (% of public symbols with corresponding doc sections)
- [ ] `kirograph_gain` output updated: 4 source categories (Graph, Docs, Compression, Memory)

---

## Differences from jDocMunch

| Aspect | jDocMunch | Kirograph Docs Module |
|--------|-----------|----------------------|
| Language | Python | TypeScript |
| Storage | Standalone JSON in `~/.doc-index/` | Integrated SQLite (same DB as code graph) |
| Code awareness | None | Cross-references docs ↔ code symbols |
| Search | BM25 + optional external embeddings | FTS + local embedding model (same engine as code) |
| Scope | Any docs: local folders + remote GitHub repos | Project-local docs only (strictly local-first) |
| Remote indexing | Yes (GitHub API) | No — local files only |
| Summarization | Requires Anthropic/Google/OpenAI API key | Local embedding model (no API key needed) |
| Installer | Separate `pip install` + `init` | Same `kirograph install` flow |
| Formats | 10 formats including Jupyter, JSON, XML | 9 formats covering all major language ecosystems |
| License | Dual (commercial requires paid) | MIT |
| Tool naming | Standalone MCP tools | `kirograph_docs_*` (5 tools, same pattern as `kirograph_mem_*`) |

---

## Effort Estimate

| Phase | Scope | Estimate |
|-------|-------|----------|
| 1 | Core parsing, DB, tools, installer | 3–4 days |
| 2 | Search, additional formats, embeddings | 2–3 days |
| 3 | Code linking, context enrichment | 2–3 days |
| 4 | OpenAPI, drift, memory, steering | 2 days |
| **Total** | | **9–12 days** |

---

## Resolved Decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| D1 | Unified vs separate search | **Separate.** `kirograph_search` for code, `kirograph_docs_search` for docs. | Keeps result types clean. Agent knows what it's getting. Avoids ranking issues between code symbols and doc sections. |
| D2 | Remote docs (GitHub repos) | **No.** Strictly local-first. Only project files on disk. | Matches kirograph's core philosophy. Remote fetching adds complexity, auth requirements, and network dependency. |
| D3 | Summarization | **Local embedding model.** Falls back to first-sentence when embeddings are disabled. | Zero external API keys. Same model already downloaded for code. Extractive summarization (sentence scoring) is cheap and deterministic. |
| D4 | Tool naming | **5 separate tools** with `kirograph_docs_*` prefix, same pattern as `kirograph_mem_*`. | Consistent with existing conventions. Clear discoverability. Each tool has a focused purpose. |
| D5 | Section ID stability | **`{file_path}::{ancestor-chain/slug}#{level}`** | Stable across re-indexing when path, heading text, level, and parent chain don't change. Readable and debuggable. |
| D6 | Docs survival during `kirograph uninit` | **Prompt separately** (same as memory). If user says no, `doc_*` tables are preserved. | Docs index is expensive to rebuild. User may want to keep it even when removing other integration files. |
| D7 | Stale code refs after reindex | **Use `qualified_name`** in `doc_code_refs` (same as `mem_links`). Resolve to `node_id` at query time. | `qualified_name` is stable across reindex. If a symbol is renamed/deleted, the link becomes stale — cleaned up by `kirograph docs lint`. |
| D8 | Context window pressure from docs in `kirograph_context` | **Opt-in, disabled by default.** If enabled, user chooses the section cap during install. Only surfaces doc sections when `docsContextLimit > 0`. | Unlike memory (where 3 observations is always useful), doc sections can be large and varied. A wrong cap could flood context or miss critical docs. Let the user decide based on their project's doc density. |
| D9 | Embedding model mismatch | **Fall back to FTS-only** if `doc_sections` embeddings don't match current model. Provide `kirograph docs reembed`. | Same pattern as memory. No crashes, graceful degradation. |
| D10 | Concurrency (MCP + CLI writing) | **Rely on existing WAL mode + busy_timeout.** Content hash deduplication on sections. | Same as memory. SQLite WAL handles concurrent access safely. |

---

## Implementation Order

| Step | Deliverable | Depends On |
|------|-------------|------------|
| 1 | `src/docs/types.ts` — type definitions | — |
| 2 | `src/docs/section-id.ts` — stable ID generation | Step 1 |
| 3 | `src/docs/formats/markdown.ts` — Markdown parser | Step 1 |
| 4 | `src/docs/formats/index.ts` — format registry | Step 3 |
| 5 | DB schema: `doc_sections`, `doc_code_refs` tables + migration | Step 1 |
| 6 | Config: `enableDocs` + validation + defaults | — |
| 7 | `src/docs/indexer.ts` — orchestrator (scan → parse → persist) | Steps 2–6 |
| 8 | `src/docs/queries.ts` — read helpers for MCP tools | Steps 5, 7 |
| 9 | MCP tools: `kirograph_docs_toc`, `kirograph_docs_section`, `kirograph_docs_outline` | Steps 7, 8 |
| 10 | Installer: `config-prompt.ts` toggle + `ConfigPatch` + `installLate` | Step 6 |
| 11 | CLI: `src/bin/commands/docs.ts` (toc, section, outline) | Steps 7, 8 |
| 12 | Sync pipeline integration | Step 7 |
| 13 | Naive cost heuristics + token tracker `'docs'` source | Step 9 |
| 14 | `KIROGRAPH_TOOL_NAMES` + `autoApprove` + steering update | Steps 9, 10 |
| 15 | FTS index on `doc_sections` + `kirograph_docs_search` tool + CLI | Steps 5, 8 |
| 16 | Additional format parsers (RST, AsciiDoc, RDoc, Org, HTML, plaintext) | Step 4 |
| 17 | Embeddings: embed section titles/summaries + local summarization | Steps 7, 8 |
| 18 | `src/docs/linker.ts` — code ↔ doc cross-reference detection | Steps 5, 7 |
| 19 | `kirograph_docs_refs` tool + CLI | Step 18 |
| 20 | Enrich `kirograph_context` with doc sections (capped, threshold) | Steps 8, 18 |
| 21 | OpenAPI parser + drift detection + tree mode | Steps 4, 7 |
| 22 | `kirograph docs lint` + `kirograph docs reembed` | Steps 7, 17, 18 |
| 23 | Architecture layer assignment + memory integration | Steps 7, 12 |
| 24 | Tests (unit + integration + regression) | All |
| 25 | Documentation: README, CHANGELOG, docs/, help, steering | All |

---

## File Structure

```
src/docs/
├── types.ts              # DocSection, DocCodeRef, DocSearchResult, DocIndexResult
├── section-id.ts         # generateSectionId(), slugify(), buildAncestorChain()
├── indexer.ts            # DocsIndexer — scan, parse, persist, incremental re-index
├── linker.ts             # detectCodeRefs() — backtick patterns, import paths, heading→symbol
├── queries.ts            # getSection(), getToc(), getOutline(), searchSections(), getRefs()
├── summarizer.ts         # extractiveSummary() — sentence scoring via embedding model
├── formats/
│   ├── index.ts          # FormatRegistry — extension → parser dispatch
│   ├── markdown.ts       # .md, .mdx, .cheatmd — ATX + setext headings
│   ├── rst.ts            # .rst — adornment-based heading detection
│   ├── asciidoc.ts       # .adoc, .asciidoc — = heading hierarchy
│   ├── rdoc.ts           # .rdoc — Ruby doc format (= headings)
│   ├── org.ts            # .org — Org-mode (* headings)
│   ├── html.ts           # .html, .htm — <h1>–<h6>
│   ├── openapi.ts        # .yaml/.json — operations grouped by tag (Phase 4)
│   └── plaintext.ts      # .txt — paragraph-block splitting
└── lint.ts               # docsLint() — broken refs, stale sections, FTS desync

src/bin/commands/
└── docs.ts               # CLI: kirograph docs {toc,search,section,outline,refs,reindex,lint,reembed}
```

---

## Testing & Validation

### Unit Tests

- `src/docs/section-id.test.ts` — ID generation determinism, slug stability, ancestor chain building
- `src/docs/formats/markdown.test.ts` — ATX headings, setext headings, nested hierarchy, byte offsets, edge cases (empty headings, code blocks with `#`)
- `src/docs/formats/rst.test.ts` — adornment detection, level inference
- `src/docs/formats/asciidoc.test.ts` — `=` hierarchy parsing
- `src/docs/formats/org.test.ts` — `*` hierarchy parsing
- `src/docs/linker.test.ts` — backtick detection, import path matching, false positive filtering
- `src/docs/summarizer.test.ts` — sentence scoring, first-sentence fallback, empty content handling
- `src/docs/indexer.test.ts` — scan, parse, persist, incremental update, content hash drift

### Integration Tests

- Full write path: file on disk → parse → sections in DB → embeddings → code refs
- Full read path: query → FTS + vector hybrid → ranked sections returned
- `kirograph_context` with docs enrichment (capped at 3 sections, 500 tokens)
- Sync pipeline: modify a doc file → `kirograph sync` → sections updated, stale removed
- Installer: toggle `enableDocs` → verify tools are registered/gated correctly
- CLI: all 6 commands produce expected output

### Regression Tests

- Run existing test suite with `enableDocs: false` — zero behavior change
- Run existing test suite with `enableDocs: true` — no interference with core graph operations
- Verify `kirograph index --force` does NOT drop `doc_*` tables (same as `mem_*` survival)
- Verify `kirograph uninit` prompts separately for doc data

---

## Token Savings Analysis

### How kirograph_gain works today

Every MCP tool call is tracked against a **naive cost estimate** — what the agent would have spent doing the same work without kirograph (reading files, running grep, etc.). The formula:

```
savings = naive_cost - actual_output_tokens
```

Constants used:
- `AVG_FILE_TOKENS = 1500` (medium source file ~200 lines)
- `AVG_GREP_TOKENS = 800` (grep result across a medium project)
- `AVG_FIND_TOKENS = 2000` (ls -R or find output)

Token estimation: `1 token ≈ 4 characters` (no external tokenizer needed).

### Token savings from docs tools

Without the docs module, an agent navigating documentation must:
1. **Read entire files** — a typical `README.md` is 200–500 lines (~1500–4000 tokens). A `docs/` folder with 10 files is 15,000–40,000 tokens.
2. **Grep for keywords** — returns noisy results with no structural context.
3. **Re-read the same files** across sessions — no memory of what was already explored.

With the docs module, the agent retrieves **only the section it needs** — typically 50–200 tokens for a heading + summary, or 200–800 tokens for a full section.

### Naive cost heuristics for docs tools

Add to `src/compression/naive-cost.ts`:

```typescript
/** Average tokens in a documentation file (README, guide, etc.) */
const AVG_DOC_FILE_TOKENS = 2500;

case 'kirograph_docs_toc': {
  // Agent would read all doc files to understand structure
  // Conservative: 3-5 doc files fully read
  return AVG_DOC_FILE_TOKENS * 4;
}

case 'kirograph_docs_search': {
  // Agent would grep across all doc files + read top matches
  const limit = (args?.limit as number) || 10;
  const filesEstimate = Math.min(Math.ceil(limit / 2), 5);
  return AVG_GREP_TOKENS + filesEstimate * AVG_DOC_FILE_TOKENS;
}

case 'kirograph_docs_section': {
  // Agent would read the full file to find the relevant section
  // With context=true, agent would also read parent/child files
  const withContext = args?.context as boolean;
  return withContext ? AVG_DOC_FILE_TOKENS * 2 : AVG_DOC_FILE_TOKENS;
}

case 'kirograph_docs_outline': {
  // Agent would read the full file to understand its structure
  return AVG_DOC_FILE_TOKENS;
}

case 'kirograph_docs_refs': {
  // Agent would grep for symbol names across docs + read code files
  // Or grep for doc references in code files
  return AVG_GREP_TOKENS * 3 + AVG_DOC_FILE_TOKENS * 2;
}
```

### Expected savings per tool call

| Tool | Naive cost (tokens) | Typical output (tokens) | Savings |
|------|--------------------:|------------------------:|--------:|
| `kirograph_docs_toc` | ~10,000 | ~400–800 | **92–96%** |
| `kirograph_docs_search` | ~8,000–13,000 | ~300–600 | **93–97%** |
| `kirograph_docs_section` | ~2,500 | ~200–800 | **68–92%** |
| `kirograph_docs_outline` | ~2,500 | ~200–400 | **84–92%** |
| `kirograph_docs_refs` | ~7,400 | ~300–500 | **93–96%** |

These are conservative estimates. For projects with large documentation sets (e.g., a framework with 50+ doc files), the savings are dramatically higher — a full TOC scan without kirograph would cost 50,000+ tokens.

### Savings in kirograph_context (enriched with docs)

When `docsContextLimit > 0` (user opted in during install), `kirograph_context` includes relevant doc section summaries alongside code context. The naive cost for this enrichment:

```typescript
// In the existing kirograph_context case, add:
// If docs context is enabled, agent would also need to grep docs for the symbol
// and read matching doc files to understand the documented behavior.
// Add 2-3 doc file reads to the naive cost.
const docsEnrichmentCost = (docsContextLimit > 0) ? AVG_DOC_FILE_TOKENS * 2 : 0;
return filesEstimate * AVG_FILE_TOKENS + docsEnrichmentCost;
```

When `docsContextLimit: 0` (default), no enrichment cost is added — the agent uses `kirograph_docs_*` tools explicitly, and those have their own naive cost tracking.

### Cumulative impact

For a typical coding session where an agent consults documentation 5–10 times:
- **Without docs module**: 25,000–100,000 tokens spent reading doc files
- **With docs module**: 2,000–6,000 tokens for precise section retrieval
- **Session savings**: 23,000–94,000 tokens (~90% reduction on doc access)

These savings are tracked by `kirograph_gain` and reported in the `bySource` breakdown as a new `docs` source category.

---

## Additional Implementation Gains

### 1. Doc-aware context building (opt-in)

When `docsContextLimit > 0`, `kirograph_context` returns not just code symbols but also:
- The doc section that *documents* the function the agent is about to modify
- The ADR that explains *why* the architecture is the way it is
- The migration guide section relevant to the change being made

This means the agent gets **intent + implementation** in a single tool call instead of needing separate doc exploration. Disabled by default to avoid unwanted noise — the user opts in during install and chooses how many sections to include.

### 2. Stale docs detection

Because we store `content_hash` for each section and cross-reference to code symbols, we can detect when:
- A function's signature changed but its doc section didn't update
- A doc section references a symbol that no longer exists (broken reference)
- A new public API was added with no corresponding documentation

This could power a `kirograph_docs_stale` tool or be surfaced in `kirograph_status`.

### 3. Doc coverage metrics

Similar to code coverage, we can report:
- What percentage of public functions/classes have corresponding doc sections
- Which packages have no documentation at all
- Which doc sections reference no code (potentially outdated)

Useful for `kirograph_architecture` output and for teams that care about documentation quality.

### 4. Section-level embeddings for smarter search

Because sections are semantically coherent units (unlike arbitrary chunks), embedding them produces higher-quality vectors. An agent searching for "how to configure authentication" gets the exact configuration section, not a random chunk that happens to contain the word "auth".

### 5. Memory + docs synergy

When `enableMemory` is active, the agent's doc exploration patterns are captured:
- "Agent consulted `docs/auth.md::oauth/token-refresh#3` while fixing the token expiry bug"
- Next session, `kirograph_context` can proactively surface that section when the agent works on related code

### 6. Gain tool enhancement — new `docs` source category

Update `TokenTracker` and `kirograph_gain` to report docs savings separately:

```
Token Savings (session):
  Total calls: 47
  Tokens without KiroGraph: ~142,000
  Tokens with KiroGraph:    ~18,500
  Saved: 123,500 tokens (87%)

By source:
  Graph tools: 22 calls, ~48,000 tokens saved (vs file reads/grep)
  Docs tools:  12 calls, ~62,000 tokens saved (vs reading full doc files)
  Compression: 8 calls, ~9,500 tokens saved (vs raw output)
  Memory: 5 calls, ~4,000 tokens saved (vs re-discovering context)
```

---

## Naming Convention

All public-facing references use `kirograph_docs` (MCP) or `kirograph docs` (CLI):

| Layer | Naming |
|-------|--------|
| MCP tools | `kirograph_docs_toc`, `kirograph_docs_search`, `kirograph_docs_section`, `kirograph_docs_outline`, `kirograph_docs_refs` |
| CLI commands | `kirograph docs toc`, `kirograph docs search`, `kirograph docs section`, `kirograph docs outline`, `kirograph docs refs`, `kirograph docs reindex`, `kirograph docs lint`, `kirograph docs reembed` |
| Config keys | `enableDocs`, `docsInclude`, `docsExclude`, `docsLinkCode`, `docsContextLimit`, `docsContextThreshold`, `docsMaxFileSize`, `docsSummarization` |
| DB tables | `doc_sections`, `doc_code_refs` |
| Internal module | `src/docs/` |
| Token tracker source | `'docs'` |

