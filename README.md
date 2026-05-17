![KiroGraph terminal](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/logo.png)

# KiroGraph

![KiroGraph terminal](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/terminal.png)

Semantic code knowledge graph for [Kiro](https://kiro.dev) and MCP-capable coding agents: fewer tool calls, instant symbol lookups, 100% local.

Inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) by [colbymchenry](https://github.com/colbymchenry) for Claude Code, rebuilt natively for Kiro's MCP and hooks system.

## Why KiroGraph?

When you ask Kiro to work on a complex task, it explores your codebase using file reads, grep, and glob searches. Every one of those is a tool call, and tool calls consume context and slow things down.

KiroGraph gives Kiro a semantic knowledge graph that's pre-indexed and always up to date. Instead of scanning files to understand your code, Kiro queries the graph instantly: symbol relationships, call graphs, type hierarchies, impact radius — all in a single MCP tool call.

The result is fewer tool calls, less context used, and faster responses on complex tasks.

## What Gets Indexed?

KiroGraph uses [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to parse your source files into an AST and extract:

- **Nodes** — functions, methods, classes, interfaces, types, enums, variables, constants, routes, components, and more (24 node kinds total)
- **Edges** — calls, imports, exports, extends, implements, contains, references, instantiates, overrides, decorates, type_of, returns

Everything is stored in a local SQLite database (`.kirograph/kirograph.db`). **Nothing leaves your machine.** No API keys. No external services.

The index is kept fresh automatically via Kiro hooks when using the Kiro integration — no background watcher process needed.

## How Indexing Works

Indexing has three layers: **structural** (always on), **semantic** (opt-in), and **architecture** (opt-in).

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

Each engine owns its embedding store exclusively — nothing is written to the SQLite `vectors` table when a non-cosine engine is active. If an engine's optional dependency is not installed, KiroGraph silently falls back to `cosine`.

Enable and configure via `kirograph install` (interactive arrow-key menu) or directly in `.kirograph/config.json`:

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "pglite"
}
```

### Architecture analysis (opt-in)

When `enableArchitecture: true` is set, KiroGraph detects the high-level structure of your project — packages and architectural layers — and computes coupling metrics between them. Results are stored in `arch_*` tables inside `kirograph.db` and exposed via dedicated MCP tools and CLI commands.

Enable via `kirograph install` or directly in `.kirograph/config.json`:

```json
{
  "enableArchitecture": true
}
```

See the [Architecture Analysis](#architecture-analysis-opt-in-1) section below for full details.

## Installation

### From npm (not yet available on npm registry)

```bash
npm install -g kirograph
```

### From source

```bash
git clone https://github.com/davide-desio-eleva/kirograph.git
cd kirograph
npm install
npm run build
sudo npm install -g .
```

After building, the `kirograph` and `kg` commands are available globally.

### Verify

```bash
kirograph --version
```

## Uninstallation

### Remove from a project

```bash
kirograph uninit [path]                  # Remove .kirograph/ and Kiro integration files
kirograph uninit --target all --force    # Skip confirmation and clean all supported integration files
```

Without `--force`, KiroGraph asks separately whether to remove the selected tool integration files and whether to remove the shared `.kirograph/` data.

This can remove:
- `.kirograph/` — index database, snapshots, and export directory
- Kiro target: `.kiro/hooks/kirograph-*.json`, `.kiro/steering/kirograph.md`, `.kiro/agents/kirograph.json`
- Claude target: `kirograph` from `.mcp.json`, plus the KiroGraph import from `CLAUDE.md`
- Codex target: the generated KiroGraph block from `AGENTS.md`

### Remove the CLI globally

If installed from npm:

```bash
npm uninstall -g kirograph
```

If installed from source:

```bash
cd kirograph
npm uninstall -g .
```

## Quick Start

```bash
# In your project:
kirograph install                  # wire up Kiro MCP + hooks + steering + CLI agent
kirograph install --target claude  # wire up Claude Code MCP + project memory
kirograph install --target codex   # write Codex instructions and print MCP config
```

All targets share the same `.kirograph/` data. If the project is already initialized, installing another target only writes that tool's integration files and reuses the existing graph configuration.

Restart Kiro IDE, or switch to the `kirograph` agent in Kiro CLI. It will now use KiroGraph tools automatically.

Or using the short alias:

```bash
kg install
```

## How It Works

```
┌─────────────────────────────────────────┐
│                  Kiro                   │
│                                         │
│  "Fix the auth bug"                     │
│           │                             │
│           ▼                             │
│  kirograph_context("auth bug")          │
│           │                             │
└───────────┼─────────────────────────────┘
            ▼
┌───────────────────────────────────────────┐
│         KiroGraph MCP Server              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │  search  │ │ callers  │ │ context  │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘   │
│       └────────────┼────────────┘         │
│         SQLite Graph DB (.kirograph/)     │
└───────────────────────────────────────────┘
```

Kiro hooks mark the index dirty on every file save or create, then flush on agent idle — batching changes efficiently with no overhead during active editing.

## Using with Kiro

`kirograph install` or `kirograph install --target kiro` sets up four things in your Kiro workspace — all coexist, so you can switch between IDE and CLI freely:

### MCP Server (`.kiro/settings/mcp.json`)

Registers the KiroGraph MCP server. Used by both the IDE and the CLI agent:

```json
{
  "mcpServers": {
    "kirograph": {
      "command": "kirograph",
      "args": ["serve", "--mcp"],
      "autoApprove": [
        "kirograph_search", "kirograph_context", "kirograph_callers",
        "kirograph_callees", "kirograph_impact", "kirograph_node",
        "kirograph_status", "kirograph_files", "kirograph_dead_code",
        "kirograph_circular_deps", "kirograph_path", "kirograph_type_hierarchy",
        "kirograph_architecture", "kirograph_coupling", "kirograph_package",
        "kirograph_hotspots", "kirograph_surprising", "kirograph_diff"
      ]
    }
  }
}
```

### IDE Auto-Sync Hooks (`.kiro/hooks/`)

Four hooks keep the index fresh automatically in the Kiro IDE:

| Hook | Event | Action |
|------|-------|--------|
| `kirograph-mark-dirty-on-save.json` | `fileEdited` | `kirograph mark-dirty` |
| `kirograph-mark-dirty-on-create.json` | `fileCreated` | `kirograph mark-dirty` |
| `kirograph-sync-on-delete.json` | `fileDeleted` | `kirograph sync-if-dirty` |
| `kirograph-sync-if-dirty.json` | `agentStop` | `kirograph sync-if-dirty --quiet` |

File changes are batched: saves and creates write a dirty marker; the actual sync runs when the agent stops. Deletes sync immediately. This means no overhead during active editing.

Hooks fire for: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.rb`, `.php`, `.swift`, `.kt`, `.dart`, `.ex`, `.exs`

### CLI Agent Config (`.kiro/agents/kirograph.json`)

A custom agent for Kiro CLI that wires up the MCP server, inlines the steering instructions as a prompt, and handles sync in the CLI's own hook format. The CLI has no file-watch events, so syncing is handled at session boundaries instead:

| Hook | Event | Action |
|------|-------|--------|
| `agentSpawn` | Agent starts | `kirograph sync-if-dirty --quiet` — catches edits made between sessions |
| `userPromptSubmit` | Each prompt | `kirograph sync-if-dirty --quiet` — keeps graph fresh within a session |
| `stop` | End of each turn | `kirograph sync-if-dirty --quiet` — deferred flush, mirrors IDE `agentStop` |

Use it with:

```bash
kiro-cli --agent kirograph
```

Or swap to it inside an active session:

```
/agent swap kirograph
```

> Note: restart `kiro-cli` after running `kirograph install` for the agent to be picked up.

### Steering File (`.kiro/steering/kirograph.md`)

Teaches the Kiro IDE to prefer graph tools over file scanning when `.kirograph/` exists. The CLI agent has the same instructions inlined directly in its `prompt` field.

## Using with Claude Code

```bash
kirograph install --target claude
```

This writes:

- `.mcp.json` — project-scoped MCP server config for Claude Code
- `.kirograph/claude.md` — KiroGraph tool guidance
- `CLAUDE.md` — an import of `.kirograph/claude.md`

Claude Code prompts for project MCP approval the first time it sees `.mcp.json`.

## Using with Codex

```bash
kirograph install --target codex
```

This writes:

- `.kirograph/codex.md` — KiroGraph tool guidance
- `AGENTS.md` — a generated KiroGraph instruction block

Codex MCP configuration is user-scoped, so the installer prints the exact `codex mcp add ...` command and equivalent `~/.codex/config.toml` snippet instead of editing files outside the project.

## MCP Tools

All tools are available to the configured MCP client once installed.

### `kirograph_context`

Comprehensive context for a task or feature — often sufficient alone without additional tool calls.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | string | required | Task, bug, or feature description |
| `maxNodes` | number | 20 | Max symbols to include |
| `includeCode` | boolean | true | Include code snippets |
| `projectPath` | string | cwd | Project root path |

**How it works:** Extracts symbol tokens from the task description (CamelCase, snake_case, SCREAMING_SNAKE, dot.notation) → runs exact name lookup + FTS + **vector search** against the active semantic engine → resolves imports to their definitions → expands through the graph to related symbols → returns entry points, related nodes, edges, and code snippets. This is the only tool that uses the vector engine on every call.

### `kirograph_search`

Quick symbol search by name. Returns locations only, no code.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Symbol name or partial name |
| `kind` | string | — | Filter: `function`, `method`, `class`, `interface`, `type_alias`, `variable`, `route`, `component` |
| `limit` | number | 10 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** Exact name match → SQLite FTS → LIKE fallback → **vector search** only if all three return nothing. Pure graph database lookup in the common case; vector engine only as a last resort.

### `kirograph_callers`

Find all functions/methods that call a specific symbol.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS traversal of incoming `call` edges in the graph database. No vector engine involved.

### `kirograph_callees`

Find all functions/methods that a specific symbol calls.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS traversal of outgoing `call` edges in the graph database. No vector engine involved.

### `kirograph_impact`

Analyze what code would be affected by changing a symbol. Use before making changes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `depth` | number | 2 | Traversal depth |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS traversal of all incoming edges (`call`, `import`, `reference`, etc.) up to the specified depth. No vector engine involved.

### `kirograph_node`

Get details about a specific symbol, optionally including source code.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `includeCode` | boolean | false | Include source code |
| `projectPath` | string | cwd | Project root path |

Returns: kind, name, qualified name, file location, signature, docstring, and optionally source code.

**How it works:** Single row lookup by symbol name in the graph database. If `includeCode` is true, reads the relevant lines directly from the source file on disk. No vector engine involved.

### `kirograph_type_hierarchy`

Traverse the type hierarchy of a class or interface.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Class or interface name |
| `direction` | string | `both` | `up` (base types), `down` (derived types), `both` |
| `projectPath` | string | cwd | Project root path |

**How it works:** Recursive traversal of `extends` and `implements` edges in the graph database. No vector engine involved.

### `kirograph_path`

Find the shortest path between two symbols in the dependency graph.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | string | required | Source symbol name |
| `to` | string | required | Target symbol name |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS shortest-path search across all edge types in the graph database. No vector engine involved.

### `kirograph_dead_code`

Find symbols with no incoming references (potential dead code). Only unexported symbols are considered.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** Queries the graph database for nodes with zero incoming edges, filtered to non-exported symbols. No vector engine involved.

### `kirograph_circular_deps`

Find circular import dependencies in the codebase.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

**How it works:** Tarjan's strongly connected components algorithm over `import` edges in the graph database. No vector engine involved.

### `kirograph_files`

List the indexed file structure with filtering and format options.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filterPath` | string | — | Filter by directory prefix (e.g., `src/`) |
| `pattern` | string | — | Filter by glob pattern (e.g., `**/*.ts`) |
| `maxDepth` | number | — | Limit tree depth |
| `format` | string | `tree` | `tree`, `flat`, or `grouped` |
| `includeMetadata` | boolean | true | Include language and symbol counts |
| `projectPath` | string | cwd | Project root path |

**How it works:** Reads file records from the graph database and builds a tree structure in memory. Filtering is applied before tree construction. No vector engine involved.

### `kirograph_status`

Check index health and statistics: files indexed, symbol count, edge count, breakdown by kind and language, frameworks detected, database size, and semantic search status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

**How it works:** Reads aggregate counts from the graph database + calls `count()` on the active vector engine to report embedding coverage. No graph traversal, no vector search.

### `kirograph_architecture` *(requires `enableArchitecture: true`)*

Get the full architecture overview: detected packages, layers, and the dependency graph between them.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

Returns: packages (with source, language, version, external deps, file membership), layers (with file counts and detection patterns), package dependency edges, layer dependency edges, and per-file package/layer assignments.

**How it works:** Reads the `arch_*` tables populated during the last `kirograph index` run. Returns nothing useful if architecture analysis was not enabled at index time.

### `kirograph_coupling` *(requires `enableArchitecture: true`)*

Get coupling metrics for all packages or a specific one.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `packageId` | string | — | Package ID (e.g. `pkg:npm:src/auth`). Omit for all packages. |
| `projectPath` | string | cwd | Project root path |

Returns per-package: **Ca** (afferent — how many other packages depend on this one), **Ce** (efferent — how many packages this one depends on), and **instability** (`Ce / (Ca + Ce)`, 0 = maximally stable, 1 = maximally unstable). When `packageId` is given, also returns the full list of incoming and outgoing package dependencies.

### `kirograph_package` *(requires `enableArchitecture: true`)*

Inspect the files and dependencies of a specific package.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `packageId` | string | required | Package ID (e.g. `pkg:npm:src/auth`) |
| `projectPath` | string | cwd | Project root path |

Returns: package metadata, all files assigned to the package, packages it depends on (with import counts), and packages that depend on it.

### `kirograph_hotspots`

Find the most-connected symbols by total edge degree (incoming + outgoing). Excludes structural `contains` edges.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

Returns each symbol with total degree, in-degree, and out-degree. Useful for identifying core abstractions and high blast-radius code before making changes.

### `kirograph_surprising`

Find non-obvious cross-file connections: direct edges between symbols in structurally distant files.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** Queries all cross-file edges (excluding `contains` and `import`). Scores each by path distance between source and target files × edge-kind weight (`calls=1.0`, `references=0.8`, `type_of=0.7`, etc.). Returns the highest-scoring unique pairs — the ones that represent the most unexpected coupling in the codebase.

### `kirograph_diff`

Compare the current graph state against a saved snapshot. Shows added/removed symbols and edges.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `snapshot` | string | latest | Snapshot label. Omit to use the most recent saved snapshot. |
| `projectPath` | string | cwd | Project root path |

Use `kirograph snapshot save` (CLI) to save a snapshot before a refactor or PR. Run `kirograph_diff` after to see what changed structurally.

## CLI Reference

### Setup

```bash
kirograph install                 # Wire up MCP + hooks + steering in .kiro/
kirograph init [path]             # Initialize .kirograph/ in a project
kirograph init --index            # Initialize and index immediately
kirograph uninit [path]           # Remove .kirograph/, hooks, and steering file
kirograph uninit --force          # Skip confirmation prompt
```

### Indexing

```bash
kirograph index [path]            # Full re-index of the project
kirograph index --force           # Force re-index all files (ignore hash cache)
kirograph sync [path]             # Incremental sync of changed files
kirograph sync --files a.ts b.ts  # Sync specific files only
kirograph sync-if-dirty [path]    # Sync only if a dirty marker is present
kirograph mark-dirty [path]       # Write a dirty marker for deferred sync
```

### Status & Maintenance

```bash
kirograph status [path]           # Show index stats (files, symbols, edges, frameworks)
kirograph unlock [path]           # Force-release a stale lock file
```

### Search & Exploration

```bash
kirograph query <term>                    # Search symbols by name
kirograph query <term> --kind class       # Filter by kind
kirograph query <term> --limit 20         # Limit results (default: 10)
```

Supported kinds: `function`, `method`, `class`, `struct`, `interface`, `trait`, `protocol`, `enum`, `type_alias`, `property`, `field`, `variable`, `constant`, `enum_member`, `parameter`, `import`, `export`, `route`, `component`, `file`, `module`, `namespace`

### File Structure

```bash
kirograph files [path]                     # Show indexed file tree
kirograph files --format flat              # Flat list of all files
kirograph files --format grouped           # Files grouped by language
kirograph files --filter src/components    # Filter by directory prefix
kirograph files --pattern "**/*.test.ts"   # Filter by glob pattern
kirograph files --max-depth 2              # Limit tree depth
kirograph files --no-metadata              # Hide language/symbol counts
kirograph files --json                     # Output as JSON
```

### Context Building

```bash
kirograph context "fix checkout bug"
kirograph context "add user authentication" --format json
kirograph context "refactor payment service" --max-nodes 30
kirograph context "validate token" --no-code
```

Extracts symbol tokens from the task description (CamelCase, snake_case, SCREAMING_SNAKE, dot.notation), finds relevant entry points, expands through the graph, and outputs structured markdown or JSON.

### Affected Tests

Find test files that depend on changed source files — useful in CI or pre-commit hooks.

```bash
kirograph affected src/utils.ts src/api.ts           # Pass files as arguments
git diff --name-only | kirograph affected --stdin     # Pipe from git diff
kirograph affected --stdin --json < changed.txt       # JSON output
kirograph affected src/auth.ts --filter "e2e/**"      # Custom test file glob
kirograph affected src/lib.ts --depth 3 --quiet       # Paths only, shallow traversal
```

| Option | Description | Default |
|--------|-------------|---------|
| `--stdin` | Read file list from stdin, one per line | false |
| `-d, --depth <n>` | Max dependency traversal depth | 5 |
| `-f, --filter <glob>` | Custom glob to identify test files | auto-detect |
| `-j, --json` | Output as JSON | false |
| `-q, --quiet` | Output file paths only | false |
| `-p, --path <path>` | Project path | cwd |

Example CI integration:

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | kirograph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

### 🪨 Caveman Mode 🪨

![KiroGraph caveman](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/caveman.png)

Caveman mode compresses the agent's communication style, cutting token usage on responses without affecting tool calls or code output. Inspired by [caveman](https://github.com/JuliusBrussee/caveman) 🪨 by [JuliusBrussee](https://github.com/JuliusBrussee).

**Why it's useful:** KiroGraph's graph tools return compact, structured data. The bottleneck in long coding sessions isn't the tool calls — it's the verbose prose the agent wraps around them. Caveman mode strips that overhead so you get the signal without the filler. The rules are injected at session start via the steering file (IDE) and the inline agent prompt (kiro-cli), so they're always in context with no extra tool calls.

Four levels:

| Mode | Style |
|------|-------|
| `off` | Normal responses *(default)* |
| `lite` | Compact, no filler, full sentences |
| `full` | Fragments, no articles, short synonyms |
| `ultra` | Maximum compression, abbreviations, `→` for causality |

```bash
kirograph caveman lite    # compact, still readable
kirograph caveman full    # fragments, no articles
kirograph caveman ultra   # maximum compression
kirograph caveman off     # back to normal
kirograph caveman         # show current mode
```

Set during `kirograph install` (interactive arrow-key menu) or any time after. Takes effect on the next agent session.

Caveman mode never touches code blocks, file paths, URLs, or technical terms — only prose.

**Auto-clarity exceptions:** the agent temporarily reverts to normal prose for security warnings, confirmations of irreversible actions (delete, overwrite, force-push), and multi-step sequences where fragment order could cause misunderstanding. Compressed style resumes immediately after.

### Architecture Analysis *(requires `enableArchitecture: true`)*

Visualize the detected package graph, architectural layers, and package dependencies.

```bash
kirograph architecture [path]              # Show packages + layers + all deps
kirograph architecture --packages          # Show packages section only
kirograph architecture --layers            # Show layers section only
kirograph architecture --format json       # JSON output
```

**Output includes:**
- Each detected package with its source (`manifest` or `directory`), language, version, and declared external deps
- Package-to-package dependency edges with import counts
- Detected layers (`api`, `service`, `data`, `ui`, `shared`) with file counts
- Layer-to-layer dependency edges

### Package Inspection *(requires `enableArchitecture: true`)*

Drill into a single package: metadata, coupling metrics, dependencies, and files.

```bash
kirograph package <name>                   # Inspect a package by name or path fragment
kirograph package auth                     # Partial match accepted (e.g. matches "pkg:npm:src/auth")
kirograph package src/auth --no-files      # Omit file list
kirograph package auth --format json       # JSON output
```

Shows package source (manifest or directory), language, version, manifest path, coupling metrics (Ca/Ce/instability), outgoing dependencies, incoming dependents, declared external deps, and the full list of files belonging to the package.

### Coupling Metrics *(requires `enableArchitecture: true`)*

Inspect coupling health across your package graph.

```bash
kirograph coupling [path]                  # All packages, sorted by instability
kirograph coupling --sort ca               # Sort by afferent coupling (most depended-on first)
kirograph coupling --sort ce               # Sort by efferent coupling (most dependent first)
kirograph coupling --sort name             # Sort alphabetically
kirograph coupling --package auth          # Detail view for a single package
kirograph coupling --format json           # JSON output
```

The table shows each package with:
- **Ca** — afferent coupling: how many packages depend on this one (higher = more stable)
- **Ce** — efferent coupling: how many packages this one depends on (higher = more unstable)
- **Instability** — `Ce / (Ca + Ce)`, rendered as a color-coded bar: green (stable) → yellow (neutral) → red (unstable)

The `--package` detail view shows who depends on this package and what it depends on, with import counts for each relationship.

### Hotspots

Find the most-connected symbols in the codebase by total edge degree (incoming + outgoing, excluding structural `contains` edges). Useful for identifying core abstractions, load-bearing code, or high blast-radius change points.

```bash
kirograph hotspots [path]             # Top 20 most-connected symbols
kirograph hotspots --limit 10         # Limit results
kirograph hotspots --format json      # JSON output
```

Output shows each symbol with an inline bar chart, total degree, and in/out breakdown.

### Surprising Connections

Find non-obvious cross-file connections: direct edges (`calls`, `references`, etc.) between symbols in structurally distant parts of the codebase. High-score pairs indicate unexpected coupling worth investigating.

```bash
kirograph surprising [path]           # Top 20 surprising connections
kirograph surprising --limit 10       # Limit results
kirograph surprising --format json    # JSON output
```

Score = path distance between files × edge-kind weight (`calls=1.0`, `references=0.8`, `type_of=0.7`, etc.).

### Snapshots & Diff

Save lightweight graph snapshots and compare them to track structural changes over time — useful before/after refactors, or in CI to audit what a PR added or removed.

```bash
kirograph snapshot save [label]       # Save current graph state with optional label
kirograph snapshot save pre-refactor  # Named snapshot
kirograph snapshot list               # List all saved snapshots
kirograph snapshot diff               # Diff current graph vs latest snapshot
kirograph snapshot diff pre-refactor  # Diff current graph vs named snapshot
kirograph snapshot diff --format full # Show full added/removed symbol lists
kirograph snapshot diff --format json # JSON output
```

Snapshots are stored in `.kirograph/snapshots/` as JSON and include all node IDs and edge tuples. The diff is computed as a set operation — O(n) regardless of codebase size.

The `kirograph_diff` MCP tool exposes the same capability to the agent: compare the current graph against the latest (or a named) snapshot without leaving the conversation.

### Dead Code

Find unexported symbols with zero incoming references — candidates for removal.

```bash
kirograph dead-code [path]            # List dead code grouped by file
kirograph dead-code --limit 20        # Limit results
kirograph dead-code --format json     # JSON output
```

Only unexported symbols are considered, since exported symbols may be used by consumers outside the indexed project.

### Path

Find the shortest connection between any two symbols, traversing all edge types in both directions.

```bash
kirograph path <from> <to>            # Find path between two symbols
kirograph path LoginController Pool   # Example: how are these connected?
kirograph path --format json          # JSON output
```

The command resolves symbol names using the same fuzzy search as `kirograph query`, preferring real symbol kinds (class, function, method…) over import/file nodes. The result shows each hop with file and line.

### Graph Export

Export the full graph as an interactive dashboard — three files served from a local directory, no server required, works offline.

```bash
kirograph export build [path]             # Generate .kirograph/export/{index.html,app.css,app.js}
kirograph export start [path]             # Generate and open in browser
kirograph export build -o /tmp/myexport  # Custom output directory
kirograph export build --include-contains # Include structural contains edges (adds noise, off by default)
```

Output lands in `.kirograph/export/` by default. Open `index.html` in any browser.

![KiroGraph export](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/export.gif)

#### Graph & navigation

- **Color-coded nodes** by kind (class, function, method, component…) with size proportional to degree
- **Directed edges** with kind labels; dashed lines for imports and references
- **Click a node** to zoom in and inspect it — kind, file, line, degree, signature, and a copy button for the file reference
- **Click two nodes** to instantly find and highlight the shortest path between them, with detail cards for both endpoints
- **History** — ‹ › navigation through previously inspected nodes
- **Keyboard shortcuts** — `f` to fit the graph, `Esc` to exit focus or path mode

#### Controls

| Button | What it does |
|--------|-------------|
| **⊞ Fit** | Fit the entire graph to the viewport |
| **⚡ Physics** | Toggle the force-directed layout |
| **⛶ Fullscreen** | Collapse the side panel for maximum graph space |
| **📷 PNG** | Save the current view as an image |
| **◎ Focus** | Show only the selected node and its direct neighbors |
| **⟶ Path** | Find the shortest path between two nodes |
| **⬡ Cluster** | Group nodes by directory; click a cluster to expand it |
| **🌡 Heat** | Color nodes by how recently their file was modified |
| **📊 Charts** | Open the analytics panel |

#### Search

Type to search by name, qualified name, or file path. Matching nodes are highlighted and the viewport fits to them.

#### Legend & filters

- **Node kind filter** — Legend tab; click any kind to hide or show all nodes of that type
- **Edge kind filter** — Legend tab; click any edge kind to hide or show edges of that type
- **Degree slider** — Filters tab; hide nodes below N connections to surface the most-connected symbols

#### Minimap

An overview of the full graph is always visible in the bottom-left corner. Click anywhere on it to pan the main graph.

#### Right-click menu

Right-click any node to focus its neighbors, start a path from it, copy its ID or file path, or highlight all nodes of the same kind.

#### Analytics charts

The 📊 Charts button opens a panel with three charts:

| Chart | What it shows |
|-------|--------------|
| **Bar** | The 15 most-connected symbols |
| **Donut** | How node kinds are distributed across the codebase |
| **Line** | How many symbols have each connection count — reveals the overall connectivity shape of the graph |


### Dashboard

When `semanticEngine` is set to `qdrant` or `typesense`, use these commands to manage the background server and its dashboard UI.

```bash
kirograph dashboard start [path]   # Start server (if not running) and open dashboard
kirograph dashboard stop [path]    # Stop the running engine server
```

**`dashboard start`**

Reads `semanticEngine` from `.kirograph/config.json` and dispatches accordingly:

- **qdrant**: Downloads the [Qdrant Web UI](https://github.com/qdrant/qdrant-web-ui) on first use (cached at `.kirograph/qdrant/dashboard/`), spawns the Qdrant server with `QDRANT__SERVICE__STATIC_CONTENT_DIR` set so the dashboard is served natively, and opens `http://127.0.0.1:<port>/dashboard` in your browser. If the server is already running with the dashboard, reconnects instead of restarting.
- **typesense**: Downloads the [Typesense Dashboard](https://github.com/bfritscher/typesense-dashboard) static UI on first use (cached at `.kirograph/typesense/dashboard/`), starts the Typesense server if not already running, serves the dashboard locally via a Node HTTP server, and opens it in your browser. Press Ctrl+C to stop the dashboard server — the Typesense server keeps running as a background daemon.

Both servers run as persistent daemons. The state file (`.kirograph/qdrant-server.json` or `.kirograph/typesense-server.json`) tracks the PID and port for reconnection across `kg` commands.

**`dashboard stop`**

Reads `semanticEngine` from config and sends SIGTERM to the running background process, then removes the state file. Does nothing if no server is running.

### MCP Server

```bash
kirograph serve --mcp                      # Start MCP server (used by Kiro)
kirograph serve --mcp --path /my/project   # Specify project path
```

## Configuration

KiroGraph stores its config in `.kirograph/config.json`. You can edit it directly.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `languages` | string[] | `[]` | Limit indexing to specific languages (empty = all) |
| `include` | string[] | `[]` | Glob patterns to include (empty = include everything not excluded) |
| `exclude` | string[] | see below | Glob patterns to exclude |
| `maxFileSize` | number | `1048576` | Skip files larger than this (bytes) |
| `extractDocstrings` | boolean | `true` | Extract JSDoc, docstrings, and comments |
| `trackCallSites` | boolean | `true` | Record line/column for call edges |
| `enableEmbeddings` | boolean | `false` | Generate semantic embeddings (opt-in) |
| `embeddingModel` | string | `nomic-ai/nomic-embed-text-v1.5` | HuggingFace `feature-extraction` model ID |
| `embeddingDim` | number | `768` | Output dimension of the chosen embedding model |
| `semanticEngine` | string | `cosine` | Search engine: `cosine`, `sqlite-vec`, `orama`, `pglite`, `lancedb`, `qdrant`, or `typesense` |
| `useVecIndex` | boolean | `false` | Deprecated alias for `semanticEngine: "sqlite-vec"` |
| `enableArchitecture` | boolean | `false` | Enable architecture analysis (package graph + layer detection, opt-in) |
| `architectureLayers` | object | — | Custom layer definitions: `{ "layerName": ["glob/**"] }` |
| `minLogLevel` | string | `warn` | Log level: `debug`, `info`, `warn`, `error` |
| `fuzzyResolutionThreshold` | number | `0.5` | Name matching threshold for cross-file resolution (0.0–1.0) |
| `cavemanMode` | string | `off` | Agent communication style: `off`, `lite`, `full`, `ultra` |

Default exclude patterns: `node_modules/**`, `dist/**`, `build/**`, `.git/**`, `*.min.js`, `.kirograph/**`

### Semantic Search (Optional)

By default, KiroGraph uses exact name lookup and full-text search. Enable semantic search for natural-language queries:

```json
{
  "enableEmbeddings": true
}
```

This generates vector embeddings for all functions, methods, classes, interfaces, type aliases, components, and modules using a local embedding model (downloaded automatically to `~/.kirograph/models/` on first use). Embeddings are kept in sync automatically via Kiro hooks — on every file save, create, or delete.

Run `kirograph install` to be guided through model and engine selection interactively with arrow-key menus, or set the fields manually in `.kirograph/config.json`.

#### Embedding models

`kirograph install` offers a curated selection of models compatible with `@huggingface/transformers`:

| Model | Dim | Size | Notes |
|-------|-----|------|-------|
| `nomic-ai/nomic-embed-text-v1.5` | 768 | ~130MB | **Default.** Best quality for code search. |
| `onnx-community/embeddinggemma-300m-ONNX` | 768 | ~300MB | Google Gemma-based. Multilingual, 2048-token context window. |
| `Xenova/all-MiniLM-L6-v2` | 384 | ~23MB | Lightweight, fast. Lower accuracy. |
| `BAAI/bge-base-en-v1.5` | 768 | ~110MB | Strong general-purpose alternative to nomic. |
| Custom | any | — | Any HuggingFace `feature-extraction` model. Provide ID + output dimension. |

The embedding dimension is stored in `embeddingDim` in `.kirograph/config.json` and used to initialise all vector engines correctly. Switching models requires a full re-index (`kirograph index --force`).

Configure manually:

```json
{
  "enableEmbeddings": true,
  "embeddingModel": "onnx-community/embeddinggemma-300m-ONNX",
  "embeddingDim": 768
}
```

#### Storage architecture

Each engine owns its embedding store exclusively — there is no redundant write to the main graph database:

| Engine | Graph store | Vector store |
|--------|-------------|--------------|
| `cosine` | `kirograph.db` (SQLite) | `kirograph.db` (`vectors` table) |
| `sqlite-vec` | `kirograph.db` (SQLite) | `.kirograph/vec.db` (sqlite-vec) |
| `orama` | `kirograph.db` (SQLite) | `.kirograph/orama.json` (Orama) |
| `pglite` | `kirograph.db` (SQLite) | `.kirograph/pglite/` (PGlite+pgvector) |
| `lancedb` | `kirograph.db` (SQLite) | `.kirograph/lancedb/` (Apache Lance) |
| `qdrant` | `kirograph.db` (SQLite) | `.kirograph/qdrant/` (Qdrant embedded) |
| `typesense` | `kirograph.db` (SQLite) | `.kirograph/typesense/` (Typesense embedded) |

The graph store (`kirograph.db`) always holds nodes, edges, files, and all structural data regardless of which engine is active.

#### Engine comparison

| Engine | Search type | Extra deps | Native? | Best for |
|--------|-------------|------------|---------|----------|
| `cosine` *(default)* | Exact cosine, linear scan | none | — | Small / medium projects, zero setup |
| `sqlite-vec` | ANN (approximate), sub-linear | `better-sqlite3`, `sqlite-vec` | yes | Large codebases, fast ANN search |
| `orama` | Hybrid (full-text + vector) | `@orama/orama`, `@orama/plugin-data-persistence` | no (pure JS) | Best result quality, no native deps |
| `pglite` | Hybrid (full-text + vector), exact | `@electric-sql/pglite` | no (pure WASM) | Exact results, no native deps, PostgreSQL semantics |
| `lancedb` | ANN (approximate), sub-linear | `@lancedb/lancedb` | no (pure JS) | Fast ANN search, no native compilation required |
| `qdrant` | ANN (HNSW), sub-linear | `qdrant-local` | yes (binary) | Full Qdrant feature set, HNSW index, embedded binary |
| `typesense` | ANN (HNSW), sub-linear | `typesense` | yes (binary) | Fast ANN search, auto-downloaded binary, no manual install |

All non-cosine engines fall back silently to `cosine` if their optional dependencies are not installed.

#### cosine (default)

In-process cosine similarity over all stored embeddings. No extra dependencies. Embeddings are stored in the `vectors` table inside `kirograph.db`.

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "cosine"
}
```

#### sqlite-vec

Approximate nearest-neighbour (ANN) index stored in `.kirograph/vec.db`. Sub-linear search time — ideal for large codebases with thousands of indexed symbols. The SQLite `vectors` table is not written to; `vec.db` is the sole embedding store.

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "sqlite-vec"
}
```

```bash
npm install better-sqlite3 sqlite-vec
```

Requires two native dependencies (compiled C extensions). If not installed, falls back to `cosine`.

#### orama

Hybrid search powered by [Orama](https://github.com/oramasearch/orama) — combines full-text relevance and vector similarity in a **single query**, producing higher-quality results than running the two searches separately. The index is persisted to `.kirograph/orama.json` and is the sole embedding store. Pure JS, no native compilation required.

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "orama"
}
```

```bash
npm install @orama/orama @orama/plugin-data-persistence
```

If not installed, falls back to `cosine`.

#### pglite

Hybrid search powered by [PGlite](https://github.com/electric-sql/pglite) — a WASM-compiled PostgreSQL with the [pgvector](https://github.com/pgvector/pgvector) extension. Combines **exact** nearest-neighbour vector search with full-text ranking (`ts_rank`) in a single SQL query. The database is persisted to `.kirograph/pglite/` using PostgreSQL's WAL-based storage and is the sole embedding store. Pure WASM — no native compilation required.

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "pglite"
}
```

```bash
npm install @electric-sql/pglite
```

Key advantages:
- **Exact** vector results (not approximate) — deterministic and reproducible
- Native SQL `ON CONFLICT` upsert — no remove+insert workaround
- HNSW index (`vector_cosine_ops`) keeps search fast as the index grows
- Single dependency, zero native binaries

If not installed, falls back to `cosine`.

#### LanceDB

ANN vector search powered by [LanceDB](https://github.com/lancedb/lancedb) — stores embeddings in Apache Lance columnar format at `.kirograph/lancedb/`. Sub-linear search time using cosine distance. Pure JS, no native compilation required.

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "lancedb"
}
```

```bash
npm install @lancedb/lancedb
```

Key characteristics:
- **Columnar storage** (Apache Lance format) — efficient for batch reads and writes
- **ANN cosine search** — fast, sub-linear query time
- Pure JS — no native binaries or WASM required

If not installed, falls back to `cosine`.

#### qdrant

ANN vector search powered by [Qdrant](https://github.com/qdrant/qdrant) running in embedded mode. The engine spawns the Qdrant binary as a managed child process, persisting data to `.kirograph/qdrant/`. Uses [`@qdrant/qdrant-js`](https://github.com/qdrant/qdrant-js) as the REST client.

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "qdrant"
}
```

```bash
npm install qdrant-local
```

Key characteristics:
- **HNSW index** — high-quality ANN search with Qdrant's native indexing
- **Embedded binary** — no separate server setup; the process is spawned and managed automatically
- **Persistent daemon** — the server stays running between `kg` commands; state tracked in `.kirograph/qdrant-server.json`
- **Built-in dashboard** — run `kg dashboard start` to download the [Qdrant Web UI](https://github.com/qdrant/qdrant-web-ui) and open it (cached at `.kirograph/qdrant/dashboard/`, served via Qdrant's built-in static content feature)
- **Async startup** — polls `/readyz` instead of blocking with a fixed sleep
- **Cosine distance** metric
- Data persists across restarts in `.kirograph/qdrant/`

Manage the server:

```bash
kirograph dashboard start   # start server + open dashboard
kirograph dashboard stop    # stop server
```

If not installed, falls back to `cosine`.

#### typesense

ANN vector search powered by [Typesense](https://github.com/typesense/typesense) running in embedded mode. The engine automatically downloads the Typesense server binary (~37 MB, cached at `~/.kirograph/bin/`) on first use and spawns it as a managed child process. Uses the official [`typesense`](https://www.npmjs.com/package/typesense) Node.js client.

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "typesense"
}
```

```bash
npm install typesense
```

Key characteristics:
- **HNSW index** — high-quality ANN search with Typesense's native indexing
- **Auto-downloaded binary** — no manual server setup; the binary is fetched and cached at `~/.kirograph/bin/` on first run
- **Persistent daemon** — the server stays running between `kg` commands; state tracked in `.kirograph/typesense-server.json`
- **Local dashboard** — run `kg dashboard start` to open the built-in Typesense Dashboard UI (served locally, cached at `.kirograph/typesense/dashboard/`)
- **Async startup** — polls `/health` instead of blocking with a fixed sleep
- **Cosine distance** metric
- Data persists across restarts in `.kirograph/typesense/`

Manage the server:

```bash
kirograph dashboard start   # start server + open dashboard
kirograph dashboard stop    # stop server
```

If not installed (or binary download fails), falls back to `cosine`.

### Architecture Analysis (opt-in)

When `enableArchitecture: true` is set, KiroGraph analyses the high-level structure of your project during indexing and populates `arch_*` tables in `kirograph.db`. Zero behavioral change when disabled.

#### What it detects

**Packages** — logical groupings of files. Detected two ways:

1. **Manifest-based** — parsed from `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`/`setup.py`/`setup.cfg`, `pom.xml`, `build.gradle`/`build.gradle.kts`, and `.csproj` files. Produces IDs like `pkg:npm:src/auth`.
2. **Directory fallback** — for files not covered by any manifest, groups them by their nearest ancestor directory. Produces IDs like `pkg:dir:src/utils`.

**Layers** — architectural tiers detected from file paths using per-language glob patterns:

| Layer | Examples |
|-------|---------|
| `api` | `**/controllers/**`, `**/routes/**`, `**/handlers/**`, `**/api/**` |
| `service` | `**/services/**`, `**/usecases/**`, `**/domain/**` |
| `data` | `**/repositories/**`, `**/models/**`, `**/db/**`, `**/migrations/**` |
| `ui` | `**/components/**`, `**/views/**`, `**/pages/**`, `**/screens/**` |
| `shared` | `**/utils/**`, `**/helpers/**`, `**/lib/**`, `**/common/**` |

Layer detection is per-language (TypeScript/JS, Python, Go, Java, Ruby, Rust, C#) with framework-specific patterns where applicable (Django, Rails, Spring MVC, ASP.NET, etc.). Custom layer overrides are supported via `architectureLayers` in config.

**Package dependencies** — rolled up from existing `imports` edges in the graph. No re-parsing required.

**Coupling metrics** — computed per package:
- **Ca** (afferent) — how many other packages depend on this one
- **Ce** (efferent) — how many packages this one depends on
- **Instability** — `Ce / (Ca + Ce)`: 0 = maximally stable (everyone depends on it, it depends on nothing), 1 = maximally unstable (depends on everything, nobody depends on it)

#### Custom layer definitions

Override or extend the auto-detected layer patterns in `.kirograph/config.json`:

```json
{
  "enableArchitecture": true,
  "architectureLayers": {
    "api": ["src/routes/**", "src/controllers/**"],
    "service": ["src/domain/**", "src/application/**"],
    "data": ["src/infrastructure/**", "src/persistence/**"]
  }
}
```

When `architectureLayers` is set, those patterns take precedence over the auto-detected ones for the specified layer names.

#### Storage

All architecture data is stored in `kirograph.db` alongside the symbol graph:

| Table | Contents |
|-------|---------|
| `arch_packages` | Package definitions (id, name, path, source, language, version, deps) |
| `arch_layers` | Layer definitions (id, name, patterns) |
| `arch_file_packages` | File → package assignments |
| `arch_file_layers` | File → layer assignments (with confidence score) |
| `arch_package_deps` | Package → package dependency edges (with import count) |
| `arch_layer_deps` | Layer → layer dependency edges |
| `arch_coupling` | Per-package Ca, Ce, instability metrics |

#### IndexProgress phase

Architecture analysis runs as a dedicated phase during `kirograph index`. Progress is reported with `phase: 'architecture'`.

## Supported Languages

| Language | Extensions |
|----------|-----------|
| TypeScript | `.ts` |
| JavaScript | `.js` |
| TSX | `.tsx` |
| JSX | `.jsx` |
| Python | `.py` |
| Go | `.go` |
| Rust | `.rs` |
| Java | `.java` |
| C | `.c`, `.h` |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp` |
| C# | `.cs` |
| PHP | `.php` |
| Ruby | `.rb` |
| Swift | `.swift` |
| Kotlin | `.kt` |
| Dart | `.dart` |
| Svelte | `.svelte` |
| Elixir | `.ex`, `.exs` |

## Framework Detection

KiroGraph automatically detects frameworks and enriches the graph with framework-specific semantics (routes, components, lifecycle methods):

**JavaScript / TypeScript:** React, Next.js, React Native, Svelte, SvelteKit, Express, Fastify, Koa

**Python:** Django, Flask, FastAPI

**Ruby:** Rails

**Java:** Spring, Spring Boot, Spring MVC

**Go:** generic Go resolver

**Rust:** generic Rust resolver

**C#:** ASP.NET Core

**Swift:** SwiftUI, UIKit, Vapor

**PHP:** Laravel

**Elixir:** Phoenix

Detected frameworks are stored in config and used to improve symbol extraction and resolution.

## Requirements

- Node.js >= 18
- Kiro IDE

## License

MIT
