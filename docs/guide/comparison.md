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

> **Note on lean-ctx:** lean-ctx is a context transport layer (file read caching, compression, budget governance) rather than a graph or analysis tool. It does not offer symbol-level analysis, vulnerability scanning, or memory — its columns in the matrices below are all `—`.

---

## Feature Matrix

### Code Graph & Analysis

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| Tree-sitter AST parsing | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| SQLite local storage | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — | — |
| Symbol search (FTS) | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| Call graph (callers/callees) | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| Impact/blast radius analysis | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| Type hierarchy traversal | ✅ | — | — | — | — | — | — | — | — | — |
| Circular dependency detection | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Dead code detection | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Hotspot/hub detection | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Surprise/cross-module coupling | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Affected tests | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| Context building (one-call) | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | ✅ |
| Byte-level precision retrieval | — | — | — | ✅ | ✅ | — | — | — | — | — |
| Trace (path between symbols) | ✅ | ✅ | — | — | — | — | — | — | — | — |
| Execution flow tracing | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Community/cluster detection | ✅ (Leiden) | — | ✅ (Leiden) | — | — | — | — | — | — | — |
| Edge confidence scoring | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Graph diff (snapshots) | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Framework-aware routes | ✅ (14+ frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — | — |
| Mixed iOS/RN/Android bridging | ✅ (incl. Android/Kotlin) | ✅ | — | — | — | — | — | — | — | — |
| Dynamic reindexing | — | — | — | ✅ | — | — | — | — | — | — |
| File read caching | ✅ | — | — | — | — | — | — | — | — | ✅ |
| Context budget governance | ✅ | — | — | — | — | — | — | — | — | ✅ |

### Architecture

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| Package graph | ✅ | — | — | — | — | — | — | — | — | — |
| Layer detection | ✅ | — | — | — | — | — | — | — | — | — |
| Coupling metrics (Ca/Ce/instability) | ✅ | — | — | — | — | — | — | — | — | — |
| Architecture overview | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Refactoring suggestions | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Rename preview | ✅ | — | ✅ | — | — | — | — | — | — | — |

### Security *(opt-in, requires `enableSecurity: true`)*

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| Dependency vulnerability scanning | ✅ | — | — | — | — | — | — | — | — | — |
| OSV vulnerability database | ✅ | — | — | — | — | — | — | — | — | — |
| Call-graph reachability analysis | ✅ | — | — | — | — | — | — | — | — | — |
| Architecture-layer impact (affected layers) | ✅ | — | — | — | — | — | — | — | — | — |
| CycloneDX 1.5 SBOM export | ✅ | — | — | — | — | — | — | — | — | — |
| CycloneDX 1.5 VEX export | ✅ | — | — | — | — | — | — | — | — | — |
| Fix suggestions per ecosystem | ✅ | — | — | — | — | — | — | — | — | — |
| EPSS exploitation probability score | ✅ | — | — | — | — | — | — | — | — | — |
| License compliance (SPDX + policy) | ✅ | — | — | — | — | — | — | — | — | — |
| Dependency staleness score | ✅ | — | — | — | — | — | — | — | — | — |
| Dashboard security overlay | ✅ | — | — | — | — | — | — | — | — | — |
| Manual CVE registration | ✅ | — | — | — | — | — | — | — | — | — |
| Queryable via MCP by AI agents | ✅ | — | — | — | — | — | — | — | — | — |

### Semantic Search & Embeddings

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| Vector embeddings | ✅ | — | ✅ | — | — | — | — | ✅ | — | — |
| Multiple engine options | ✅ (7 engines) | — | — | — | — | — | — | — | — | — |
| Custom HuggingFace models | ✅ | — | — | — | — | — | — | — | — | — |
| Hybrid search (FTS + vector) | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Local-only (no API keys) | ✅ | ✅ | ✅ (optional cloud) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Memory & Knowledge

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| Persistent cross-session memory | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — | ✅ |
| Observations linked to symbols | ✅ | — | — | — | — | — | — | — | — | — |
| Compressed storage | ✅ | — | — | — | — | — | — | ✅ | — | — |
| Memory deduplication (SHA-256) | ✅ | — | — | — | — | — | — | ✅ | — | — |
| Memory search (semantic) | ✅ | — | — | — | — | — | — | ✅ | — | — |
| Zero LLM tokens on write | ✅ | — | — | — | — | — | — | ✅ | — | — |
| Hook-based auto-capture | ✅ | — | — | — | — | — | — | ✅ | — | — |

### Documentation & Data

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| Documentation indexing | ✅ | — | — | — | ✅ | — | — | — | — | — |
| Section-level retrieval | ✅ | — | — | — | ✅ | — | — | — | — | — |
| Stable section IDs | ✅ | — | — | — | ✅ | — | — | — | — | — |
| Multiple doc formats | ✅ (9 formats) | — | — | — | ✅ (8+ formats) | — | — | — | — | — |
| Code ↔ docs cross-references | ✅ | — | — | — | — | — | — | — | — | — |
| Tabular data querying | ✅ | — | — | — | — | ✅ | — | — | — | — |
| CSV/JSON/Excel/Parquet support | ✅ | — | — | — | — | ✅ | — | — | — | — |
| Server-side aggregations | ✅ | — | — | — | — | ✅ | — | — | — | — |
| Column profiling | ✅ | — | — | — | — | ✅ | — | — | — | — |
| Streaming parsers | ✅ | — | — | — | — | ✅ | — | — | — | — |

### Token Optimization

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| Shell output compression | ✅ | — | — | — | — | — | — | — | ✅ | — |
| Agent prose compression (caveman) | ✅ | — | — | — | — | — | ✅ | — | — | — |
| Token analytics/tracking | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Estimated context savings | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Token benchmarking | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| Command family filters | ✅ (6 families) | — | — | — | — | — | — | — | ✅ (20+ families) | — |
| Standalone CLI proxy | — | — | — | — | — | — | — | — | ✅ | — |
| Token-efficient by design | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Integration & Platform Support

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| MCP server (stdio) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | — |
| Primary target | Kiro | Claude Code | Claude Code | Any MCP client | Any MCP client | Any MCP client | Claude Code | Claude Code | Any shell | Any MCP client |
| Multi-platform support | ✅ (34 targets) | ✅ (7 targets) | ✅ (13 targets) | — | — | — | — | — | ✅ (any agent) | — |
| Auto-detection of platforms | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| Auto-sync hooks | ✅ | ✅ (file watcher) | ✅ (hooks + watch) | — | — | — | — | — | — | — |
| Incremental updates | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | — |
| VS Code extension | — | ✅ | ✅ | — | — | — | — | — | — | — |
| Interactive visualization | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Graph export (GraphML, Cypher, Obsidian) | ✅ | — | ✅ | — | — | — | — | — | — | — |
| Multi-repo support | — | — | ✅ | — | — | — | — | — | — | — |
| Uninit/uninstall | ✅ | ✅ | — | — | — | — | — | — | — | — |

### Language Support

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|
| Languages supported | 24+ | 22 | 30+ | 20+ | N/A | N/A | N/A | N/A | N/A | N/A |
| Framework detection | ✅ (26 frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — | — |
| Framework-aware route extraction | ✅ (14+ frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — | — |
| Jupyter notebook support | ✅ | — | ✅ | — | — | — | — | — | — | — |

---

## KiroGraph-Sec vs Dedicated SCA Tools

None of the MCP tools above include dependency vulnerability scanning. When evaluating KiroGraph's security module (`enableSecurity: true`), the relevant comparison is against dedicated Software Composition Analysis (SCA) tools.

| Tool | Type | Reachability | SBOM/VEX | EPSS | License | Staleness | MCP / AI-queryable | Local / free | Ecosystems |
|------|------|:------------:|:--------:|:----:|:-------:|:---------:|:------------------:|:------------:|:----------:|
| **KiroGraph-Sec** | Graph-integrated SCA | ✅ call-graph BFS | ✅ CycloneDX 1.5 | ✅ | ✅ | ✅ | ✅ | ✅ | 14 |
| [Trivy](https://github.com/aquasecurity/trivy) | Container + app SCA | — | ✅ CycloneDX | — | — | — | — | ✅ | 10+ (+ OS) |
| [Grype](https://github.com/anchore/grype) | App + container SCA | — | ✅ via Syft | — | — | — | — | ✅ | 10+ |
| [OWASP Dep-Check](https://github.com/jeremylong/DependencyCheck) | App SCA | — | ✅ CycloneDX | — | — | — | — | ✅ | 8+ |
| [npm audit](https://docs.npmjs.com/cli/v9/commands/npm-audit) | Built-in (npm only) | — | — | — | — | — | — | ✅ | npm only |
| [Snyk](https://snyk.io) | Commercial SCA | ✅ (paid) | ✅ | ✅ (paid) | — | — | — | ✗ paid | 10+ |
| [Dependabot](https://docs.github.com/en/code-security/dependabot) | GitHub-integrated | — | — | — | — | — | — | ✅ | 10+ |

### The key differentiator: reachability analysis

Traditional SCA tools report "this dependency has a CVE." KiroGraph-Sec answers the harder question: **"is the vulnerable code actually reachable from your application's entry points?"**

Using the call graph that already exists from code indexing, KiroGraph-Sec performs BFS traversal from routes, handlers, and exported APIs through call/import/reference edges to the vulnerable dependency. Each vulnerability is classified as:

- **`affected`** — at least one call path exists from an entry point to the vulnerable dependency; includes the specific paths and architectural layers traversed
- **`not_affected`** — no path exists and no unresolved imports were encountered; strongest signal that the vulnerability is not exploitable in this deployment
- **`under_investigation`** — traversal encountered unresolved symbols (dynamic dispatch, reflection, etc.); conservative classification rather than a false negative

This matters because the typical npm project has 500–1000 transitive dependencies, and most CVEs affect code that is never actually called. Reachability analysis eliminates the noise.

### What KiroGraph-Sec does not do

- **No container or OS-level scanning** — application dependencies only (use Trivy for container images)
- **No proprietary vulnerability databases** — OSV by default (which aggregates NVD, GitHub Advisory Database, and others); no Snyk Intel feed
- **No CI/CD-native integration** — can be run as part of CI via `kirograph vulns --refresh`, but no native GitHub Actions/GitLab CI plugin
- **14 ecosystems** — npm (+ pnpm), Maven, Gradle, Go, pip, pyproject.toml (Poetry/PDM/Hatch), Cargo, NuGet, RubyGems, Composer, Swift PM, Dart/pub, Elixir/Hex. No container/OS-level scanning.

For container scanning or OS-level coverage, combine KiroGraph-Sec with Trivy. For AI-queryable call-graph reachability during active development, KiroGraph-Sec is the only option.

---

## How They Relate

```
┌──────────────────────────────────────────────────────────────────────┐
│                           KiroGraph                                  │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐  │
│  │  Graph   │  │  Memory  │  │   Docs   │  │   Data   │  │ Shell│  │
│  │(CodeGraph│  │(cavemem) │  │(jDocMunch│  │(jDataMun │  │(rtk) │  │
│  │ inspired)│  │ inspired)│  │ inspired)│  │ inspired)│  │insp.)│  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Security (KiroGraph-Sec)                                    │   │
│  │  dependency scanning + call-graph reachability + SBOM/VEX   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  + Architecture analysis + Caveman mode + 7 semantic engines         │
│  + 34 platform targets + Auto-detection + Token analytics            │
└──────────────────────────────────────────────────────────────────────┘
```

KiroGraph combines the capabilities of 8 separate tools/concepts into a single integrated package:

- **Code graph** layer inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) — tree-sitter parsing, symbol extraction, call graphs, impact analysis
- **Memory** layer inspired by [cavemem](https://github.com/JuliusBrussee/cavemem) — persistent observations, compressed storage, hook-based capture
- **Documentation** layer inspired by [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) — section-level retrieval, stable IDs, multiple formats
- **Data** layer inspired by [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) — tabular data querying, column profiling, server-side computation
- **Shell compression** inspired by [rtk](https://github.com/rtk-ai/rtk) — token-optimized command output with family-specific filters
- **Prose compression** inspired by [caveman](https://github.com/JuliusBrussee/caveman) — agent communication compression (lite/full/ultra)
- **Context layer** inspired by [lean-ctx](https://github.com/yvgude/lean-ctx) — file read caching, multiple read modes, context budget governance
- **Security** (KiroGraph-Sec) — dependency vulnerability scanning with call-graph reachability analysis and CycloneDX SBOM/VEX export; reachability leverages the existing call graph from the code indexing layer

The [jCodeMunch-MCP](https://github.com/jgravelle/jcodemunch-mcp) family (jCodeMunch + jDocMunch + jDataMunch) represents the same "token-efficient retrieval" philosophy applied to three different data types: source code, documentation, and tabular data. KiroGraph unifies all three into a single MCP server with a shared graph database.

[code-review-graph](https://github.com/tirth8205/code-review-graph) is the closest competitor in scope, with its own graph + community detection + refactoring tools + multi-platform support. The main differences are language (Python vs TypeScript), primary target (Claude Code vs Kiro), and KiroGraph's additional documentation/data/memory/security layers.

[lean-ctx](https://github.com/yvgude/lean-ctx) focuses on the context transport layer (caching, compression, governance). KiroGraph integrates these concepts alongside deep code intelligence — users get both efficient delivery and structural understanding in one tool.

---

## Key Differentiators

| What makes it unique | KiroGraph | CodeGraph | code-review-graph |
|---------------------|-----------|-----------|-------------------|
| All-in-one (graph + memory + docs + data + security + compression) | ✅ | — | — |
| 7 pluggable semantic engines | ✅ | — | — |
| Architecture metrics (Ca/Ce/instability) | ✅ | — | — |
| Call-graph reachability for vulnerability analysis | ✅ | — | — |
| Architecture-layer impact for CVEs (which layers are hit) | ✅ | — | — |
| CycloneDX 1.5 SBOM/VEX export | ✅ | — | — |
| Documentation cross-references to code | ✅ | — | — |
| Tabular data querying via MCP | ✅ | — | — |
| Framework-aware route extraction (14+ frameworks) | ✅ | ✅ | — |
| Community detection | ✅ (Leiden) | — | ✅ (Leiden) |
| Execution flow tracing | ✅ | — | ✅ |
| Refactoring tools (rename + suggest) | ✅ | — | ✅ |
| Mixed iOS/RN/Expo/Android cross-language bridging | ✅ | ✅ | — |
| Multi-repo daemon with health checks | — | — | ✅ |
| Self-contained binary (no Node.js required) | — | ✅ | — |
