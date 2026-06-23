# MCP Tools

All tools are auto-approved in Kiro once installed. Other MCP clients can use the same tools after configuring their respective targets.

## `kirograph_context`

PRIMARY TOOL: Build comprehensive context for a task or feature request. Returns entry points, related symbols, and key code — often enough to understand the codebase without additional tool calls.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | string | required | Task, bug, or feature description |
| `maxNodes` | number | 20 | Max symbols to include |
| `detail` | string | `full` | Code verbosity: `full` (complete source), `signatures` (signature + docstring, ~70% fewer tokens), `summary` (locations only, no code) |
| `includeCode` | boolean | true | Include code snippets — deprecated, prefer `detail` |
| `projectPath` | string | cwd | Project root path |

**How it works:** Extracts symbol tokens from the task description (CamelCase, snake_case, SCREAMING_SNAKE, dot.notation) → runs exact name lookup + FTS + **vector search** against the active semantic engine → resolves imports to their definitions → expands through the graph to related symbols → returns entry points, related nodes, edges, and code snippets. This is the only tool that uses the vector engine on every call.

## `kirograph_search`

Quick symbol search by name. Returns locations only, no code.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Symbol name or partial name |
| `kind` | string | - | Filter: `function`, `method`, `class`, `interface`, `type_alias`, `variable`, `route`, `component` |
| `limit` | number | 10 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** Exact name match → SQLite FTS → LIKE fallback → **vector search** only if all three return nothing. Pure graph database lookup in the common case; vector engine only as a last resort.

## `kirograph_callers`

Find all functions/methods that call a specific symbol.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS traversal of incoming `call` edges in the graph database; no vector engine involved.

## `kirograph_callees`

Find all functions/methods that a specific symbol calls.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS traversal of outgoing `call` edges in the graph database; no vector engine involved.

## `kirograph_impact`

Analyze what code would be affected by changing a symbol. Use before making changes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `depth` | number | 2 | Traversal depth |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS traversal of all incoming edges (`call`, `import`, `reference`, etc.) up to the specified depth; no vector engine involved.

## `kirograph_node`

Get details about a specific symbol, optionally including its source code.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `detail` | string | `summary` | Code detail level: `summary` (name + location + qualified name), `signatures` (+ signature + docstring), `full` (+ complete source code) |
| `includeCode` | boolean | false | Include full source code — deprecated, prefer `detail: "full"` |
| `projectPath` | string | cwd | Project root path |

Returns: kind, name, qualified name, file location, and (depending on `detail`) signature, docstring, and source code.

## `kirograph_type_hierarchy`

Traverse the type hierarchy of a class or interface.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Class or interface name |
| `direction` | string | `both` | `up` (base types), `down` (derived types), `both` |
| `projectPath` | string | cwd | Project root path |

## `kirograph_path`

Find the shortest path between two symbols in the dependency graph.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | string | required | Source symbol name |
| `to` | string | required | Target symbol name |
| `projectPath` | string | cwd | Project root path |

## `kirograph_dead_code`

Find symbols with no incoming references (potential dead code). Only unexported symbols are considered.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

## `kirograph_circular_deps`

Find circular import dependencies in the codebase.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

## `kirograph_files`

