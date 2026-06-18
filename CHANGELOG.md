# Changelog

## [0.27.0] - 2026-06-18: Kiro IDE v1.0.0 hooks — version-aware installer

### Added

- **Kiro version prompt**: the installer now asks "Which version of Kiro IDE are you using?" as the very first question when targeting Kiro. Two options:
  - *Beta Version 0.x.x* — emits legacy `.kiro.hook` files (v1 format: `when`/`then`)
  - *Version 1.x.x* — emits `.json` hook files (v2 format: `trigger`/`action`)

- **v2 hook format support**: hooks are now generated in the Kiro IDE v1.0.0 schema (`{ "version": "v1", "hooks": [{ name, trigger, matcher?, action }] }`). Trigger mapping from v1: `agentStop` → `Stop`, `preToolUse` → `PreToolUse`. Action mapping: `runCommand` → `{ type: "command" }`, `askAgent` → `{ type: "agent" }`. The v1 `toolTypes: ["shell"]` becomes v2 `matcher: "execute_bash"`.

- **Format-exclusive generation**: only the selected format is written. The opposite format's files are cleaned up if they exist from a previous install.

- **`KiroHookFormat` type** exported from `src/bin/installer/hooks.ts` (`'v1-legacy' | 'v2'`).

### Changed

- **`writeHooks` accepts `kiroHookFormat`**: all hook definitions are stored as dual `HookDef` objects carrying both `v1` and `v2` payloads; `writeHookForFormat` emits only the correct one.

- **`TargetInstaller` interface** extended with optional `kiroHookFormat` parameter on `installEarly` and `installLate`.

- **Legacy `.kiro.hook` files removed from repo**: workspace now contains only the v2 `.json` hooks.

- **`uninit` cleanup list updated**: covers both `.json` and `.kiro.hook` filenames for all hook IDs.

### Fixed

- **Hooks inactive in new Kiro IDE**: v1 `.kiro.hook` files were silently ignored by Kiro IDE 1.x. The new format is now correctly recognized.

---

## [0.26.0] - 2026-06-17: Installer overhaul — real feature flags, minimal defaults

### Added

- **Real MCP feature flags**: tools are now absent from `tools/list` and `tools/call` entirely when their feature is disabled — not just unapproved. `FEATURE_TOOL_SETS` maps each config flag to the tool names it gates. `setEnabledTools()` is computed once at init and cached.

- **New installer tool groups**: three new optional groups added to the install wizard, each defaulting to **no**:
  - *Code health* (`enableCodeHealth`): `kirograph_hotspots`, `kirograph_surprising`, `kirograph_diff`, `kirograph_dead_code`, `kirograph_circular_deps`
  - *Advanced analysis* (`enableAdvancedAnalysis`): `kirograph_type_hierarchy`, `kirograph_flows`, `kirograph_communities`, `kirograph_refactor` — offered only when Architecture is enabled
  - *Agent utilities* (`enableAgentUtils`): `kirograph_read`, `kirograph_gain`, `kirograph_budget`

- **`kirograph_exec` gated by shell compression**: tool is absent when `shellCompressionLevel` is `off`. `enableShellExec` is a derived field computed from `shellCompressionLevel !== 'off'` — never stored in config.

- **`kirograph_callers` / `kirograph_callees` gated by `trackCallSites`**: call-site graph tools only appear when the feature is enabled.

- **Atomic mcp.json write**: `writeMcpConfigFinal` overwrites the MCP entry with the correct `autoApprove` list in one operation from `installKiroLate`, eliminating the intermediate "all tools" state that Kiro detected on reconnect or reinstall.

- **`--path` in mcp.json args**: written at install time so the server always loads the correct project config regardless of working directory.

- **Eager config loading**: `start()` calls `tryInit()` before the transport starts, preventing the race where `tools/list` arrives before `initialize`.

### Changed

- **All toggle prompts default to no**: every installer question now shows `no` first (index 0) and `yes` second — activation is a deliberate choice.

- **`extractDocstrings` defaults to `false`** (was `true`).

- **`trackCallSites` defaults to `false`** (was `true`).

- **"Install KiroGraph for Kiro?" confirmation removed**: the target was already chosen in the preceding prompt; the redundant confirmation step is gone.

- **Steering file is now fully dynamic**: `buildSteeringContent` builds the quick decision guide rows, tool reference sections, workflows, and workflow steering file table conditionally based on enabled features. Disabled tools are absent — not mentioned at all.

- **Workflow steering files conditionalized**: `kirograph-review.md`, `kirograph-debug.md`, `kirograph-onboard.md`, `kirograph-refactor.md`, and `kirograph-architecture.md` now only include steps and tips for tools that are actually enabled. Step numbering adjusts automatically.

- **Security workflow table row** only appears in the steering file when `enableSecurity` is true.

### Fixed

- **Reconnect bug**: clicking Reconnect in Kiro IDE no longer jumps from 7 to 74 tools. Root causes fixed: wrong cwd (solved by `--path` arg), async race (solved by eager init), and intermediate mcp.json state (solved by atomic write).

- **Reinstall bug**: uninstall + reinstall now shows the correct tool count immediately without requiring a reconnect.

- **`enableShellExec` unknown config warning**: field added to `KNOWN_FIELDS` as a legacy alias; removed from `.kirograph/config.json` where it was incorrectly persisted as a stored value.

---

## [0.25.0] - 2026-06-15: Wiki — LLM-maintained structured knowledge base

### Added

- **Wiki module** (`enableWiki: true`): Karpathy-style LLM wiki that compounds knowledge across sessions. Knowledge flows through three ops: **ingest** (build a structured prompt for the LLM from source text), **apply-diff** (write the LLM-generated `WIKI_DIFF` to SQLite + markdown files), and **lint** (health check for broken links, orphan pages, contradictions).

- **6 new MCP tools**:
  - `kirograph_wiki_ingest` — build an ingest prompt (SCHEMA + MANIFEST + source) for the active LLM; returns the prompt string for the agent to process
  - `kirograph_wiki_apply_diff` — apply a `WIKI_DIFF_START ... WIKI_DIFF_END` block; supports `create`, `upsert`, `append` actions; reports pending conflicts
  - `kirograph_wiki_search` — FTS5 full-text search over wiki pages with BM25 ranking
  - `kirograph_wiki_page` — retrieve the full markdown content of a page by slug
  - `kirograph_wiki_list` — list all pages with slug, title, source count, and last-updated timestamp
  - `kirograph_wiki_lint` — detect broken `[[slug]]` links, orphan pages, stale sources, and contradiction signals

- **`kirograph wiki` CLI subcommand**: `init`, `ingest`, `apply-diff`, `search`, `page`, `list`, `lint`, `reindex`, `status`

- **WIKI_DIFF format**: block-delimited `WIKI_DIFF_START / WIKI_DIFF_END` with a JSON header per entry and markdown content. Deterministic parser; `WIKI_DIFF_CONFLICTS` blocks for contradiction reporting. Designed so the agent reviews diffs before they are applied (two-tool pattern).

- **Two synthesis modes** (`wikiSynthesisMode`):
  - `agent` (default): the active LLM generates diffs via the `askAgent` hook
  - `local`: same HuggingFace/ONNX infra as Watchmen — zero API cost, no data leaves the machine

- **Conflict resolution** (`wikiAutoResolveConflicts: true`): conflicting sections auto-resolved by source date when opt-in; otherwise conflicts are surfaced as pending items for manual review.

- **Context enrichment**: `kirograph_context` auto-includes wiki pages above the score threshold (`wikiContextThreshold: 0.4`, limit `wikiContextLimit: 3`).

- **Installer integration**: `kirograph install` prompts for `enableWiki` and `wikiSynthesisMode`. Writes two Kiro hooks (`kirograph-wiki-ingest.kiro.hook`, `kirograph-wiki-lint.kiro.hook`) and a steering skill file `kirograph-wiki-workflow.md` with the 8-step ingest workflow.

- **Wiki section in `kirograph.md` steering** (when `enableWiki: true`): explains available tools, the two-tool ingest flow, and when to consult vs update the wiki.

- **New config keys**: `enableWiki`, `wikiSynthesisMode`, `wikiLocalModel`, `wikiSources`, `wikiAutoResolveConflicts`, `wikiLintFrequency`, `wikiContextLimit`, `wikiContextThreshold`

- **`applyWikiSchema()`** on `KiroGraphDatabase`: initializes `wiki_pages` table and `wiki_fts` virtual table (FTS5) with INSERT/UPDATE/DELETE triggers. Safe to call multiple times.

- **`scripts/wiki/test.sh`**: end-to-end test covering WikiDatabase API, parseWikiDiff, applyDiff (create + upsert), getIngestPrompt structure, lint (broken_link detection), and CLI subcommands.

---

## [0.24.0] - 2026-06-15: KiroGraph-Mem — Conflict Detection + Engram Feature Parity

