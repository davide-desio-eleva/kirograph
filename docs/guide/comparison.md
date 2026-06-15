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
| [Engram](https://github.com/Gentleman-Programming/engram) | Gentleman-Programming | Go | Persistent memory MCP server | — |
| [watchmen](https://github.com/firstbatchxyz/watchmen) | firstbatchxyz | Python | Session-mining + AGENTS.md synthesis | — |
| [turboquant-js](https://github.com/danilodevhub/turboquant-js) | danilodevhub | JavaScript | WHT + Lloyd-Max vector quantization | — |
| [turbovec](https://github.com/RyanCodrai/turbovec) | RyanCodrai | Rust | SIMD vector search (NEON / AVX-512BW) | — |
| [pdf-inspector](https://github.com/firecrawl/pdf-inspector) | firecrawl | Rust | Pure-Rust PDF text extraction | — |

> **Note:** jCodeMunch, jDocMunch, and jDataMunch are three separate MCP servers by the same author (J. Gravelle), each focused on a different data type. They share a design philosophy (token-efficient retrieval via structured indexing) but run as independent servers.

> **Note on lean-ctx:** lean-ctx is a context transport layer (file read caching, compression, budget governance) rather than a graph or analysis tool. It does not offer symbol-level analysis, vulnerability scanning, or memory — its columns in the matrices below are all `—`.

> **Note on LLM Wiki:** The wiki module is inspired by [Andrej Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — a design sketch rather than a published package. KiroGraph implements the three-op pattern (ingest → apply → lint), WIKI_DIFF block format, FTS5 search, conflict resolution, and local model synthesis.

> **Note on TurboQuant / TurboVec:** turboquant-js and turbovec are two implementations of the same Walsh-Hadamard + Lloyd-Max quantization algorithm. KiroGraph ships both: the TypeScript (turboquant-js) variant for zero-native-build setups, and the Rust/napi-rs (turbovec) variant for SIMD-accelerated throughput. Together they account for two of the nine available semantic engines.

---

## Feature Matrix

### Code Graph & Analysis

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| Tree-sitter AST parsing | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| SQLite local storage | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — | — | — |
| Symbol search (FTS) | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| Call graph (callers/callees) | ✅ | ✅ | ✅ | — | — | — | — | — | — | — | — |
| Impact/blast radius analysis | ✅ | ✅ | ✅ | — | — | — | — | — | — | — | — |
| Type hierarchy traversal | ✅ | — | — | — | — | — | — | — | — | — | — |
| Circular dependency detection | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Dead code detection | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Hotspot/hub detection | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Surprise/cross-module coupling | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Affected tests | ✅ | ✅ | ✅ | — | — | — | — | — | — | — | — |
| Context building (one-call) | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | ✅ | — |
| Byte-level precision retrieval | — | — | — | ✅ | ✅ | — | — | — | — | — | — |
| Trace (path between symbols) | ✅ | ✅ | — | — | — | — | — | — | — | — | — |
| Execution flow tracing | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Community/cluster detection | ✅ (Leiden) | — | ✅ (Leiden) | — | — | — | — | — | — | — | — |
| Edge confidence scoring | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Graph diff (snapshots) | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Framework-aware routes | ✅ (14+ frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — | — | — |
| Mixed iOS/RN/Android bridging | ✅ (incl. Android/Kotlin) | ✅ | — | — | — | — | — | — | — | — | — |
| Dynamic reindexing | — | — | — | ✅ | — | — | — | — | — | — | — |
| File read caching | ✅ | — | — | — | — | — | — | — | — | ✅ | — |
| Context budget governance | ✅ | — | — | — | — | — | — | — | — | ✅ | — |

### Architecture

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| Package graph | ✅ | — | — | — | — | — | — | — | — | — | — |
| Layer detection | ✅ | — | — | — | — | — | — | — | — | — | — |
| Coupling metrics (Ca/Ce/instability) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Architecture overview | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Refactoring suggestions | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Rename preview | ✅ | — | ✅ | — | — | — | — | — | — | — | — |

### Security *(opt-in, requires `enableSecurity: true`)*

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| Dependency vulnerability scanning | ✅ | — | — | — | — | — | — | — | — | — | — |
| OSV vulnerability database | ✅ | — | — | — | — | — | — | — | — | — | — |
| Batch OSV queries (1000 deps/request) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Call-graph reachability analysis | ✅ | — | — | — | — | — | — | — | — | — | — |
| Combined risk score (CVSS + EPSS + reachability + staleness) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Architecture-layer impact (affected layers) | ✅ | — | — | — | — | — | — | — | — | — | — |
| CycloneDX 1.5 SBOM export | ✅ | — | — | — | — | — | — | — | — | — | — |
| CycloneDX 1.5 VEX export | ✅ | — | — | — | — | — | — | — | — | — | — |
| EPSS exploitation probability | ✅ | — | — | — | — | — | — | — | — | — | — |
| Attack surface mapping (routes → vulnerable deps) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Secrets detection with call-graph blast radius | ✅ | — | — | — | — | — | — | — | — | — | — |
| SAST-lite (SQL injection, eval, path traversal, weak crypto) | ✅ | — | — | — | — | — | — | — | — | — | — |
| OWASP Top 10 mapping | ✅ | — | — | — | — | — | — | — | — | — | — |
| Supply chain health (OpenSSF Scorecard) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Dependency confusion detection | ✅ | — | — | — | — | — | — | — | — | — | — |
| Remediation SLA tracking | ✅ | — | — | — | — | — | — | — | — | — | — |
| CI/CD SARIF export (GitHub Security tab) | ✅ | — | — | — | — | — | — | — | — | — | — |
| CVE suppression list | ✅ | — | — | — | — | — | — | — | — | — | — |
| Fix suggestions per ecosystem | ✅ | — | — | — | — | — | — | — | — | — | — |
| License compliance (SPDX + policy) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Dependency staleness score | ✅ | — | — | — | — | — | — | — | — | — | — |
| Dashboard security overlay | ✅ | — | — | — | — | — | — | — | — | — | — |
| Manual CVE registration | ✅ | — | — | — | — | — | — | — | — | — | — |
| Queryable via MCP by AI agents | ✅ | — | — | — | — | — | — | — | — | — | — |

### Semantic Search & Embeddings

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| Vector embeddings | ✅ | — | ✅ | — | — | — | — | ✅ | — | — | — |
| Multiple engine options | ✅ (9 engines) | — | — | — | — | — | — | — | — | — | — |
| Custom HuggingFace models | ✅ | — | — | — | — | — | — | — | — | — | — |
| Hybrid search (FTS + vector) | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Embedding quantization (WHT + Lloyd-Max, 20–30× RAM) | ✅ (TurboQuant) | — | — | — | — | — | — | — | — | — | — |
| SIMD vector search (NEON / AVX-512BW) | ✅ (TurboVec) | — | — | — | — | — | — | — | — | — | — |
| Rust native addon (napi-rs, auto-built by installer) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Local-only (no API keys) | ✅ | ✅ | ✅ (optional cloud) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |

### Memory & Knowledge

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| Persistent cross-session memory | ✅ | ✅ | ✅ | — | — | — | — | ✅ | — | ✅ | ✅ |
| Observations linked to symbols | ✅ | — | — | — | — | — | — | — | — | — | — |
| Compressed storage | ✅ | — | — | — | — | — | — | ✅ | — | — | — |
| Memory deduplication (SHA-256) | ✅ | — | — | — | — | — | — | ✅ | — | — | — |
| Memory search (semantic) | ✅ | — | — | — | — | — | — | ✅ | — | — | — |
| FTS search | ✅ | — | — | — | — | — | — | — | — | — | ✅ |
| Zero LLM tokens on write | ✅ | — | — | — | — | — | — | ✅ | — | — | — |
| Hook-based auto-capture | ✅ | — | — | — | — | — | — | ✅ | — | — | — |
| Conflict detection (relations) | ✅ | — | — | — | — | — | — | — | — | — | ✅ |
| Stale observation review | ✅ | — | — | — | — | — | — | — | — | — | ✅ |
| Passive learning capture | ✅ | — | — | — | — | — | — | — | — | — | ✅ |
| Prompt saving | ✅ | — | — | — | — | — | — | — | — | — | ✅ |
| Stable topic key | ✅ | — | — | — | — | — | — | — | — | — | ✅ |
| Cloud / git sync | — | — | — | — | — | — | — | — | — | — | ✅ |
| Session-based synthesis (watchmen-style) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Auto-threshold for synthesis triggering | ✅ | — | — | — | — | — | — | — | — | — | — |
| AGENTS.md / skill file generation | ✅ | — | — | — | — | — | — | — | — | — | — |
| Local model synthesis (on-device LLM, no API key) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Structured wiki (WIKI_DIFF three-op format) | ✅ | — | — | — | — | — | — | — | — | — | — |
| FTS5 full-text wiki search | ✅ | — | — | — | — | — | — | — | — | — | — |
| Wiki conflict resolution (auto-resolve) | ✅ | — | — | — | — | — | — | — | — | — | — |
| Wiki agent mode (cloud LLM synthesis) | ✅ | — | — | — | — | — | — | — | — | — | — |

### Documentation & Data

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| Documentation indexing | ✅ | — | — | — | ✅ | — | — | — | — | — | — |
| Section-level retrieval | ✅ | — | — | — | ✅ | — | — | — | — | — | — |
| Stable section IDs | ✅ | — | — | — | ✅ | — | — | — | — | — | — |
| Multiple doc formats | ✅ (9 formats) | — | — | — | ✅ (8+ formats) | — | — | — | — | — | — |
| Code ↔ docs cross-references | ✅ | — | — | — | — | — | — | — | — | — | — |
| Tabular data querying | ✅ | — | — | — | — | ✅ | — | — | — | — | — |
| CSV/JSON/Excel/Parquet support | ✅ | — | — | — | — | ✅ | — | — | — | — | — |
| Server-side aggregations | ✅ | — | — | — | — | ✅ | — | — | — | — | — |
| Column profiling | ✅ | — | — | — | — | ✅ | — | — | — | — | — |
| Streaming parsers | ✅ | — | — | — | — | ✅ | — | — | — | — | — |
| PDF text extraction | ✅ | — | — | — | — | — | — | — | — | — | — |
| Pure-Rust PDF parser (no OCR, no network) | ✅ | — | — | — | — | — | — | — | — | — | — |

### Token Optimization

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| Shell output compression | ✅ | — | — | — | — | — | — | — | ✅ | — | — |
| Agent prose compression (caveman) | ✅ | — | — | — | — | — | ✅ | — | — | — | — |
| Token analytics/tracking | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Estimated context savings | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Token benchmarking | ✅ | ✅ | ✅ | — | — | — | — | — | — | — | — |
| Command family filters | ✅ (6 families) | — | — | — | — | — | — | — | ✅ (20+ families) | — | — |
| Standalone CLI proxy | — | — | — | — | — | — | — | — | ✅ | — | — |
| Token-efficient by design | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |

### Integration & Platform Support

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| MCP server (stdio) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | — | — |
| Primary target | Kiro | Claude Code | Claude Code | Any MCP client | Any MCP client | Any MCP client | Claude Code | Claude Code | Any shell | Any MCP client | — |
| Multi-platform support | ✅ (34 targets) | ✅ (7 targets) | ✅ (13 targets) | — | — | — | — | — | ✅ (any agent) | — | — |
| Auto-detection of platforms | ✅ | ✅ | ✅ | — | — | — | — | — | — | — | — |
| Auto-sync hooks | ✅ | ✅ (file watcher) | ✅ (hooks + watch) | — | — | — | — | — | — | — | — |
| Incremental updates | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| VS Code extension | — | ✅ | ✅ | — | — | — | — | — | — | — | — |
| Interactive visualization | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Graph export (GraphML, Cypher, Obsidian) | ✅ | — | ✅ | — | — | — | — | — | — | — | — |
| Multi-repo support | — | — | ✅ | — | — | — | — | — | — | — | — |
| Uninit/uninstall | ✅ | ✅ | — | — | — | — | — | — | — | — | — |

### Language Support

| Feature | KiroGraph | CodeGraph | code-review-graph | jCodeMunch | jDocMunch | jDataMunch | caveman | cavemem | rtk | lean-ctx | engram |
|---------|:---------:|:---------:|:-----------------:|:----------:|:---------:|:----------:|:-------:|:-------:|:---:|:--------:|:------:|
| Languages supported | 33+ | 22 | 30+ | 20+ | N/A | N/A | N/A | N/A | N/A | N/A | — |
| Framework detection | ✅ (26 frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — | — | — |
| Framework-aware route extraction | ✅ (14+ frameworks) | ✅ (14 frameworks) | — | — | — | — | — | — | — | — | — |
| Jupyter notebook support | ✅ | — | ✅ | — | — | — | — | — | — | — | — |

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
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                  KiroGraph                                       │
│                                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐  ┌────────┐  │
│  │  Graph   │  │  Memory  │  │ Watchmen │  │   Wiki   │  │ Docs │  │  Data  │  │
│  │(CodeGraph│  │(cavemem) │  │(firstbat.│  │(Karpathy │  │(jDoc │  │(jData  │  │
│  │crg insp.)│  │ inspired)│  │ inspired)│  │  gist)   │  │Munch)│  │Munch)  │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────┘  └────────┘  │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  Security (KiroGraph-Sec)                                                │   │
│  │  dependency scanning + call-graph reachability + SBOM/VEX               │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  + Architecture analysis (code-review-graph) + Shell/Prose compression (rtk/    │
│    caveman) + 9 semantic engines (incl. TurboQuant/TurboVec) + PDF parsing      │
│  + Context layer (lean-ctx) + 34 platform targets + Token analytics             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

KiroGraph combines the capabilities of 12 separate projects into a single integrated package:

- **Code graph** layer inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) — tree-sitter parsing, symbol extraction, call graphs, impact analysis
- **Community detection** inspired by [code-review-graph](https://github.com/tirth8205/code-review-graph) — coupling metrics (Ca/Ce/instability), execution flow tracing, refactoring tools
- **Memory** layer inspired by [cavemem](https://github.com/JuliusBrussee/cavemem) — persistent observations, compressed storage, hook-based capture
- **Watchmen synthesis** inspired by [watchmen](https://github.com/firstbatchxyz/watchmen) — session-mining, AGENTS.md / skill file generation, local model synthesis, auto-threshold
- **LLM Wiki** inspired by [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — WIKI_DIFF three-op format, FTS5 search, conflict resolution, local model mode
- **Documentation** layer inspired by [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) — section-level retrieval, stable IDs, multiple formats
- **Data** layer inspired by [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) — tabular data querying, column profiling, server-side computation
- **PDF parsing** inspired by [pdf-inspector](https://github.com/firecrawl/pdf-inspector) — pure Rust, no OCR, no network, prebuilt binaries, piped into the data module
- **Shell compression** inspired by [rtk](https://github.com/rtk-ai/rtk) — token-optimized command output with family-specific filters
- **Prose compression** inspired by [caveman](https://github.com/JuliusBrussee/caveman) — agent communication compression (lite/full/ultra)
- **Embedding compression** inspired by [turboquant-js](https://github.com/danilodevhub/turboquant-js) — Walsh-Hadamard + Lloyd-Max quantization, 20–30× RAM savings
- **SIMD vector search** inspired by [turbovec](https://github.com/RyanCodrai/turbovec) — NEON on ARM64, AVX-512BW on x86, auto-built by the installer via napi-rs
- **Context layer** inspired by [lean-ctx](https://github.com/yvgude/lean-ctx) — file read caching, multiple read modes, context budget governance
- **Conflict detection, topic key, stale review, passive capture, prompt saving** inspired by [Engram](https://github.com/Gentleman-Programming/engram) — typed relations between observations, judgment workflow, stable semantic addressing

[Engram](https://github.com/Gentleman-Programming/engram) by [Gentleman-Programming](https://github.com/Gentleman-Programming): conflict detection (typed relations + judgment workflow), `topic_key` stable addressing, `review_after` stale observation scheduling, passive capture, and prompt saving patterns.
- **Security** (KiroGraph-Sec) — dependency vulnerability scanning with call-graph reachability analysis and CycloneDX SBOM/VEX export; reachability leverages the existing call graph from the code indexing layer

The [jCodeMunch-MCP](https://github.com/jgravelle/jcodemunch-mcp) family (jCodeMunch + jDocMunch + jDataMunch) represents the same "token-efficient retrieval" philosophy applied to three different data types: source code, documentation, and tabular data. KiroGraph unifies all three into a single MCP server with a shared graph database.

[code-review-graph](https://github.com/tirth8205/code-review-graph) is the closest competitor in scope, with its own graph + community detection + refactoring tools + multi-platform support. The main differences are language (Python vs TypeScript), primary target (Claude Code vs Kiro), and KiroGraph's additional documentation/data/memory/security layers.

[lean-ctx](https://github.com/yvgude/lean-ctx) focuses on the context transport layer (caching, compression, governance). KiroGraph integrates these concepts alongside deep code intelligence — users get both efficient delivery and structural understanding in one tool.

---

## Key Differentiators

| What makes it unique | KiroGraph | CodeGraph | code-review-graph |
|---------------------|-----------|-----------|-------------------|
| All-in-one (graph + memory + watchmen + wiki + docs + data + security + compression) | ✅ | — | — |
| 9 pluggable semantic engines | ✅ | — | — |
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
| Watchmen session synthesis → AGENTS.md / skill files | ✅ | — | — |
| LLM Wiki (WIKI_DIFF + FTS5 + conflict resolution) | ✅ | — | — |
| Wiki local model synthesis (on-device, no API key) | ✅ | — | — |
| Embedding quantization (WHT + Lloyd-Max, 20–30× RAM) | ✅ | — | — |
| SIMD vector search (NEON / AVX-512BW) | ✅ | — | — |
| PDF parsing (pure Rust, no OCR, no network) | ✅ | — | — |
| Multi-repo daemon with health checks | — | — | ✅ |
| Self-contained binary (no Node.js required) | — | ✅ | — |
