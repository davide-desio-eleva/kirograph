# KiroGraph Watchmen — Implementation Plan

## What it is

An opt-in module (`KiroGraph-Watchmen`) that watches memory observations accumulate across sessions and, once a threshold is reached, signals the active AI agent (via a flag in the `kirograph_mem_store` response) to synthesize patterns into workspace brief files. No external API calls. No background daemon. No new MCP tools. The active AI agent does the synthesis using the existing MCP tools it already has.

---

## Core mechanism: `watchmenReady` flag in `kirograph_mem_store`

When `enableWatchmen: true`, `kirograph_mem_store` gains one extra behavior after writing the observation: it counts observations since the last `kind: 'summary'` and checks against `watchmenThreshold`. If the count meets the threshold, the response includes synthesis instructions alongside the normal `id` field.

**Normal response (threshold not met):**
```json
{ "id": "obs_abc123" }
```

**Ready response (threshold met):**
```json
{
  "id": "obs_abc123",
  "watchmenReady": true,
  "pendingCount": 8,
  "message": "8 new observations since last synthesis. Synthesize now: call kirograph_mem_search for each kind (decision, error, pattern, architecture, note), identify recurring patterns, write the workspace brief to the target files listed below, then store a kind='summary' observation to mark completion.",
  "targetFiles": [".kiro/steering/kirograph-watchmen.md"]
}
```

`targetFiles` is computed server-side by checking which files/directories exist in the project root. Each tool gets its own dedicated file only — no redundant cross-writes:

```
targetFiles = []
if .kiro/ exists        → add .kiro/steering/kirograph-watchmen.md
if CLAUDE.md exists     → add CLAUDE.md
if GEMINI.md exists     → add GEMINI.md
if CONVENTIONS.md exists → add CONVENTIONS.md
if augment-guidelines.md exists → add augment-guidelines.md
if AGENTS.md exists     → add AGENTS.md   (targets that write it: Codex, Copilot CLI,
                                            Devin, Goose, Junie, OpenHands, Replit, Warp, Roo)
if targetFiles is empty → add AGENTS.md   (last-resort fallback for unknown tools)
```

Rules:
- Kiro writes only to its steering file — never to `AGENTS.md` or `CLAUDE.md`
- Claude Code writes only to `CLAUDE.md` — not to `AGENTS.md`
- `AGENTS.md` is written when it already exists on disk (installed by one of the targets above) or when nothing else matched
- Multiple targets can coexist; each gets its own entry in `targetFiles`

### The watermark: last `kind: 'summary'` observation

No state file needed. The watermark is implicitly the `createdAt` timestamp of the most recent `kind: 'summary'` observation. After the agent synthesizes, it stores a `kind: 'summary'` observation (e.g. "Synthesized 8 observations into workspace brief"). That observation resets the counter — the next threshold check counts only observations created after it.

---

## How it works per tool

### Kiro (full support)

Two hooks fire at `agentStop`:

1. **`kirograph-mem-capture`** (existing) — `askAgent` prompt: store important observations via `kirograph_mem_store`. If the response includes `watchmenReady: true`, proceed directly to synthesis without waiting for the second hook.

2. **`kirograph-watchmen`** (new) — `askAgent` prompt: call `kirograph_mem_store` with a lightweight probe observation (`kind: 'note'`, content: `"watchmen check"`). If `watchmenReady: true` is returned, synthesize. Otherwise discard. *(Fallback in case mem-capture did not trigger the threshold.)*

Actually the cleanest Kiro approach: the `kirograph-mem-capture` hook prompt already ends with `kirograph_mem_store` calls. The prompt is extended to say: "If any `kirograph_mem_store` response includes `watchmenReady: true`, also run the synthesis step before finishing." No second hook needed.

Synthesis output for Kiro:
- Writes/updates `.kiro/steering/kirograph-watchmen.md` (`inclusion: always`) — only this file

### Claude Code (partial support)

No `askAgent` hook. Claude Code's Stop hook only runs `kirograph sync --quiet` (a `runCommand`). However, Claude Code calls `kirograph_mem_store` mid-session when following the instructions in `.kirograph/claude.md`. When it does and gets `watchmenReady: true`, it synthesizes on the spot.

Claude Code writes to:
- `CLAUDE.md` only — updates the `## KiroGraph Watchmen` section

The synthesis happens during the session (triggered by the flag), not at session end. This is acceptable — it fires when the threshold is crossed, which is most likely near the end of a session when the agent wraps up.