List the indexed file structure with filtering and format options.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filterPath` | string | - | Filter by directory prefix (e.g., `src/`) |
| `pattern` | string | - | Filter by glob pattern (e.g., `**/*.ts`) |
| `maxDepth` | number | - | Limit tree depth |
| `format` | string | `tree` | `tree`, `flat`, or `grouped` |
| `includeMetadata` | boolean | true | Include language and symbol counts |
| `projectPath` | string | cwd | Project root path |

## `kirograph_status`

Check index health and statistics: files indexed, symbol count, edge count, breakdown by kind and language, frameworks detected, database size, and semantic search status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

## `kirograph_hotspots`

Find the most-connected symbols by total edge degree (incoming + outgoing). Excludes structural `contains` edges.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

## `kirograph_surprising`

Find non-obvious cross-file connections: direct edges between symbols in structurally distant files.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** Queries all cross-file edges (excluding `contains` and `import`). Scores each by path distance between source and target files × edge-kind weight (`calls=1.0`, `references=0.8`, `type_of=0.7`, etc.). Returns the highest-scoring unique pairs.

## `kirograph_diff`

Compare the current graph state against a saved snapshot. Shows added/removed symbols and edges.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `snapshot` | string | latest | Snapshot label. Omit to use the most recent saved snapshot. |
| `projectPath` | string | cwd | Project root path |

## `kirograph_exec`

Run a shell command and return token-optimized output. Automatically filters noise from git, test runners, linters, build tools, docker, and package managers.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `command` | string | required | Shell command to execute |
| `cwd` | string | project root | Working directory |
| `level` | string | `normal` | Compression level: `normal`, `aggressive`, `ultra` |
| `timeout` | number | 60 | Timeout in seconds |
| `projectPath` | string | cwd | Project root path |

## `kirograph_gain`

Show token savings statistics from compressed command outputs.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | string | `session` | Time period: `session`, `today`, `week`, `all` |
| `projectPath` | string | cwd | Project root path |

---

## Agent Utilities *(require `enableAgentUtils: true`)* — 4 tools · ~278 tok

### `kirograph_read`

Read a file with caching and multiple modes. First read returns full content; subsequent reads of unchanged files return a compact `[cached: file unchanged]` marker (~13 tokens). Inspired by [lean-ctx](https://github.com/yvgude/lean-ctx).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | required | File path (absolute or relative to project root) |
| `mode` | string | `full` | `full`, `map` (structure overview), `signatures` (function signatures only), `diff` (changes since last read), `lines` (line range), `imports`, `exports` |
| `start` | number | - | Start line (for `lines` mode) |
| `end` | number | - | End line (for `lines` mode) |
| `noCache` | boolean | false | Force fresh read, bypass cache |
| `projectPath` | string | cwd | Project root path |

### `kirograph_retrieve`

CCR — Cached Content Retrieval. Returns the full content stored in the session cache, or reads and caches the file if not yet seen. Use after `kirograph_read` returns a `[cached: file unchanged]` marker to recover the actual content without a redundant filesystem read. Inspired by [headroom](https://github.com/chopratejas/headroom).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | required | File path to retrieve |
| `projectPath` | string | cwd | Project root path |

### `kirograph_budget`

Show current session context budget usage. Returns tokens consumed, remaining budget, and utilization percentage. Inspired by [lean-ctx](https://github.com/yvgude/lean-ctx).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `reset` | boolean | false | Reset session budget counters |
| `projectPath` | string | cwd | Project root path |

---

## General-purpose Compression *(require `enableGeneralCompression: true`)* — 1 tool · ~68 tok

### `kirograph_compress`

On-demand compression for arbitrary text before it reaches the model. Routes to two engines based on whether `command` is provided. Reports savings inline: `[42% tokens saved | 1800→1044 | rtk:git:aggressive]`. Inspired by [headroom](https://github.com/chopratejas/headroom).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | string | required | Text to compress |
| `command` | string | - | Shell command that produced this output (e.g. `git log`, `npm test`). Activates rtk-style structural filters. Omit for prose/text — uses caveman grammar. |
| `level` | string | `full` | Intensity: `lite` / `normal` (light), `full` / `aggressive` (medium, default), `ultra` (maximum) |

**Engine routing:**
- **With `command`**: rtk-style structural filters — pattern-matched per command family (git, npm, jest, docker, AWS, …), removes noise lines, deduplicates repeated lines, groups results
- **Without `command`**: caveman grammar — strips filler words, articles, hedging phrases; at `ultra` also abbreviates common phrases. Preserves code blocks, paths, URLs, and identifiers.

**When to use:**
- Text arrived outside of `kirograph_exec` (e.g. from a tool that runs commands directly)
- Compressing an observation before storing it to memory
- Explicitly comparing compressed vs original before a follow-up tool call

**When not to use:**
- Commands run via `kirograph_exec` — already compressed automatically
- Agent prose — use `cavemanMode` in config instead (zero tool-call overhead)
- Source code — may break identifiers or whitespace-sensitive syntax

---

## Architecture Tools *(require `enableArchitecture: true`)* — 3 tools · ~142 tok

### `kirograph_architecture`

Get the full architecture overview: detected packages, layers, and the dependency graph between them.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `level` | string | `both` | `packages`, `layers`, or `both` |
| `includeFiles` | boolean | false | Include per-file package/layer assignments |
| `projectPath` | string | cwd | Project root path |

### `kirograph_coupling`

Get coupling metrics for all packages or a specific one.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sortBy` | string | `instability` | Sort: `instability`, `afferent`, `efferent` |
| `limit` | number | 20 | Max results |
| `projectPath` | string | cwd | Project root path |

Returns per-package: **Ca** (afferent), **Ce** (efferent), and **instability** (`Ce / (Ca + Ce)`).

### `kirograph_package`

Inspect the files and dependencies of a specific package.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `package` | string | required | Package name or path (partial match accepted) |
| `includeFiles` | boolean | true | List files in the package |
| `projectPath` | string | cwd | Project root path |

---

## Memory Tools *(require `enableMemory: true`)* — 16 tools · ~746 tok

### `kirograph_mem_search`

Search project memory for past decisions, errors, patterns, and context.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Natural language search query |
| `kind` | string | - | Filter: `decision`, `error`, `pattern`, `architecture`, `summary`, `note` |
| `limit` | number | 10 | Max results |
| `sessionId` | string | - | Filter to specific session |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_store`

Store an observation in project memory.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | required | Observation text |
| `kind` | string | `note` | `decision`, `error`, `pattern`, `architecture`, `summary`, `note` |
| `projectPath` | string | cwd | Project root path |

**Normal response:**
```json
{ "id": "obs_abc123" }
```

**Watchmen response** (when `enableWatchmen: true` and threshold is met):

When enough observations have accumulated since the last `kind: 'summary'`, the response includes additional fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The observation ID as usual |
| `watchmenReady` | `true` | Present only when synthesis should run |
| `pendingCount` | number | Observations since last `kind: 'summary'` |
| `message` | string | Synthesis instructions for the agent |
| `targetFiles` | string[] | Project-relative paths to write the workspace brief to, based on installed targets |
| `skillTargetDir` | string? | Present only when Kiro is detected (`.kiro/` exists). Path to the steering directory for individual `inclusion: manual` skill files (`watchmen-<slug>.md`). Absent for non-Kiro targets — embed procedures in the brief instead. |

On receiving `watchmenReady: true`, the agent should: (1) call `kirograph_mem_search` for each kind, (2) write the workspace brief to each file in `targetFiles`, (3) if `skillTargetDir` is present write separate `watchmen-<slug>.md` skill files for recurring procedures, otherwise embed a `## Recurring Procedures` section in the brief, (4) store a `kind: 'summary'` observation to reset the counter.

### `kirograph_mem_timeline`

List recent sessions and their observations chronologically.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 5 | Number of sessions to show |
| `sessionId` | string | - | Show observations for a specific session |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_status`

Memory subsystem health: session count, observations, embedding coverage, model mismatch detection, relations count and pending conflicts.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_review`

List observations past their `review_after` date — stale facts the agent should re-evaluate, update, or supersede. Reports days overdue.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Max results |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_mark_reviewed`

Mark an observation as reviewed — clears its `review_after` date, removing it from the review queue.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | required | Observation ID |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_compare`

Establish a typed relation between two observations. Accepts observation IDs or `topic_key` values. Creates a `pending` relation for agent review via `kirograph_mem_judge`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `observationA` | string | required | First observation ID or topic_key |
| `observationB` | string | required | Second observation ID or topic_key |
| `relation` | string | required | `supersedes`, `conflicts_with`, `compatible`, `scoped`, `related`, `not_conflict` |
| `confidence` | number | 1.0 | Confidence 0.0–1.0 |
| `reason` | string | - | Explanation for the relation |
| `evidence` | string | - | Supporting evidence text |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_judge`

Finalize a pending conflict relation — confirm, revise, or dismiss it. Changes `judgment_status` from `pending` to `judged`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `relationId` | string | required | Relation ID (from `kirograph_mem_compare`) |
| `relation` | string | required | Final relation type |
| `confidence` | number | required | Final confidence 0.0–1.0 |
| `reason` | string | - | Reasoning for judgment |
| `evidence` | string | - | Supporting evidence |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_capture`

Extract and store structured learnings from a freeform text block. Looks for `## Key Learnings`, `## Observations`, `## Decisions`, `## Key Changes` sections and saves each bullet as a separate typed observation. Pure structural parser — no LLM.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | required | Text block with structured sections |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_save_prompt`

Save the current user prompt to session memory for context reconstruction.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | required | Prompt content to save |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_suggest_topic_key`

Suggest a stable `topic_key` for an observation based on its kind and content. Returns a deterministic slug like `"architecture/auth-model"`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `kind` | string | required | `decision`, `error`, `pattern`, `architecture`, `summary`, `note` |
| `title` | string | required | Short title or first sentence of the observation |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_conflicts_scan`

Scan recent observations for potential conflicts using FTS similarity. Returns candidate pairs that may need a relation established via `kirograph_mem_compare`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max observations to scan |
| `projectPath` | string | cwd | Project root path |

---

## Documentation Tools *(require `enableDocs: true`)* — 5 tools · ~241 tok

### `kirograph_docs_toc`

Get table of contents for a documentation file or the whole project.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `file` | string | - | Filter to a specific doc file. Omit for project-wide TOC. |
| `tree` | boolean | false | Return nested tree structure |
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_search`

Search documentation sections by query.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query (natural language or keywords) |
| `file` | string | - | Narrow search to a specific doc file |
| `limit` | number | 10 | Max results |
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_section`

Retrieve full content of a documentation section by its stable ID.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | required | Section ID (from `kirograph_docs_toc` or `kirograph_docs_search`) |
| `context` | boolean | false | Include ancestor heading chain and child summaries |
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_outline`

Get the heading hierarchy for a single documentation file.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `file` | string | required | Relative path to the doc file |
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_refs`

Find code symbols referenced by a doc section, or doc sections that reference a code symbol.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sectionId` | string | - | Doc section ID (find code symbols it references) |
| `nodeId` | string | - | Code symbol qualified name (find doc sections that reference it) |
| `projectPath` | string | cwd | Project root path |

---

## Data Tools *(require `enableData: true`)* — 10 tools · ~519 tok

### `kirograph_data_list`

List all indexed datasets with row counts, column counts, and file sizes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_describe`

Full schema profile for a dataset: column names, inferred types, cardinality, null percentages, min/max values, and sample values.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID (from `kirograph_data_list`) |
| `column` | string | - | Deep dive on a single column |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_query`

Filtered row retrieval with structured operators. Multiple filters are ANDed.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `filters` | Filter[] | - | Array of `{column, op, value}`. Ops: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `is_null`, `between` |
| `columns` | string[] | all | Column projection |
| `limit` | number | 500 | Max rows (hard cap: 500) |
| `offset` | number | 0 | Pagination offset |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_aggregate`

Server-side GROUP BY aggregation. Computation happens in SQLite; only results enter the context window.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `groupBy` | string[] | required | Columns to group by |
| `metrics` | Metric[] | required | Array of `{column, op}`. Ops: `count`, `sum`, `avg`, `min`, `max`, `count_distinct` |
| `filters` | Filter[] | - | Pre-aggregation filters |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_search`

Search column names and sample values by keyword within a dataset.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `query` | string | required | Search keyword |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_join`

SQL JOIN across two indexed datasets.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `left` | string | required | Left dataset ID |
| `right` | string | required | Right dataset ID |
| `leftColumn` | string | required | Join column from left dataset |
| `rightColumn` | string | required | Join column from right dataset |
| `type` | string | `inner` | Join type: `inner`, `left`, `right` |
| `columns` | string[] | all | Column projection (prefix with dataset ID) |
| `limit` | number | 100 | Max rows (hard cap: 500) |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_correlations`

Pairwise Pearson correlations between numeric columns.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `threshold` | number | 0.3 | Min absolute correlation to include |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_quality`

Data quality triage: rank columns by composite risk score (null rate, cardinality anomalies, type issues).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `projectPath` | string | cwd | Project root path |

---

## Visual PDF Search *(require `enableVisualPDF: true`)* — 1 tool · ~200 tok base

> **⚠ Experimental.** This feature may change or be removed in future releases. Hardware requirements are significant — see [hardware requirements](installation.md#visual-pdf-search-hardware-requirements) before enabling.

### `kirograph_pdf_visual_search`

Semantic search over scanned PDFs and visually complex documents (multi-column, charts, mixed images and text) using [PixelRAG](https://github.com/StarTrail-org/PixelRAG) (Qwen3-VL-Embedding-2B + FAISS).

**When to use:** Only for queries about visual content in scanned PDFs, photographed documents, or PDFs with complex layouts. Do **not** use for source code, structured data, or normal text documents — use `kirograph_context` for those.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Natural language query about the visual content |
| `limit` | number | `3` | Max results to return (1–10) |
| `minTileHeight` | number | `50` | Min tile height in px — filters out tiny fragments |
| `projectPath` | string | cwd | Project root path |

**How it works:** Sends `query` to the local PixelRAG FastAPI server (`POST /search`) → FAISS IVFFlat search over Qwen3-VL-2B embeddings of rendered PDF tile images → returns ranked results.

**Token cost:** The tool response itself is ~200 tokens. Each result includes a `chunkImagePath` (absolute path to the rendered PNG tile). Reading a tile image costs **~1 500 tokens**. Read only the tiles the query actually requires.

**Response fields per result:**
- `score` — similarity score (higher = more relevant)
- `filePath` — absolute path to the source PDF
- `tileIndex` / `chunkIndex` — page and strip within the page
- `yOffset` / `chunkHeight` — vertical position and size in px
- `chunkImagePath` — absolute path to the rendered PNG tile

---

## Security Tools *(require `enableSecurity: true` and `enableArchitecture: true`)* — 15 tools · ~675 tok

### `kirograph_security`

Security overview: total dependencies, vulnerability counts, verdict breakdown (affected/not_affected/under_investigation), and stale data warnings.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

### `kirograph_vulns`

List vulnerabilities with filtering by severity and reachability verdict. Includes fix suggestions when a fixed version is available.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `severity` | string | - | Filter: `critical`, `high`, `medium`, `low` |
| `verdict` | string | - | Filter: `affected`, `not_affected`, `under_investigation` |
| `limit` | number | 20 | Max results |
| `refresh` | boolean | false | Trigger fresh enrichment from configured databases before listing |
| `projectPath` | string | cwd | Project root path |

**Example response:**

```
CVE-2023-44270 (7.5 HIGH) — postcss
  Verdict: affected
  Paths: 2 entry points reach this dependency
  Layers: api, service
  💡 Fix: npm install postcss@8.4.31
```

### `kirograph_sbom`

Generate a CycloneDX 1.5 SBOM JSON document containing all project dependencies as components with purl identifiers, scope classification, and dependency relationships.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

### `kirograph_vex`

Generate a CycloneDX 1.5 VEX JSON document with reachability-derived analysis states. Maps graph verdicts to CycloneDX VEX states: `affected` → "affected", `not_affected` → "not_affected" (justification: "code_not_reachable"), `under_investigation` → "under_investigation".

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

### `kirograph_reachability`

Analyze reachability for a specific CVE or dependency. Returns the verdict, shortest paths from each reaching entry point, unresolved symbols (if any), and impact summary (affected layers, entry points, distinct path count).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `target` | string | required | CVE identifier (e.g. `CVE-2024-1234`) or package name (e.g. `lodash`) |
| `projectPath` | string | cwd | Project root path |

**Example response:**

```
CVE-2024-1234 — lodash@4.17.20
  Verdict: affected
  Reaching entry points: 3
  Paths:
    POST /api/users → UserService.create → validateInput → lodash
    GET /api/users → UserService.list → formatResponse → lodash
    POST /api/auth → AuthController.login → sanitize → lodash
  Affected layers: api, service
  Distinct paths: 5
```

### `kirograph_vuln_add`

Manually register a CVE against a dependency. Creates a Vulnerability_Node linked to the matching Dependency_Node. Useful for private/internal advisories not in public databases.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cveId` | string | required | CVE identifier (e.g. `CVE-2024-9999`) |
| `package` | string | required | Package name (must match an existing indexed dependency) |
| `severity` | number | - | CVSS v3.1 base score (0.0–10.0) |
| `summary` | string | - | Human-readable description (truncated to 500 chars) |
| `fixedVersion` | string | - | Version that fixes the vulnerability |
| `projectPath` | string | cwd | Project root path |

## Advanced Security Tools *(require `enableSecurity: true`)*

### `kirograph_attack_surface`

Map all HTTP routes to reachable vulnerable dependencies. Shows route name, exposure level (public/authenticated/internal), hop count to vulnerable dependency, and risk score.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | - | Max routes to return |
| `publicOnly` | boolean | false | Return only public-facing routes |
| `projectPath` | string | cwd | Project root path |

### `kirograph_secrets`

Scan for 14 secret types (AWS keys, GitHub tokens, DB URLs, JWT, etc.) enriched with call-graph blast radius — shows which entry points reach each detected secret.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeTests` | boolean | false | Include test files in the scan |
| `severity` | string | - | Filter by severity: `critical`, `high`, `medium`, `low` |
| `projectPath` | string | cwd | Project root path |

### `kirograph_security_flows`

SAST-lite: detect SQL injection, dangerous eval/exec, unsafe deserialization, path traversal, and weak crypto. Each finding is tagged with an OWASP Top 10 (2021) category.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | - | Filter flow type: `sql`, `eval`, `deserialization`, `path-traversal`, `crypto` |
| `projectPath` | string | cwd | Project root path |

### `kirograph_supply_chain`

Supply chain health: OpenSSF Scorecard scores, maintainer count, abandoned package detection (>365 days inactive), and new package risk (<30 days old).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `threshold` | string | - | Minimum risk threshold to include: `low`, `medium`, `high`, `critical` |
| `refresh` | boolean | false | Re-query external sources before returning results |
| `projectPath` | string | cwd | Project root path |

### `kirograph_dep_confusion`

Detect dependency confusion: internal packages whose names exist in public registries (supply chain attack vector). Also detects typosquatting (Levenshtein distance ≤ 2 from popular packages).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

### `kirograph_remediation`

SLA tracking per CVE. Thresholds: critical=7 days, high=30 days, medium=90 days. Returns days open, days with fix available, and SLA status (ok/warning/overdue).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `overdueOnly` | boolean | false | Return only CVEs that have breached their SLA threshold |
| `projectPath` | string | cwd | Project root path |

### `kirograph_licenses`

List dependency licenses and check against the configured policy (`securityLicensePolicy`).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `policy` | boolean | false | Show only policy violations (deny/warn) |
| `projectPath` | string | cwd | Project root path |

### `kirograph_staleness`

Check dependency freshness — identifies packages significantly behind their latest published version. Supports npm, PyPI, crates.io, RubyGems, and Packagist registries.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `threshold` | number | 0.3 | Minimum staleness score (0.0–1.0) to include |
| `refresh` | boolean | false | Re-query registries before listing |
| `projectPath` | string | cwd | Project root path |

---

## Pattern Search Tools *(require `enablePatterns: true` and `@ast-grep/napi` installed)* — 3 tools · ~93 tok

These tools only appear in the MCP tool list when both conditions are met. When either is false, they are not registered and cannot be called.

### `kirograph_live_search`

Run a live AST structural pattern search across the indexed codebase. Finds code patterns that can't be expressed as symbol names or semantic queries.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pattern` | string | required | ast-grep inline pattern (e.g. `"eval($X)"`) |
| `language` | string | required | Language to search: `javascript`, `typescript`, `python`, `go`, `rust`, `java`, etc. |
| `limit` | number | 20 | Max results (max 100) |
| `projectPath` | string | cwd | Project root path |
