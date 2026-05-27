# Gap Analysis Plan: KiroGraph vs code-review-graph

## Summary

Based on the feature comparison, code-review-graph (CRG) has 8 features that KiroGraph lacks. This plan prioritizes them by impact and feasibility, with implementation guidance for each.

---

## Gap Inventory

| # | CRG Feature | KiroGraph Status | Impact | Effort |
|---|-------------|-----------------|--------|--------|
| 1 | Execution flow tracing | ❌ Missing | High | Medium |
| 2 | Community/cluster detection (Leiden) | ❌ Missing | High | Large |
| 3 | Edge confidence scoring | ❌ Missing | Medium | Small |
| 4 | Refactoring suggestions | ❌ Missing | Medium | Medium |
| 5 | Rename preview | ❌ Missing | Medium | Medium |
| 6 | Estimated context savings | ❌ Missing | Low | Small |
| 7 | Reproducible benchmarks | ❌ Missing | Low | Medium |
| 8 | MCP prompts/workflow templates | ❌ Missing | Medium | Small |
| 9 | Graph export (Neo4j Cypher, Obsidian) | ❌ Missing | Low | Small |

---

## Phase 1: Execution Flow Tracing

**What CRG does:** Traces call chains from entry points (e.g., HTTP handlers, main functions), sorted by weighted criticality. Shows the full execution path a request takes through the system.

**Why it matters:** Agents need to understand runtime behavior, not just static structure. "How does a request reach the database?" is a common question that callers/callees alone can't answer efficiently — you need the full chain.

**Implementation plan:**

### New MCP tool: `kirograph_flows`

```typescript
// Parameters:
// - entryPoint: string (symbol name or "auto" to detect entry points)
// - maxDepth: number (default 10)
// - projectPath: string

// Returns: ordered list of call chains from entry points,
// each hop with symbol name, file, line, and edge type
```

### How to build it:

1. **Entry point detection** — Identify symbols that are likely entry points:
   - Functions with no incoming `call` edges (roots)
   - Symbols matching known patterns: `main`, `handler`, `controller`, route handlers
   - Symbols in files matching framework patterns (e.g., `routes/*.ts`, `pages/*.tsx`)

2. **Forward BFS from entry points** — Walk outgoing `call` edges depth-first, recording the path. Stop at max depth or when hitting a cycle.

3. **Criticality scoring** — Weight each flow by:
   - Number of downstream dependents (fan-out)
   - Whether it touches external I/O (DB, HTTP, file system)
   - Whether it's covered by tests (from `affected tests` data)

4. **Output format** — Return flows as ordered arrays of hops:
   ```json
   {
     "flows": [
       {
         "entryPoint": "handleLogin",
         "criticality": 0.85,
         "hops": [
           { "symbol": "handleLogin", "file": "src/auth/handler.ts", "line": 42 },
           { "symbol": "validateCredentials", "file": "src/auth/validate.ts", "line": 15 },
           { "symbol": "queryUser", "file": "src/db/users.ts", "line": 88 }
         ]
       }
     ]
   }
   ```

### Files to create/modify:
- `src/graph/flows.ts` — Flow detection and traversal logic
- `src/mcp/tools.ts` — Register `kirograph_flows` tool
- `src/mcp/tool-names.ts` — Add to tool names list

### Estimated effort: 2-3 days

---

## Phase 2: Community/Cluster Detection

**What CRG does:** Uses the Leiden algorithm to cluster related code into communities. Oversized communities (>25% of graph) are recursively split. Communities power architecture overview, wiki generation, and refactoring suggestions.

**Why it matters:** Understanding which code belongs together is fundamental for architecture questions. "What are the main modules?" and "Which files are tightly coupled?" are answered instantly with communities.

**Implementation plan:**

### New MCP tool: `kirograph_communities`

```typescript
// Parameters:
// - projectPath: string
// - resolution: number (default 1.0, higher = more communities)

// Returns: list of communities with member symbols, inter-community edges,
// and coupling metrics
```

### How to build it:

1. **Graph construction** — Build an undirected weighted graph from the existing edges table. Weight = number of edges between two symbols (calls + imports + references).

2. **Leiden algorithm** — Implement or port a Leiden community detection algorithm. Options:
   - Port from CRG's Python implementation (it uses `igraph` with Leiden)
   - Use a JS implementation of Louvain (simpler, similar results) as a starting point
   - Consider `graphology` npm package which has community detection

3. **Auto-split** — If any community exceeds 25% of total nodes, recursively apply Leiden to that subgraph with higher resolution.