### Codex, Copilot CLI, Devin, Goose, OpenHands, Replit, Warp, Roo, Junie

These tools write `AGENTS.md` during `kirograph install`, so it exists on disk. When their agent calls `kirograph_mem_store` and gets `watchmenReady: true`, `targetFiles` includes `AGENTS.md` and the `message` field instructs synthesis. No hooks available for most of these — synthesis fires mid-session when the threshold is crossed.

### Gemini CLI / AntiGravity

`GEMINI.md` exists on disk after install. `targetFiles` includes `GEMINI.md`. No `AGENTS.md` written.

### Aider

`CONVENTIONS.md` exists on disk after install. `targetFiles` includes `CONVENTIONS.md`. No `AGENTS.md` written.

### Augment

`augment-guidelines.md` exists on disk after install. `targetFiles` includes `augment-guidelines.md`. No `AGENTS.md` written.

### Cursor, Cline, Windsurf, Continue, Kilo, Trae, OpenCode (rules-based tools)

These use tool-specific rules directories for static installation-time instructions. Watchmen never writes to those. These targets do not write any of the generic project memory files (`CLAUDE.md`, `AGENTS.md`, etc.) during install either. So `targetFiles` falls through to the last-resort rule: `AGENTS.md` is created as a fallback and the agent writes the watchmen brief there.

### Unknown / generic targets

Same last-resort fallback: `AGENTS.md` is used if nothing else matched.

---

## What the synthesis writes

The agent produces a structured `## KiroGraph Watchmen` block. For `AGENTS.md` and `CLAUDE.md`, it upserts the block (replaces if already present, appends if not). For `.kiro/steering/`, it writes the full steering file.

**`.kiro/steering/kirograph-watchmen.md`:**
```md
---
inclusion: always
---

# Workspace Knowledge (KiroGraph Watchmen)

_Auto-generated from memory observations. Last updated: {date}._

## Decisions
- Prefer X over Y for Z reason.

## Recurring Patterns
- When touching auth middleware, always run kirograph_affected_tests first.

## Known Errors & Fixes
- `TypeError: cannot read foo` in the data module → run `kirograph sync` first.

## Architecture Notes
- The mem module and graph share the same SQLite handle; do not open a second connection.
```

**`AGENTS.md` / `CLAUDE.md` block (upserted):**
```md
## KiroGraph Watchmen

> Auto-generated from memory observations. Last updated: {date}.

**Decisions:** Prefer X over Y. Auth tokens expire after 15 min in staging.
**Patterns:** Always run kirograph_affected_tests before touching auth middleware.
**Known errors:** TypeError in data module → kirograph sync fixes it.
**Architecture:** Mem and graph share one SQLite handle.
```

---

## Files to create or modify

### `src/watchmen/index.ts` (new)
Exports `WatchmenChecker` — the only new class:
- `shouldSynthesize(memDb)` — counts observations since last `kind: 'summary'`, returns `{ ready, pendingCount }`
- `buildReadyResponse(pendingCount, projectRoot)` — constructs the `watchmenReady` response payload including the `targetFiles` array (computed from which files exist on disk)

No state file. No watermark file. Just a query against the existing mem tables.

### `src/memory/index.ts` (modify)
`MemoryManager.store()` gains one step after the existing flow (step 8, only when `enableWatchmen && enableMemory`):

```ts
// 8. Watchmen threshold check (if enabled)
if (this.watchmenChecker) {
  const check = this.watchmenChecker.shouldSynthesize(this.memDb);
  if (check.ready) {
    return { id, ...this.watchmenChecker.buildReadyResponse(check.pendingCount, this.projectRoot) };
  }
}
return id; // normal return when watchmen not ready or not enabled
```

`MemoryManager.store()` return type changes from `Promise<string | null>` to `Promise<string | WatchmenReadyResult | null>`.

### `src/memory/types.ts` (modify)
Add:
```ts
export interface WatchmenReadyResult {
  id: string;
  watchmenReady: true;
  pendingCount: number;
  message: string;
  targetFiles: string[];
}
```

### `src/config.ts` (modify)
Two new fields following the `enableMemory` / `enableSecurity` pattern:
```ts
enableWatchmen: boolean;    // default: false — requires enableMemory: true
watchmenThreshold: number;  // default: 5
```

### `src/bin/installer/hooks.ts` (modify)
Extend the `kirograph-mem-capture` hook prompt to add the synthesis instruction at the end:

