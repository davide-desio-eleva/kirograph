# Gap Analysis Plan: KiroGraph vs lean-ctx

## Summary

lean-ctx (2.2k ⭐) is a Rust-based "cognitive context layer" focused on caching, compression, session memory, and context governance. It has 4 features KiroGraph lacks. This plan prioritizes them by impact and feasibility.

---

## Gap Inventory

| # | lean-ctx Feature | KiroGraph Status | Impact | Effort |
|---|-----------------|-----------------|--------|--------|
| 1 | File read caching (re-reads cost ~13 tokens) | ❌ Missing | High | Medium |
| 2 | Multiple read modes (map/signatures/diff/lines) | ❌ Missing | High | Medium |
| 3 | Context budget governance (profiles, roles, throttling) | ❌ Missing | Medium | Large |
| 4 | Knowledge graph with temporal facts (validity windows) | ❌ Missing | Low | Medium |

---

## Phase 1: File Read Caching

**What lean-ctx does:** Caches file contents in memory. First read costs normal tokens, subsequent reads of the same file cost ~13 tokens (returns a "cached, unchanged" marker or just the delta). Uses content hashing to detect changes.

**Why it matters:** Agents frequently re-read the same files within a session. Without caching, each read costs full tokens. With caching, the agent gets a "no changes since last read" response for ~13 tokens instead of ~2000.

**Implementation plan:**

### How to build it:

1. **In-memory file cache** in the MCP server — store `{ path → { contentHash, lastRead, content } }`
2. **On `kirograph_node` with `includeCode: true`** — before returning code, check if the file was already read this session with the same content hash. If so, return a compact "unchanged since last read" response.
3. **New MCP tool: `kirograph_read`** — explicit file read with caching:
   - First read: returns full content, caches hash
   - Subsequent reads: if hash unchanged → returns `"[cached: unchanged since {timestamp}]"` (~13 tokens)
   - If file changed on disk → returns full new content + diff summary
4. **Cache invalidation** — on `kirograph sync`, clear cache entries for changed files

### CLI equivalent:
```bash
kirograph read <path>                    # Read with caching (full mode)
kirograph read <path> --no-cache         # Force fresh read
kirograph cache status                   # Show cached files + hit rate
kirograph cache clear                    # Clear all cached reads
```

### Files to create/modify:
- `src/mcp/cache.ts` — File read cache (Map-based, session-scoped)
- `src/mcp/tools.ts` — Add `kirograph_read` tool, integrate cache into `kirograph_node`
- `src/mcp/tool-names.ts` — Add `kirograph_read`

### Estimated effort: 2-3 days

---

## Phase 2: Multiple Read Modes

**What lean-ctx does:** 10 read modes for files: `full`, `map` (structure overview), `signatures` (function/class signatures only), `diff` (changes since last read), `lines:N-M` (line range), `outline`, `imports`, `exports`, `tests`, `changes`.

**Why it matters:** Agents don't always need the full file. A "map" mode that shows just the structure (function names, class names, line numbers) costs 80-90% fewer tokens than reading the full file. This is especially valuable for large files.

**Implementation plan:**

### New parameter on `kirograph_read`:

```typescript
kirograph_read(path: "src/auth.ts", mode: "map")       // structure only
kirograph_read(path: "src/auth.ts", mode: "signatures") // function signatures
kirograph_read(path: "src/auth.ts", mode: "diff")       // changes since last read
kirograph_read(path: "src/auth.ts", mode: "lines", start: 10, end: 50)
kirograph_read(path: "src/auth.ts", mode: "full")       // default, full content
```

### How to build each mode:

1. **`full`** — Return entire file content (default, same as today)
2. **`map`** — Use the existing graph data: query all nodes in this file, return `kind name line` for each. No file read needed — pure graph query.
3. **`signatures`** — Query nodes in file, return their `signature` field. Falls back to first line of each function.
4. **`diff`** — Compare current file content against cached version. Return unified diff. If no cache exists, return full content.
5. **`lines:N-M`** — Read file, return only lines N through M.
6. **`imports`** — Query edges where source is in this file and kind = 'imports'. Return import list.
7. **`exports`** — Query nodes in this file where `is_exported = 1`. Return export list.

### CLI equivalent:
```bash
kirograph read <path>                          # full (default)
kirograph read <path> --mode map               # structure overview
kirograph read <path> --mode signatures        # function signatures only
kirograph read <path> --mode diff              # changes since last read
kirograph read <path> --mode lines --start 10 --end 50
kirograph read <path> --mode imports           # import list
kirograph read <path> --mode exports           # export list
```

### Files to create/modify:
- `src/mcp/read-modes.ts` — Mode implementations
- `src/mcp/tools.ts` — Add mode parameter to `kirograph_read`
- `src/mcp/cache.ts` — Support diff mode (needs previous content)

### Estimated effort: 2-3 days

---

## Phase 3: Context Budget Governance

**What lean-ctx does:** Profiles, roles, per-agent budgets, throttling policies, and a browser dashboard showing real-time token usage. Agents can be configured with max token budgets per session, and responses are throttled when approaching limits.

**Why it matters:** For teams and enterprise use, controlling how much context each agent consumes is important for cost management. The dashboard provides visibility into where tokens are being spent.