4. **Community metadata** — For each community, compute:
   - Member count and list of top symbols
   - Dominant language/directory
   - Inter-community edge count (coupling)
   - A generated label (most common directory prefix or dominant class name)

5. **Storage** — Add `community_id` column to the nodes table, plus a `communities` table with metadata.

### Files to create/modify:
- `src/graph/communities.ts` — Leiden/Louvain implementation
- `src/db/schema.sql` — Add community tables
- `src/mcp/tools.ts` — Register `kirograph_communities` tool
- `src/mcp/tool-names.ts` — Add to tool names list

### Estimated effort: 5-7 days

---

## Phase 3: Edge Confidence Scoring

**What CRG does:** Three-tier confidence scoring on edges: EXTRACTED (directly from AST), INFERRED (resolved via heuristics like name matching), AMBIGUOUS (multiple possible targets). Each edge also has a float confidence score.

**Why it matters:** When the agent traces a call chain, knowing whether a hop is certain (extracted from AST) or guessed (inferred from naming conventions) helps it decide whether to verify the connection by reading the actual code.

**Implementation plan:**

### Schema change:

```sql
ALTER TABLE edges ADD COLUMN confidence TEXT DEFAULT 'extracted';
-- Values: 'extracted', 'inferred', 'ambiguous'
ALTER TABLE edges ADD COLUMN confidence_score REAL DEFAULT 1.0;
-- Range: 0.0 to 1.0
```

### How to build it:

1. **During extraction** — Edges created directly from tree-sitter AST queries get `confidence = 'extracted'`, `confidence_score = 1.0`.

2. **During resolution** — Edges created by the name-matcher resolution pass get:
   - `confidence = 'inferred'` if there's exactly one match
   - `confidence = 'ambiguous'` if there are multiple possible targets
   - `confidence_score` = 1.0 / number_of_candidates (so a unique match = 1.0, two candidates = 0.5)

3. **Expose in tool output** — Include confidence in `kirograph_callers`, `kirograph_callees`, `kirograph_impact` results so the agent can see which hops are certain vs guessed.

### Files to modify:
- `src/db/schema.sql` — Add columns
- `src/db/database.ts` — Update edge insertion to include confidence
- `src/extraction/extractor.ts` — Set confidence = 'extracted' for AST edges
- `src/resolution/index.ts` — Set confidence = 'inferred'/'ambiguous' for resolved edges
- `src/graph/queries.ts` — Include confidence in query results
- `src/mcp/tools.ts` — Include confidence in tool responses

### Estimated effort: 1-2 days

---

## Phase 4: Refactoring Suggestions

**What CRG does:** Three modes:
- `suggest` — Community-driven refactoring suggestions (e.g., "these 5 functions in 3 different files all belong to the same community — consider grouping them")
- `dead_code` — Framework-aware dead code detection (already in KiroGraph)
- `rename` — Preview all locations that would change if a symbol is renamed

**Why it matters:** Agents doing refactoring need to know what's safe to move and what the blast radius of a rename would be. This is especially useful for large codebases.

**Implementation plan:**

### New MCP tool: `kirograph_refactor`

```typescript
// Parameters:
// - mode: 'suggest' | 'rename'
// - symbol?: string (required for rename mode)
// - projectPath: string

// Returns:
// - suggest mode: list of refactoring opportunities with rationale
// - rename mode: list of all files/lines that reference the symbol
```

### How to build it:

1. **Suggest mode** (depends on Phase 2 — communities):
   - Find symbols that are in a different directory than most of their community members
   - Find files with high fan-out to a single other community (candidate for moving)
   - Find large files with symbols in multiple communities (candidate for splitting)

2. **Rename mode:**
   - Find the target symbol by name
   - Collect all incoming edges (callers, importers, references)
   - For each referencing symbol, report the file and line where the reference occurs
   - Group by file for a clean edit preview

### Files to create/modify:
- `src/graph/refactor.ts` — Refactoring logic
- `src/mcp/tools.ts` — Register `kirograph_refactor` tool
- `src/mcp/tool-names.ts` — Add to tool names list

### Estimated effort: 3-4 days (suggest mode depends on Phase 2)

---

## Phase 6: Estimated Context Savings

**What CRG does:** On every `detect_changes` and review output, attaches a compact `context_savings` metadata block showing how many tokens the graph saved vs reading the full files.

**Why it matters:** Users want to see the ROI of the graph. Showing "graph query: 2,400 tokens vs full file read: 48,000 tokens (95% savings)" builds trust and justifies the tool.

**Implementation plan:**

### How to build it:

1. **Token estimation** — Estimate tokens for the files that would have been read without the graph (simple heuristic: chars / 4).