```
...store them using kirograph_mem_store with the appropriate kind...
If any kirograph_mem_store call returns watchmenReady: true in its response,
also synthesize: search observations with kirograph_mem_search for each kind,
write the workspace brief to each file listed in targetFiles (upsert the
## KiroGraph Watchmen section), then store one final kind='summary' observation
to mark completion.
```

The hook is already gated on `enableMemory`. Add a second gate: only include the synthesis instruction tail when `enableWatchmen` is also true.

### `src/bin/installer/config-prompt.ts` (modify)
Add one new prompt after the memory prompt:
- "Enable Watchmen? Auto-synthesize steering files from accumulated memory observations [y/N]"
- Only shown when memory was enabled
- Sets `enableWatchmen: true` and `watchmenThreshold: 5`

### `src/bin/commands/memory.ts` (modify)
Add `kirograph watchmen` sub-command with two actions:
- `kirograph watchmen status` — prints observation count since last summary, threshold, and list of files that would be written
- `kirograph watchmen reset` — stores a `kind: 'summary'` observation manually to reset the counter without running synthesis (useful for clearing a stuck threshold)

---

## What does NOT change

- No new MCP tools registered
- No state file on disk
- No background process
- No external API calls from kirograph code
- No changes to `src/mcp/tools.ts` or `src/mcp/tool-names.ts`
- The `kirograph_mem_store` MCP tool response envelope is extended, not replaced — callers that ignore unknown fields are unaffected

---

## Constraints

- `enableWatchmen: true` silently does nothing if `enableMemory: false`. The installer enforces the dependency order.
- The `kind: 'summary'` observation stored after synthesis counts toward the next threshold — so a threshold of 5 means "5 non-summary observations since the last summary", which is the intended behaviour.
- `targetFiles` only lists files that already exist on disk at the moment `kirograph_mem_store` is called. Files created after installation are picked up automatically on the next synthesis.
- Tool-specific rules directories (`.cursor/rules/`, `.clinerules/`, `.windsurf/rules/`, etc.) are never written to by watchmen — those are static installation-time files.

---

## Documentation updates

### `CHANGELOG.md`
Add a new entry at the top following the established format:

```md
## [0.X.0] - YYYY-MM-DD: KiroGraph-Watchmen

### Added
- **KiroGraph-Watchmen** (`enableWatchmen: true`): opt-in module that auto-synthesizes
  accumulated memory observations into workspace brief files at session end. When the
  observation count since the last synthesis reaches `watchmenThreshold` (default: 5),
  `kirograph_mem_store` returns a `watchmenReady` signal with a `targetFiles` list and
  synthesis instructions. The active AI agent writes the brief to the appropriate file
  for its tool — `.kiro/steering/kirograph-watchmen.md` for Kiro, `CLAUDE.md` for
  Claude Code, `AGENTS.md` for Codex/Copilot/Devin/Goose/Warp/Roo/OpenHands/Replit/Junie,
  and dedicated files for Gemini CLI, Aider, and Augment. Falls back to `AGENTS.md`
  for tools with no dedicated project memory file. No external API calls, no background
  daemon — synthesis is done by the active agent using existing `kirograph_mem_search`.
- `kirograph watchmen status` CLI — shows pending observation count, threshold, and
  which files would be written on next synthesis.
- `kirograph watchmen reset` CLI — stores a `kind='summary'` observation to manually
  reset the threshold counter without triggering synthesis.
- `enableWatchmen` and `watchmenThreshold` config fields.
```

### `README.md`
Two changes:

**1. Features table** — add a row in the `Knowledge & Data` section below the Persistent Memory row:

```md
| 👁️ **Watchmen (KiroGraph-Watchmen opt-in module)** | Auto-synthesizes accumulated memory observations into workspace briefs — `.kiro/steering/`, `CLAUDE.md`, `AGENTS.md`, or tool equivalent. Fires via the `watchmenReady` signal in `kirograph_mem_store` when threshold is reached. No external API calls, no daemon. |
```

**2. Inspirations section** — add an entry:

```md
- [watchmen](https://github.com/firstbatchxyz/watchmen) by [firstbatch](https://github.com/firstbatchxyz): the watchmen module's session-mining concept, workspace brief generation, and `AGENTS.md` mirroring pattern.
```

### `docs/guide/how-it-works.md`
Add a new `### Watchmen (opt-in)` section after the existing `### Memory (opt-in)` section, following the same structure:

