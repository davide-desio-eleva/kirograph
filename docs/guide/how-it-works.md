# How It Works

## Indexing Layers

Indexing has five layers: **structural** (always on), **semantic** (opt-in), **architecture** (opt-in), **documentation** (opt-in), and **data** (opt-in).

### Structural indexing

tree-sitter parses every source file into an AST. Nodes and edges are extracted and written to `kirograph.db`. This is what powers all graph traversal tools (`kirograph_callers`, `kirograph_impact`, `kirograph_path`, etc.) and exact/FTS symbol search.

This layer has no extra dependencies and runs on every `kirograph index` or `kirograph sync`.

### Semantic indexing (opt-in)

When `enableEmbeddings: true` is set, KiroGraph additionally generates 768-dimensional vector embeddings for every embeddable symbol (`function`, `method`, `class`, `interface`, `type_alias`, `component`, `module`) using the `nomic-ai/nomic-embed-text-v1.5` model (~130MB, downloaded once to `~/.kirograph/models/`).

These embeddings power natural-language search in `kirograph_context` and act as a fallback in `kirograph_search`. The embeddings are stored in the **semantic engine** of your choice:

| Engine | Store | Search type | Extra deps |
|--------|-------|-------------|------------|
| `cosine` *(default)* | `kirograph.db` (`vectors` table) | Exact cosine, linear scan | none |
| `sqlite-vec` | `.kirograph/vec.db` | ANN (approximate), sub-linear | `better-sqlite3`, `sqlite-vec` (native) |
| `orama` | `.kirograph/orama.json` | Hybrid (full-text + vector) | `@orama/orama`, `@orama/plugin-data-persistence` |
| `pglite` | `.kirograph/pglite/` | Hybrid (full-text + vector), exact | `@electric-sql/pglite` (WASM) |
| `lancedb` | `.kirograph/lancedb/` | ANN (approximate), sub-linear | `@lancedb/lancedb` (pure JS) |
| `qdrant` | `.kirograph/qdrant/` | ANN (HNSW), sub-linear | `qdrant-local` (embedded binary) |
| `typesense` | `.kirograph/typesense/` | ANN (HNSW), sub-linear | `typesense` (auto-downloaded binary) |

Each engine owns its embedding store exclusively; nothing is written to the SQLite `vectors` table when a non-cosine engine is active. If an engine's optional dependency is not installed, KiroGraph silently falls back to `cosine`.