2. **Attach to responses** — On `kirograph_context`, `kirograph_impact`, and `kirograph_callers` responses, include:
   ```json
   {
     "context_savings": {
       "graph_tokens": 2400,
       "naive_tokens": 48000,
       "savings_pct": 95
     }
   }
   ```

3. **Accumulate in `kirograph_gain`** — The existing gain tracking tool already tracks savings. Extend it to include per-call savings from graph tools.

### Files to modify:
- `src/mcp/tools.ts` — Add savings calculation to relevant tool responses
- `src/compression/tracker.ts` — Extend to track graph tool savings

### Estimated effort: 1 day

---

## Phase 7: Reproducible Benchmarks

**What CRG does:** An automated evaluation runner against real open-source repositories (pinned SHAs). Measures token efficiency, impact accuracy, build performance. Results are deterministic across machines.

**Why it matters:** Claims like "fewer tool calls" and "token savings" need evidence. Reproducible benchmarks let users verify claims and track regressions.

**Implementation plan:**

### How to build it:

1. **Benchmark config** — A JSON file defining test repos with pinned commits:
   ```json
   {
     "benchmarks": [
       { "repo": "https://github.com/expressjs/express", "sha": "abc123", "questions": [...] }
     ]
   }
   ```

2. **Runner** — A CLI command `kirograph benchmark` that:
   - Clones each repo at the pinned SHA
   - Indexes it
   - Runs a set of predefined queries
   - Measures: tokens in response, files that would have been read, time taken

3. **Report** — Outputs a markdown table comparing graph-query tokens vs naive-read tokens.

### Files to create:
- `benchmarks/config.json` — Benchmark definitions
- `src/bin/commands/benchmark.ts` — CLI command
- `benchmarks/README.md` — How to run and interpret results

### Estimated effort: 3-4 days

---

## Phase 8: MCP Prompts / Workflow Templates

**What CRG does:** Ships 5 built-in MCP prompt templates (review, architecture, debug, onboard, pre-merge) that agents can invoke as structured workflows. Each template guides the agent through a multi-step process using the graph tools.

**Why it matters:** Agents perform better with structured recipes. Instead of figuring out which tools to call in what order, the agent picks a workflow template and follows it. This reduces hallucination and produces more consistent results.

**Implementation plan:**

### Approach: Task-specific steering files

KiroGraph already has a steering system (`.kiro/steering/`). Extend it with task-specific workflow files that agents can reference:

```
.kiro/steering/kirograph.md              # General (already exists)
.kiro/steering/kirograph-review.md       # Code review workflow
.kiro/steering/kirograph-debug.md        # Debug workflow
.kiro/steering/kirograph-architecture.md # Architecture exploration
.kiro/steering/kirograph-onboard.md      # Onboarding workflow
.kiro/steering/kirograph-refactor.md     # Refactoring workflow
```

Each file uses Kiro's `inclusion: manual` frontmatter so users invoke them with `#kirograph-review` in chat.

### Workflow content (per file):

1. **Review** (`kirograph-review.md`):
   - Step 1: `kirograph_context` with the task description
   - Step 2: `kirograph_impact` on changed symbols
   - Step 3: Check test coverage via affected tests
   - Step 4: Produce risk-scored findings

2. **Debug** (`kirograph-debug.md`):
   - Step 1: `kirograph_search` for symbols related to the error
   - Step 2: `kirograph_callers` / `kirograph_callees` to trace the chain
   - Step 3: `kirograph_impact` to understand blast radius
   - Step 4: Check recent changes via `kirograph_diff`

3. **Architecture** (`kirograph-architecture.md`):
   - Step 1: `kirograph_architecture` for package overview
   - Step 2: `kirograph_coupling` for dependency metrics
   - Step 3: `kirograph_hotspots` for most-connected symbols
   - Step 4: `kirograph_surprising` for unexpected coupling

4. **Onboard** (`kirograph-onboard.md`):
   - Step 1: `kirograph_status` for project overview
   - Step 2: `kirograph_files` for structure
   - Step 3: `kirograph_hotspots` for key entry points
   - Step 4: `kirograph_context` for specific areas of interest

5. **Refactor** (`kirograph-refactor.md`):
   - Step 1: `kirograph_impact` on the target symbol
   - Step 2: `kirograph_callers` to find all dependents
   - Step 3: `kirograph_circular_deps` to check for cycles
   - Step 4: `kirograph_dead_code` to find cleanup opportunities

### For non-Kiro targets:

Generate equivalent files in each target's format:
- Claude Code: `.claude/skills/` directory with skill markdown files
- Gemini CLI: `.gemini/skills/` directory
- Cursor: Additional `.cursor/rules/` files
- Others: Include in the generated instructions markdown