```md
### Watchmen (opt-in)

When `enableWatchmen: true` is set (requires `enableMemory: true`), KiroGraph
automatically synthesizes accumulated memory observations into workspace brief files.
Inspired by [watchmen](https://github.com/firstbatchxyz/watchmen) by firstbatch.

After each `kirograph_mem_store` call, KiroGraph counts observations since the last
`kind: 'summary'`. When the count reaches `watchmenThreshold` (default: 5), the
response includes a `watchmenReady` flag and instructions for the active agent to:

1. Search memory by kind via `kirograph_mem_search`
2. Synthesize patterns into a workspace brief
3. Write the brief to the appropriate file for the active tool
4. Store a `kind: 'summary'` observation to reset the counter

Target files per tool:

| Tool | File written |
|------|-------------|
| Kiro | `.kiro/steering/kirograph-watchmen.md` (`inclusion: always`) |
| Claude Code | `CLAUDE.md` (`## KiroGraph Watchmen` section) |
| Codex, Copilot CLI, Devin, Goose, Warp, Roo, OpenHands, Replit, Junie | `AGENTS.md` |
| Gemini CLI / AntiGravity | `GEMINI.md` |
| Aider | `CONVENTIONS.md` |
| Augment | `augment-guidelines.md` |
| Rules-based tools (Cursor, Cline, Windsurf…) | `AGENTS.md` fallback |

Zero LLM tokens spent by KiroGraph — synthesis is done entirely by the active AI
agent using its own intelligence and the existing MCP tools.

```json
{
  "enableMemory": true,
  "enableWatchmen": true,
  "watchmenThreshold": 5
}
```
```

### `docs/guide/configuration.md`
Add two rows to the configuration table, below the `enableMemory` row:

```md
| `enableWatchmen` | boolean | `false` | Enable Watchmen — auto-synthesize workspace briefs from memory observations. Requires `enableMemory: true`. |
| `watchmenThreshold` | number | `5` | Minimum new observations since last synthesis before `watchmenReady` fires. |
```

### `docs/guide/mcp-tools.md`
Add a note to the `kirograph_mem_store` section documenting the `watchmenReady` response shape:

```md
**Watchmen response (when `enableWatchmen: true` and threshold is met):**

When enough observations have accumulated since the last synthesis, the response
includes additional fields alongside `id`:

| Field | Type | Description |
|-------|------|-------------|
| `watchmenReady` | `true` | Present only when synthesis should run |
| `pendingCount` | number | Observations since last `kind: 'summary'` |
| `message` | string | Synthesis instructions for the agent |
| `targetFiles` | string[] | Files to write the brief to, based on installed targets |
```

---

## Scope estimate

| File | Change | LOC |
|------|--------|-----|
| `src/watchmen/index.ts` | new | ~80 |
| `src/memory/types.ts` | add `WatchmenReadyResult` | ~10 |
| `src/memory/index.ts` | step 8 in `store()`, type change | ~20 |
| `src/config.ts` | two new fields + parsing | ~20 |
| `src/bin/installer/hooks.ts` | extend prompt tail + gate | ~15 |
| `src/bin/installer/config-prompt.ts` | one new prompt | ~20 |
| `src/bin/commands/memory.ts` | two sub-commands | ~50 |
| `CHANGELOG.md` | new entry | — |
| `README.md` | features table row + inspiration entry | — |
| `docs/guide/how-it-works.md` | new `### Watchmen` section | — |
| `docs/guide/configuration.md` | two new config rows | — |
| `docs/guide/mcp-tools.md` | `watchmenReady` response note in `kirograph_mem_store` | — |
| **Total** | | **~215 LOC** |

No new npm dependencies.

---

## Implementation order

1. `src/watchmen/index.ts` — pure logic, no deps, fully testable in isolation
2. `src/memory/types.ts` — add `WatchmenReadyResult`
3. `src/config.ts` — add `enableWatchmen` + `watchmenThreshold`
4. `src/memory/index.ts` — wire `WatchmenChecker` into `store()`
5. `src/bin/installer/hooks.ts` — extend mem-capture prompt + gate
6. `src/bin/installer/config-prompt.ts` — add watchmen prompt
7. `src/bin/commands/memory.ts` — add `watchmen status` / `watchmen reset`
8. `CHANGELOG.md` — new version entry
9. `README.md` — features table + inspirations
10. `docs/guide/how-it-works.md` — Watchmen section
11. `docs/guide/configuration.md` — two config rows
12. `docs/guide/mcp-tools.md` — `watchmenReady` response note
