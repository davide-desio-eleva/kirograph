![KiroGraph terminal](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/logo.png)

# KiroGraph

![KiroGraph terminal](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/terminal.png)

Semantic code knowledge graph for [Kiro](https://kiro.dev): fewer tool calls, instant symbol lookups, 100% local.

Inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) by [colbymchenry](https://github.com/colbymchenry) for Claude Code, rebuilt natively for Kiro's MCP and hooks system.

> **Full support is for Kiro only.** Experimental integrations for 32 other MCP-capable tools are available — community-contributed, vibecoded, and unverified. PRs welcome for fixes. See [Other Tools (Experimental)](#other-tools-experimental) for the full list.

## Why KiroGraph?

When you ask Kiro to work on a complex task, it explores your codebase using file reads, grep, and glob searches. Every one of those is a tool call, and tool calls consume context and slow things down.

KiroGraph gives Kiro a semantic knowledge graph that's pre-indexed and always up to date. Instead of scanning files to understand your code, Kiro queries the graph instantly: symbol relationships, call graphs, type hierarchies, impact radius, all in a single MCP tool call.

The result is fewer tool calls, less context used, and faster responses on complex tasks.

## What Gets Indexed?

KiroGraph uses [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to parse your source files into an AST and extract:

- **Nodes**: functions, methods, classes, interfaces, types, enums, variables, constants, routes, components, and more (24 node kinds total)
- **Edges**: calls, imports, exports, extends, implements, contains, references, instantiates, overrides, decorates, type_of, returns

Everything is stored in a local SQLite database (`.kirograph/kirograph.db`). **Nothing leaves your machine.** No API keys. No external services.

The index is kept fresh automatically via Kiro hooks when using the Kiro integration; no background watcher process needed.

## How Indexing Works

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

See the [Architecture Analysis](#architecture-analysis-opt-in-1) section below for full details.

### Memory (opt-in)

When `enableMemory: true` is set, KiroGraph stores persistent observations across sessions — decisions, errors, patterns, and architecture notes. Inspired by [cavemem](https://github.com/JuliusBrussee/cavemem) by [Julius Brussee](https://www.linkedin.com/in/julius-brussee/). Observations are:

- **Compressed** with the caveman grammar (if caveman mode is enabled) — deterministic, no LLM tokens spent
- **Linked to code symbols** — identifiers in observation text are matched against the graph and stored as stable `qualified_name` references
- **Embedded** with the configured semantic engine — enabling natural-language search over past observations
- **Deduplicated** — SHA-256 content hash prevents storing the same observation twice

Memory surfaces automatically in `kirograph_context` and `kirograph_impact` results when relevant observations are linked to the symbols being queried. The agent can also search memory directly via `kirograph_mem_search` or store new observations via `kirograph_mem_store`.

Zero LLM tokens on write. ~150-350 tokens per search (vs ~2000-5000 tokens to re-discover context by reading files).

Enable via `kirograph install` or directly in `.kirograph/config.json`:

```json
{
  "enableMemory": true
}
```

See the [Memory](#memory-requires-enablememory-true) section below for full details.

### Documentation indexing (opt-in)

When `enableDocs: true` is set, KiroGraph indexes project documentation by heading hierarchy and section structure. Instead of reading entire doc files, agents retrieve exactly the section they need via stable section IDs. Inspired by [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/).

- **9 format parsers**: Markdown, MDX, reStructuredText, AsciiDoc, RDoc, Org-mode, HTML, plain text, OpenAPI/Swagger
- **Code ↔ docs cross-references**: Backtick references, CamelCase identifiers, and snake_case patterns in docs are resolved against the code graph
- **Section-level FTS search**: Independent from code search (`kirograph_docs_search`)
- **Stable section IDs**: `{file_path}::{ancestor-chain/slug}#{level}` — stable across re-indexing
- **Token savings**: 92–97% reduction vs reading full doc files (tracked in `kirograph_gain`)

Enable via `kirograph install` or directly in `.kirograph/config.json`:

```json
{
  "enableDocs": true
}
```

See the [Documentation](#documentation-requires-enabledocs-true) section below for full details.

### Data indexing (opt-in)

When `enableData: true` is set, KiroGraph indexes tabular data files (CSV, TSV, JSONL, JSON, Excel, Parquet) that live alongside your code — test fixtures, seed data, configuration tables, sample datasets. Inspired by [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/).

- **Streaming parser**: never loads full files into memory. Processes line-by-line (CSV/JSONL) or in chunks (Excel/Parquet)
- **Column profiling**: type inference, cardinality, null percentages, min/max, sample values
- **Server-side computation**: filters, aggregations, and joins run in SQLite. Only results enter the context window
- **Incremental**: content hash (SHA-256) skips unchanged files on re-index
- **Token savings**: 95–99% reduction vs reading raw data files (tracked in `kirograph_gain`)
- **Optional format deps**: CSV/TSV/JSONL/JSON are built-in (zero deps). Excel requires `xlsx`, Parquet requires `parquetjs-lite`

Enable via `kirograph install` or directly in `.kirograph/config.json`:

```json
{
  "enableData": true
}
```

See the [Data](#data-requires-enabledata-true) section below for full details.

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
kirograph uninit [path]                  # Prompts to remove Kiro integration files and .kirograph/ data separately
kirograph uninit --force                 # Remove Kiro integration files + .kirograph/ data without confirmation
kirograph uninit --target all --force    # Remove all integration files (Kiro + Claude + Codex + Cursor + Antigravity + OpenCode) + .kirograph/ data
```

`kirograph uninstall` is an alias for `kirograph uninit`.

Without `--force`, KiroGraph asks separately whether to remove the selected tool integration files and whether to remove the shared `.kirograph/` data. With `--force`, both are removed unconditionally.

This can remove:
- `.kirograph/`: index database, snapshots, and export directory
- Kiro target: `.kiro/hooks/kirograph-*.json`, `.kiro/steering/kirograph.md`, `.kiro/agents/kirograph.json`
- Claude target (experimental): `kirograph` from `.mcp.json`, plus the KiroGraph import from `CLAUDE.md`
- Codex target (experimental): the generated KiroGraph block from `AGENTS.md`
- Cursor target (experimental): `kirograph` from `.cursor/mcp.json`, plus `.cursor/rules/kirograph.mdc`
- Antigravity target (experimental): KiroGraph block from `GEMINI.md`, hooks from `.agents/hooks.json`
- OpenCode target (experimental): `kirograph` MCP and instructions from `.opencode.json`, sync plugin from `.opencode/plugins/`

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
```

All Kiro integration files are written to `.kiro/`. Restart Kiro IDE, or switch to the `kirograph` agent in Kiro CLI. It will now use KiroGraph tools automatically.

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

A single Kiro hook triggers on `agentStop` and asks the agent to sync the index if any source files were changed during the session. No per-file hooks, no background watcher — zero overhead during active editing.

## Using with Kiro

`kirograph install` or `kirograph install --target kiro` sets up four things in your Kiro workspace (all coexist, so you can switch between IDE and CLI freely):

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
        "kirograph_hotspots", "kirograph_surprising", "kirograph_diff",
        "kirograph_exec", "kirograph_gain"
        "kirograph_mem_search", "kirograph_mem_store",
        "kirograph_mem_timeline", "kirograph_mem_status",
        "kirograph_docs_toc", "kirograph_docs_search",
        "kirograph_docs_section", "kirograph_docs_outline", "kirograph_docs_refs",
        "kirograph_data_list", "kirograph_data_describe",
        "kirograph_data_query", "kirograph_data_aggregate", "kirograph_data_search",
        "kirograph_data_join", "kirograph_data_correlations", "kirograph_data_quality"
      ]
    }
  }
}
```

### IDE Hooks (`.kiro/hooks/`)

Up to three hooks are installed (`.kiro.hook` extension):

| Hook file | Event | Type | Behavior |
|-----------|-------|------|----------|
| `kirograph-sync-if-dirty.kiro.hook` | `agentStop` | `runCommand` | Runs `kirograph sync --quiet` when the agent stops, syncing any file changes from the session. The sync command skips unchanged files via content hashing, so it's fast even when nothing changed. |
| `kirograph-compress-hint.kiro.hook` | `preToolUse` (shell) | `askAgent` | Reminds the agent to use `kirograph_exec` for commands that benefit from token compression (git, gh, test, lint, build, docker, aws, grep). Only installed when shell compression is enabled. |
| `kirograph-mem-capture.kiro.hook` | `agentStop` | `askAgent` | Prompts the agent to store important observations (decisions, errors, patterns) in memory at the end of each session. Only installed when memory is enabled. |

The sync hook replaces the previous per-file approach (mark-dirty-on-save, mark-dirty-on-create, sync-on-delete). A single `agentStop` hook handles all file changes in one pass with zero overhead during active editing.

### CLI Agent Config (`.kiro/agents/kirograph.json`)

A custom agent for Kiro CLI that wires up the MCP server, references the steering file as a resource, and handles sync in the CLI's own hook format. The CLI has no file-watch events, so syncing is handled at session boundaries:

| Event | Action |
|-------|--------|
| `agentSpawn` | `kirograph sync-if-dirty --quiet` (catches edits made between sessions) |
| `userPromptSubmit` | `kirograph sync-if-dirty --quiet` (keeps graph fresh within a session) |
| `stop` | `kirograph sync-if-dirty --quiet` (deferred flush, mirrors IDE `agentStop`) |

> Note: The CLI agent format only supports `command` hooks (shell commands), not `askAgent` prompts. Memory capture and compression hints are handled via the steering file instructions instead — the agent reads them from `.kiro/steering/kirograph.md` which is referenced as a resource.

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

## Other Tools (Experimental)

> **⚠️ Community-contributed, vibecoded, unverified.** These integrations are provided as-is. PRs welcome for fixes and corrections.

KiroGraph can be installed for any MCP-capable coding agent. All targets share the same `.kirograph/` data — installing another target only writes that tool's integration files and reuses the existing graph.

### How It Works

Every target does two things:

1. **Registers the MCP server** — writes a config file that tells the tool to launch `kirograph serve --mcp` as a stdio MCP server.
2. **Injects agent instructions** — writes a rules/instructions file that teaches the agent to prefer graph tools over grep/glob when `.kirograph/` exists.

The MCP server exposes 24 tools (search, context, callers, callees, impact, node, path, type hierarchy, dead code, circular deps, files, status, architecture, coupling, package, hotspots, surprising, diff, exec, gain, mem_search, mem_store, mem_timeline, mem_status). All tools are read-only except `mem_store`.

### Supported Targets (33)

| Target | Command | MCP Config | Instructions | Pattern |
|--------|---------|-----------|--------------|---------|
| **🎯 Kiro** (full support) | `kirograph install` | `.kiro/settings/mcp.json` | `Steering + CLI agent` | Full |
| Cursor | `--target cursor` | `.cursor/mcp.json` | `.cursor/rules/kirograph.mdc` | A |
| GitHub Copilot | `--target copilot` | `.github/copilot-mcp.json` | `.github/copilot-instructions.md` | A |
| Roo Code | `--target roo` | `.roo/mcp.json` | `.roo/rules/kirograph.md` | A |
| JetBrains Junie | `--target junie` | `.junie/mcp/mcp.json` | `.junie/AGENTS.md` | A |
| Continue | `--target continue` | `.continue/mcpServers/kirograph.json` | `.continue/rules/kirograph.md` | A |
| Warp | `--target warp` | `.warp/.mcp.json` | `AGENTS.md` | A |
| Trae | `--target trae` | `.trae/mcp.json` | `.trae/rules/kirograph.md` | A |
| Augment Code | `--target augment` | `.augment/mcp.json` | `augment-guidelines.md` | A |
| Sourcegraph Amp | `--target amp` | `.amp/config.json` | `.amp/instructions.md` | A |
| Tabnine | `--target tabnine` | `.tabnine/mcp.json` | `.tabnine/instructions.md` | A |
| Claude Code | `--target claude` | `.mcp.json` | `CLAUDE.md` | B |
| Codex CLI | `--target codex` | `.codex/hooks.json` | `AGENTS.md` | B |
| Gemini CLI | `--target gemini-cli` | `.gemini/settings.json` | `GEMINI.md` | C |
| OpenCode | `--target opencode` | `.opencode.json` | `.opencode.json (instructions)` | C |
| Kilo Code | `--target kilo` | `kilo.json` | `.kilo/rules/kirograph.md` | C |
| Devin | `--target devin` | `.devin/config.json` | `AGENTS.md` | C |
| OpenHands | `--target openhands` | `.openhands/config.json` | `AGENTS.md` | C |
| Windsurf | `--target windsurf` | Print command | `.windsurf/rules/kirograph.md` | D |
| Cline | `--target cline` | Print command | `.clinerules/kirograph.md` | D |
| Antigravity | `--target antigravity` | Print command | `GEMINI.md` | D |
| Aider | `--target aider` | Print CLI flag | `CONVENTIONS.md` | D |
| Replit Agent | `--target replit` | Print command | `AGENTS.md` | D |
| Block Goose | `--target goose` | Print command | `AGENTS.md` | D |
| Mistral Vibe | `--target mistral-vibe` | Print command | `.kirograph/mistral-vibe.md` | D |
| IBM Bob | `--target ibm-bob` | Print command | `.kirograph/ibm-bob.md` | D |
| Crush | `--target crush` | Print command | `.kirograph/crush.md` | D |
| Droid Factory | `--target droid-factory` | Print command | `.kirograph/droid-factory.md` | D |
| ForgeCode | `--target forgecode` | Print command | `.kirograph/forgecode.md` | D |
| iFlow CLI | `--target iflow` | Print command | `.kirograph/iflow.md` | D |
| Qwen Code | `--target qwen` | Print command | `.kirograph/qwen.md` | D |
| Atlassian Rovo Dev | `--target rovo` | Print command | `.kirograph/rovo.md` | D |
| Qoder | `--target qoder` | Print command | `.kirograph/qoder.md` | D |

### Integration Patterns

**Pattern A — Project-level MCP config + rules file** (Cursor, Windsurf, Copilot, Cline, Roo, Kilo, Junie, Continue, Warp, Trae, Augment, Amp, Tabnine): The installer writes a JSON config file that the tool reads on startup, plus a rules/instructions file the agent loads into context. Restart the tool after installing.

**Pattern B — Standard mcpServers + project memory file** (Claude Code, Antigravity/Gemini CLI): Writes a standard `mcpServers` config plus a generated block in the tool's project memory file (`CLAUDE.md`, `GEMINI.md`). The block is idempotent — safe to re-run.

**Pattern C — Custom config format** (OpenCode, Devin): The tool has its own config schema. The installer merges the kirograph entry into the existing config without overwriting other settings.

**Pattern D — Print-only** (Codex, Aider, Replit, Goose, Mistral Vibe, IBM Bob, Crush, Droid Factory, ForgeCode, iFlow, Qwen, Rovo, Qoder): The tool's MCP config is user-scoped or cloud-hosted. The installer writes instructions locally and prints the exact command to register the MCP server.

### Auto-Sync Hooks

KiroGraph keeps its index fresh via lifecycle hooks. For tools that support a hook/event system, the installer writes auto-sync hooks that run `kirograph sync` when the agent finishes a task — no manual intervention needed.

| Tool | Hook file | Event trigger | What it does |
|------|-----------|---------------|--------------|
| **Kiro** | `.kiro/hooks/*.kiro.hook` | `agentStop` + `preToolUse` | Sync + compression hint + memory capture |
| **Cursor** | `.cursor/hooks.json` | `stop` | Sync on task completion |
| **Windsurf** | `.windsurf/hooks.json` | `post_cascade_response` | Sync after each Cascade response |
| **Claude Code** | `.claude/settings.json` | `Stop` | Sync on session stop |
| **GitHub Copilot** | `.github/hooks.json` | `session-end` | Sync on session end |
| **Cline** | `.clinerules/hooks/task_completed` | `task_completed` | Executable script that syncs |
| **Codex CLI** | `.codex/hooks.json` | `Stop` | Sync on session stop |
| **Antigravity** | `.agents/hooks.json` | `Stop` | Sync on execution stop |
| **Gemini CLI** | `.gemini/settings.json` | `SessionEnd` | Sync on session end |
| **OpenCode** | `.opencode/plugins/kirograph-sync.js` | `session.idle` | JS plugin that syncs |
| **Devin** | `.devin/hooks.v1.json` | `Stop` | Sync on session stop |

For tools **without** a hook system (22 targets), the generated instructions include a "Session Hygiene" section that tells the agent to manually run `kirograph sync` at the start and end of each session.

### Uninstalling

Every target supports `uninit`:

```bash
kirograph uninit --target cursor       # removes .cursor/mcp.json + rules + hooks
kirograph uninit --target windsurf     # removes .windsurf/mcp.json + .windsurfrules + hooks
kirograph uninit --target all --force  # removes ALL integration files + .kirograph/ data
```

### Multiple Targets

You can install multiple targets in the same project. They all share the same `.kirograph/` graph data:

```bash
kirograph install                      # Kiro (primary)
kirograph install --target cursor      # also Cursor
kirograph install --target claude      # also Claude Code
```

Each target writes its own integration files without conflicting with others. Multiple targets can write to `AGENTS.md` simultaneously using unique block IDs (`<!-- kirograph:codex:start -->`, `<!-- kirograph:devin:start -->`, etc.).

## MCP Tools

All tools are auto-approved in Kiro once installed. Other MCP clients can use the same tools after configuring their respective targets.

### `kirograph_context`

Comprehensive context for a task or feature, often sufficient alone without additional tool calls.

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
| `kind` | string | - | Filter: `function`, `method`, `class`, `interface`, `type_alias`, `variable`, `route`, `component` |
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

**How it works:** BFS traversal of incoming `call` edges in the graph database; no vector engine involved.

### `kirograph_callees`

Find all functions/methods that a specific symbol calls.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `limit` | number | 20 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS traversal of outgoing `call` edges in the graph database; no vector engine involved.

### `kirograph_impact`

Analyze what code would be affected by changing a symbol. Use before making changes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `depth` | number | 2 | Traversal depth |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS traversal of all incoming edges (`call`, `import`, `reference`, etc.) up to the specified depth; no vector engine involved.

### `kirograph_node`

Get details about a specific symbol, optionally including source code.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Symbol name |
| `includeCode` | boolean | false | Include source code |
| `projectPath` | string | cwd | Project root path |

Returns: kind, name, qualified name, file location, signature, docstring, and optionally source code.

**How it works:** Single row lookup by symbol name in the graph database. If `includeCode` is true, reads the relevant lines directly from the source file on disk; no vector engine involved.

### `kirograph_type_hierarchy`

Traverse the type hierarchy of a class or interface.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `symbol` | string | required | Class or interface name |
| `direction` | string | `both` | `up` (base types), `down` (derived types), `both` |
| `projectPath` | string | cwd | Project root path |

**How it works:** Recursive traversal of `extends` and `implements` edges in the graph database; no vector engine involved.

### `kirograph_path`

Find the shortest path between two symbols in the dependency graph.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from` | string | required | Source symbol name |
| `to` | string | required | Target symbol name |
| `projectPath` | string | cwd | Project root path |

**How it works:** BFS shortest-path search across all edge types in the graph database; no vector engine involved.

### `kirograph_dead_code`

Find symbols with no incoming references (potential dead code). Only unexported symbols are considered.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (1–100) |
| `projectPath` | string | cwd | Project root path |

**How it works:** Queries the graph database for nodes with zero incoming edges, filtered to non-exported symbols; no vector engine involved.

### `kirograph_circular_deps`

Find circular import dependencies in the codebase.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

**How it works:** Tarjan's strongly connected components algorithm over `import` edges in the graph database; no vector engine involved.

### `kirograph_files`

List the indexed file structure with filtering and format options.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `filterPath` | string | - | Filter by directory prefix (e.g., `src/`) |
| `pattern` | string | - | Filter by glob pattern (e.g., `**/*.ts`) |
| `maxDepth` | number | - | Limit tree depth |
| `format` | string | `tree` | `tree`, `flat`, or `grouped` |
| `includeMetadata` | boolean | true | Include language and symbol counts |
| `projectPath` | string | cwd | Project root path |

**How it works:** Reads file records from the graph database and builds a tree structure in memory. Filtering is applied before tree construction; no vector engine involved.

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
| `packageId` | string | - | Package ID (e.g. `pkg:npm:src/auth`). Omit for all packages. |
| `projectPath` | string | cwd | Project root path |

Returns per-package: **Ca** (afferent: how many other packages depend on this one), **Ce** (efferent: how many packages this one depends on), and **instability** (`Ce / (Ca + Ce)`, 0 = maximally stable, 1 = maximally unstable). When `packageId` is given, also returns the full list of incoming and outgoing package dependencies.

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

**How it works:** Queries all cross-file edges (excluding `contains` and `import`). Scores each by path distance between source and target files × edge-kind weight (`calls=1.0`, `references=0.8`, `type_of=0.7`, etc.). Returns the highest-scoring unique pairs. the ones that represent the most unexpected coupling in the codebase.

### `kirograph_diff`

Compare the current graph state against a saved snapshot. Shows added/removed symbols and edges.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `snapshot` | string | latest | Snapshot label. Omit to use the most recent saved snapshot. |
| `projectPath` | string | cwd | Project root path |

Use `kirograph snapshot save` (CLI) to save a snapshot before a refactor or PR. Run `kirograph_diff` after to see what changed structurally.

### `kirograph_exec`

Run a shell command and return token-optimized output. Automatically filters noise from git, test runners, linters, build tools, docker, and package managers.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `command` | string | required | Shell command to execute |
| `cwd` | string | project root | Working directory |
| `level` | string | `normal` | Compression level: `normal`, `aggressive`, `ultra` |
| `timeout` | number | 60 | Timeout in seconds |
| `projectPath` | string | cwd | Project root path |

**How it works:** Executes the command, detects the command family (git, test, lint, etc.), applies the appropriate filter strategy, and returns compressed output with a savings footer. Error output is always preserved. Does not require KiroGraph to be initialized, works standalone.

### `kirograph_gain`

Show token savings statistics from compressed command outputs.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | string | `session` | Time period: `session`, `today`, `week`, `all` |
| `projectPath` | string | cwd | Project root path |

Returns total commands, original/compressed token counts, savings percentage, breakdown by command family, and recent command history.

### `kirograph_mem_search` *(requires `enableMemory: true`)*

Search project memory for past decisions, errors, patterns, and context.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Natural language search query |
| `kind` | string | - | Filter: `decision`, `error`, `pattern`, `architecture`, `summary`, `note` |
| `limit` | number | 10 | Max results |
| `sessionId` | string | - | Filter to specific session |
| `projectPath` | string | cwd | Project root path |

**How it works:** Hybrid search combining FTS5 keyword matching and vector cosine similarity (using the configured semantic engine). Results are ranked by a blended score (configurable via `memorySearchAlpha`). Falls back to FTS-only if embeddings are disabled or model mismatch is detected.

### `kirograph_mem_store` *(requires `enableMemory: true`)*

Store an observation in project memory. Content is automatically compressed (if caveman mode is on) and linked to relevant code symbols.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | required | Observation text |
| `kind` | string | `note` | `decision`, `error`, `pattern`, `architecture`, `summary`, `note` |
| `projectPath` | string | cwd | Project root path |

**How it works:** Strips `<private>` blocks → applies caveman compression (if enabled) → computes SHA-256 hash for deduplication → stores in `mem_observations` → detects symbol identifiers and creates `mem_links` → embeds with the configured model. Zero LLM tokens consumed.

### `kirograph_mem_timeline` *(requires `enableMemory: true`)*

List recent sessions and their observations chronologically.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 5 | Number of sessions to show |
| `sessionId` | string | - | Show observations for a specific session |
| `projectPath` | string | cwd | Project root path |

### `kirograph_mem_status` *(requires `enableMemory: true`)*

Memory subsystem health: session count, observations, embedding coverage, model mismatch detection.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_toc` *(requires `enableDocs: true`)*

Get table of contents for a documentation file or the whole project. Returns section IDs, titles, levels, and summaries.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `file` | string | - | Filter to a specific doc file (relative path). Omit for project-wide TOC. |
| `tree` | boolean | false | Return nested tree structure |
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_search` *(requires `enableDocs: true`)*

Search documentation sections by query. Returns matching sections ranked by relevance. Independent from `kirograph_search` (code-only).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query (natural language or keywords) |
| `file` | string | - | Narrow search to a specific doc file |
| `limit` | number | 10 | Max results |
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_section` *(requires `enableDocs: true`)*

Retrieve full content of a documentation section by its stable ID. Use `context=true` to also get ancestor headings and child summaries.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | required | Section ID (from `kirograph_docs_toc` or `kirograph_docs_search` results) |
| `context` | boolean | false | Include ancestor heading chain and child summaries |
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_outline` *(requires `enableDocs: true`)*

Get the heading hierarchy for a single documentation file. Lighter than full TOC when you know which file is relevant.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `file` | string | required | Relative path to the doc file |
| `projectPath` | string | cwd | Project root path |

### `kirograph_docs_refs` *(requires `enableDocs: true`)*

Find code symbols referenced by a doc section, or doc sections that reference a code symbol. Bidirectional lookup.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sectionId` | string | - | Doc section ID (find code symbols it references) |
| `nodeId` | string | - | Code symbol qualified name (find doc sections that reference it) |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_list` *(requires `enableData: true`)*

List all indexed datasets with row counts, column counts, and file sizes.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_describe` *(requires `enableData: true`)*

Full schema profile for a dataset: column names, inferred types, cardinality, null percentages, min/max values, and sample values.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID (from `kirograph_data_list`) |
| `column` | string | - | Deep dive on a single column |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_query` *(requires `enableData: true`)*

Filtered row retrieval with structured operators. Multiple filters are ANDed. All queries use parameterized SQL (zero injection surface).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `filters` | Filter[] | - | Array of `{column, op, value}`. Ops: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `is_null`, `between` |
| `columns` | string[] | all | Column projection |
| `limit` | number | 500 | Max rows (hard cap: 500) |
| `offset` | number | 0 | Pagination offset |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_aggregate` *(requires `enableData: true`)*

Server-side GROUP BY aggregation. Computation happens in SQLite; only results enter the context window.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `groupBy` | string[] | required | Columns to group by |
| `metrics` | Metric[] | required | Array of `{column, op}`. Ops: `count`, `sum`, `avg`, `min`, `max`, `count_distinct` |
| `filters` | Filter[] | - | Pre-aggregation filters |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_search` *(requires `enableData: true`)*

Search column names and sample values by keyword within a dataset.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `query` | string | required | Search keyword |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_join` *(requires `enableData: true`)*

SQL JOIN across two indexed datasets. Combines data without loading either file into context.

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

### `kirograph_data_correlations` *(requires `enableData: true`)*

Pairwise Pearson correlations between numeric columns. Discovers hidden relationships without loading data.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `threshold` | number | 0.3 | Min absolute correlation to include |
| `projectPath` | string | cwd | Project root path |

### `kirograph_data_quality` *(requires `enableData: true`)*

Data quality triage: rank columns by composite risk score (null rate, cardinality anomalies, type issues).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataset` | string | required | Dataset ID |
| `projectPath` | string | cwd | Project root path |

## CLI Reference

### Setup

```bash
kirograph install                 # Wire up MCP + hooks + steering in .kiro/
kirograph init [path]             # Initialize .kirograph/ in a project
kirograph init --index            # Initialize and index immediately
kirograph uninit [path]           # Prompts to remove integration files and .kirograph/ data
kirograph uninit --force          # Remove everything without confirmation
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

Find test files that depend on changed source files, useful in CI or pre-commit hooks.

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

**Why it's useful:** KiroGraph's graph tools return compact, structured data. The bottleneck in long coding sessions isn't the tool calls; it is the verbose prose the agent wraps around them. Caveman mode strips that overhead so you get the signal without the filler. The rules are injected at session start via the steering file (IDE) and the inline agent prompt (kiro-cli), so they're always in context with no extra tool calls.

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

Caveman mode never touches code blocks, file paths, URLs, or technical terms, only prose.

**Auto-clarity exceptions:** the agent temporarily reverts to normal prose for security warnings, confirmations of irreversible actions (delete, overwrite, force-push), and multi-step sequences where fragment order could cause misunderstanding. Compressed style resumes immediately after.

### Shell Compression (`kirograph_exec`)

![KiroGraph caveman](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/rtk.png)

KiroGraph includes a built-in shell compression engine inspired by [rtk](https://github.com/rtk-ai/rtk). The `kirograph_exec` MCP tool runs shell commands and returns token-optimized output, saving 60-90% of tokens on verbose commands like git, test runners, linters, and build tools.

**Why it's useful:** LLM context is expensive. A raw `git status` might be 2,000 tokens; compressed it's 200. A passing test suite might be 25,000 tokens of noise; compressed it's a single "PASSED: 42/42 tests" line. The compression engine knows how to extract the signal from each command family.

Supported command families:

| Family | Commands | Typical savings |
|--------|----------|----------------|
| Git | status, log, diff, push, pull, commit, add, fetch, branch, stash | 75-96% |
| GitHub CLI | gh pr list/view, gh issue list, gh run list/view | 60-80% |
| Test runners | jest, vitest, pytest, cargo test, go test, rspec, minitest, playwright | 80-90% |
| Linters/build | eslint, tsc, ruff, clippy, cargo build, prettier, biome, golangci-lint, rubocop, next build | 70-85% |
| File listings | ls, find, tree | 60-80% |
| Search | grep, rg/ripgrep (grouped by file) | 60-80% |
| Diff | diff file1 file2 (condensed context) | 50-70% |
| Docker/k8s | docker ps, images, logs, compose ps, kubectl pods, logs, services | 70-80% |
| Package managers | npm/pnpm install/list, pip list/install/outdated, bundle install/list, prisma generate | 75-92% |
| AWS | sts, ec2, lambda, logs, cloudformation, dynamodb, iam, s3, ecs, sqs, sns | 60-88% |
| Network | curl (strip progress/headers), wget (strip progress bars) | 50-70% |

**Supported commands (full list):**

```
# Git
kirograph exec git status                  # Compact status
kirograph exec git log -n 10               # One-line commits
kirograph exec git diff                    # Condensed diff
kirograph exec git add .                   # → "ok"
kirograph exec git commit -m "msg"         # → "ok abc1234"
kirograph exec git push                    # → "ok main → origin/main"
kirograph exec git pull                    # → "ok 3 files +10 -2"

# GitHub CLI
kirograph exec gh pr list                  # Compact PR listing
kirograph exec gh pr view 42               # PR details + checks
kirograph exec gh issue list               # Compact issue listing
kirograph exec gh run list                 # Workflow run status

# Test Runners
kirograph exec jest                        # Failures only
kirograph exec vitest run                  # Failures only
kirograph exec playwright test             # E2E results (failures only)
kirograph exec pytest                      # Python tests (-90%)
kirograph exec go test ./...               # Go tests (-90%)
kirograph exec cargo test                  # Cargo tests (-90%)
kirograph exec rake test                   # Ruby minitest (-90%)
kirograph exec rspec                       # RSpec tests (-60%+)

# Build & Lint
kirograph exec eslint .                    # Grouped by rule/file
kirograph exec tsc --noEmit                # TypeScript errors grouped by file
kirograph exec next build                  # Next.js build compact
kirograph exec prettier --check .          # Files needing formatting
kirograph exec cargo build                 # Cargo build (-80%)
kirograph exec cargo clippy                # Cargo clippy (-80%)
kirograph exec ruff check                  # Python linting (-80%)
kirograph exec golangci-lint run           # Go linting (-85%)
kirograph exec rubocop                     # Ruby linting (-60%+)
kirograph exec biome check .               # Biome linting

# Files & Search
kirograph exec ls -la src/                 # Structured directory listing
kirograph exec find . -name "*.ts"         # Grouped by directory
kirograph exec tree                        # Truncated with summary
kirograph exec grep -r "pattern" .         # Grouped search results
kirograph exec rg "pattern"                # Grouped search results
kirograph exec diff file1 file2            # Condensed diff

# Package Managers
kirograph exec npm install                 # → "ok +5 packages"
kirograph exec npm list                    # Compact dependency tree
kirograph exec pip list                    # Python packages
kirograph exec pip install -r req.txt      # Strip progress bars
kirograph exec bundle install              # Strip "Using" lines
kirograph exec prisma generate             # Strip ASCII art

# AWS
kirograph exec aws sts get-caller-identity # One-line identity
kirograph exec aws ec2 describe-instances  # Compact instance list
kirograph exec aws lambda list-functions   # Name/runtime/memory
kirograph exec aws logs get-log-events ... # Timestamped messages only
kirograph exec aws cloudformation describe-stack-events ...  # Failures first
kirograph exec aws dynamodb scan ...       # Unwraps type annotations
kirograph exec aws iam list-roles          # Strips policy documents
kirograph exec aws s3 ls s3://bucket       # Truncated listing

# Containers
kirograph exec docker ps                   # Compact container list
kirograph exec docker images               # Compact image list
kirograph exec docker logs container       # Deduplicated logs
kirograph exec docker compose ps           # Compose services
kirograph exec kubectl get pods            # Compact pod list
kirograph exec kubectl logs pod            # Deduplicated logs
kirograph exec kubectl get svc             # Compact service list

# Network
kirograph exec curl https://api.example.com/data  # Strip progress/headers
kirograph exec wget https://example.com/file.zip  # Strip progress bars
```

Three compression levels:

| Level | Style |
|-------|-------|
| `normal` | Balanced: removes noise, keeps structure *(default)* |
| `aggressive` | More compact: groups by category, limits output |
| `ultra` | Maximum compression: counts and summaries only |

```bash
kirograph compression normal     # balanced (default)
kirograph compression aggressive # more compact
kirograph compression ultra      # maximum compression
kirograph compression off        # disable hook (tool still available)
kirograph compression            # show current level
```

Set during `kirograph install` (interactive arrow-key menu) or any time after. When set to anything other than `off`, a `preToolUse` hook reminds the agent to use `kirograph_exec` for supported commands. The configured level is used as the default when the agent doesn't specify one explicitly.

**Error preservation:** Failed commands always show full diagnostic output regardless of compression level. The engine detects error patterns and preserves detail when it matters.

**Token analytics:**

```bash
kirograph gain               # summary stats
kirograph gain --graph       # ASCII graph (last 30 days)
kirograph gain --history     # recent command history
kirograph gain --daily       # day-by-day breakdown
kirograph gain --json        # JSON export
```

The `kirograph_gain` MCP tool exposes the same stats to the agent.

### Savings Heuristics

`kirograph gain` tracks two types of savings: compression (measured exactly) and graph tools (estimated via heuristics). For graph tools, the system estimates what the agent *would have spent* doing the same work without KiroGraph, based on typical agent behavior:

| Tool | What the agent would do manually | Estimated naive cost |
|------|----------------------------------|---------------------|
| `kirograph_context` | Read 5-10 files to orient on a task | ~7,500-15,000 tokens |
| `kirograph_search` | Run grep + read top matches | ~3,300 tokens |
| `kirograph_callers` | Grep for symbol + read each calling file | ~8,300 tokens |
| `kirograph_callees` | Read function body + grep for each call | ~3,900 tokens |
| `kirograph_impact` | Recursive grep + read per depth level | ~6,900 × depth |
| `kirograph_node` | Read the full file containing the symbol | ~1,500 tokens |
| `kirograph_files` | Run `find` or `ls -R` | ~2,000 tokens |
| `kirograph_path` | Trace connections manually (multiple grep + read) | ~7,700 tokens |
| `kirograph_type_hierarchy` | Grep for extends/implements + read each file | ~5,400 tokens |
| `kirograph_dead_code` | Not feasible manually (read every file) | 5× output, min 15,000 |
| `kirograph_hotspots` | Not feasible manually (count edges for every symbol) | 5× output, min 15,000 |
| `kirograph_architecture` | Not feasible manually | 4× output, min 7,500 |
| `kirograph_mem_search` | Re-read 3-5 files to recall past decisions + grep | ~5,800 tokens |
| `kirograph_mem_timeline` | Ask user or re-read session history | ~2,300 tokens |
| `kirograph_data_list` | Run ls/find on data files + inspect each | ~3,500 tokens |
| `kirograph_data_describe` | Read the full data file to understand schema | ~45,000 tokens |
| `kirograph_data_query` | Read the full file and scan for matching rows | ~45,000 tokens |
| `kirograph_data_aggregate` | Read the full file + reason about aggregation | ~52,500 tokens |
| `kirograph_data_search` | Read file headers + grep for values | ~9,100 tokens |

Constants used: 1,500 tokens per average source file (~200 lines), 800 tokens per grep result set, 2,000 tokens per directory listing. These are conservative estimates; in practice agents often read more files, retry failed searches, and explore dead ends.

**Coexistence with Caveman Mode:** Compression and caveman mode are complementary, they compress different things. Caveman mode compresses the agent's *prose responses* (the text it writes around tool results); it never touches code or tool output. Shell compression compresses *shell command output* (the raw data coming back from shell commands); it never touches how the agent communicates. They stack: with both enabled, shell commands return 60-90% fewer tokens *and* the agent's explanations around those results are also shorter. Pick both independently during `kirograph install`. The "ultra + ultra" combo gives maximum token savings on both fronts.

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
- **Ca**: afferent coupling: how many packages depend on this one (higher = more stable)
- **Ce**: efferent coupling: how many packages this one depends on (higher = more unstable)
- **Instability** (`Ce / (Ca + Ce)`), rendered as a color-coded bar: green (stable) → yellow (neutral) → red (unstable)

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

Save lightweight graph snapshots and compare them to track structural changes over time, useful before/after refactors, or in CI to audit what a PR added or removed.

```bash
kirograph snapshot save [label]       # Save current graph state with optional label
kirograph snapshot save pre-refactor  # Named snapshot
kirograph snapshot list               # List all saved snapshots
kirograph snapshot diff               # Diff current graph vs latest snapshot
kirograph snapshot diff pre-refactor  # Diff current graph vs named snapshot
kirograph snapshot diff --format full # Show full added/removed symbol lists
kirograph snapshot diff --format json # JSON output
```

Snapshots are stored in `.kirograph/snapshots/` as JSON and include all node IDs and edge tuples. The diff is computed as a set operation, O(n) regardless of codebase size.

The `kirograph_diff` MCP tool exposes the same capability to the agent: compare the current graph against the latest (or a named) snapshot without leaving the conversation.

### Dead Code

Find unexported symbols with zero incoming references, candidates for removal.

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

### Memory *(requires `enableMemory: true`)*

Persistent cross-session observations — search, store, and manage project memory from the CLI.

```bash
# Search (mirrors kirograph_mem_search)
kirograph mem search "payment retry"              # hybrid FTS + vector search
kirograph mem search "auth bug" --kind error      # filter by kind
kirograph mem search "refactor" --limit 5         # limit results
kirograph mem search "token" --format json        # JSON output

# Store (mirrors kirograph_mem_store)
kirograph mem store "decided to use idempotency keys for payments"
kirograph mem store "auth bug: token refresh missing" --kind error
kirograph mem store --kind decision < decision.txt   # pipe from stdin

# Timeline (mirrors kirograph_mem_timeline)
kirograph mem timeline                    # last 5 sessions
kirograph mem timeline --limit 10         # more sessions
kirograph mem timeline --session <id>     # specific session
kirograph mem timeline --format json

# Status (mirrors kirograph_mem_status)
kirograph mem status                      # health dashboard

# Maintenance
kirograph mem prune --older-than 90d      # cleanup old observations
kirograph mem export --format jsonl       # machine-readable export (importable)
kirograph mem export --format md          # human-readable export
kirograph mem import backup.jsonl         # restore from backup (deduplicates)
kirograph mem reembed                     # re-embed after model change
kirograph mem reembed --batch 50          # control batch size
kirograph mem lint                        # find stale links, model mismatch
kirograph mem lint --fix                  # auto-repair issues
```

**How observations are stored:** Text → strip `<private>` blocks → caveman compress (if enabled) → SHA-256 dedup check → store → detect symbol identifiers → link to graph → embed. Zero LLM tokens.

**How observations surface:** `kirograph_context` and `kirograph_impact` automatically include relevant memory observations (max 3, above relevance threshold 0.3) when memory is enabled. No extra tool call needed.

### Documentation *(requires `enableDocs: true`)*

Section-level documentation navigation — search, browse, and retrieve doc sections from the CLI.

```bash
# Table of contents
kirograph docs toc                          # whole project
kirograph docs toc README.md                # single file
kirograph docs toc README.md --tree         # nested tree structure
kirograph docs toc --json                   # JSON output

# Search (mirrors kirograph_docs_search)
kirograph docs search "authentication"
kirograph docs search "config" --file docs/guide.md
kirograph docs search "install" --limit 5

# Retrieve a section (mirrors kirograph_docs_section)
kirograph docs section "README.md::installation#1"
kirograph docs section "README.md::installation#1" --context

# Outline (mirrors kirograph_docs_outline)
kirograph docs outline docs/api.md

# Cross-references (mirrors kirograph_docs_refs)
kirograph docs refs "docs/auth.md::oauth/token-refresh#2"

# Maintenance
kirograph docs reindex                      # force full re-index
kirograph docs lint                         # health checks (broken refs, stale sections)
kirograph docs reembed                      # re-embed with current model
```

**How sections are identified:** Each section gets a stable ID in the format `{file_path}::{ancestor-chain/slug}#{level}`. IDs remain stable across re-indexing as long as the file path, heading text, heading level, and parent chain don't change.

**How code linking works:** When `docsLinkCode: true` (default), the indexer scans section content for backtick references (`` `functionName` ``), CamelCase identifiers, and snake_case patterns, then resolves them against the code graph. Matches are stored as `doc_code_refs` using `qualified_name` (stable across reindex).

### Data *(requires `enableData: true`)*

Tabular data navigation — list, describe, query, aggregate, search, join, correlate, and inspect data quality from the CLI.

```bash
# List datasets
kirograph data list                         # all indexed datasets
kirograph data list --json                  # JSON output

# Describe schema
kirograph data describe tests-fixtures-users           # full schema + column profiles + validation rules + sample hints
kirograph data describe tests-fixtures-users --column email  # deep dive on one column
kirograph data describe tests-fixtures-users --json

# Query rows
kirograph data query orders --filter status:eq:shipped --limit 10
kirograph data query users --filter age:gt:18 --columns name,email
kirograph data query products --filter price:between:10:50 --json

# Aggregate
kirograph data aggregate orders --group-by region --metric sum:amount
kirograph data aggregate users --group-by role --metric count:id --metric avg:age
kirograph data aggregate orders --group-by status --metric count_distinct:customer_id --json

# Search columns
kirograph data search orders "price"        # find columns matching "price"
kirograph data search users "email"         # find columns matching "email"

# Join two datasets
kirograph data join users orders --left-col id --right-col user_id
kirograph data join users orders --left-col id --right-col user_id --type left --limit 50

# Correlations
kirograph data correlations sales-data                  # Pearson correlations between numeric columns
kirograph data correlations sales-data --threshold 0.5  # only strong correlations

# Quality
kirograph data quality orders               # rank columns by risk (null rate, cardinality anomalies)

# History & drift
kirograph data history orders               # show schema change history
kirograph data drift orders                 # compare last two indexes (added/removed/changed columns)

# Indexing
kirograph data index                        # incremental index (skips unchanged files)
kirograph data reindex                      # force re-index all data files

# Maintenance
kirograph data lint                         # validate index integrity (row counts, stale files, missing deps)
```

**How datasets are identified:** Each data file gets a stable ID derived from its relative path: `tests/fixtures/users.csv` → `tests-fixtures-users`. IDs remain stable across re-indexing.

**Filter format (CLI):** `column:op:value` — e.g. `age:gt:18`, `status:eq:active`, `price:between:10:50`. Multiple `--filter` flags are ANDed.

**Metric format (CLI):** `op:column` — e.g. `sum:amount`, `avg:price`, `count:id`, `count_distinct:customer_id`.

**How code linking works:** When `dataLinkCode: true` (default), the indexer scans source files for references to data file paths (`readFileSync('data/users.csv')`, `pd.read_csv(...)`, SQL `COPY FROM`, etc.) and stores matches in `data_code_refs`. This enables test fixture awareness in `kirograph affected` and dataset schema enrichment in `kirograph_context`.

### Graph Export

Export the full graph as an interactive dashboard. three files served from a local directory, no server required, works offline.

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
- **Click a node** to zoom in and inspect it. kind, file, line, degree, signature, and a copy button for the file reference
- **Click two nodes** to instantly find and highlight the shortest path between them, with detail cards for both endpoints
- **History**: ‹ › navigation through previously inspected nodes
- **Keyboard shortcuts**: `f` to fit the graph, `Esc` to exit focus or path mode

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

- **Node kind filter**: Legend tab; click any kind to hide or show all nodes of that type
- **Edge kind filter**: Legend tab; click any edge kind to hide or show edges of that type
- **Degree slider**: Filters tab; hide nodes below N connections to surface the most-connected symbols

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
| **Line** | How many symbols have each connection count. reveals the overall connectivity shape of the graph |


### Dashboard

When `semanticEngine` is set to `qdrant` or `typesense`, use these commands to manage the background server and its dashboard UI.

```bash
kirograph dashboard start [path]   # Start server (if not running) and open dashboard
kirograph dashboard stop [path]    # Stop the running engine server
```

**`dashboard start`**

Reads `semanticEngine` from `.kirograph/config.json` and dispatches accordingly:

- **qdrant**: Downloads the [Qdrant Web UI](https://github.com/qdrant/qdrant-web-ui) on first use (cached at `.kirograph/qdrant/dashboard/`), spawns the Qdrant server with `QDRANT__SERVICE__STATIC_CONTENT_DIR` set so the dashboard is served natively, and opens `http://127.0.0.1:<port>/dashboard` in your browser. If the server is already running with the dashboard, reconnects instead of restarting.
- **typesense**: Downloads the [Typesense Dashboard](https://github.com/bfritscher/typesense-dashboard) static UI on first use (cached at `.kirograph/typesense/dashboard/`), starts the Typesense server if not already running, serves the dashboard locally via a Node HTTP server, and opens it in your browser. Press Ctrl+C to stop the dashboard server. the Typesense server keeps running as a background daemon.

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
| **Indexing** | | | |
| `languages` | string[] | `[]` | Limit indexing to specific languages (empty = all) |
| `include` | string[] | `[]` | Glob patterns to include (empty = include everything not excluded) |
| `exclude` | string[] | see below | Glob patterns to exclude |
| `maxFileSize` | number | `1048576` | Skip files larger than this (bytes) |
| `extractDocstrings` | boolean | `true` | Extract JSDoc, docstrings, and comments |
| `trackCallSites` | boolean | `true` | Record line/column for call edges |
| `frameworkHints` | string[] | auto | Override framework detection (e.g. `["react", "express"]`) |
| `fuzzyResolutionThreshold` | number | `0.5` | Name matching threshold for cross-file resolution (0.0–1.0) |
| `syncWarningThreshold` | number | `10` | Warn in `kirograph_status` when pending files exceed this count |
| **Semantic Search** | | | |
| `enableEmbeddings` | boolean | `false` | Generate semantic embeddings (opt-in) |
| `embeddingModel` | string | `nomic-ai/nomic-embed-text-v1.5` | HuggingFace `feature-extraction` model ID |
| `embeddingDim` | number | `768` | Output dimension of the chosen embedding model |
| `semanticEngine` | string | `cosine` | Engine: `cosine`, `sqlite-vec`, `orama`, `pglite`, `lancedb`, `qdrant`, `typesense` |
| `useVecIndex` | boolean | `false` | Deprecated alias for `semanticEngine: "sqlite-vec"` |
| `typesenseDashboard` | boolean | `false` | Open Typesense dashboard after indexing |
| `qdrantDashboard` | boolean | `false` | Open Qdrant dashboard after indexing |
| **Architecture** | | | |
| `enableArchitecture` | boolean | `false` | Enable architecture analysis (package graph + layer detection) |
| `architectureLayers` | object | - | Custom layer definitions: `{ "layerName": ["glob/**"] }` |
| **Memory** | | | |
| `enableMemory` | boolean | `false` | Enable persistent cross-session memory |
| `memorySearchAlpha` | number | `0.5` | Blend weight for hybrid search (0 = FTS only, 1 = vector only) |
| `memoryKeepRaw` | boolean | `true` | Store original text alongside compressed version |
| `memoryMaxObservations` | number | `10000` | Max observations before auto-pruning oldest |
| `memorySessionTimeout` | number | `3600000` | Session timeout in ms (default 1 hour) |
| `memoryContextLimit` | number | `3` | Max observations surfaced in `kirograph_context` |
| `memoryContextThreshold` | number | `0.3` | Min relevance score to surface in context |
| `memoryExcludePatterns` | string[] | `[]` | Glob patterns for files to exclude from symbol linking |
| **Documentation** | | | |
| `enableDocs` | boolean | `false` | Enable documentation indexing (section-level retrieval) |
| `docsInclude` | string[] | `["**/*.md", ...]` | Glob patterns for doc files to include |
| `docsExclude` | string[] | `["node_modules/**", ...]` | Glob patterns for doc files to exclude |
| `docsLinkCode` | boolean | `true` | Auto-link doc sections to code symbols |
| `docsContextLimit` | number | `0` | Max doc sections in `kirograph_context` (0 = disabled) |
| `docsContextThreshold` | number | `0.5` | Min confidence for doc refs in context |
| `docsMaxFileSize` | number | `1048576` | Max doc file size in bytes |
| `docsSummarization` | string | `first-sentence` | Summary strategy: `embedding`, `first-sentence`, `off` |
| **Data** | | | |
| `enableData` | boolean | `false` | Enable tabular data indexing and querying |
| `dataInclude` | string[] | `["**/*.csv", ...]` | Glob patterns for data files to include |
| `dataExclude` | string[] | `["node_modules/**", ...]` | Glob patterns for data files to exclude |
| `dataLinkCode` | boolean | `true` | Auto-link data files to code symbols via path detection |
| `dataContextLimit` | number | `0` | Max datasets in `kirograph_context` (0 = disabled) |
| `dataMaxFileSize` | number | `52428800` | Max data file size in bytes (50MB) |
| `dataMaxRows` | number | `1000000` | Max rows to index per file |
| `dataQueryLimit` | number | `500` | Max rows returned per query (hard cap) |
| `dataMaxResponseTokens` | number | `8000` | Max token budget per data tool response |
| **Agent Behavior** | | | |
| `cavemanMode` | string | `off` | Communication style: `off`, `lite`, `full`, `ultra` |
| `shellCompressionLevel` | string | `normal` | Shell compression: `off`, `normal`, `aggressive`, `ultra` |
| `minLogLevel` | string | `warn` | Log level: `debug`, `info`, `warn`, `error` |

Default exclude patterns: `node_modules/**`, `dist/**`, `build/**`, `.git/**`, `*.min.js`, `.kirograph/**`

### Semantic Search (Optional)

By default, KiroGraph uses exact name lookup and full-text search. Enable semantic search for natural-language queries:

```json
{
  "enableEmbeddings": true
}
```

This generates vector embeddings for all functions, methods, classes, interfaces, type aliases, components, and modules using a local embedding model (downloaded automatically to `~/.kirograph/models/` on first use). Embeddings are kept in sync automatically via the Kiro `agentStop` hook, which syncs the index (including embeddings) whenever files change during a session.

Run `kirograph install` to be guided through model and engine selection interactively with arrow-key menus, or set the fields manually in `.kirograph/config.json`.

#### Embedding models

`kirograph install` offers a curated selection of models compatible with `@huggingface/transformers`:

| Model | Dim | Size | Notes |
|-------|-----|------|-------|
| `nomic-ai/nomic-embed-text-v1.5` | 768 | ~130MB | **Default.** Best quality for code search. |
| `onnx-community/embeddinggemma-300m-ONNX` | 768 | ~300MB | Google Gemma-based. Multilingual, 2048-token context window. |
| `Xenova/all-MiniLM-L6-v2` | 384 | ~23MB | Lightweight, fast. Lower accuracy. |
| `BAAI/bge-base-en-v1.5` | 768 | ~110MB | Strong general-purpose alternative to nomic. |
| Custom | any | - | Any HuggingFace `feature-extraction` model. Provide ID + output dimension. |

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

Each engine owns its embedding store exclusively. there is no redundant write to the main graph database:

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
| `cosine` *(default)* | Exact cosine, linear scan | none | - | Small / medium projects, zero setup |
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

Approximate nearest-neighbour (ANN) index stored in `.kirograph/vec.db`. Sub-linear search time. ideal for large codebases with thousands of indexed symbols. The SQLite `vectors` table is not written to; `vec.db` is the sole embedding store.

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

Hybrid search powered by [Orama](https://github.com/oramasearch/orama). combines full-text relevance and vector similarity in a **single query**, producing higher-quality results than running the two searches separately. The index is persisted to `.kirograph/orama.json` and is the sole embedding store. Pure JS, no native compilation required.

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

Hybrid search powered by [PGlite](https://github.com/electric-sql/pglite), a WASM-compiled PostgreSQL with the [pgvector](https://github.com/pgvector/pgvector) extension. Combines **exact** nearest-neighbour vector search with full-text ranking (`ts_rank`) in a single SQL query. The database is persisted to `.kirograph/pglite/` using PostgreSQL's WAL-based storage and is the sole embedding store. Pure WASM, no native compilation required.

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
- **Exact** vector results (not approximate). deterministic and reproducible
- Native SQL `ON CONFLICT` upsert, no remove+insert workaround
- HNSW index (`vector_cosine_ops`) keeps search fast as the index grows
- Single dependency, zero native binaries

If not installed, falls back to `cosine`.

#### LanceDB

ANN vector search powered by [LanceDB](https://github.com/lancedb/lancedb). stores embeddings in Apache Lance columnar format at `.kirograph/lancedb/`. Sub-linear search time using cosine distance. Pure JS, no native compilation required.

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
- **Columnar storage** (Apache Lance format). efficient for batch reads and writes
- **ANN cosine search**: fast, sub-linear query time
- Pure JS, no native binaries or WASM required

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
- **HNSW index**: high-quality ANN search with Qdrant's native indexing
- **Embedded binary**: no separate server setup; the process is spawned and managed automatically
- **Persistent daemon**: the server stays running between `kg` commands; state tracked in `.kirograph/qdrant-server.json`
- **Built-in dashboard**: run `kg dashboard start` to download the [Qdrant Web UI](https://github.com/qdrant/qdrant-web-ui) and open it (cached at `.kirograph/qdrant/dashboard/`, served via Qdrant's built-in static content feature)
- **Async startup**: polls `/readyz` instead of blocking with a fixed sleep
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
- **HNSW index**: high-quality ANN search with Typesense's native indexing
- **Auto-downloaded binary**: no manual server setup; the binary is fetched and cached at `~/.kirograph/bin/` on first run
- **Persistent daemon**: the server stays running between `kg` commands; state tracked in `.kirograph/typesense-server.json`
- **Local dashboard**: run `kg dashboard start` to open the built-in Typesense Dashboard UI (served locally, cached at `.kirograph/typesense/dashboard/`)
- **Async startup**: polls `/health` instead of blocking with a fixed sleep
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

**Packages**: logical groupings of files. Detected two ways:

1. **Manifest-based**: parsed from `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`/`setup.py`/`setup.cfg`, `pom.xml`, `build.gradle`/`build.gradle.kts`, and `.csproj` files. Produces IDs like `pkg:npm:src/auth`.
2. **Directory fallback**: for files not covered by any manifest, groups them by their nearest ancestor directory. Produces IDs like `pkg:dir:src/utils`.

**Layers**: architectural tiers detected from file paths using per-language glob patterns:

| Layer | Examples |
|-------|---------|
| `api` | `**/controllers/**`, `**/routes/**`, `**/handlers/**`, `**/api/**` |
| `service` | `**/services/**`, `**/usecases/**`, `**/domain/**` |
| `data` | `**/repositories/**`, `**/models/**`, `**/db/**`, `**/migrations/**` |
| `ui` | `**/components/**`, `**/views/**`, `**/pages/**`, `**/screens/**` |
| `shared` | `**/utils/**`, `**/helpers/**`, `**/lib/**`, `**/common/**` |

Layer detection is per-language (TypeScript/JS, Python, Go, Java, Ruby, Rust, C#) with framework-specific patterns where applicable (Django, Rails, Spring MVC, ASP.NET, etc.). Custom layer overrides are supported via `architectureLayers` in config.

**Package dependencies**: rolled up from existing `imports` edges in the graph. No re-parsing required.

**Coupling metrics**: computed per package:
- **Ca** (afferent). how many other packages depend on this one
- **Ce** (efferent). how many packages this one depends on
- **Instability** (`Ce / (Ca + Ce)`): 0 = maximally stable (everyone depends on it, it depends on nothing), 1 = maximally unstable (depends on everything, nobody depends on it)

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

### General-purpose

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
| Scala | `.scala`, `.sc`, `.sbt` |
| Lua | `.lua` |
| Zig | `.zig`, `.zon` |
| Bash | `.sh`, `.bash`, `.zsh` |
| OCaml | `.ml`, `.mli` |
| Elm | `.elm` |
| Objective-C | `.m` |

### Frontend & UI

| Language | Extensions |
|----------|-----------|
| React / React Native | `.tsx`, `.jsx` (via TypeScript/JSX grammars) |
| Next.js | `.tsx`, `.jsx` (via TypeScript/JSX grammars) |
| Angular | `.ts`, `.html` (via TypeScript/HTML grammars) |
| Svelte | `.svelte` |
| Vue | `.vue` |
| HTML | `.html`, `.htm` |
| CSS | `.css` |
| SCSS / Sass | `.scss`, `.sass` |

### Domain-specific

| Language | Domain | Extensions |
|----------|--------|-----------|
| Solidity | Blockchain / Web3 | `.sol` |
| Elixir | Distributed systems / Real-time | `.ex`, `.exs` |

### Configuration & Infrastructure

| Language | Extensions |
|----------|-----------|
| YAML | `.yaml`, `.yml` |
| HCL (Terraform) | `.tf`, `.tfvars` |

## Framework Detection

KiroGraph automatically detects frameworks and enriches the graph with framework-specific semantics (routes, components, lifecycle methods):

### Web Frameworks

**JavaScript / TypeScript:** React, Next.js, React Native, Angular, Svelte, SvelteKit, Express, Fastify, Koa

**Vue:** Vue, Nuxt

**Python:** Django, Flask, FastAPI

**Ruby:** Rails

**Java:** Spring, Spring Boot, Spring MVC

**Scala:** Play, Akka HTTP, http4s

**Go:** generic Go resolver

**Rust:** generic Rust resolver

**C#:** ASP.NET Core

**Swift:** SwiftUI, UIKit, Vapor

**PHP:** Laravel

**Elixir:** Phoenix

**Solidity:** Hardhat, Foundry, Truffle (OpenZeppelin patterns)

### Infrastructure as Code

AWS CDK, SST, Serverless Framework, AWS SAM, Terraform / OpenTofu, Pulumi, CloudFormation, AWS Amplify Gen 2

### Containers & Orchestration

Kubernetes, Helm, Docker Compose

### Configuration Management

Ansible

Detected frameworks are stored in config and used to improve symbol extraction and resolution.

## Credits

KiroGraph is inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) by [Colby McHenry](https://www.linkedin.com/in/colby-mchenry/). the original concept of building a semantic code graph for AI coding agents comes from his work.

### Inspirations

- [cavemem](https://github.com/JuliusBrussee/cavemem) by [Julius Brussee](https://www.linkedin.com/in/julius-brussee/): the memory module's hook-based observation capture, deterministic compression, and SQLite storage pattern.
- [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/): the documentation module's section-first retrieval approach, stable section IDs, and byte-offset addressing.
- [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/): the data module's column profiling, streaming parsers, and server-side aggregation approach.

### Contributors

- [Alessandro Franceschi](https://www.linkedin.com/in/alessandrofranceschi/). Claude Code and Codex integration, Elixir/Phoenix language and framework support.
- [Mauro Argo](https://www.linkedin.com/in/argomauro/). original idea for the architecture layer analysis feature.

## Requirements

- Node.js >= 18
- Kiro IDE (fully supported)
- Other MCP-capable tools (experimental. see [Other Tools](#other-tools-experimental))

## License

MIT
