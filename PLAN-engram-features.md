# Plan: Engram Feature Parity in KiroGraph-Mem

Reference: [Engram](https://github.com/Gentleman-Programming/engram) by Gentleman-Programming — a persistent memory MCP server in Go.

Instead of importing Engram as a dependency (impossible natively; HTTP-only), we implement its most valuable features directly in KiroGraph-Mem's existing SQLite + TypeScript stack.

---

## Feature Gap Summary

| Feature | Engram | KiroGraph-Mem (now) | Plan |
|---------|:------:|:-------------------:|:----:|
| Persistent cross-session memory | ✅ | ✅ | — |
| FTS search | ✅ | ✅ | — |
| Vector / semantic search | — | ✅ (9 engines) | — |
| Symbol-linking (code graph) | — | ✅ | — |
| Watchmen auto-synthesis | — | ✅ | — |
| Caveman compression | — | ✅ | — |
| Temporal validity (validFrom/Until) | — | ✅ | — |
| **`topic_key` (stable semantic key)** | ✅ | — | ✅ Phase 1 |
| **`review_after` (stale review date)** | ✅ | — | ✅ Phase 1 |
| **Conflict detection (relations)** | ✅ | — | ✅ Phase 2 |
| **Relation annotations on search** | ✅ | — | ✅ Phase 2 |
| **Passive capture (structured extract)** | ✅ | — | ✅ Phase 3 |
| **Prompt saving** | ✅ | — | ✅ Phase 3 |
| **Session summary (structured)** | ✅ | partial | ✅ Phase 3 |
| Cloud sync | ✅ | — | out of scope |
| Git sync | ✅ | — | out of scope |
| Scope (personal/global) | ✅ | — | out of scope |

---

## Phase 1 — Schema Foundation: `topic_key` + `review_after`

**What:** Two new columns on `mem_observations`. No new tables. Minimal blast radius.

**Why first:** `topic_key` is the stable handle used by conflict detection in Phase 2. `review_after` is fully independent — can ship alone.

### 1a. SQL schema (`src/db/memory-schema.sql`)

Add to `CREATE TABLE mem_observations`:
```sql
topic_key TEXT,           -- stable semantic key, e.g. "architecture/auth-model"
review_after INTEGER      -- epoch ms: observation should be re-evaluated after this date
```

Add index:
```sql
CREATE INDEX IF NOT EXISTS idx_mem_obs_topic ON mem_observations(topic_key);
CREATE INDEX IF NOT EXISTS idx_mem_obs_review ON mem_observations(review_after);
```

### 1b. Migration (`src/memory/database.ts` — `migrateTemporalColumns()`)

Add `topic_key TEXT` and `review_after INTEGER` to the `columnsToAdd` array in the existing migration method.

### 1c. Types (`src/memory/types.ts`)

```ts
// Add to MemObservation:
topicKey?: string;
reviewAfter?: number;

// Add to MemObservationInput:
topicKey?: string;
reviewAfter?: number;
```

### 1d. Database (`src/memory/database.ts`)

- `insertObservation`: accept `topicKey` and `reviewAfter` in opts, write to columns.
- `rowToObservation`: map `row.topic_key` → `topicKey`, `row.review_after` → `reviewAfter`.
- New method `getObservationsForReview(projectPath?, limit = 20)`: returns observations where `review_after IS NOT NULL AND review_after < now AND superseded_by IS NULL`, ordered by `review_after ASC`.
- New method `markReviewed(id)`: sets `review_after = NULL` on the observation.

### 1e. MemoryManager (`src/memory/index.ts`)

- `store()`: pass `topicKey` and `reviewAfter` through to `insertObservation`.
- New `getObservationsForReview(limit)`: delegates to DB.
- New `markReviewed(id)`: delegates to DB.

### 1f. MCP tool: `kirograph_mem_store` update (`src/mcp/tools.ts`)

Add to input schema:
```json
"topicKey": { "type": "string", "description": "Stable semantic key for this observation (e.g. 'architecture/auth-model'). Enables addressing by concept, not just ID." },
"reviewAfter": { "type": "number", "description": "Epoch ms timestamp after which this observation should be re-evaluated." }
```

### 1g. New MCP tool: `kirograph_mem_review`

```
Name: kirograph_mem_review
Description: List observations past their review_after date — stale facts the agent should re-evaluate, update, or supersede.
Input: { limit?: number, projectPath?: string }
Output: Numbered list of overdue observations with topic_key, kind, age, and review_after date.
```

Handler: calls `mem.getObservationsForReview(limit)`, formats results.

Add `kirograph_mem_review` to `tool-names.ts` and the handler switch in `tools.ts`.

---

## Phase 2 — Conflict Detection: Relations System

**What:** A `mem_relations` table that links pairs of observations with a typed relation and a judgment status. New tools `kirograph_mem_judge` and `kirograph_mem_compare`. Search results enriched with active relation annotations.

**Why:** The highest-value feature gap from Engram. Allows the agent to detect, flag, and resolve contradictory knowledge.

### 2a. SQL schema (`src/db/memory-schema.sql`)

New table:
```sql
CREATE TABLE IF NOT EXISTS mem_relations (
  id TEXT PRIMARY KEY,
  observation_a TEXT NOT NULL REFERENCES mem_observations(id) ON DELETE CASCADE,
  observation_b TEXT NOT NULL REFERENCES mem_observations(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,         -- supersedes | conflicts_with | compatible | scoped | related | not_conflict
  confidence REAL NOT NULL DEFAULT 1.0,
  reason TEXT,
  evidence TEXT,
  judgment_status TEXT NOT NULL DEFAULT 'pending',  -- pending | judged | ignored
  judged_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(observation_a, observation_b)
);

CREATE INDEX IF NOT EXISTS idx_mem_rel_a ON mem_relations(observation_a);
CREATE INDEX IF NOT EXISTS idx_mem_rel_b ON mem_relations(observation_b);
CREATE INDEX IF NOT EXISTS idx_mem_rel_status ON mem_relations(judgment_status);
```

### 2b. Types (`src/memory/types.ts`)

```ts
export type RelationType =
  | 'supersedes'
  | 'conflicts_with'
  | 'compatible'
  | 'scoped'
  | 'related'
  | 'not_conflict';

export type JudgmentStatus = 'pending' | 'judged' | 'ignored';

export interface MemRelation {
  id: string;
  observationA: string;
  observationB: string;
  relation: RelationType;
  confidence: number;
  reason?: string;
  evidence?: string;
  judgmentStatus: JudgmentStatus;
  judgedAt?: number;
  createdAt: number;
}

export interface MemRelationInput {
  observationA: string;
  observationB: string;
  relation: RelationType;
  confidence?: number;
  reason?: string;
  evidence?: string;
}

// Add to ScoredObservation:
relations?: MemRelation[];   // active relations for this observation
```

### 2c. Database (`src/memory/database.ts`)

New methods:
- `insertRelation(input: MemRelationInput): string` — inserts with `judgment_status = 'pending'`.
- `judgeRelation(id: string, relation: RelationType, confidence: number, reason?: string, evidence?: string): void` — updates existing relation, sets `judgment_status = 'judged'`, `judged_at = now`.
- `getRelationsForObservation(observationId: string): MemRelation[]` — returns all relations where `observation_a = id OR observation_b = id`.
- `getPendingRelations(limit = 20): MemRelation[]` — returns relations with `judgment_status = 'pending'`.
- `ignoreRelation(id: string): void` — sets `judgment_status = 'ignored'`.
- `getStats`: add `relations: number` and `pendingConflicts: number` to the return value (update `MemStats` type).

### 2d. MemoryManager (`src/memory/index.ts`)

New methods:
- `compareObservations(input: MemRelationInput): string` — inserts a relation, returns relation id.
- `judgeRelation(relationId, relation, confidence, reason?, evidence?)` — delegates to DB.
- `getPendingRelations(limit?)` — delegates to DB.

Update `search()`: after collecting `ScoredObservation[]`, for each result call `getRelationsForObservation(obs.id)` and attach to `relations`. (Batch: one query with `IN (...)` rather than N+1.)

New query in DB: `getRelationsForObservations(ids: string[]): Map<string, MemRelation[]>` — single `WHERE observation_a IN (...) OR observation_b IN (...)` query, group by observation id.

### 2e. MCP tool: `kirograph_mem_compare`

```
Name: kirograph_mem_compare
Description: Establish a relation between two memory observations (supersedes, conflicts_with, compatible, scoped, related, not_conflict). Creates a pending judgment for review.
Input: {
  observationA: string (ID or topic_key),
  observationB: string (ID or topic_key),
  relation: RelationType,
  confidence: number (0.0–1.0),
  reason?: string,
  evidence?: string,
  projectPath?: string
}
Output: Relation ID + summary of the two observations linked.
```

Resolve `observationA/B` by ID first, then fall back to `topic_key` lookup.

### 2f. MCP tool: `kirograph_mem_judge`

```
Name: kirograph_mem_judge
Description: Finalize a pending relation between two observations. Called after the agent reviews a conflict flagged by kirograph_mem_compare or returned by kirograph_mem_search.
Input: {
  relationId: string,
  relation: RelationType,
  confidence: number (0.0–1.0),
  reason?: string,
  evidence?: string,
  projectPath?: string
}
Output: Updated relation with final status.
```

### 2g. Search enrichment (`src/memory/index.ts` — `search()`)

After merging FTS + vector results, batch-fetch relations for all result IDs and attach to each `ScoredObservation.relations`. The MCP handler formats annotations inline:

```
1. [decision] Chose PostgreSQL for auth storage (6 days ago)
   ⚡ conflicts_with #42 "Use SQLite for simplicity" (confidence: 0.9)
   ↩ supersedes #31 "Use in-memory session store" (judged)
```

### 2h. Update `kirograph_mem_status`

Add `relations` and `pendingConflicts` counts to the status output.

Add tools to `tool-names.ts` and handler switch.

---

## Phase 3 — Passive Capture, Prompt Saving, Structured Session Summary

### 3a. Passive capture: `kirograph_mem_capture`

**What:** Agent passes freeform text containing a `## Key Learnings:` section (or similar markers). Tool parses and saves each item as a separate observation.

**Schema:** No new table. Uses `mem_observations` with `source = 'passive'`.

**Parser (pure TypeScript, no LLM):** Extract lines under `## Key Learnings:`, `## Observations:`, `## Decisions:` headings. Each non-empty bullet (`-`, `*`, numbered) becomes a separate observation. Infer `kind` from the heading name.

**MCP tool:**
```
Name: kirograph_mem_capture
Description: Extract and store structured learnings from a freeform text block. Looks for ## Key Learnings, ## Observations, ## Decisions sections and saves each bullet as a separate memory observation.
Input: {
  content: string,
  sessionId?: string,
  projectPath?: string
}
Output: List of extracted observations with their IDs and kinds.
```

New method `MemoryManager.capturePassive(content, sessionId?)`: runs the parser, calls `store()` for each item, returns `Array<{id, kind, content}>`.

### 3b. Prompt saving

**What:** Track the user's prompts linked to a session for context reconstruction.

**Schema (`src/db/memory-schema.sql`):**
```sql
CREATE TABLE IF NOT EXISTS mem_prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES mem_sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mem_prompts_session ON mem_prompts(session_id);
```

**Types:** `MemPrompt { id, sessionId, content, createdAt }`.

**Database:** `insertPrompt(sessionId, content): string`, `getPromptsBySession(sessionId, limit): MemPrompt[]`.

**MemoryManager:** `savePrompt(content, sessionId?)` — auto-resolves or creates session.

**MCP tool:**
```
Name: kirograph_mem_save_prompt
Description: Save the current user prompt to session memory for context reconstruction.
Input: { content: string, sessionId?: string, projectPath?: string }
Output: Prompt ID.
```

### 3c. Structured session summary

**What:** `kirograph_mem_timeline` / session end currently accepts free-text. Add a structured summary format.

**No schema change.** Store summary as `kind: 'summary'`, `source: 'agent'`, with a recognized format:
```
## Goal
<what the session was trying to achieve>

## Key Changes
- ...

## Decisions
- ...

## Unresolved
- ...
```

**Update `kirograph_mem_store`:** when `kind = 'summary'` and content contains `## Goal`, parse the sections. For each item under `## Decisions`, auto-call `capturePassive`-style insertion with `kind: 'decision'`. This enriches the knowledge base from session ends automatically.

**No new MCP tool needed** — this is a behavior change on the existing `kirograph_mem_store` with `kind: 'summary'`.

---

## File Change Map

| File | Change |
|------|--------|
| `src/db/memory-schema.sql` | Add `topic_key`, `review_after` columns; add `mem_relations` table; add `mem_prompts` table |
| `src/memory/types.ts` | Add `topicKey`, `reviewAfter` to `MemObservation`/`MemObservationInput`; add `MemRelation`, `MemRelationInput`, `RelationType`, `JudgmentStatus`, `MemPrompt`; update `ScoredObservation` and `MemStats` |
| `src/memory/database.ts` | Migration for new columns; new relation methods; new prompt methods; `getObservationsForReview`; `markReviewed`; batch relation fetch; update `getStats` |
| `src/memory/index.ts` | `store()` passes `topicKey`/`reviewAfter`; new `compareObservations`, `judgeRelation`, `getPendingRelations`, `getObservationsForReview`, `markReviewed`, `capturePassive`, `savePrompt`; enrich `search()` results |
| `src/mcp/tool-names.ts` | Add: `kirograph_mem_review`, `kirograph_mem_judge`, `kirograph_mem_compare`, `kirograph_mem_capture`, `kirograph_mem_save_prompt` |
| `src/mcp/tools.ts` | Update `kirograph_mem_store` schema; update `kirograph_mem_status` output; add 5 new tool definitions and handlers |
| `CHANGELOG.md` | New version entry (see below) |
| `README.md` | Update KiroGraph-Mem feature bullet in the feature table |
| `docs/guide/comparison.md` | Add Engram row to project table; add new memory feature rows |
| `docs/guide/mcp-tools.md` | Document 5 new tools with full parameter tables |
| `docs/index.html` | Update feature list in the Memory section |
| `docs/docs.html` | Update MCP tools reference for the Memory section |

---

## CHANGELOG.md entry (draft)

```markdown
## [0.24.0] - 2026-06-XX: KiroGraph-Mem — Conflict Detection + Engram Feature Parity

Inspired by [Engram](https://github.com/Gentleman-Programming/engram) by Gentleman-Programming.

### Added

- **`topic_key` on observations**: stable semantic key for an observation (e.g. `"architecture/auth-model"`).
  Passed as `topicKey` in `kirograph_mem_store`. Enables addressing memory by concept, not just UUID.
  `kirograph_mem_compare` and `kirograph_mem_judge` accept both IDs and topic keys.

- **`review_after` on observations**: schedule an observation for re-evaluation. When set, the observation
  appears in `kirograph_mem_review` after the given timestamp. Useful for time-sensitive decisions,
  temporary workarounds, and facts that expire.

- **`kirograph_mem_review`**: list observations past their `review_after` date — stale facts the agent
  should re-evaluate, update, or supersede. Returns topic key, kind, age, and days overdue.

- **Conflict detection — `mem_relations` table**: typed relations between pairs of observations.
  Relation types: `supersedes`, `conflicts_with`, `compatible`, `scoped`, `related`, `not_conflict`.
  Each relation carries `confidence` (0–1), optional `reason` and `evidence`, and a `judgment_status`
  (`pending` | `judged` | `ignored`).

- **`kirograph_mem_compare`**: establish a relation between two observations. Accepts observation IDs
  or `topic_key` values. Creates a `pending` judgment for agent review.

- **`kirograph_mem_judge`**: finalize a pending relation — confirm, revise, or dismiss a conflict flag.

- **Relation annotations on search**: `kirograph_mem_search` results now include active relations inline
  (e.g. `⚡ conflicts_with #42`, `↩ supersedes #31`). Relations are batch-fetched in a single query.

- **`kirograph_mem_capture`**: passive learning extraction. Pass a freeform text block containing
  `## Key Learnings`, `## Observations`, or `## Decisions` sections — each bullet is saved as a separate
  typed observation. No LLM involved; pure structural parser.

- **`kirograph_mem_save_prompt`**: save the current user prompt to session memory for context
  reconstruction and session archaeology.

- **Structured session summary**: `kirograph_mem_store` with `kind: 'summary'` now recognizes
  `## Goal / ## Key Changes / ## Decisions / ## Unresolved` sections. Items under `## Decisions`
  are auto-extracted as `kind: 'decision'` observations, enriching the knowledge base at session end.

- **`kirograph_mem_status`** now reports `relations` count and `pendingConflicts` count.

### Changed

- `kirograph_mem_store` input schema: new optional fields `topicKey` and `reviewAfter`.
- `ScoredObservation` type: new optional `relations` field carrying active `MemRelation[]`.
- `MemStats` type: new `relations` and `pendingConflicts` fields.
```

---

## README.md changes

Update the KiroGraph-Mem row in the feature table:

**Before:**
```
| 🧠 **Persistent Memory (KiroGraph-Mem opt-in module)** | Cross-session observations — decisions, errors, patterns — auto-linked to code symbols |
```

**After:**
```
| 🧠 **Persistent Memory (KiroGraph-Mem opt-in module)** | Cross-session observations — decisions, errors, patterns — auto-linked to code symbols. **Conflict detection**: typed relations between observations (`supersedes`, `conflicts_with`, `compatible`) with agent judgment workflow. **Stale review**: schedule observations for re-evaluation with `review_after`. **Passive capture**: extract learnings from structured text. **Prompt saving**: session context reconstruction. |
```

---

## `docs/guide/comparison.md` changes

### 1. Add Engram to the project table

```markdown
| [Engram](https://github.com/Gentleman-Programming/engram) | Gentleman-Programming | Go | Persistent memory MCP server | — ⭐ |
```

### 2. Add new rows to the Memory & Knowledge section

Extend column headers to include `engram`:

| Feature | KiroGraph | ... | engram |
|---------|:---------:|-----|:------:|
| Conflict detection (relations) | ✅ | — | ✅ |
| Stale observation review | ✅ | — | ✅ |
| Passive learning capture | ✅ | — | ✅ |
| Prompt saving | ✅ | — | ✅ |
| Stable topic key | ✅ | — | ✅ |
| Symbol-linked memory | ✅ | — | — |
| Vector / semantic memory search | ✅ | — | — |
| Scope (personal / global) | — | — | ✅ |
| Cloud / git sync | — | — | ✅ |

### 3. Add Engram to the credits / inspirations section

```markdown
- [Engram](https://github.com/Gentleman-Programming/engram) by [Gentleman-Programming](https://github.com/Gentleman-Programming):
  conflict detection (typed relations + judgment workflow), `topic_key` stable addressing,
  `review_after` stale observation scheduling, passive capture, and prompt saving patterns.
```

---

## `docs/guide/mcp-tools.md` changes

Add five new tool entries under `## Memory Tools`:

- `kirograph_mem_review` — full parameter table + output format
- `kirograph_mem_compare` — full parameter table (observationA/B, relation, confidence, reason, evidence)
- `kirograph_mem_judge` — full parameter table (relationId, relation, confidence, reason, evidence)
- `kirograph_mem_capture` — full parameter table (content, sessionId)
- `kirograph_mem_save_prompt` — full parameter table (content, sessionId)

Update `kirograph_mem_store` parameter table with `topicKey` and `reviewAfter`.

Update `kirograph_mem_status` output documentation with `relations` and `pendingConflicts`.

---

## `docs/index.html` changes

In the feature card for KiroGraph-Mem, extend the bullet list:
- Add: Conflict detection (supersedes / conflicts_with / compatible)
- Add: Stale review scheduling (`review_after`)
- Add: Passive learning capture
- Add: Prompt saving

---

## `docs/docs.html` changes

Mirror the `mcp-tools.md` additions — add the five new tool entries in the Memory section of the docs HTML, following the existing markup pattern for tool cards.

---

## Open questions before implementation

1. **Version number**: `0.24.0` — confirm this is correct given the current HEAD is `0.23.0`.
2. **`markReviewed` tool**: should there be a `kirograph_mem_mark_reviewed(id)` MCP tool to let the agent close out an overdue observation, or is `kirograph_mem_store` with `supersededBy` sufficient?
3. **Conflict auto-scan**: Engram has a background `conflicts/scan` endpoint. Do we want a CLI command (`kirograph mem conflicts scan`) that proactively finds potential conflicts in existing memory using FTS similarity, or leave detection fully manual (agent-driven via `kirograph_mem_compare`)?
4. **`topic_key` suggestion**: Engram has `mem_suggest_topic_key` (LLM-assisted). Do we want a deterministic version (slug from kind + first N words of title), or skip the tool entirely and let the agent supply the key?
