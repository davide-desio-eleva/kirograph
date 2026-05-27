# Feature Comparison: KiroGraph vs Related Tools

A comparison of KiroGraph with the open-source projects that inspired it or operate in the same space.

| Project | Author | Language | Focus | Stars |
|---------|--------|----------|-------|-------|
| [KiroGraph](https://github.com/davide-desio-eleva/kirograph) | davide-desio-eleva | TypeScript | All-in-one code intelligence for Kiro | 81 ⭐ |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | colbymchenry | TypeScript | Code knowledge graph for Claude Code | 27.6k ⭐ |
| [code-review-graph](https://github.com/tirth8205/code-review-graph) | tirth8205 | Python | Code graph for token-efficient reviews | 17.4k ⭐ |
| [jCodeMunch-MCP](https://github.com/jgravelle/jcodemunch-mcp) | jgravelle | Python | Token-efficient code retrieval via AST | 1.9k ⭐ |
| [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) | jgravelle | Python | Documentation section retrieval | — |
| [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) | jgravelle | Python | Tabular data exploration | — |
| [caveman](https://github.com/JuliusBrussee/caveman) | JuliusBrussee | Markdown (skill) | Agent prose compression | 63.3k ⭐ |
| [cavemem](https://github.com/JuliusBrussee/cavemem) | JuliusBrussee | TypeScript | Persistent cross-agent memory | 457 ⭐ |
| [rtk](https://github.com/rtk-ai/rtk) | rtk-ai | Rust | Shell output compression proxy | 54.8k ⭐ |
| [lean-ctx](https://github.com/yvgude/lean-ctx) | yvgude | Rust | Cognitive context layer (cache + compress + memory) | 2.2k ⭐ |

> **Note:** jCodeMunch, jDocMunch, and jDataMunch are three separate MCP servers by the same author (J. Gravelle), each focused on a different data type. They share a design philosophy (token-efficient retrieval via structured indexing) but run as independent servers.

---

## Feature Matrix

### Code Graph & Analysis

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|
| Tree-sitter AST parsing | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — |
| SQLite local storage | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — |
| Symbol search (FTS) | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — |
| Call graph (callers/callees) | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| Impact/blast radius analysis | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| Type hierarchy traversal | ✅ | — | — | — | — | — | — | — | — |
| Circular dependency detection | ✅ | — | ✅ | — | — | — | — | — | — |
| Dead code detection | ✅ | — | ✅ | — | — | — | — | — | — |
| Hotspot/hub detection | ✅ | — | ✅ | — | — | — | — | — | — |
| Surprise/cross-module coupling | ✅ | — | ✅ | — | — | — | — | — | — |
| Affected tests | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| Context building (one-call) | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — |
| Byte-level precision retrieval | — | — | — | ✅ | ✅ | — | — | — | — |
| Trace (path between symbols) | ✅ | ✅ | — | — | — | — | — | — | — |
| Execution flow tracing | ✅ | — | ✅ | — | — | — | — | — | — |
| Community/cluster detection | ✅ (Louvain) | — | ✅ (Leiden) | — | — | — | — | — | — |
| Edge confidence scoring | ✅ | — | ✅ | — | — | — | — | — | — |
| Graph diff (snapshots) | ✅ | — | ✅ | — | — | — | — | — | — |
| Framework-aware routes | ✅ (14+ frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — |
| Mixed iOS/RN bridging | ✅ | ✅ | — | — | — | — | — | — | — |
| Dynamic reindexing | — | — | — | ✅ | — | — | — | — | — |

### Architecture

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|
| Package graph | ✅ | — | — | — | — | — | — | — | — |
| Layer detection | ✅ | — | — | — | — | — | — | — | — |
| Coupling metrics (Ca/Ce/instability) | ✅ | — | — | — | — | — | — | — | — |
| Architecture overview | ✅ | — | ✅ | — | — | — | — | — | — |
| Refactoring suggestions | ✅ | — | ✅ | — | — | — | — | — | — |
| Rename preview | ✅ | — | ✅ | — | — | — | — | — | — |

### Semantic Search & Embeddings

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|
| Vector embeddings | ✅ | — | ✅ | — | — | — | — | ✅ | — |
| Multiple engine options | ✅ (7 engines) | — | — | — | — | — | — | — | — |
| Custom HuggingFace models | ✅ | — | — | — | — | — | — | — | — |
| Hybrid search (FTS + vector) | ✅ | — | ✅ | — | — | — | — | — | — |
| Local-only (no API keys) | ✅ | ✅ | ✅ (optional cloud) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Memory & Knowledge

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|
| Persistent cross-session memory | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — |
| Observations linked to symbols | ✅ | — | — | — | — | — | — | — | — |
| Compressed storage | ✅ | — | — | — | — | — | — | ✅ | — |
| Memory deduplication (SHA-256) | ✅ | — | — | — | — | — | — | ✅ | — |
| Memory search (semantic) | ✅ | — | — | — | — | — | — | ✅ | — |
| Zero LLM tokens on write | ✅ | — | — | — | — | — | — | ✅ | — |
| Hook-based auto-capture | ✅ | — | — | — | — | — | — | ✅ | — |

### Documentation & Data

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|
| Documentation indexing | ✅ | — | — | — | ✅ | — | — | — | — |
| Section-level retrieval | ✅ | — | — | — | ✅ | — | — | — | — |
| Stable section IDs | ✅ | — | — | — | ✅ | — | — | — | — |
| Multiple doc formats | ✅ (9 formats) | — | — | — | ✅ (8+ formats) | — | — | — | — |
| Code ↔ docs cross-references | ✅ | — | — | — | — | — | — | — | — |
| Tabular data querying | ✅ | — | — | — | — | ✅ | — | — | — |
| CSV/JSON/Excel/Parquet support | ✅ | — | — | — | — | ✅ | — | — | — |
| Server-side aggregations | ✅ | — | — | — | — | ✅ | — | — | — |
| Column profiling | ✅ | — | — | — | — | ✅ | — | — | — |
| Streaming parsers | ✅ | — | — | — | — | ✅ | — | — | — |

### Token Optimization

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|
| Shell output compression | ✅ | — | — | — | — | — | — | — | ✅ |
| Agent prose compression (caveman) | ✅ | — | — | — | — | — | ✅ | — | — |
| Token analytics/tracking | ✅ | — | ✅ | — | — | — | — | — | — |
| Estimated context savings | ✅ | — | ✅ | — | — | — | — | — | — |
| Token benchmarking | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| Command family filters | ✅ (6 families) | — | — | — | — | — | — | — | ✅ (20+ families) |
| Standalone CLI proxy | — | — | — | — | — | — | — | — | ✅ |
| Token-efficient by design | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Integration & Platform Support

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|
| MCP server (stdio) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| Primary target | Kiro | Claude Code | Claude Code | Any MCP client | Any MCP client | Any MCP client | Claude Code | Claude Code | Any shell |
| Multi-platform support | ✅ (34 targets) | ✅ (7 targets) | ✅ (13 targets) | — | — | — | — | — | ✅ (any agent) |
| Auto-detection of platforms | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| Auto-sync hooks | ✅ | ✅ (file watcher) | ✅ (hooks + watch) | — | — | — | — | — | — |
| Incremental updates | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — |
| VS Code extension | — | ✅ | ✅ | — | — | — | — | — | — |
| Interactive visualization | ✅ | — | ✅ | — | — | — | — | — | — |
| Graph export (GraphML, Cypher, Obsidian) | ✅ | — | ✅ | — | — | — | — | — | — |
| Multi-repo support | — | — | ✅ | — | — | — | — | — | — |
| Uninit/uninstall | ✅ | ✅ | — | — | — | — | — | — | — |

### Language Support

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|
| Languages supported | 24+ | 22 | 30+ | 20+ | N/A | N/A | N/A | N/A | N/A |
| Framework detection | ✅ (26 frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — |
| Framework-aware route extraction | ✅ (14+ frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — |
| Jupyter notebook support | — | — | ✅ | — | — | — | — | — | — |

---

## How They Relate

```
┌─────────────────────────────────────────────────────────────────────┐
│                          KiroGraph                                   │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐ │
│  │  Graph   │  │  Memory  │  │   Docs   │  │   Data   │  │ Shell│ │
│  │ (CodeGraph│  │(cavemem) │  │(jDocMunch│  │(jDataMun │  │(rtk) │ │
│  │ inspired)│  │ inspired)│  │ inspired)│  │ inspired)│  │insp.)│ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────┘ │
│                                                                     │
│  + Architecture analysis + Caveman mode + 7 semantic engines        │
│  + 34 platform targets + Auto-detection + Token analytics           │
└─────────────────────────────────────────────────────────────────────┘
```

KiroGraph combines the capabilities of 7 separate tools into a single integrated package:

- **Code graph** layer inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) — tree-sitter parsing, symbol extraction, call graphs, impact analysis
- **Memory** layer inspired by [cavemem](https://github.com/JuliusBrussee/cavemem) — persistent observations, compressed storage, hook-based capture
- **Documentation** layer inspired by [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) — section-level retrieval, stable IDs, multiple formats
- **Data** layer inspired by [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) — tabular data querying, column profiling, server-side computation
- **Shell compression** inspired by [rtk](https://github.com/rtk-ai/rtk) — token-optimized command output with family-specific filters
- **Prose compression** inspired by [caveman](https://github.com/JuliusBrussee/caveman) — agent communication compression (lite/full/ultra)
- **Context layer** inspired by [lean-ctx](https://github.com/yvgude/lean-ctx) — file read caching, multiple read modes, context budget governance

The [jCodeMunch-MCP](https://github.com/jgravelle/jcodemunch-mcp) family (jCodeMunch + jDocMunch + jDataMunch) represents the same "token-efficient retrieval" philosophy applied to three different data types: source code, documentation, and tabular data. KiroGraph unifies all three into a single MCP server with a shared graph database.

[code-review-graph](https://github.com/tirth8205/code-review-graph) is the closest competitor in scope, with its own graph + community detection + refactoring tools + multi-platform support. The main differences are language (Python vs TypeScript), primary target (Claude Code vs Kiro), and KiroGraph's additional documentation/data/memory layers.

[lean-ctx](https://github.com/yvgude/lean-ctx) focuses on the context transport layer (caching, compression, governance). KiroGraph integrates these concepts alongside deep code intelligence — users get both efficient delivery and structural understanding in one tool.

---

## Key Differentiators

| What makes it unique | KiroGraph | CodeGraph | code-review-graph |
|---------------------|-----------|-----------|-------------------|
| All-in-one (graph + memory + docs + data + compression) | ✅ | — | — |
| 7 pluggable semantic engines | ✅ | — | — |
| Architecture metrics (Ca/Ce/instability) | ✅ | — | — |
| Documentation cross-references to code | ✅ | — | — |
| Tabular data querying via MCP | ✅ | — | — |
| Framework-aware route extraction (14+ frameworks) | ✅ | ✅ | — |
| Community detection | ✅ (Louvain) | — | ✅ (Leiden) |
| Execution flow tracing | ✅ | — | ✅ |
| Refactoring tools (rename + suggest) | ✅ | — | ✅ |
| Mixed iOS/RN/Expo cross-language bridging | — | ✅ | — |
| Multi-repo daemon with health checks | — | — | ✅ |
| Self-contained binary (no Node.js required) | — | ✅ | — |