Inspired by [Engram](https://github.com/Gentleman-Programming/engram) by Gentleman-Programming — persistent memory MCP server in Go.

### Added

- **`topic_key` on observations**: stable semantic key for an observation (e.g. `"architecture/auth-model"`). Pass as `topicKey` in `kirograph_mem_store`. `kirograph_mem_compare` and `kirograph_mem_judge` resolve both IDs and topic keys.

- **`review_after` on observations**: schedule an observation for re-evaluation at a future timestamp. Appears in `kirograph_mem_review` once overdue.

- **`kirograph_mem_review`** / `kirograph mem review`: list observations past their `review_after` date — stale facts the agent should re-evaluate, update, or supersede. Reports days overdue.

- **`kirograph_mem_mark_reviewed`** / `kirograph mem mark-reviewed <id>`: clear an observation's `review_after` date, removing it from the review queue.

- **Conflict detection — `mem_relations` table**: typed relations between pairs of observations. Relation types: `supersedes`, `conflicts_with`, `compatible`, `scoped`, `related`, `not_conflict`. Each carries `confidence` (0–1), optional `reason` and `evidence`, and a `judgment_status` (`pending` | `judged` | `ignored`).

- **`kirograph_mem_compare`** / `kirograph mem conflicts compare <a> <b>`: establish a relation between two observations. Accepts IDs or `topic_key` values. Creates a `pending` relation for review.

- **`kirograph_mem_judge`** / `kirograph mem conflicts judge <relationId>`: finalize a pending relation — confirm, revise, or dismiss.

- **`kirograph_mem_conflicts_scan`** / `kirograph mem conflicts scan`: FTS-based scan of recent observations for potential conflicts. Returns candidate pairs for agent review.

- **`kirograph mem conflicts list`**: list pending relations.

- **`kirograph mem conflicts ignore <relationId>`**: mark a relation as irrelevant.

- **Relation annotations on search**: `kirograph_mem_search` results now include active relation annotations inline (e.g. `⚡ conflicts_with`, `↩ supersedes`). Relations batch-fetched in a single query.

- **`kirograph_mem_capture`** / `kirograph mem capture`: passive learning extraction. Pass a freeform text block with `## Key Learnings`, `## Observations`, `## Decisions`, or `## Key Changes` sections — each bullet saved as a typed observation. Pure structural parser, no LLM.

- **`kirograph_mem_save_prompt`** / `kirograph mem save-prompt`: save the current user prompt to session memory for context reconstruction.

- **`kirograph_mem_suggest_topic_key`** / `kirograph mem suggest-topic-key`: deterministic slug generation — returns `"kind/slugified-title"` for use as a stable `topic_key`.

- **`kirograph_mem_status`** now reports `relations` count and `pendingConflicts` count.

- **Structured session summary**: `kirograph_mem_store` with `kind: 'summary'` and `## Goal / ## Key Changes / ## Decisions / ## Unresolved` sections auto-extracts `## Decisions` items as `kind: 'decision'` observations.

### Changed

- `kirograph_mem_store` / `kirograph mem store`: new optional params `topicKey` and `reviewAfter`.
- `ScoredObservation` type: new optional `relations: MemRelation[]` field.
- `MemStats` type: new `relations` and `pendingConflicts` fields.
- Schema migration: `topic_key`, `review_after` added to `mem_observations` via non-destructive `ALTER TABLE` (safe for existing databases).

---

## [0.23.0] - 2026-06-12: TurboVec — Rust/SIMD vector engine via napi-rs

### Added

- **TurboVec semantic engine** (`"semanticEngine": "turbovec"`): 9th vector search engine — a napi-rs native addon wrapping [turbovec](https://github.com/RyanCodrai/turbovec) by Ryan Codrai. Same TurboQuant compression algorithm as `turboquant-js`, implemented in Rust with **SIMD-accelerated search** (NEON on ARM64, AVX-512BW on x86-64). String IDs from KiroGraph are mapped to `u64` via FNV-1a hashing with a JSON sidecar (`.tvim.ids`) for round-trip persistence. Index file format: `.kirograph/turbovec.tvim`. On macOS, turbovec links the Accelerate framework (always available); on Linux, `libopenblas`; on Windows, pure-Rust matrixmultiply fallback (no extra deps).

- **`turbovecBits` config field** (number, default `4`, valid: `2`, `3`, `4`): bits per coordinate. Tighter range than turboquant (which accepts 1–8) because turbovec's Rust codepaths are validated for 2–4 only. Changing this requires `kirograph index --force`.

- **`turbovecMemDocs` config field** (boolean, default `false`): reserved for applying the TurboVec ANN index to memory observations and doc sections (mirrors `turboquantMemDocs`).

- **`native/turbovec-node/`**: napi-rs Rust crate that compiles to a platform-specific `.node` binary. Build once with `cd native/turbovec-node && npm install && npm run build`. Requires Rust toolchain (`rustup`). Falls back silently to `cosine` if the addon is not built.

- **`npm run test:turbovec`**: end-to-end test script in `scripts/turbovec/`. Covers Rust build detection, config + index + status + query + export + memory workflow, `validateConfig` turbovecBits validation, and a 14-step unit test of `TurboVecIndex` (construct → upsert → search → upsert-update → prepare → remove → save → load → round-trip → close, plus invalid-dim and invalid-bitwidth error checks). Flags: `--skip-unit`, `--no-build`, `--skip-native`.

- **Installer**: when `turbovec` is selected as the engine, `kirograph install` checks for an existing `.node` binary, verifies the Rust toolchain, and runs `npm install && npm run build` inside `native/turbovec-node`. Falls back with clear instructions if `rustc` is not found.

## [0.22.0] - 2026-06-10: PDF support for the data module

### Added

- **PDF indexing** (`enableData: true`): `.pdf` files are now indexed by the data module via [`@firecrawl/pdf-inspector`](https://github.com/firecrawl/pdf-inspector) (optional dep, pure Rust, no OCR, no network). Each page becomes one row with columns `page`, `content`, `needs_ocr`, `has_tables`, `has_columns`. Text-based PDFs process in under 200ms locally.
- **Mixed/scanned PDF handling**: text pages index normally; scanned pages are flagged with `needs_ocr = true` and surfaced in `kirograph data quality`.
- **Encoding issue detection**: `kirograph data quality` warns when `hasEncodingIssues` is set on a PDF dataset (garbled font encodings that may require OCR pre-processing).
- **`kirograph data classify <file>`**: new subcommand — fast (~10–50ms) PDF classification without full indexing. Reports type (`TextBased`/`Scanned`/`Mixed`/`ImageBased`), confidence, page count, and which pages need OCR. Supports `--json`.
- **PDF code-reference detection**: `kirograph data lint` / linker now detects `readFileSync`, `createReadStream`, `open`, `pdfplumber.open`, `fitz.open`, and `PdfReader` calls referencing `.pdf` paths.
- **`metadata_json` column on `data_datasets`**: stores PDF-specific metadata (type, confidence, title, encoding issues, complex layout) surfaced in `kirograph data describe`.
- **Platform support**: prebuilt binaries for linux-x64 and macOS ARM64. Other platforms degrade gracefully (`isAvailable() = false`, PDFs skipped with a lint warning).
- **Optional dep**: `npm install --save-optional @firecrawl/pdf-inspector`.

## [0.21.0] - 2026-06-09: TurboQuant embedding compression

### Added

- **TurboQuant semantic engine** (`"semanticEngine": "turboquant"`): 8th vector search engine powered by [turboquant-js](https://github.com/danilodevhub/turboquant-js) by Danilo Dev — a TypeScript implementation of [Google's TurboQuant algorithm](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/). **Zero native dependencies** (pure TypeScript, works in CI, ARM, and restricted environments). **Compresses embeddings at index time**: each 768-dim `Float32Array` (3,072 bytes) is reduced to ~120 bytes via Walsh-Hadamard rotation + Lloyd-Max scalar quantization (~25× at the default 3 bits). 100K symbols: ~300 MB raw → ~12 MB compressed. No raw `Float32` values are written to disk or held in RAM when turboquant is active — the compressed ANN index (`.kirograph/turboquant.bin`) is the only artifact. Loaded from binary in milliseconds on startup. Falls back silently to `cosine` if `turboquant-js` is not installed. Optional dep: `npm install turboquant-js`.

- **`turboquantMemDocs` config field** (boolean, default `false`): applies TurboQuant compression and ANN indexing to memory observations and doc section search. Replaces the O(n) linear cosine scan that loads all raw Float32 vectors from SQLite into RAM on every query. Serializes to `.kirograph/turboquant-mem.bin` and `.kirograph/turboquant-doc.bin`. Works independently of `semanticEngine`.

- **`turboquantBits` config field** (number, default `3`, range `1–8`): controls the compression/quality tradeoff. Changing this field requires `kirograph index --force`.

- **`kirograph status` compression stats**: when TurboQuant is active, shows compression ratio, bits per vector, raw → compressed size, and total RAM saved across code nodes, memory, and docs.

- **`kirograph gain` TurboQuant row**: shows total embeddings compressed and MB saved in the "By source" breakdown. Reads from `.kirograph/turboquant-stats.json` without loading the index.

- **Installer**: `turboquant` appears as the 2nd engine choice in `kirograph install` (after `cosine`, before `sqlite-vec`), with a clear note on zero native deps and compression. When `cosine` or `turboquant` is chosen, a follow-up prompt offers TurboQuant for memory and doc search (`turboquantMemDocs`).

## [0.20.0] - 2026-06-08: KiroGraph-Watchmen *(experimental)*

> ⚠️ **Experimental feature.** Output quality in local synthesis mode depends heavily on the model used and the hardware it runs on. Smaller or quantized models may produce incomplete briefs and lower-quality skill files. Use `watchmenSynthesisMode: 'agent'` for best results on Kiro.

### Added
- **KiroGraph-Watchmen** (`enableWatchmen: true`): opt-in **experimental** module that auto-synthesizes accumulated memory observations into workspace briefs and skill files. When the observation count since the last `kind: 'summary'` reaches `watchmenThreshold` (default: 5), `kirograph_mem_store` returns a `watchmenReady` signal with `targetFiles`, `skillTargetDir`, and synthesis instructions. Requires `enableMemory: true`. No background daemon.

- **Local model synthesis** (`watchmenSynthesisMode: 'local'`, default): synthesis runs entirely on-device via `@huggingface/transformers` (ONNX Runtime). No external API calls, no API key required. Model downloaded once to `~/.kirograph/models/` alongside the embedding model. Default: `onnx-community/gemma-4-E4B-it-ONNX`.
  - Download: ~3–4 GB one-time
  - RAM during inference: ~3–5 GB
  - Speed: 8–15 s on Apple Silicon (M1+, CoreML); 30–60 s on Intel CPU
  - Fires only at `agentStop` when threshold is reached — not a persistent process

- **Agent synthesis** (`watchmenSynthesisMode: 'agent'`): delegates synthesis to the active AI agent via `askAgent` hook (Kiro only). Consumes agent API tokens/credits. Higher quality output but requires Kiro.

- **Skill file generation**: when Kiro is detected (`.kiro/` present), Watchmen writes individual `inclusion: manual` steering files at `.kiro/steering/watchmen-<slug>.md` for each recurring procedure identified in the observations. Files from previous runs are automatically pruned when patterns change. Non-Kiro targets get a `## Recurring Procedures` section embedded in their brief file.

- **Per-tool output**: `.kiro/steering/kirograph-watchmen.md` (`inclusion: always`) for Kiro; `CLAUDE.md` for Claude Code; `AGENTS.md` for Codex/Copilot CLI/Devin/Goose/Warp/Roo/OpenHands/Replit/Junie; `GEMINI.md` for Gemini CLI; `CONVENTIONS.md` for Aider; `augment-guidelines.md` for Augment; `AGENTS.md` fallback for Cursor, Cline, Windsurf, and rules-based tools.

- **Hook**: `kirograph-watchmen.kiro.hook` written to `.kiro/hooks/` when `enableWatchmen: true`. Uses `runCommand: kirograph mem watchmen synthesize --quiet` in local mode (works for all tools); `askAgent` prompt in agent mode (Kiro only).

- **CLI commands**:
  - `kirograph mem watchmen status` — pending count, threshold, ready state, target files
  - `kirograph mem watchmen synthesize [--force] [--quiet]` — run local model synthesis immediately; `--force` bypasses threshold check; `--quiet` suppresses output for hook use
  - `kirograph mem watchmen reset` — store a `kind='summary'` observation to reset the counter

- **New config fields**: `enableWatchmen` (bool), `watchmenThreshold` (number, default 5), `watchmenSynthesisMode` (`'local'` | `'agent'`, default `'local'`), `watchmenLocalModel` (string, default `'onnx-community/gemma-4-E4B-it-ONNX'`).
- **`WatchmenReadyResult`** type exported from `kirograph/memory`: `{ id, watchmenReady, pendingCount, message, targetFiles, skillTargetDir? }`.
- **Installer**: after enabling memory, prompts for synthesis mode (local model with model picker, or active agent with token cost warning). `kirograph install --yes` skips all prompts using existing config.
- **`--yes` flag** on `kirograph install`: non-interactive mode — skips confirmation and index prompts, uses config on disk. Useful in scripts and CI.
- **`test-watchmen.sh`**: end-to-end test script in `test-watchmen/`. Covers install (`--yes`), index, threshold counter, `watchmenReady` signal, synthesis (brief + skill files), pruning, timeline, search, and manual reset. Flags: `--skip-llm`, `--no-build`.

## [0.19.1] - 2026-06-01: KiroGraph-Patterns (ast-grep integration)

### Added

- **KiroGraph-Patterns** (`enablePatterns: true`, opt-in): AST structural pattern matching via `@ast-grep/napi`. Adds a fourth search mode alongside FTS, graph traversal, and semantic vector search — finding code patterns that can't be expressed as symbol names.
  - **Index-time SAST upgrade**: during `kirograph index`, 10 bundled YAML rules run against every source file and store matches in `pattern_matches` SQLite table. `kirograph security flows` merges AST findings with existing SQL heuristics (additive, SQL heuristics always preserved).
  - **`kirograph_live_search` MCP tool**: dynamically registered in the MCP tool list *only* when `enablePatterns: true` AND `@ast-grep/napi` is installed — absent otherwise. Lets the AI agent search any ast-grep structural pattern across the indexed file list at query time without re-indexing.
  - **`kirograph pattern` CLI**: `kirograph pattern '<pattern>'` (live search), `--list` (browse library), `--library <id>` (run specific rule), `--lang`, `--format json`. Exit code 1 on findings for CI gates.
  - **10 bundled YAML rules**: SQL injection (JS/TS/Python ×3), dangerous eval/exec (JS/Python ×2), path traversal (JS/Python ×2), prototype pollution (JS), weak crypto MD5/SHA-1 (JS/Python ×2). All tagged with OWASP Top 10 (2021) category and fix hint.
  - **3 new config fields**: `enablePatterns` (default `false`), `patternLibraryPath` (custom rules directory, merged with bundled), `patternSeverityThreshold` (default `low`).
  - **Installer prompt**: "Precise SAST with ast-grep?" after the Security section — auto-installs `@ast-grep/napi` on yes, warns and continues on failure.
  - **`kirograph-patterns.md` workflow steering file** (`inclusion: manual`): step-by-step guide — browse rules, live search, run library rules, pattern syntax reference. Written only when `enablePatterns: true`. Activatable via `/kirograph-patterns` in Kiro IDE/CLI.
  - **Agent integration**: `kirograph_live_search` and `kirograph pattern` in steering decision guide (conditional on `enablePatterns`), CLI agent resources include `kirograph-patterns.md` when enabled, all 34 non-Kiro target agent instructions include a Pattern Search section when `enablePatterns: true`.

- **MCP tool parity**: `kirograph_pattern_coverage`, `kirograph_pattern_save_baseline`, `kirograph_pattern_diff` — full MCP equivalents of the CLI commands, usable by AI agents in sessions.
- **`kirograph_status` pattern section**: when `enablePatterns: true`, shows match count, files affected, rules triggered.
- **`kirograph_security` SAST findings**: overview now includes pattern match count + critical count from `pattern_matches`.
- **`kirograph_impact` pattern warning**: when analyzing blast radius, surfaces pattern matches on the target symbol ("this symbol has 2 SQL injection pattern matches at line N").
- **`kirograph attack-surface` pattern awareness**: routes now show pattern matches found along call paths (up to 5 hops), with pattern-adjusted risk score.
- **`kirograph hotspots --security`**: new mode that scores symbols by severity × caller count, showing only symbols with pattern matches.
- **`symbol_node_id` in pattern_matches**: each match records the enclosing function/method node ID, enabling graph-level queries like "who calls code with SQL injection?"
- **Pattern-aware `kirograph_context`**: context MCP tool surfaces up to 5 pattern findings from relevant files inline.
- **OWASP coverage report** (`kirograph pattern --coverage`): bar chart of rule coverage per category, with match counts and uncovered gap list.
- **Pattern diff** (`kirograph pattern --save-baseline / --diff`): snapshot and diff pattern match counts over time.
- **`fix:` field in pattern rules**: all 10 bundled rules now carry a `fix:` template using ast-grep metavariables. `kirograph pattern --library <id> --fix` applies transformations in-process via `@ast-grep/napi` (no spawned processes). Falls back to range-based text substitution if `commitEdits()` is unavailable.
- **4 new rules for Java and Go**: `sql-injection-java`, `dangerous-reflection-java` (critical/high), `command-injection-go`, `path-traversal-go` (critical/high). Total bundled rules: 14.
- **`symbol_node_id` in `pattern_matches`**: each match now records the enclosing function/method/class node ID. Enables queries like "who calls code containing a SQL injection pattern?" via `findCallersOfPatternMatches()` in `src/patterns/graph.ts`.
- **Pattern-aware `kirograph_context`**: when `enablePatterns: true`, the context MCP tool surfaces up to 5 pattern findings from the relevant files as a `## ⚠ Pattern Findings` section — same inline warning pattern as CVE surfacing.
- **`kirograph pattern --coverage`**: OWASP Top 10 coverage report — bar chart of rules-per-category, match counts, affected files, and "no coverage" gaps. `--format json` for CI.
- **`kirograph pattern --save-baseline [label]` / `--diff [label]`**: save a JSON snapshot of current pattern match counts to `.kirograph/pattern-baseline-<label>.json`, then diff future state against it. Shows NEW/RESOLVED/UNCHANGED buckets with net delta.

### Changed

- `DataFlowAnalyzer.analyze()` now merges `pattern_matches` results with SQL heuristic results when `enablePatterns: true` and data is present — deduplicating by `(filePath, line)` with AST entries preferred. SQL heuristics run unchanged regardless.
- `IndexPipeline` gains a `patterns` phase (after embeddings, before architecture). Non-critical: wrapped in try/catch.
- Incremental sync re-runs patterns for changed files only; file removal deletes corresponding `pattern_matches` rows.
- `InstructionOptions`, `buildInstructionOpts`, and all 27 non-Kiro `installLate` implementations extended with `enablePatterns` parameter.
- `PatternRule` extended with `fix?: string`; `PatternMatch` extended with `fixSuggestion?: string`.
- `pattern_matches` schema extended with `symbol_node_id TEXT` (nullable, indexed) — backward-compatible migration via `tryAlter`.

---

## [0.19.0] - 2026-05-29: Security Module
- **Security module** (`enableSecurity: true`): dependency vulnerability detection with reachability-aware impact analysis. Leverages the existing call graph and architecture layers to classify vulnerabilities as `affected`, `not_affected`, or `under_investigation`.
  - **`enableSecurity` config flag**: Guards the security pipeline. Requires `enableArchitecture: true` (auto-enabled if missing).
  - **CLI commands**:
    - `kirograph security`: Overview of vulnerability status — dependency counts, verdict breakdown, stale data warnings.
    - `kirograph vulns`: List vulnerabilities with severity/verdict filters, `--refresh` for on-demand enrichment, `--add` for manual CVE registration.
    - `kirograph reachability <target>`: Reachability analysis for a CVE ID or package name — verdict, call paths (up to 5), unresolved symbols, impact summary.
    - `kirograph sbom`: Export CycloneDX 1.5 SBOM to stdout or file (`--output`; parent directory created automatically).
    - `kirograph vex`: Export CycloneDX 1.5 VEX with reachability verdicts to stdout or file (`--output`; parent directory created automatically).
  - **MCP tools**:
    - `kirograph_security`: Security overview — vulnerability counts, verdict breakdown, stale data warnings.
    - `kirograph_vulns`: List vulnerabilities with filtering by severity, verdict, and limit.
    - `kirograph_sbom`: Generate CycloneDX 1.5 SBOM JSON.
    - `kirograph_vex`: Generate CycloneDX 1.5 VEX JSON with reachability verdicts.
    - `kirograph_reachability`: Analyze reachability for a CVE ID or package name — verdict, paths, impact summary.
    - `kirograph_vuln_add`: Manually register a CVE against a dependency (private advisories).
  - **`🔒 Security` section** in `kirograph --help`: lists all 5 security commands with options and examples.
  - **14 ecosystem parsers**: npm (+ pnpm-lock.yaml support), Maven, Gradle, Go, pip, pyproject.toml (Poetry/Hatch/PDM/PEP 621), Cargo, NuGet, RubyGems, Composer, Swift PM, Dart/pub, Elixir/Hex — each with lock file resolution for resolved versions.
  - **Batch OSV queries**: `VulnerabilityDatabaseClient.enrichAll()` now uses `/v1/querybatch` (up to 1000 packages per HTTP request) instead of sequential single queries, with automatic fallback to sequential on batch failure. For a project with 200 dependencies, enrichment drops from 200 HTTP requests to 1.
  - **EPSS integration**: After CVE enrichment, `EpssClient` fetches exploitation probability scores from `api.first.org/data/v1/epss` in batches of 500. Scores stored as `epss_score` (0.0–1.0) and `epss_percentile` on each vulnerability. Shown in `kirograph vulns` output; filterable via `--epss <threshold>`.
  - **License compliance**: All manifest plugins (npm, Maven, Cargo, pyproject, NuGet, RubyGems, Composer, pubspec) now extract SPDX license identifiers. New `securityLicensePolicy` config field (`deny`/`warn` arrays with wildcard support). New `kirograph licenses` CLI command and `kirograph_licenses` MCP tool.
  - **Dependency staleness**: New `StalenessChecker` queries npm, PyPI, crates.io, RubyGems, and Packagist registries for latest published versions. Staleness score (0.0–1.0) based on major versions behind + time since latest. New `kirograph staleness` CLI command, `kirograph_staleness` MCP tool, `--stale` flag on `kirograph vulns`, `--refresh-staleness` on `kirograph security`.
  - **Dashboard security overlay**: The interactive graph export (`kirograph export`) now color-codes `dependency` and `vulnerability` nodes by security status (red=affected, amber=investigating, green=not_affected, gray=no data). New `🔒 Security` toolbar button highlights security nodes and dims the rest. Includes legend panel.
  - **`kirograph status` security section**: When `enableSecurity: true`, the status command and `kirograph_status` MCP tool now show a security summary (dep count, vuln count, verdict breakdown, stale warning).
  - **pyproject.toml support** (PEP 621, Poetry, PDM, Hatch) with lock file support (poetry.lock, pdm.lock, uv.lock).
  - **pnpm-lock.yaml support** added to the npm plugin (v5/v6/v9 format).
  - **7 new ecosystems**: NuGet, Gradle, RubyGems, Composer (PHP), Swift PM, Dart/pub, Elixir/Hex — each with lock file resolution.
  - **`securityLicensePolicy`** config field: `{ deny: string[], warn: string[] }` with SPDX wildcard matching (e.g. `GPL-*`).
  - **OSV integration**: Primary vulnerability database via /v1/query endpoint. 30-second timeout per dependency. Staleness tracking with `vulnDataStale` flag.
  - **Reachability analysis**: BFS traversal from entry points through call/import/reference edges. Three verdicts: `affected` (path exists), `not_affected` (no path, no unresolved imports), `under_investigation` (unresolved symbols encountered).
  - **Architecture-aware impact analysis**: Identifies affected layers, entry points, and distinct code paths (capped at 100). Reads `arch_file_layers` table populated by the architecture module.
  - **CycloneDX 1.5 SBOM export**: All dependencies as components with purl, scope, direct/transitive classification, and dependency relationships.
  - **CycloneDX 1.5 VEX export**: Vulnerability entries with reachability-derived analysis states and justifications.
  - **Fix suggestions**: Ecosystem-appropriate upgrade commands (`npm install`, `go get`, `pip install`, `cargo update`, Maven pom.xml update) shown alongside vulnerabilities.
  - **`kirograph_context` integration**: Automatically surfaces security warnings (max 3 CVEs) when queried symbols are reachable from affected vulnerabilities.
  - **Manual CVE registration**: `kirograph vulns --add <cveId> --package <name> --version <ver>` for private/internal advisories.
  - **On-demand refresh**: `kirograph vulns --refresh` triggers fresh enrichment from configured databases.
- **Installer prompt**: "Security analysis?" added to the interactive installer after the Architecture section.
- **Steering file security section**: Full security guidance for agents — 8 tools, proactive triggers (run on dep changes and pre-deploy), EPSS interpretation guide (≥0.5 = patch immediately), 7-step workflow, staleness score reference.
- **`kirograph-security.md` workflow steering file** (`inclusion: manual`): Step-by-step security audit — triage affected CVEs, EPSS-based prioritization, deep-dive reachability, license compliance, staleness check, SBOM/VEX export. Written only when `enableSecurity: true`.
- **`kirograph-architecture.md` workflow steering file** now conditional on `enableArchitecture: true` (same pattern as security).
- **Workflow steering files in CLI agent resources**: All `kirograph-*.md` files (review, debug, onboard, refactor, + architecture/security when enabled) are registered in `.kiro/agents/kirograph.json` so they're activatable via `/kirograph-<name>` slash commands in Kiro CLI.
- **Agent instructions for all 34 non-Kiro targets**: `InstructionOptions` and `buildAgentInstructions` now support `enableArchitecture`, `enableDocs`, `enableData`, `enableSecurity` — each produces a conditional section with tool list and guidance. All 27 `installLate` implementations updated to propagate these flags through `buildInstructionOpts`.
- **`context-warnings.ts` EPSS-aware**: Security warnings surfaced in `kirograph_context` now include EPSS score/percentile, are sorted by EPSS first (actual exploit probability), then CVSS.
- **`kirograph install` UX**: Without `--target`, now prompts "Kiro only (recommended) vs Auto-detect all platforms" instead of immediately entering auto-detect flow.
- **"Did you know?" tips**: Expanded from 8 to 37 tips covering all CLI commands — core graph, indexing, architecture, security (vulns/reachability/licenses/staleness/EPSS), memory, docs, data, export, shell compression, and workflow slash commands (`/kirograph-security`, `/kirograph-review`, etc.).
- **3 new config fields**: `enableSecurity`, `securityDatabases`, `securityAutoEnrich`, `securityLicensePolicy`.
- **Jupyter notebook support** (`.ipynb`): code cells extracted as Python, line numbers remapped to notebook coordinate space. All existing Python symbol kinds (functions, classes, imports, calls) work on notebook code.
- **Flutter full support**:
  - **Architecture layer detection** (`src/architecture/layers/dart.ts`): `screens/pages/views/widgets` → `ui`, `services/providers/blocs/cubits` → `service`, `repositories/data/models/domain` → `data`, `core/utils/helpers/extensions` → `shared`, `routes/navigation` + `main.dart` → `api`.
  - **Widget classification**: `StatelessWidget`, `StatefulWidget`, `HookWidget`, `ConsumerWidget`, `ConsumerStatefulWidget` subclasses → kind `component`.
  - **Flutter framework resolver** (`src/frameworks/flutter.ts`): route extraction from `MaterialApp(routes: {...})`, `GoRouter`, and `@RoutePage()` AutoRoute annotations.
  - **Flutter Method Channel bridge** (`src/resolution/bridges/flutter-channel.ts`): Dart `invokeMethod('name')` → Kotlin/Java/Swift `setMethodCallHandler`. Channel name string is the linking key. `MethodChannel` call→handler: `calls` at 0.7; `EventChannel` stream→handler: `references` at 0.65.
- **`kirograph attack-surface`**: maps all HTTP routes → reachable vulnerable dependencies, with hop count, auth heuristic (detects middleware/guard patterns), exposure level (public/authenticated/internal), and combined risk score. Unique: no other SCA tool traces from routes through the call graph to vulnerable deps.
- **`kirograph security secrets`**: 14-pattern secrets scanner (AWS keys, GitHub tokens, Stripe, JWT, DB URLs, generic API keys, etc.) enriched with call-graph blast radius — shows which function contains the secret and how many entry points reach it. Orders by severity × reachability.
- **`kirograph security flows`**: SAST-lite dangerous data flow detection using the call graph — SQL injection, dangerous eval/exec, unsafe deserialize, weak crypto, path traversal. Each finding tagged with OWASP Top 10 (2021) category.
- **`kirograph security ci-report`**: structured security report for CI/CD — JSON, SARIF 2.1.0 (uploadable to GitHub Security tab as code scanning results), or compact text. `--fail-on` exit codes. Aggregates vulns + secrets into one report.
- **`kirograph attack-surface` / `kirograph supply-chain` / `kirograph dep-confusion` / `kirograph remediation`**: supply chain health (OpenSSF Scorecard, maintainer count, abandonment detection), dependency confusion detection (internal package names that exist in public registries + typosquatting heuristic), and remediation SLA tracking (days open, days with fix available, SLA thresholds by severity: critical=7d, high=30d, medium=90d).
- **OWASP Top 10 mapping** (`src/security/owasp.ts`): utility that maps CVE summaries to OWASP A01–A10 categories. Used by `security flows` and `security ci-report`.
- **Combined risk score** (`risk_score` 0–10): computed per CVE as `reachability_factor × (0.4 × CVSS_normalized + 0.6 × EPSS) × staleness_bonus`. `affected` = 1.0×, `under_investigation` = 0.5×, `not_affected` = 0.1×. Default sort in `kirograph vulns` and `kirograph_vulns`. Shown as colored badge `[Risk: 8.5]`. Top-risk CVE shown in `kirograph security` overview.
- **CVE suppression list** (`.kirograph/security-suppressions.json`): `kirograph vuln suppress <cveId> [--reason] [--expires]`, `kirograph vuln unsuppress <cveId>`, `kirograph vuln suppressions`. Suppressed CVEs are filtered from all output (CLI + MCP). Expired suppressions are auto-pruned on load. New `kirograph_vuln_suppress` MCP tool.
- **CI exit codes** (`--fail-on`): `kirograph vulns --fail-on affected|any|critical|high|epss=N` exits with code 1 when condition is met. `kirograph security --fail-on affected` same. Enables security gates in CI pipelines.
- **Auto-enrich age warning** (`securityEnrichMaxAgeDays`, default 7): `kirograph security` warns when vulnerability data is older than the configured threshold and suggests `kirograph vulns --refresh`.
- **Workspace grouping** (`kirograph vulns --group-by workspace`): groups vulnerabilities by the directory of their source manifest. Silently skipped when all deps are in a single workspace.
- **`kirograph security export`** CLI command: generates a self-contained HTML security dashboard with 6 tabs — Overview (stat cards, verdict bar chart, top 5 CVEs by EPSS×CVSS), Vulnerabilities (filterable table with EPSS badges, expandable call paths), SBOM (component list + one-click CycloneDX JSON download), VEX (analysis states + one-click download), Licenses (policy violations highlighted), Staleness (score bars, sortable table). Use `--open` to open immediately in the browser.
- **Android/Kotlin React Native bridge** (`src/resolution/bridges/android-rn.ts`): `@ReactMethod` → JS `NativeModules.Module.method()` call edges, `NativeEventEmitter` binding edges, `@ReactProp` setter → JSX attribute usage edges.
- **10 new languages**: ReScript (full — WASM in tree-sitter-wasms), SQL, R, Julia, PowerShell, Perl, Astro, GDScript, Nix, Verilog/SystemVerilog (file tracking + node kind handlers ready; WASMs compiled via `scripts/compile-grammars.sh`). KiroGraph now covers 33+ languages, matching or exceeding all compared tools.

### Fixed

- **`security-schema.sql` not copied to dist**: Build script `copyAssets()` was missing the copy, causing `no such table: sec_dependencies` on all security commands after a clean install.
- **`kirograph vex/sbom --output`**: Crashed with `EROFS` when output directory didn't exist. Both now call `mkdirSync(..., { recursive: true })` before writing.
- **`kirograph uninit`**: Only removed `kirograph.md` from `.kiro/steering/`. Now removes all `kirograph-*.md` files (main + all workflow files).
- **`kirograph_reachability` MCP parameter**: Documented as `cve` (CVE-only) in several places; corrected to `target` which accepts both CVE IDs and package names.
- **`kirograph_vuln_add` MCP parameters**: Corrected `cve` → `cveId`, removed non-existent `version` param, added `fixedVersion`.
- **`--severity` filter**: Docs incorrectly described as comma-separated; accepts a single value.

### Changed

- MCP tool count: 37 → 45 (`kirograph_security`, `kirograph_vulns`, `kirograph_sbom`, `kirograph_vex`, `kirograph_reachability`, `kirograph_vuln_add`, `kirograph_licenses`, `kirograph_staleness`).
- `IndexProgress.phase` type extended with `'security'` phase.
- `NodeKind` extended with `'dependency' | 'vulnerability'`.
- `EdgeKind` extended with `'has_vulnerability' | 'depends_on' | 'declared_in'`.
- `GraphDatabase` exposes `applySecuritySchema()` with automatic migration for new columns (`epss_score`, `epss_percentile`, `license`, `latest_version`, `staleness_score`, etc.) on existing databases.
- Installer `installLate` signature extended with `enableSecurity` and `enableArchitecture` parameters across all 27 non-Kiro target implementations.
- `ConfigPatch` type extended with `enableSecurity` and `securityLicensePolicy`.
- `SteeringOptions` extended with `enableArchitecture`, `enableDocs`, `enableData`, `enableSecurity` — all are now properly conditional in both Kiro steering and non-Kiro agent instructions.
- Build script copies `security-schema.sql` to dist.
- `KIROGRAPH_TOOL_NAMES` updated with 8 new security tools.
- **Community detection: Louvain → Leiden**: refinement phase added after local move — guarantees all communities are internally well-connected. Public API unchanged; `CommunityResult` gains `algorithm: 'leiden'`.
- Bridge resolver count: 6 → 8 (added `android-rn-bridge`, `flutter-channel-bridge`).

---

## [0.18.6] - 2026-05-22: Antigravity, Gemini CLI & OpenCode Fixes

### Fixed

- **Antigravity IDE target rewritten**: MCP is now correctly documented as user-scoped (`~/.gemini/antigravity/mcp_config.json`) — installer prints setup instructions instead of writing to a wrong path. Hooks now written to `.agents/hooks.json` (workspace-level) with `Stop` event. Passes `hasHooks: true`.
- **Gemini CLI target rewritten**: No longer an alias for Antigravity. Now a full implementation writing MCP + hooks to `.gemini/settings.json` with `SessionEnd` event. Uses correct Gemini CLI hook format. Passes `hasHooks: true`.
- **OpenCode target enhanced**: Added `.opencode/plugins/kirograph-sync.js` auto-sync plugin that fires on `session.idle` event. Passes `hasHooks: true`. MCP and instructions config unchanged (already correct).

### Changed

- Hook-enabled targets: 7 → 10 (added Antigravity, Gemini CLI, OpenCode).
- Targets with Session Hygiene fallback: 26 → 23.

---

## [0.18.5] - 2026-05-22: Hooks & Session Hygiene

> ⚠️ Community-contributed, vibecoded, unverified. PRs welcome for fixes.

### Added

- **Auto-sync hooks for 5 targets** that support lifecycle events:
  - **Cursor**: `.cursor/hooks.json` — `stop` → `kirograph sync --quiet`. Optional `beforeShellExecution` compression hint.
  - **Windsurf**: `.windsurf/hooks.json` — `post_cascade_response` → `kirograph sync --quiet`.
  - **Claude Code**: `.claude/settings.json` hooks — `Stop` → `kirograph sync --quiet`.
  - **GitHub Copilot**: `.github/hooks.json` — `session-end` → `kirograph sync --quiet`.
  - **Cline**: `.clinerules/hooks/task_completed` — executable shell script that syncs.
  - **Codex CLI**: `.codex/hooks.json` — `Stop` → `kirograph sync --quiet`.
- **"Session Hygiene" section** in agent instructions for all targets without hooks (25+ targets). Tells the agent to manually run `kirograph sync` at session start/end and store observations before ending.
- **`hasHooks` option** in `InstructionOptions` — targets with hooks pass `true` to suppress the session hygiene section.

### Changed

- Cursor, Windsurf, Claude Code, Copilot, and Cline targets now pass `hasHooks: true` to `buildInstructionOpts`, suppressing the manual sync reminder.
- `uninit` for all 5 hook-enabled targets now cleans up hook entries/files.

---

## [0.18.4] - 2026-05-22: Tier 4 — Full Coverage

> ⚠️ Community-contributed, vibecoded, unverified. PRs welcome for fixes.

### Added

- **Generic print-only target factory** (`src/bin/installer/targets/generic.ts`): declarative config for tools without a well-known project-level MCP config path. Writes `.kirograph/<target>.md` and prints setup instructions.
- **9 new print-only targets**: Mistral Vibe (`--target mistral-vibe`), IBM Bob (`--target ibm-bob`), Crush (`--target crush`), Droid Factory (`--target droid-factory`), ForgeCode (`--target forgecode`), iFlow CLI (`--target iflow`), Qwen Code (`--target qwen`), Atlassian Rovo Dev (`--target rovo`), Qoder (`--target qoder`).
- **Install target count**: 24 → 33.

### Fixed

- **`buildAgentInstructions` now includes all enabled features**: shell compression (`kirograph_exec` section with level-specific examples), memory (`kirograph_mem_search`/`kirograph_mem_store` guidance), and the full decision guide table. Previously non-Kiro targets only got basic tool guidance + caveman rules, missing compression and memory sections entirely.
- **All 32 non-Kiro targets** now pass `shellCompressionLevel` and `enableMemory` through to `buildAgentInstructions` via the new `buildInstructionOpts` helper. Feature parity with the Kiro steering file.

---

## [0.18.3] - 2026-05-22: Tier 3 IDE Expansion

> ⚠️ Community-contributed, vibecoded, unverified. PRs welcome for fixes.

### Added

- **Augment Code install target** (`--target augment`): `.augment/mcp.json` + generated block in `augment-guidelines.md`.
- **Kilo Code install target** (`--target kilo`): `.kilo/mcp_settings.json` + generated block in `.kilorules`.
- **Sourcegraph Amp install target** (`--target amp`): `.amp/config.json` MCP + `.amp/instructions.md`.
- **Devin install target** (`--target devin`): `devin.json` MCP + generated block in `AGENTS.md`.
- **Replit Agent install target** (`--target replit`): generated block in `AGENTS.md` + prints MCP setup instructions.
- **Block Goose install target** (`--target goose`): generated block in `AGENTS.md` + prints `goose mcp add` command.
- **OpenHands install target** (`--target openhands`): `.openhands/config.json` MCP + generated block in `AGENTS.md`.
- **Tabnine install target** (`--target tabnine`): `.tabnine/mcp.json` + `.tabnine/instructions.md`.
- **Install target count**: 16 → 24.

---

## [0.18.2] - 2026-05-22: Tier 2 IDE Expansion

> ⚠️ Community-contributed, vibecoded, unverified. PRs welcome for fixes.

### Added

- **Continue install target** (`--target continue`): `.continue/config.json` MCP + `.continue/rules/kirograph.md`.
- **Roo Code install target** (`--target roo`): `.roo/mcp.json` + generated block in `.roorules`.
- **Warp install target** (`--target warp`): `.warp/mcp.json` + `.warp/rules/kirograph.md`.
- **Aider install target** (`--target aider`): generated block in `CONVENTIONS.md` + prints MCP CLI flag.
- **Trae install target** (`--target trae`): `.trae/mcp.json` + `.trae/rules/kirograph.md`.
- **Install target count**: 11 → 16.

---

## [0.18.1] - 2026-05-22: Tier 1 IDE Expansion

> ⚠️ Community-contributed, vibecoded, unverified. PRs welcome for fixes.

### Added

- **Windsurf install target** (`--target windsurf`): `.windsurf/mcp.json` + generated block in `.windsurfrules`.
- **GitHub Copilot install target** (`--target copilot`): `.github/copilot-mcp.json` + generated block in `.github/copilot-instructions.md`.
- **Cline install target** (`--target cline`): `.cline/mcp_settings.json` + generated block in `.clinerules`.
- **JetBrains Junie install target** (`--target junie`): `.junie/mcp.json` + generated block in `.junie/guidelines.md`.
- **Gemini CLI install target** (`--target gemini-cli`): alias for `antigravity` (shares `.gemini/settings/mcp.json` + `GEMINI.md`).
- **Install target count**: 6 → 11.

### Changed

- `InstallTarget` type extended with `'windsurf' | 'cline' | 'copilot' | 'junie' | 'gemini-cli'`.
- `kirograph install --target` now dynamically lists all available targets in help and error messages.
- README and docs updated with all Tier 1 targets.

---

## [0.18.0] - 2026-05-22: Multi-IDE Expansion

### Added

- **Cursor install target** (`--target cursor`): full integration for Cursor IDE.
  - `.cursor/mcp.json`: project-scoped MCP server registration (same `mcpServers` format Cursor expects).
  - `.cursor/rules/kirograph.mdc`: always-active Cursor rule with `alwaysApply: true` frontmatter, teaching the agent to prefer graph tools over grep/glob.
  - `.kirograph/cursor.md`: reference copy of agent instructions.
  - `uninit --target cursor`: removes MCP entry and rule file cleanly.
- **Antigravity install target** (`--target antigravity`): full integration for Google Antigravity IDE.
  - `.gemini/settings/mcp.json`: project-scoped MCP server registration.
  - `GEMINI.md`: generated KiroGraph instruction block (upsert pattern, safe to re-run).
  - `.kirograph/antigravity.md`: reference copy of agent instructions.
  - `uninit --target antigravity`: removes MCP entry and GEMINI.md block cleanly.
- **OpenCode install target** (`--target opencode`): full integration for OpenCode (SST terminal agent).
  - `.opencode.json`: MCP server registration (`mcp.kirograph` with `type: "local"`) + `instructions` array referencing `.kirograph/opencode.md`.
  - `.kirograph/opencode.md`: reference copy of agent instructions.
  - `uninit --target opencode`: removes MCP entry and instructions reference from `.opencode.json`.
- **Install target count**: 3 → 6 (kiro, claude, codex, cursor, antigravity, opencode).

### Changed

- `InstallTarget` type extended: `'kiro' | 'claude' | 'codex'` → `'kiro' | 'claude' | 'codex' | 'cursor' | 'antigravity' | 'opencode'`.
- `kirograph install --target` help text and error messages updated to include `cursor`, `antigravity`, and `opencode`.
- README and docs updated with Cursor, Antigravity, and OpenCode usage instructions in the "Other Tools (Experimental)" section.

## [0.17.1] - 2026-05-26: Multi-Platform Auto-Detection & Gap Closure

### Added

- **Multi-platform auto-detection**: `kirograph install` (no flags) now auto-detects installed AI coding tools and offers to configure them all. Supports `--all` (skip prompt) and `--target all` as aliases.
- **`kirograph_flows` MCP tool + CLI**: Trace execution flows from entry points (routes, handlers, main functions) through the call graph, sorted by criticality scoring.
- **`kirograph_communities` MCP tool + CLI**: Louvain-based community detection clusters related code. Auto-splits oversized communities. Shows modularity, inter-community coupling, and dominant directories.
- **`kirograph_refactor` MCP tool + CLI**: Two modes — `rename` (preview all locations referencing a symbol) and `suggest` (community-driven refactoring suggestions: move, split, extract candidates).
- **Edge confidence scoring**: Edges now carry `confidence` (extracted/inferred/ambiguous) and `confidence_score` (0.0–1.0). Resolution-created edges are marked as inferred; ambiguous when multiple candidates exist.
- **Estimated context savings**: `kirograph_context` responses now include a savings footer showing graph tokens vs naive file-read tokens.
- **Workflow steering files**: 5 task-specific steering files generated on install (review, debug, architecture, onboard, refactor) with `inclusion: manual` for on-demand use.
- **Graph export formats**: `kirograph export graphml` (Gephi/yEd), `kirograph export cypher` (Neo4j), `kirograph export obsidian` (Markdown vault with wikilinks).
- **Reproducible benchmarks**: `kirograph benchmark` CLI command clones repos at pinned SHAs, indexes them, runs predefined queries, and measures token efficiency. Results in `benchmarks/results/`.
- **Copilot CLI target**: New `--target copilot-cli` writes MCP config to `~/.copilot/mcp-config.json` with `servers` key.
- **`kirograph status --integrations`**: Shows which platforms are configured vs detected-but-not-configured.
- **iOS/React Native/Expo cross-language bridging**: 7 bridge resolvers synthesize edges across language boundaries — Swift ↔ ObjC, RN Legacy Bridge, TurboModules, Expo Modules, Native Events, Fabric/Paper Views. Enables `kirograph_callers`, `kirograph_impact`, and `kirograph_flows` to trace calls across Swift/ObjC/Java/Kotlin/JS boundaries.
- **`kirograph_read` MCP tool + CLI**: File read with session caching (re-reads of unchanged files cost ~13 tokens) and 7 read modes: `full`, `map`, `signatures`, `diff`, `lines`, `imports`, `exports`. Map and signatures modes use graph data — no file read needed.
- **`kirograph_budget` MCP tool + CLI**: Context budget governance — tracks cumulative token consumption per session with configurable limits (`contextBudget` in config). Warns at threshold, throttles at limit.
- **Temporal facts in memory**: Observations now support `valid_from`, `valid_until`, `superseded_by`, and `fact_type` fields. `kirograph_mem_search` gains `asOf` parameter for temporal queries. Expired/superseded facts are filtered automatically.

### Fixed

- **Windsurf**: Now writes MCP config directly to `~/.codeium/windsurf/mcp_config.json` (was print-only).
- **Antigravity**: Now writes MCP config directly to `~/.gemini/antigravity/mcp_config.json` (was print-only).
- **Copilot**: Now writes to both `.vscode/mcp.json` (with `servers` key for VS Code Copilot Chat) and `.github/copilot-mcp.json` (with `mcpServers` key for agent mode).
- **Cline**: Now writes MCP config to `.cline/mcp_settings.json` (was print-only).
- **Qoder**: Promoted from generic print-only to proper target writing `.qoder/mcp.json`.
- **Qwen**: Promoted from generic print-only to proper target writing `~/.qwen/settings.json`.
- **Idempotent re-install**: `writeMcpServersConfig` now returns false and skips if kirograph is already configured (no overwrite).
- **Uninit for user-scoped configs**: Windsurf, Antigravity, Copilot CLI, and Qwen uninit now removes the kirograph entry from user-scoped config files.

### Changed

- Install command default behavior: without `--target`, auto-detects platforms instead of defaulting to Kiro.
- `--dry-run` flag added to install command.
- Target count increased from 33 to 34 (added copilot-cli).

---

## [0.17.0] - 2026-05-24: Data Navigation

### Added

- **Data module** (`enableData: true`): indexes tabular data files (CSV, TSV, JSONL, JSON, Excel, Parquet) for structured querying. Inspired by [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp), implemented natively in TypeScript with full kirograph integration.
  - **`kirograph_data_list` MCP tool**: List all indexed datasets with row counts, column counts, and file sizes.
  - **`kirograph_data_describe` MCP tool**: Full schema profile — column names, inferred types, cardinality, null percentages, min/max, sample values, NL summaries, validation rules, and sample data generation hints.
  - **`kirograph_data_query` MCP tool**: Filtered row retrieval with 10 structured operators (eq, neq, gt, gte, lt, lte, contains, in, is_null, between). Parameterized SQL, zero injection surface. Anti-loop detection warns on excessive pagination.
  - **`kirograph_data_aggregate` MCP tool**: Server-side GROUP BY — count, sum, avg, min, max, count_distinct. Computation in SQLite, only results enter context.
  - **`kirograph_data_search` MCP tool**: Search column names and sample values by keyword within a dataset.
  - **`kirograph_data_join` MCP tool**: Cross-dataset SQL JOIN (inner, left, right) with column projection.
  - **`kirograph_data_correlations` MCP tool**: Pairwise Pearson correlations between numeric columns. Discovers hidden relationships without loading data.
  - **`kirograph_data_quality` MCP tool**: Data quality triage — rank columns by composite risk score (null rate, cardinality anomalies, type issues).
  - **6 format parsers**: CSV/TSV (built-in, streaming), JSONL/NDJSON (built-in, streaming), JSON array (built-in, streaming), Excel .xlsx/.xls (optional dep: `xlsx`), Parquet (optional dep: `parquetjs-lite`).
  - **Column profiler**: Type inference (string, integer, float, boolean, date, null), cardinality, null counting, min/max, mean, sample values, auto-generated NL summaries.
  - **Streaming parser**: Never loads full file into memory. Processes line-by-line (CSV/JSONL) or in chunks (Excel/Parquet).
  - **Incremental indexing**: Content hash (SHA-256) per file. Only re-indexes files that changed on disk.
  - **Code ↔ data linker** (`src/data/linker.ts`): Detects file path references in source code (Node.js `readFileSync`, Python `pd.read_csv`, SQL `COPY FROM`, generic path strings). Populates `data_code_refs` during indexing.
  - **`kirograph_context` enrichment** (opt-in): When `dataContextLimit > 0`, relevant dataset schemas are surfaced alongside code symbols. Disabled by default.
  - **Test fixture awareness**: `kirograph affected` now includes test files that reference changed data files via `data_code_refs`.
  - **Schema drift detection**: `data_dataset_history` table tracks profile snapshots on each re-index. `kirograph data drift` compares latest two snapshots (added/removed/changed columns, row count delta).
  - **Validation rules extraction**: Infers validation rules from column profiles (required, type, range, enum, uniqueness).
  - **Sample data generation hints**: From column profiles, provides hints for generating realistic test data.
  - **NL summaries**: Auto-generated natural-language summaries for each column based on profile patterns.
  - **Anti-loop detection**: Warns when agent paginates row-by-row (>5 sequential queries with incrementing offsets).
  - **Token budget enforcement**: Responses exceeding `dataMaxResponseTokens` are truncated with a clear message.
  - **CLI** (13 commands): `kirograph data {list,describe,query,aggregate,search,index,reindex,join,correlations,quality,history,drift,lint}`.
  - **Token savings tracking**: Data tools tracked as `'data'` source in `kirograph_gain` with naive cost heuristics (95–99% savings vs reading raw data files).
  - **`kirograph_status` enhanced**: Shows data stats (datasets, rows, columns, source size) when enabled.
  - **Sync pipeline integration**: Data files are re-indexed automatically during `kirograph index` and `kirograph sync` with dedicated progress phase.
  - **Architecture layer auto-assignment**: Data files are assigned to a `data` layer when architecture analysis is enabled.
- **Installer prompt**: "Tabular data indexing?" added to the interactive installer. Follow-up prompts for Excel/Parquet optional deps and `dataContextLimit`.
- **Steering file data section**: Teaches the agent to use `kirograph_data_*` tools. Conditionally included when data is enabled.
- **9 new config fields**: `enableData`, `dataInclude`, `dataExclude`, `dataLinkCode`, `dataContextLimit`, `dataMaxFileSize`, `dataMaxRows`, `dataQueryLimit`, `dataMaxResponseTokens`.

### Changed

- MCP tool count: 29 → 37 (`kirograph_data_list`, `kirograph_data_describe`, `kirograph_data_query`, `kirograph_data_aggregate`, `kirograph_data_search`, `kirograph_data_join`, `kirograph_data_correlations`, `kirograph_data_quality`).
- `kirograph_gain` output now shows five source categories: Graph tools, Docs tools, Data tools, Compression, Memory.
- `TokenSavingsRecord.source` type: `'exec' | 'graph' | 'memory' | 'docs'` → `'exec' | 'graph' | 'memory' | 'docs' | 'data'`.
- `IndexProgress.phase` type extended with `'docs'` and `'data'` phases.
- Progress rendering: docs and data indexing now have dedicated progress output (previously incorrectly used the `architecture` phase).
- `GraphDatabase` exposes `applyDataSchema()` for data module access.
- Installer `installLate` signature extended with `enableData` parameter.
- `ConfigPatch` type extended with `enableData` and `dataContextLimit`.
- Build script copies `data-schema.sql` to dist.
- `KIROGRAPH_TOOL_NAMES` updated with 8 new data tools.

---

## [0.16.0] - 2026-05-24: Documentation Navigation

### Added

- **Documentation module** (`enableDocs: true`): indexes project documentation by heading hierarchy for section-level retrieval. Inspired by [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp), implemented natively in TypeScript with full kirograph integration.
  - **`kirograph_docs_toc` MCP tool**: Table of contents for a file or the whole project. Flat or tree mode.
  - **`kirograph_docs_search` MCP tool**: FTS5-powered search across documentation sections. Independent from code search.
  - **`kirograph_docs_section` MCP tool**: Retrieve full content of a section by stable ID. Optional context mode (ancestor chain + child summaries).
  - **`kirograph_docs_outline` MCP tool**: Heading hierarchy for a single document.
  - **`kirograph_docs_refs` MCP tool**: Bidirectional code ↔ doc cross-references via `qualified_name`.
  - **9 format parsers**: Markdown (.md, .mdx, .cheatmd), reStructuredText (.rst), AsciiDoc (.adoc, .asciidoc), RDoc (.rdoc), Org-mode (.org), HTML (.html, .htm), Plain text (.txt), OpenAPI/Swagger (.yaml, .yml, .json — content-detected).
  - **Code linker**: Detects backtick references, CamelCase identifiers, and snake_case patterns in doc content, resolves against the code graph, stores as `doc_code_refs`.
  - **`kirograph_context` enrichment** (opt-in): When `docsContextLimit > 0`, relevant doc sections are surfaced alongside code symbols. Disabled by default — user chooses the cap during install.
  - **CLI mirrors all MCP tools**: `kirograph docs {toc,search,section,outline,refs,reindex,lint,reembed}`.
  - **`kirograph docs lint`**: Health checks — broken code refs, stale sections, FTS desync, orphan refs.
  - **Stable section IDs**: Format `{file_path}::{ancestor-chain/slug}#{level}`. Stable across re-indexing when path, heading text, level, and parent chain don't change.
  - **Incremental indexing**: Content hash (SHA-256) per section. Only re-indexes files that changed on disk.
  - **Token savings tracking**: Docs tools tracked as `'docs'` source in `kirograph_gain` with naive cost heuristics (92–97% savings vs reading full doc files).
  - **`kirograph_status` enhanced**: Shows docs stats (files, sections, code refs) when enabled.
  - **Sync pipeline integration**: Docs are re-indexed automatically during `kirograph index` and `kirograph sync`.
- **Installer prompt**: "Documentation indexing (section-level retrieval)?" added to the interactive installer. Follow-up prompt for `docsContextLimit` when enabled.
- **Steering file docs section**: Teaches the agent to use `kirograph_docs_*` tools. Conditionally included when docs is enabled.
- **8 new config fields**: `enableDocs`, `docsInclude`, `docsExclude`, `docsLinkCode`, `docsContextLimit`, `docsContextThreshold`, `docsMaxFileSize`, `docsSummarization`.

### Changed

- MCP tool count: 24 → 29 (`kirograph_docs_toc`, `kirograph_docs_search`, `kirograph_docs_section`, `kirograph_docs_outline`, `kirograph_docs_refs`).
- `kirograph_gain` output now shows four source categories: Graph tools, Docs tools, Compression, Memory.
- `TokenSavingsRecord.source` type: `'exec' | 'graph' | 'memory'` → `'exec' | 'graph' | 'memory' | 'docs'`.
- `GraphDatabase` exposes `applyDocsSchema()` for docs module access.
- Installer `installLate` signature extended with `enableDocs` parameter.
- Build script copies `docs-schema.sql` to dist.

---

## [0.15.0] - 2026-05-21: Memory

### Added

- **Memory subsystem** (`enableMemory: true`): persistent cross-session observations stored in isolated `mem_*` tables. Zero LLM tokens on write, minimal tokens on read. Inspired by [cavemem](https://github.com/JuliusBrussee/cavemem).
  - **`kirograph_mem_search` MCP tool**: Hybrid FTS5 + vector search over observations. Supports filtering by kind and session.
  - **`kirograph_mem_store` MCP tool**: Store observations with automatic caveman compression (if enabled), symbol detection, and embedding.
  - **`kirograph_mem_timeline` MCP tool**: Chronological session and observation listing.
  - **`kirograph_mem_status` MCP tool**: Memory health — session count, observations, embedding coverage, model mismatch detection.
  - **CLI mirrors all MCP tools**: `kirograph mem {search,store,timeline,status,prune,export,import,reembed,lint}`.
  - **Observations linked to code symbols**: Detected identifiers in observation text are matched against the graph and stored as `qualified_name` links (stable across reindex).
  - **`kirograph_context` enhanced**: Surfaces relevant memory observations alongside code symbols when memory is enabled (capped at 3 observations, 500 tokens).
  - **`kirograph_impact` enhanced**: Shows related memory observations for the target symbol ("why it was built this way" alongside "what breaks").
  - **`kirograph-mem-capture` hook**: `agentStop` hook that prompts the agent to store important observations at session end. Memory accumulates automatically — the agent decides what's worth remembering.
  - **Caveman compression conditional**: Observations compressed only if `cavemanMode` is not `off`. Uses the same level the user chose during install.
  - **Deduplication**: SHA-256 content hash prevents storing the same observation twice.
  - **Privacy**: `<private>...</private>` blocks stripped at write boundary. Path exclusion patterns via `memoryExcludePatterns` config.
  - **Auto-session management**: Sessions auto-created on first write, auto-closed after configurable inactivity timeout (default: 2 hours).
  - **`kirograph mem lint`**: Health checks — stale symbol links, embedding model mismatch, orphan observations, FTS desync, stale sessions. `--fix` flag for auto-repair.
  - **`kirograph mem reembed`**: Re-embed all observations when the embedding model changes.
  - **`kirograph mem export/import`**: JSONL (round-trip) and Markdown (human-readable) export formats.
  - **Token savings tracking**: Memory tools tracked as `'memory'` source in `kirograph_gain` with naive cost heuristics.
- **Installer prompt**: "Enable memory: persistent cross-session observations?" added to the interactive installer.
- **Steering file memory section**: Teaches the agent to use `kirograph_mem_search` and `kirograph_mem_store`. Conditionally included when memory is enabled.
- **8 new config fields**: `enableMemory`, `memorySearchAlpha`, `memoryKeepRaw`, `memoryMaxObservations`, `memorySessionTimeout`, `memoryContextLimit`, `memoryContextThreshold`, `memoryExcludePatterns`.

### Changed

- MCP tool count: 20 → 24 (`kirograph_mem_search`, `kirograph_mem_store`, `kirograph_mem_timeline`, `kirograph_mem_status`).
- `kirograph_gain` output now shows three source categories: Graph tools, Compression, Memory.
- `TokenSavingsRecord.source` type: `'exec' | 'graph'` → `'exec' | 'graph' | 'memory'`.
- `GraphDatabase` exposes `applyMemorySchema()` and `getRawDb()` for memory module access.
- `KiroGraph` class exposes `getDatabase()` accessor.
- Installer `installLate` signature extended with `enableMemory` parameter.

## [0.14.1] - 2026-05-21: Hook Consolidation & Uninit Fixes

### Changed

- **Hooks consolidated**: Replaced four per-file hooks (`kirograph-mark-dirty-on-save`, `kirograph-mark-dirty-on-create`, `kirograph-sync-on-delete`, `kirograph-sync-if-dirty`) with a single `agentStop` hook (`kirograph-sync-if-dirty.kiro.hook`) that uses `askAgent` to tell the agent to sync if any files changed during the session.
- **Hook file extension**: Migrated from `.json` to `.kiro.hook` extension. The installer automatically migrates existing `.json` hooks and removes legacy files.
- **Compression hint hook**: `kirograph-compress-hint.kiro.hook` now uses `.kiro.hook` extension (was `.json`).

### Fixed

- **`kirograph uninit`**: fixed uninit command failing to fully clean up integration files.

## [0.14.0] - 2026-05-19: Shell Compression

### Added

- **Shell compression engine** (`src/compression/`): Filters and compresses shell command outputs to reduce token consumption by 60-90%. Inspired by [rtk](https://github.com/rtk-ai/rtk), implemented in pure TypeScript with no external dependencies.
  - **6 command family filters**: git, test runners (jest/vitest/pytest/cargo test/go test/rspec/minitest), linters/build (eslint/tsc/ruff/clippy/cargo build/prettier/biome/golangci-lint/rubocop/next build), file listings (ls/find/tree), docker/k8s (docker ps/images/logs, kubectl pods/logs/services), package managers (npm/pip/bundle/pnpm/yarn).
  - **Generic fallback filter**: deduplication + truncation for unrecognized commands.
  - **3 compression levels**: `normal` (balanced), `aggressive` (grouped/limited), `ultra` (counts and summaries only).
  - **Error preservation**: failed commands always show full diagnostic output regardless of compression level.
- **`kirograph_exec` MCP tool**: Run any shell command and return token-optimized output. Works standalone without requiring KiroGraph to be initialized. Supports `command`, `cwd`, `level`, and `timeout` parameters.
- **`kirograph_gain` MCP tool**: Query token savings statistics by period (`session`, `today`, `week`, `all`). Returns total commands, savings percentage, breakdown by command family, and recent history.
- **`kirograph gain` CLI command**: Token savings analytics with `--graph` (ASCII chart), `--history`, `--daily`, `--json`, and `--period` options.
- **`kirograph compression` CLI command**: Set shell compression level (`off | normal | aggressive | ultra`). Mirrors the caveman command pattern with arrow-key display of available levels.
- **`shellCompressionLevel` config field** (default: `'normal'`): Controls the default compression level and whether the hook/steering are installed. Supports legacy `enableCompression` boolean via automatic migration.
- **Installer prompt**: "Enable shell compression (kirograph_exec)?" added to the interactive installer alongside caveman mode.
- **`kirograph-compress-hint.json` hook**: `preToolUse` hook on shell commands that reminds the agent to use `kirograph_exec` for supported command families. Only installed when compression is enabled.
- **Steering file compression section**: Teaches the agent when and how to use `kirograph_exec`, with examples and level descriptions. Conditionally included based on `enableCompression`.
- **Token savings tracker** (`src/compression/tracker.ts`): JSONL-based analytics stored in `.kirograph/token-savings.jsonl`. Session-aware, auto-rotating at 500KB.
- **`compact` format for `kirograph_files`**: New output format showing directory summaries with file counts and language breakdown.
- **Token savings in `kirograph_status`**: Status output now includes session compression stats when available.
- **Documentation updates**: MCP tools docs page updated with `kirograph_exec` and `kirograph_gain` tool cards and sidebar links.

### Changed

- MCP tool count: 18 → 20 (`kirograph_exec`, `kirograph_gain`).
- `kirograph_files` format enum: `tree | flat | grouped` → `tree | flat | grouped | compact`.
- `writeHooks()` now accepts `{ enableCompression?: boolean }` to conditionally include the compression hint hook.
- `writeSteering()` now accepts a `SteeringOptions` object (backward-compatible with the old string signature).
- `TargetInstaller.installLate()` signature extended with `enableCompression` parameter.
- Help output updated with `compression` and `gain` commands in the Agent & Configuration section.

---

## [0.13.1] - 2026-05-18: Multi-client Support

### Added

- **Multi-client installer targets** (`--target claude`, `--target codex`). KiroGraph can now be installed for Claude Code and Codex in addition to Kiro. All targets share the same `.kirograph/` data; installing another target only writes that tool's integration files. Contributed by [Alessandro Franceschi](https://www.linkedin.com/in/alessandrofranceschi/).
  - `kirograph install --target claude`: writes `.mcp.json`, `.kirograph/claude.md`, and imports it from `CLAUDE.md`.
  - `kirograph install --target codex`: writes `.kirograph/codex.md`, generates a KiroGraph block in `AGENTS.md`, and prints the `codex mcp add` command.
- **Centralized MCP tool name list** (`src/mcp/tool-names.ts`): single source of truth for all 18 tool names, used by the installer, CLI agent config, and MCP server registration.
- **Split uninstall prompts**: `kirograph uninit` now asks separately whether to remove integration files and whether to remove `.kirograph/` data. Supports `--target kiro|claude|codex|all`.
- **`kirograph uninstall` alias** for `kirograph uninit`.
- **Shared agent instructions builder** (`src/bin/installer/instructions.ts`): generates tool guidance for Claude and Codex targets, with caveman mode support.
- **Credits section** in README and docs with contributor attributions.

### Changed

- `kirograph install` without `--target` defaults to `kiro` (no behavior change for existing users).
- `autoApprove` list in Kiro MCP config now includes all 18 tools (previously missing `kirograph_hotspots`, `kirograph_surprising`, `kirograph_diff`).
- README and docs restructured to clearly position Kiro as the primary supported target, with other tools marked as experimental.

---

## [0.13.0] - 2026-05-18: Language & Framework Expansion

### Added

- **14 new languages**: Scala (`.scala`, `.sc`, `.sbt`), Lua (`.lua`), Zig (`.zig`, `.zon`), Bash (`.sh`, `.bash`, `.zsh`), OCaml (`.ml`, `.mli`), Elm (`.elm`), Solidity (`.sol`), Vue (`.vue`), Objective-C (`.m`), YAML (`.yaml`, `.yml`), HCL/Terraform (`.tf`, `.tfvars`), CSS (`.css`), SCSS/Sass (`.scss`, `.sass`), and HTML (`.html`, `.htm`). YAML, CSS, and HTML use pre-compiled WASM grammars from `tree-sitter-wasms`. HCL uses a WASM grammar built from [tree-sitter-grammars/tree-sitter-hcl](https://github.com/tree-sitter-grammars/tree-sitter-hcl) and SCSS from [tree-sitter-grammars/tree-sitter-scss](https://github.com/tree-sitter-grammars/tree-sitter-scss), both bundled in `src/extraction/wasm/`.
- **17 new framework resolvers:**
  - **Play (Scala)**: detects Play Framework via `build.sbt`/`plugins.sbt`. Resolves controller, service, and model references. Extracts routes from `conf/routes` and Akka HTTP / http4s DSL patterns.
  - **Nuxt / Vue**: detects Nuxt via `nuxt.config.ts` and Vue via `package.json`. Resolves composables (`useXxx`), auto-imported components (PascalCase → file lookup), and Pinia stores. Extracts file-based routes from `pages/` and server API routes from `server/api/`.
  - **Solidity**: detects Hardhat/Foundry/Truffle projects. Resolves interface references (`IERC20`, etc.), contract inheritance, and library function calls.
  - **SST**: detects SST via `sst.config.ts` or `sst` in `package.json`. Resolves Lambda handler strings to actual function symbols. Extracts API routes from `api.route()` calls and route object literals.
  - **AWS CDK**: detects CDK via `cdk.json` or `aws-cdk-lib` in dependencies. Resolves handler strings and Stack/Construct class references. Extracts API Gateway routes from `addMethod`/`addResource`/`addRoutes` patterns.
  - **Serverless Framework**: detects via `serverless.yml`/`serverless.ts`. Resolves handler strings. Extracts HTTP event routes from YAML config (`- http: GET /users`) and TypeScript config.
  - **AWS SAM**: detects via `template.yaml` with `AWS::Serverless` transform or `samconfig.toml`. Resolves handler strings. Extracts API/HttpApi event routes from SAM template YAML.
  - **Terraform / OpenTofu**: detects via `.terraform/` directory or `.tf` files. Extracts resources, data sources, modules, variables, outputs, and locals as graph nodes via regex-based parsing. Resolves cross-file resource, module, and variable references. Extracts API Gateway routes from `aws_api_gateway_resource` and `aws_api_gateway_method` blocks.
  - **Pulumi**: detects via `Pulumi.yaml` or `@pulumi/*` in dependencies. Resolves resource property references and component class references. Extracts API Gateway routes from route object patterns.
  - **CloudFormation**: detects raw CloudFormation templates (non-SAM) via `AWSTemplateFormatVersion`. Extracts resources (with logical IDs and types), parameters, and outputs. Resolves `!Ref`/`!GetAtt` cross-references.
  - **Kubernetes / Helm**: detects via `Chart.yaml` or K8s manifest directories. Extracts Deployments, Services, ConfigMaps, Ingress, and other resources as typed nodes. Extracts Ingress paths as routes and Service ports.
  - **Docker Compose**: detects via `docker-compose.yml` or `compose.yaml`. Extracts services (as components), networks, volumes, and exposed port mappings.
  - **Ansible**: detects via `ansible.cfg`, playbook files, or standard role directory structure. Extracts plays, tasks, handlers, roles, and variables from the Ansible project structure.
  - **Angular**: detects via `angular.json` or `@angular/core` in dependencies. Resolves services, components, modules, guards, pipes, directives, and interceptors using Angular's naming conventions. Extracts routes from routing modules.
  - **AWS Amplify Gen 2**: detects via `amplify/backend.ts` or `@aws-amplify/backend` in dependencies. Extracts data models from `a.model()`, functions from `defineFunction()`, custom queries/mutations as routes, and resource definitions (`defineAuth`, `defineStorage`, `defineData`). Resolves function handler entry points to actual code.
- **4 new architecture layer detectors:**
  - **Scala**: Play controllers/models/views, SBT services/repositories, Akka actors, Slick persistence.
  - **Vue / Nuxt**: pages, components, composables, stores, server/api, layouts, plugins.
  - **Solidity**: contracts (service), interfaces (api), libraries (shared), storage/migrations (data), mocks.
  - **OCaml**: bin (api), domain/service, db/repo (data), lib (shared). Dune-aware patterns.
- **3 new manifest parsers:**
  - **SBT** (`build.sbt`): extracts project name, version, library dependencies, and multi-module sub-project detection.
  - **OCaml** (`dune-project`, `.opam`): extracts project name, version, dependencies, and discovers sub-libraries via `dune` files.
  - **Elm** (`elm.json`): handles both application and package types, extracts direct dependencies.
- **Language-specific AST node mappings**: added `getLanguageSpecificKind` entries for all 9 new code languages (Scala `object_definition`/`val_definition`/`type_definition`, Lua `local_function`/`local_variable_declaration`, Zig `VarDecl`/`ContainerDecl`, Bash `variable_assignment`, OCaml `let_binding`/`type_binding`/`module_binding`, Elm `function_declaration_left`/`type_alias_declaration`, Solidity `contract_declaration`/`event_definition`/`modifier_definition`/`state_variable_declaration`, Objective-C `class_interface`/`class_implementation`/`protocol_declaration`/`method_declaration`/`property_declaration`).
- **Generic KIND_MAP additions**: `trait_definition` (Scala), `struct_definition` (Zig), `module_definition` (OCaml) added to the shared node type map.
- **Manifest skip directories**: `_build`, `_opam`, `elm-stuff`, `zig-cache`, `zig-out` added to the directory exclusion list during manifest scanning.
- **Expanded test file detection**: `getAffectedTests` default pattern now covers all languages: `*_test.*` (Go, Python, Zig, Lua, OCaml, Elixir), `*Test.*` (Java, Scala), `*Spec.*` (Scala, Ruby), `**/test/**`, `**/spec/**`, `**/src/test/**`, `*.t.sol` (Foundry), `*.bats` (Bash).
- **Hook file patterns**: `kirograph install` now generates hooks that trigger for all supported languages including `.scala`, `.lua`, `.zig`, `.sh`, `.ml`, `.elm`, `.sol`, `.vue`, `.m`, `.yaml`, `.yml`, `.tf`, `.css`, `.scss`, `.html`.

---

## [0.12.2] - 2026-05-16: Documentation Site & npm

### Added

- **GitHub Pages documentation site**: full static site in `docs/` with home, docs, MCP tools reference, CLI reference, and changelog pages. Dark theme, responsive layout, left/right sidebars with scroll-spy navigation.
- **npm publication**: package published as `kirograph` on npm. Install globally with `npm install -g kirograph`.
- **`npm run docs` script**: serves the documentation site locally via `npx serve docs` for development preview.

### Changed

- README images now use absolute URLs (`raw.githubusercontent.com`) instead of relative paths, fixing broken images on npmjs.com.

---

## [0.12.1] - 2026-05-14: Sync Progress & Stability

### Added

- **`sync --progress`**: new verbose per-file progress flag. Prints each file as it is parsed (`parse  [i/total]  path/to/file.ts`), shows exclude-cleanup removals with a distinct `exclude` prefix, and prints all errors inline with full detail instead of a suppressed count.
- **Exclude rule cleanup on sync**: `kirograph sync` now removes already-indexed files that match newly added exclude patterns (e.g. `**/.vite/**`). Previously those files stayed in the index until a full `--force` re-index. The cleanup runs at the start of every sync, before processing changed files.
- **MCP sync awareness in `kirograph_status`**: the `kirograph_status` tool now surfaces sync state. When pending unindexed files exceed a configurable threshold it warns: *"Index may be incomplete: N files pending sync. Sync is running in background. Would you like to wait before proceeding?"* This gives the agent the ability to pause rather than silently working with a stale index.
- **`syncWarningThreshold` config field**: controls the pending-file count above which `kirograph_status` emits the staleness warning. Default `10`. Set to `0` to disable.
- **Sync state in `kirograph status` CLI**: the status command now shows a `Sync` section with idle/running state and pending file count, with a yellow warning when the count exceeds the threshold.
- **`LockManager.isLocked()`**: exposes whether a sync/index is currently running in another process, used by both the MCP tool and CLI status command.
- **`KiroGraph.getPendingSyncCount()`**: returns the number of files that have changed on disk but are not yet reflected in the index. Uses `git status` first, falls back to a filesystem diff against the indexed set.
- **Large-codebase pre-flight warning**: when embeddable node count exceeds 100K, a yellow warning is printed before the embedding phase starts, advising the user to disable embeddings or use a lighter model.
- **Paginated `embedAll`**: the embedding phase now streams nodes in pages of 2,000 instead of loading all nodes into memory at once. Critical for large codebases (100K+ symbols) where a single `getAllNodes()` call could exhaust the Node.js heap or WASM linear memory.
- **`getEmbeddableNodesPaged()` and `countEmbeddableNodes()`**: new paginated DB queries for memory-efficient embedding.

### Fixed

- **WASM parser poisoning on large codebases**: when a tree-sitter WASM parser aborts (e.g. due to memory pressure), the language is now tracked as "poisoned" and remaining files of that language are skipped until `clearParserCache()` + `initGrammars()` succeeds. Previously, every subsequent file of the same language would instantly re-abort, producing hundreds of `Aborted()` messages and wasting time.
- `config-prompt.ts`: `cavemanMode` was missing from the initial `ConfigPatch` object literal, causing a TypeScript error. Default is now `'off'` (overwritten later in the prompt flow).
- `config-prompt.ts`: `CavemanMode` type was used but never defined or imported; added local type alias.

---

## [0.12.0] - 2026-05-09: Elixir & Phoenix

### Added

- **Elixir language support**: `.ex` and `.exs` files are now indexed using the `tree-sitter-elixir` grammar (already included in `tree-sitter-wasms`). Extracts modules (`defmodule`), functions (`def`, `defp`), macros (`defmacro`, `defmacrop`), protocols (`defprotocol`), implementations (`defimpl`), and structs (`defstruct`). `defp` and `defmacrop` are marked private. `alias`, `use`, `import`, and `require` are extracted as import edges.
- **Phoenix framework detection**: auto-detected via `mix.exs` containing `:phoenix`. Resolves `Controller`, `LiveView`, and `Channel` module references by convention. Extracts HTTP routes (`get`, `post`, `put`, `patch`, `delete`), `resources`, and `live` routes from `router.ex` as `route` nodes.
- **Elixir architecture layer detection**: Phoenix-aware glob patterns for all five layers: `api` (controllers, channels, router, plugs), `service` (contexts, workers, jobs), `data` (schemas, repo, migrations), `ui` (LiveView, components, views, templates), `shared` (helpers, lib, config, mailers).
- Auto-sync hooks now fire for `.ex` and `.exs` files.

### Fixed

- **Multi-language call edge extraction**: `walkForCalls` previously only recognised `call_expression` (JS/TS/Go/Rust/…). C# (`invocation_expression`), Java (`method_invocation`), Python (`call`), Ruby (`call`), and PHP (`function_call_expression`) produced zero call edges, causing empty `kirograph_callers`, `kirograph_callees`, and `kirograph_hotspots` results. All missing call node types are now handled with per-language name extraction using tree-sitter field lookups.
- **Inheritance edge extraction for C# and Java**: `walkTree` now scans `base_list` (C# class/interface declarations) and `superclass`/`super_interfaces`/`extends_interfaces` (Java) to emit `extends` and `implements` edges. This restores `kirograph_type_hierarchy` results for C# and Java projects.
- **Namespace/package import resolution**: `_resolveImportPath` previously returned `null` for any import that didn't start with `.`. Java package imports (`import com.example.Foo`) now resolve via exact qualifiedName lookup, then name+namespace-prefix match. C# namespace imports (`using MyApp.Services`) resolve via a new namespace prefix cache (built from qualifiedNames at warm-cache time) and namespace node lookup. Wildcard imports (`import com.example.*`) resolve to any type in the namespace.

---

## [0.11.0] - 2026-04-20: Interactive Graph Dashboard

### Added

- `kirograph export` is now available to render a full interactive graph dashboard.
- **Search**: live symbol search; matching nodes are highlighted, non-matching ones dim; viewport fits to results
- **Two-click path**: click any two nodes to instantly find and highlight the shortest path between them, with detail cards for both endpoints
- **Zoom to node**: clicking a node zooms in so its label is always readable
- **Cluster view**: group nodes by directory; click the cluster to expand it back to the full graph
- **Minimap**: always-visible overview of the full graph; click to pan
- **Right-click menu**: focus neighbors, start a path, copy ID or file path, highlight all nodes of the same kind
- **Heat map**: color nodes by how recently their file was modified, to spot the most active areas of the codebase
- **Analytics charts**: bar chart of the most connected symbols, donut chart of node distribution by kind, degree distribution curve

### Fixed

- FTS5 query sanitizer now strips commas: task strings with commas (e.g. `kirograph_context`) previously caused `fts5: syntax error near ","`
- `kirograph path` resolves to real symbol kinds (class, function, method…) before falling back to import/file nodes
- `findPath` BFS is now undirected: traverses edges in both directions

---

## [0.10.0] - 2026-04-18: Hotspots, Snapshots & Dead Code

### Added

- `kirograph_hotspots` MCP tool: finds the most-connected symbols by total edge degree (in + out, excluding `contains`); rendered with an inline bar chart showing in/out breakdown
- `kirograph_surprising` MCP tool: finds non-obvious cross-file connections scored by path distance × edge-kind weight (`calls=1.0`, `references=0.8`, `type_of=0.7`, etc.)
- `kirograph_diff` MCP tool: compares the current graph against a saved snapshot; shows added/removed symbols and edges
- `kirograph hotspots` CLI command: table output with proportional bar chart; `--limit`, `--format json`
- `kirograph surprising` CLI command: ranked list of unexpected cross-module links; `--limit`, `--format json`
- `kirograph snapshot save|list|diff` CLI commands: save lightweight graph snapshots to `.kirograph/snapshots/`, list them, and diff current graph vs any snapshot; `--format full|json`
- `kirograph dead-code` CLI command: groups unexported unreferenced symbols by file; `--limit`, `--format json`; achieves CLI parity with `kirograph_dead_code` MCP tool
- `kirograph path <from> <to>` CLI command: finds shortest path between two symbols via undirected BFS; shows resolved nodes and hop chain; `--format json`; achieves CLI parity with `kirograph_path` MCP tool
- `SnapshotManager` in `src/core/snapshot.ts`: save/load/diff logic; diffs computed as O(n) set operations on node ID and edge tuple sets
- `findHotspots()` and `findSurprisingConnections()` on `GraphDatabase`; `getAllEdges()` for snapshot capture

### Changed

- Help output reorganised into six named groups (🔧 Workspace Setup, 📦 Indexing, 🔍 Search & Exploration, 📊 Graph Insights, 🏛️ Architecture Analysis, ⚙️ Agent & Configuration) with consistent cross-group alignment
- `kirograph caveman` rendered in brown with 🪨 prefix and attribution line: _Inspired by Caveman: original idea by github.com/JuliusBrussee/caveman_
- `findPath` BFS changed from directed-only to undirected: now traverses edges in both directions, finding connections across the full graph not just directed call chains
- `path` command prefers real symbol kinds (function, class, method, etc.) over import/file nodes when resolving search results

### Fixed

- FTS5 query sanitizer now strips commas: long natural-language task descriptions containing commas (e.g. in `kirograph_context`) previously caused `fts5: syntax error near ","` errors

---

## [0.9.0] - 2026-04-16: Caveman Mode

### Added

- Caveman mode: agent communication style compression, inspired by [caveman](https://github.com/JuliusBrussee/caveman) by JuliusBrussee
- `cavemanMode` config field (`off` | `lite` | `full` | `ultra`); default `off`
- `kirograph caveman [mode]` command: reads or sets the mode; regenerates steering file and CLI agent config immediately
- Four compression levels: `lite` (compact, no filler, full sentences), `full` (fragments, no articles), `ultra` (maximum compression, abbreviations, `→` for causality)
- Rules injected into `.kiro/steering/kirograph.md` (IDE, `inclusion: always`) and inlined into `.kiro/agents/kirograph.json` prompt (kiro-cli): no extra hook calls
- `kirograph install` interactive arrow-key prompt for caveman mode selection

### Changed

- Caveman rules no longer use a dedicated hook file (`kirograph-caveman.json`): the steering file's `inclusion: always` makes injection hooks unnecessary for both IDE and CLI

---

## [0.8.0] - 2026-04-14: esbuild Migration

### Added

- `esbuild` + `tsx` replace `tsc` as the build pipeline: ~400ms builds vs ~5-10s
- `npm run dev` watch mode with incremental rebuilds
- `npm run typecheck` for type-only validation (`tsc --noEmit`), decoupled from the build

### Changed

- `scripts/build.ts` (TypeScript, executed via `tsx`) replaces the old `tsc && node scripts/copy-assets.js && chmod +x` chain
- Asset copy (schema.sql, wasm files) and bin chmod are now part of the build script
- `scripts/copy-assets.js` removed
- `postinstall` script removed: embedding models are downloaded lazily on first use, making the pre-download unnecessary
- Embedding model progress bar shown only during `kg install`, not on every command
- Model download progress aggregated into a single global bar (`X / Y MB`) instead of per-file
- Noisy `@huggingface/transformers` internal warnings suppressed during model download

### Fixed

- Dynamic `import()` of relative modules rewritten to `Promise.resolve().then(() => require())` at build time, fixing the double-default CJS/ESM wrapping issue
- Model cache detection updated for `@huggingface/transformers` v3 directory layout (`org/model` instead of `org--model`), preventing re-download on every command

---

## [0.7.0] - 2026-04-14: Embedding Model Selection

### Added

- Configurable embedding model selection: `kirograph install` now presents an arrow-key menu with four curated models plus a custom option
- `embeddingDim` config field; all vector engine constructors use it instead of a hardcoded `768`
- `VectorManager.initialize()` runs a post-load dimension check: if the model's actual output shape differs from `embeddingDim`, a warning is logged and the runtime value is corrected automatically
- Curated model presets: `nomic-ai/nomic-embed-text-v1.5` (768-dim, ~130 MB, default), `onnx-community/embeddinggemma-300m-ONNX` (768-dim, ~300 MB, Google Gemma-based, multilingual, 2048-token context), `Xenova/all-MiniLM-L6-v2` (384-dim, ~23 MB), `BAAI/bge-base-en-v1.5` (768-dim, ~110 MB), and a free-form custom entry that prompts for model ID and dimension

### Changed

- Migrated from `@xenova/transformers` (v2) to `@huggingface/transformers` (v3), enabling support for modern ONNX models (IR version 10+)
- `typesense` moved from `dependencies` to `optionalDependencies`, consistent with all other engine packages

### Fixed

- Cache-hit detection in `postinstall.js` was `replace('/', '/')`: a no-op; now correctly uses `replace('/', '--')`

### Security

- Added `axios` override (`^1.8.3`) to patch two critical CVEs in typesense's transitive dependency: [GHSA-3p68-rc4w-qgx5](https://github.com/advisories/GHSA-3p68-rc4w-qgx5) and [GHSA-fvcv-3m26-pcqx](https://github.com/advisories/GHSA-fvcv-3m26-pcqx)

---

## [0.6.0] - 2026-04-13: Architecture Analysis

### Added

- `enableArchitecture` config field (default `false`) and opt-in `architectureLayers` override map
- Package detection via two strategies: manifest-based (parses `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`/`setup.py`/`setup.cfg`, `pom.xml`, `build.gradle`/`build.gradle.kts`, `.csproj`) and directory fallback when a root manifest covers the whole repo
- Layer detection with per-language glob patterns for `api`, `service`, `data`, `ui`, and `shared` tiers; detectors for TypeScript/JS, Python, Go, Java, Ruby, Rust, and C#
- Package dependency rollup derived from existing `imports` edges: no re-parsing required
- Coupling metrics per package: afferent Ca, efferent Ce, instability `Ce / (Ca + Ce)`
- Seven new `arch_*` tables in `kirograph.db`; zero overhead when `enableArchitecture` is `false`
- MCP tools: `kirograph_architecture`, `kirograph_coupling`, `kirograph_package`
- CLI commands: `kirograph architecture`, `kirograph coupling`, `kirograph package`
- `kirograph install` prompts to enable architecture analysis
- Steering file and CLI agent config updated to teach Kiro when and how to use the architecture tools

---

## [0.5.0] - 2026-04-10: CLI Agent

### Added

- `kirograph install` writes `.kiro/agents/kirograph.json`: a workspace custom agent with the MCP server wired up, steering instructions inlined as the system prompt, and sync hooks at `agentSpawn`, `userPromptSubmit`, and `stop`
- Support for `kiro-cli --agent kirograph` and the `/agent swap kirograph` in-session command
- CLI sync strategy for kiro-cli: `kirograph sync-if-dirty --quiet` at session boundaries (the CLI has no file-watch events)

---

## [0.4.0] - 2026-04-01: Guided Installer

### Added

- Interactive guided installer (`kirograph install`) that wires up a Kiro workspace in one command
- Installer writes `.kiro/settings/mcp.json`, `.kiro/hooks/*.json`, `.kiro/steering/kirograph.md`, and `.kiro/agents/kirograph.json`
- Interactive prompts for all config options: embeddings on/off, embedding model, semantic engine, Typesense/Qdrant dashboard opt-in, docstring extraction, call-site tracking, and architecture analysis
- Auto-installs optional npm dependencies for the chosen engine
- Optional immediate project initialisation and indexing after configuration
- Opens Typesense or Qdrant dashboard post-index when opted in

### Fixed

- Ctrl+C shutdown crash after the Typesense dashboard starts: replaced `process.exit(0)` in the SIGINT handler with a graceful HTTP server close, eliminating a native addon mutex race condition

---

## [0.3.5] - 2026-04-07: Typesense Engine

### Added

- `typesense` engine: ANN search via auto-downloaded Typesense binary (~37 MB, cached at `~/.kirograph/bin/`); persistent daemon; local dashboard UI; requires `typesense`

---

## [0.3.4] - 2026-04-07: Qdrant Engine

### Added

- `qdrant` engine: ANN search via Qdrant embedded binary (HNSW, cosine); managed child process with a persistent daemon between commands; built-in Web UI dashboard (`kirograph dashboard start`); requires `qdrant-local`

---

## [0.3.3] - 2026-04-06: LanceDB Engine

### Added

- `lancedb` engine: ANN cosine search via Apache Lance columnar format; pure JS (`@lancedb/lancedb`); data stored in `.kirograph/lancedb/`

---

## [0.3.2] - 2026-04-01: PGlite Engine

### Added

- `pglite` engine: hybrid search via WASM-compiled PostgreSQL + `pgvector`; exact vector results; single dependency (`@electric-sql/pglite`), zero native binaries

---

## [0.3.1] - 2026-03-31: Orama Engine

### Added

- `orama` engine: hybrid full-text + vector search via `@orama/orama`; pure JS, no native dependencies; index persisted to `.kirograph/orama.json`

---

## [0.3.0] - 2026-03-31: Pluggable Vector Engines

### Added

- `sqlite-vec` engine: ANN index stored in `.kirograph/vec.db`; sub-linear search time; requires `better-sqlite3` + `sqlite-vec` (native compiled)
- `semanticEngine` config field accepting `cosine | sqlite-vec | orama | pglite | lancedb | qdrant | typesense`
- Each engine is an optional dependency: only installed when chosen; absent packages fall back silently to `cosine`

### Changed

- `useVecIndex` boolean is now a deprecated alias for `semanticEngine: 'sqlite-vec'`; existing configs continue to work

---

## [0.2.0] - 2026-03-30: MCP Server & Hooks

### Added

- MCP server (`kirograph serve --mcp`) registered in `.kiro/settings/mcp.json` with all tools auto-approved
- Four IDE hooks to keep the index fresh automatically: `fileEdited` → `kirograph mark-dirty`, `fileCreated` → `kirograph mark-dirty`, `fileDeleted` → `kirograph sync-if-dirty`, `agentStop` → `kirograph sync-if-dirty --quiet`
- Steering file `.kiro/steering/kirograph.md` that teaches the IDE agent to prefer graph tools over file scanning
- `LockManager` and dirty-marker system: changes are batched and synced at agent idle with no overhead during active editing

---

## [0.1.0] - 2026-03-27: Initial Release

### Added

- Initial port of [CodeGraph](https://github.com/colbymchenry/codegraph) to Kiro's MCP and hooks system
- Storage layer rebuilt with `node-sqlite3-wasm` (pure WASM SQLite, no native compilation) replacing `better-sqlite3`
- Cache directory at `~/.kirograph/`
- MCP server wired to Kiro's `.kiro/settings/mcp.json` format
- Hooks wired to Kiro's `.kiro/hooks/` format
- `@xenova/transformers` for local embedding model inference
- Cosine similarity as the default semantic engine: no extra dependencies
- Full tree-sitter AST extraction pipeline: 17 languages, 24 node kinds, 12 edge kinds
- MCP tools: `kirograph_context`, `kirograph_search`, `kirograph_callers`, `kirograph_callees`, `kirograph_impact`, `kirograph_node`, `kirograph_type_hierarchy`, `kirograph_path`, `kirograph_dead_code`, `kirograph_circular_deps`, `kirograph_files`, `kirograph_status`
- CLI: `kirograph index`, `kirograph sync`, `kirograph query`, `kirograph context`, `kirograph files`, `kirograph affected`, `kirograph status`, `kirograph unlock`

[0.13.1]: https://github.com/davide-desio-eleva/kirograph/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.12.2...v0.13.0
[0.12.2]: https://github.com/davide-desio-eleva/kirograph/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/davide-desio-eleva/kirograph/compare/v0.12.0...v0.12.1
[0.10.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/davide-desio-eleva/kirograph/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/davide-desio-eleva/kirograph/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/davide-desio-eleva/kirograph/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/davide-desio-eleva/kirograph/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/davide-desio-eleva/kirograph/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/davide-desio-eleva/kirograph/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/davide-desio-eleva/kirograph/releases/tag/v0.1.0