**Implementation plan:**

### How to build it:

1. **Token budget tracking** — Extend the existing `TokenTracker` to track cumulative tokens per session with a configurable budget limit.

2. **Budget configuration** in `.kirograph/config.json`:
   ```json
   {
     "contextBudget": {
       "maxTokensPerSession": 100000,
       "warnAt": 80000,
       "throttleAt": 95000
     }
   }
   ```

3. **Budget enforcement** — When a tool response would exceed the budget:
   - At `warnAt`: append a warning to the response
   - At `throttleAt`: truncate responses more aggressively, switch to map/signature mode automatically

4. **New MCP tool: `kirograph_budget`** — Returns current session token usage, remaining budget, and utilization percentage.

5. **Dashboard** — Moved to "What NOT to Port" (no background processes, no browser UI for this).

### CLI equivalent:
```bash
kirograph budget                    # Show current session token usage + remaining
kirograph budget --reset            # Reset session counters
```

### Files to create/modify:
- `src/compression/tracker.ts` — Add budget tracking (max, warn, throttle thresholds)
- `src/mcp/tools.ts` — Add `kirograph_budget` tool, integrate budget checks into all tool responses
- `src/mcp/tool-names.ts` — Add `kirograph_budget`
- `src/config.ts` — Add `contextBudget` config field

### Estimated effort: 3-4 days

---

## Phase 4: Knowledge Graph with Temporal Facts

**What lean-ctx does:** Stores facts with validity windows (start/end timestamps). Facts can expire, be superseded, or be scoped to specific time ranges. Supports episodic memory (what happened) and procedural memory (how to do things).

**Why it matters:** KiroGraph's current memory stores observations as flat records. Temporal facts would allow the agent to know "this was true last week but may have changed" — useful for tracking evolving architecture decisions, deprecated patterns, and migration status.

**Implementation plan:**

### Schema extension:

```sql
ALTER TABLE memory_observations ADD COLUMN valid_from INTEGER;
ALTER TABLE memory_observations ADD COLUMN valid_until INTEGER;
ALTER TABLE memory_observations ADD COLUMN superseded_by TEXT;
ALTER TABLE memory_observations ADD COLUMN fact_type TEXT DEFAULT 'observation';
-- fact_type: 'observation' | 'decision' | 'procedure' | 'constraint'
```

### How to build it:

1. **Temporal validity** — When storing observations, optionally set `valid_from` and `valid_until`. Search results filter out expired facts by default.

2. **Fact supersession** — When a new observation contradicts an old one (same symbols, same kind), mark the old one as `superseded_by` the new one's ID.

3. **Fact types** — Extend the existing `kind` field to support `procedure` (how-to instructions) and `constraint` (rules that must be followed).

4. **Temporal queries** — `kirograph_mem_search` gains an optional `asOf` parameter to query facts valid at a specific point in time.

### Files to modify:
- `src/db/memory-schema.sql` — Add columns
- `src/memory/database.ts` — Add migration + temporal query support
- `src/memory/index.ts` — Support temporal filtering in search
- `src/mcp/tools.ts` — Add `asOf` parameter to `kirograph_mem_search`

### Estimated effort: 2-3 days

---

## Execution Priority

> **P0** = do first (high impact, reasonable effort), **P1** = important, **P2** = nice-to-have

| Priority | Phase | Feature | Rationale |
|----------|-------|---------|-----------|
| **P0** | Phase 1 | File read caching | Immediate token savings on every session, simple to implement |
| **P0** | Phase 2 | Multiple read modes | High token savings, leverages existing graph data |
| **P1** | Phase 3 | Context budget governance | Enterprise value, cost control |
| **P2** | Phase 4 | Temporal facts | Incremental improvement to existing memory |

### Recommended execution order:

```
Week 1:  Phase 1 (caching) + Phase 2 (read modes) — immediate token savings
Week 2:  Phase 3 (budget governance) — enterprise feature
Week 3:  Phase 4 (temporal facts) — memory enhancement
```

---

## What NOT to Port

| Feature | Reason |
|---------|--------|
| Browser dashboard | No background processes, no browser UI. CLI `kirograph budget` + `kirograph gain` cover the same info. |
| Lean4 formal proofs | Academic exercise, no practical value for users |
| Context Proof (cryptographic verification) | Enterprise-only, overkill for open-source tool |
| Cloud sync | KiroGraph is local-first by design |
| Discord bot | Out of scope |
| Email templates | Out of scope |
| Multi-agent orchestration | KiroGraph is single-project-scoped |

---

## Key Insight

**Rule: Every MCP tool must have a CLI equivalent.** All new tools (`kirograph_read`, `kirograph_budget`) and modifications to existing tools must be accessible from the command line with the same capabilities.

lean-ctx and KiroGraph are **complementary**, not competitive:
- **lean-ctx** = context layer (caching, compression, governance) — optimizes the *transport* of information
- **KiroGraph** = code intelligence (graph analysis, architecture, refactoring) — optimizes the *understanding* of code

By adding file caching and read modes, KiroGraph gets the best of both worlds: deep code understanding AND efficient context delivery. Users won't need both tools.