Enable and configure via `kirograph install` (interactive arrow-key menu) or directly in `.kirograph/config.json`:

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "pglite"
}
```

### Architecture analysis (opt-in)

When `enableArchitecture: true` is set, KiroGraph detects the high-level structure of your project (packages and architectural layers) and computes coupling metrics between them. Results are stored in `arch_*` tables inside `kirograph.db` and exposed via dedicated MCP tools and CLI commands.

Enable via `kirograph install` or directly in `.kirograph/config.json`:

```json
{
  "enableArchitecture": true
}
```

See the [Configuration — Architecture Analysis](configuration.md#architecture-analysis) section for full details.

### Memory (opt-in)

When `enableMemory: true` is set, KiroGraph stores persistent observations across sessions — decisions, errors, patterns, and architecture notes. Inspired by [cavemem](https://github.com/JuliusBrussee/cavemem) by [Julius Brussee](https://www.linkedin.com/in/julius-brussee/). Observations are:

- **Compressed** with the caveman grammar (if caveman mode is enabled) — deterministic, no LLM tokens spent
- **Linked to code symbols** — identifiers in observation text are matched against the graph and stored as stable `qualified_name` references
- **Embedded** with the configured semantic engine — enabling natural-language search over past observations
- **Deduplicated** — SHA-256 content hash prevents storing the same observation twice

Memory surfaces automatically in `kirograph_context` and `kirograph_impact` results when relevant observations are linked to the symbols being queried. The agent can also search memory directly via `kirograph_mem_search` or store new observations via `kirograph_mem_store`.

Zero LLM tokens on write. ~150-350 tokens per search (vs ~2000-5000 tokens to re-discover context by reading files).

```json
{
  "enableMemory": true
}
```

### Watchmen (opt-in)

When `enableWatchmen: true` is set (requires `enableMemory: true`), KiroGraph automatically signals the active AI agent to synthesize accumulated memory observations into workspace brief files. Inspired by [watchmen](https://github.com/firstbatchxyz/watchmen) by [firstbatch](https://github.com/firstbatchxyz).

After each `kirograph_mem_store` call, KiroGraph counts non-summary observations created since the last `kind: 'summary'`. When the count reaches `watchmenThreshold` (default: 5), the response includes a `watchmenReady` flag with synthesis instructions and a `targetFiles` list. The active AI agent then:

1. Calls `kirograph_mem_search` for each observation kind
2. Synthesizes patterns into a structured workspace brief
3. Writes or updates the brief in each file listed in `targetFiles`
4. Stores a `kind: 'summary'` observation to reset the counter

Target file per installed tool:

| Tool | File written |
|------|-------------|
| Kiro | `.kiro/steering/kirograph-watchmen.md` (`inclusion: always`) |
| Claude Code | `CLAUDE.md` (`## KiroGraph Watchmen` section) |
| Codex, Copilot CLI, Devin, Goose, Warp, Roo, OpenHands, Replit, Junie | `AGENTS.md` |
| Gemini CLI / AntiGravity | `GEMINI.md` |
| Aider | `CONVENTIONS.md` |
| Augment | `augment-guidelines.md` |
| Rules-based tools (Cursor, Cline, Windsurf…) | `AGENTS.md` fallback |

Zero LLM tokens spent by KiroGraph — synthesis is done entirely by the active AI agent using its own intelligence and the existing `kirograph_mem_search` tool.

```json
{
  "enableMemory": true,
  "enableWatchmen": true,
  "watchmenThreshold": 5
}
```

### Documentation indexing (opt-in)

When `enableDocs: true` is set, KiroGraph indexes project documentation by heading hierarchy and section structure. Instead of reading entire doc files, agents retrieve exactly the section they need via stable section IDs. Inspired by [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/).

- **9 format parsers**: Markdown, MDX, reStructuredText, AsciiDoc, RDoc, Org-mode, HTML, plain text, OpenAPI/Swagger
- **Code ↔ docs cross-references**: Backtick references, CamelCase identifiers, and snake_case patterns in docs are resolved against the code graph
- **Section-level FTS search**: Independent from code search (`kirograph_docs_search`)
- **Stable section IDs**: `{file_path}::{ancestor-chain/slug}#{level}` — stable across re-indexing
- **Token savings**: 92–97% reduction vs reading full doc files (tracked in `kirograph_gain`)

```json
{
  "enableDocs": true
}
```

### Data indexing (opt-in)

When `enableData: true` is set, KiroGraph indexes tabular data files (CSV, TSV, JSONL, JSON, Excel, Parquet) that live alongside your code — test fixtures, seed data, configuration tables, sample datasets. Inspired by [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/).

- **Streaming parser**: never loads full files into memory. Processes line-by-line (CSV/JSONL) or in chunks (Excel/Parquet)
- **Column profiling**: type inference, cardinality, null percentages, min/max, sample values
- **Server-side computation**: filters, aggregations, and joins run in SQLite. Only results enter the context window
- **Incremental**: content hash (SHA-256) skips unchanged files on re-index
- **Token savings**: 95–99% reduction vs reading raw data files (tracked in `kirograph_gain`)
- **Optional format deps**: CSV/TSV/JSONL/JSON are built-in (zero deps). Excel requires `xlsx`, Parquet requires `parquetjs-lite`

```json
{
  "enableData": true
}
```

## Index Freshness

The index is kept fresh automatically via a Kiro hook (`agentStop`) — no background watcher process needed. A single hook triggers at the end of each agent session and syncs any changed files in one pass.