### Files to create/modify:
- `src/bin/installer/steering.ts` — Generate workflow-specific steering files
- `src/bin/installer/targets/*.ts` — Generate platform-native equivalents for non-Kiro targets

### Estimated effort: 2-3 days

---

## Phase 9: Graph Export (Neo4j Cypher, Obsidian)

**What CRG does:** Exports the graph in multiple formats:
- **GraphML** — For Gephi/yEd visualization
- **Neo4j Cypher** — Import into Neo4j for advanced graph queries
- **Obsidian vault** — Markdown files with wikilinks for knowledge exploration
- **SVG** — Static graph image

KiroGraph already has an interactive HTML dashboard export. These additional formats serve different use cases.

**Why it matters:** Users who want to explore the graph outside the MCP tools benefit from standard formats. Neo4j enables complex graph queries. Obsidian creates a browsable knowledge base. GraphML works with any graph visualization tool.

**Implementation plan:**

### New CLI command options:

```bash
kirograph export --format html       # Already exists (interactive dashboard)
kirograph export --format graphml    # New: Gephi/yEd compatible
kirograph export --format cypher     # New: Neo4j import script
kirograph export --format obsidian   # New: Markdown vault with wikilinks
kirograph export --format svg        # New: Static graph image
```

### How to build each:

1. **GraphML** — XML format. Each node becomes a `<node>` element with attributes (kind, name, file, line). Each edge becomes an `<edge>` with type attribute. Libraries: none needed, just XML string building.

2. **Neo4j Cypher** — Generate a `.cypher` file with `CREATE` statements:
   ```cypher
   CREATE (n:Function {name: 'handleLogin', file: 'src/auth.ts', line: 42});
   CREATE (n)-[:CALLS]->(m);
   ```

3. **Obsidian vault** — One markdown file per symbol (or per file). Wikilinks connect related symbols:
   ```markdown
   # handleLogin
   - File: src/auth.ts:42
   - Kind: function
   - Calls: [[validateCredentials]], [[queryUser]]
   - Called by: [[authRouter]]
   ```

4. **SVG** — Use a simple force-directed layout algorithm (or just a hierarchical layout) to position nodes, then render as SVG paths and text elements. No external dependencies needed.

### Files to create/modify:
- `src/bin/commands/export.ts` — Add `--format` option (may already exist)
- `src/core/export-graphml.ts` — GraphML serializer
- `src/core/export-cypher.ts` — Neo4j Cypher generator
- `src/core/export-obsidian.ts` — Obsidian vault generator
- `src/core/export-svg.ts` — SVG renderer

### Estimated effort: 3-4 days

---

## Execution Priority

> **P0** = do first (quick wins), **P1** = high impact, **P2** = important but larger, **P3** = depends on earlier phases

| Priority | Phase | Feature | Rationale |
|----------|-------|---------|-----------|
| **P0** | Phase 3 | Edge confidence scoring | Small effort, immediate value, no dependencies |
| **P0** | Phase 6 | Estimated context savings | Small effort, builds user trust |
| **P1** | Phase 1 | Execution flow tracing | High impact, medium effort, no dependencies |
| **P1** | Phase 4 | Refactoring (rename mode only) | Medium effort, high utility for agents |
| **P1** | Phase 8 | MCP prompts / workflow templates | Small effort, improves agent consistency |
| **P2** | Phase 2 | Community detection | High impact but large effort |
| **P2** | Phase 7 | Reproducible benchmarks | Important for credibility |
| **P2** | Phase 9 | Graph export formats | Low effort per format, nice for power users |
| **P3** | Phase 4 | Refactoring (suggest mode) | Depends on Phase 2 |

### Recommended execution order:

```
Week 1:  Phase 3 (confidence) + Phase 6 (savings) + Phase 8 (prompts) — quick wins
Week 2:  Phase 1 (flows) — high-impact feature
Week 3:  Phase 4 rename mode + Phase 9 (exports) — useful standalone
Week 4+: Phase 2 (communities) — foundational for suggest mode
Later:   Phase 7 (benchmarks)
```

---

## What NOT to Port

These CRG features are intentionally excluded:

| Feature | Reason |
|---------|--------|
| Multi-repo support | KiroGraph is project-scoped by design. Each project has its own `.kirograph/` graph. |
| Wiki generation | Low value — agents don't read wikis, they query tools |
| Watch mode daemon | KiroGraph uses hook-based sync (lighter, no background process) |
| Token benchmarking with tiktoken | Overkill — char/4 estimation is sufficient for savings display |
| Memory loop (Q&A re-ingestion) | KiroGraph's memory module already handles this differently |
