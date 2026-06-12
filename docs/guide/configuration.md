# Configuration

KiroGraph stores its config in `.kirograph/config.json`. You can edit it directly or use `kirograph install` for an interactive setup.

## Config Fields

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
| `semanticEngine` | string | `cosine` | Engine: `cosine`, `turboquant`, `turbovec`, `sqlite-vec`, `orama`, `pglite`, `lancedb`, `qdrant`, `typesense` |
| `useVecIndex` | boolean | `false` | Deprecated alias for `semanticEngine: "sqlite-vec"` |
| `turboquantMemDocs` | boolean | `false` | Use TurboQuant ANN index for memory observation and doc section search (requires `turboquant-js`) |
| `turboquantBits` | number | `3` | TurboQuant bits per coordinate (1–8). Controls compression/quality tradeoff. Changing this requires `kirograph index --force`. |
| `turbovecMemDocs` | boolean | `false` | Use TurboVec ANN index for memory observation and doc section search (requires built addon) |
| `turbovecBits` | number | `4` | TurboVec bits per coordinate (2, 3, or 4). Controls compression/quality tradeoff. Changing this requires `kirograph index --force`. |
| `typesenseDashboard` | boolean | `false` | Open Typesense dashboard after indexing |
| `qdrantDashboard` | boolean | `false` | Open Qdrant dashboard after indexing |
| **Architecture** | | | |
| `enableArchitecture` | boolean | `false` | Enable architecture analysis (package graph + layer detection) |
| `architectureLayers` | object | - | Custom layer definitions: `{ "layerName": ["glob/**"] }` |
| **Security** | | | |
| `enableSecurity` | boolean | `false` | Enable dependency vulnerability detection and reachability analysis. Requires `enableArchitecture` (auto-enabled if missing). |
| `securityDatabases` | string[] | `["OSV"]` | Vulnerability databases to query. Supported: `OSV`. |
| `securityAutoEnrich` | boolean | `true` | Auto-run vulnerability enrichment after manifest parsing. Set to `false` for on-demand only (via `kirograph vulns --refresh` or `kirograph_vulns` with `refresh: true`). |
| `enablePatterns` | boolean | `false` | Enable AST pattern matching SAST via `@ast-grep/napi`. Requires `npm install @ast-grep/napi`. |
| `patternLibraryPath` | string | — | Path to custom YAML pattern rules directory (merged with bundled rules) |
| `patternSeverityThreshold` | string | `low` | Minimum severity to store: `critical`, `high`, `medium`, `low` |
| **Memory** | | | |
| `enableMemory` | boolean | `false` | Enable persistent cross-session memory |
| `memorySearchAlpha` | number | `0.5` | Blend weight for hybrid search (0 = FTS only, 1 = vector only) |
| `memoryKeepRaw` | boolean | `true` | Store original text alongside compressed version |
| `memoryMaxObservations` | number | `10000` | Max observations before auto-pruning oldest |
| `memorySessionTimeout` | number | `3600000` | Session timeout in ms (default 1 hour) |
| `memoryContextLimit` | number | `3` | Max observations surfaced in `kirograph_context` |
| `memoryContextThreshold` | number | `0.3` | Min relevance score to surface in context |
| `memoryExcludePatterns` | string[] | `[]` | Glob patterns for files to exclude from symbol linking |
| **Watchmen** | | | |
| `enableWatchmen` | boolean | `false` | Enable Watchmen — auto-synthesize workspace briefs from memory observations. Requires `enableMemory: true`. |
| `watchmenThreshold` | number | `5` | Minimum new observations since last synthesis before `watchmenReady` fires. |
| `watchmenSynthesisMode` | string | `'local'` | `'local'` — runs a local HuggingFace model on-device (no API key, no external calls); `'agent'` — delegates to the active AI agent via `askAgent` hook (Kiro only, consumes tokens). |
| `watchmenLocalModel` | string | `'onnx-community/gemma-4-E4B-it-ONNX'` | HuggingFace model ID for local synthesis. Downloaded once to `~/.kirograph/models/`. ~3–4 GB, ~3–5 GB RAM at inference, 8–15 s on Apple Silicon. Only used when `watchmenSynthesisMode: 'local'`. |
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
| `dataInclude` | string[] | `["**/*.csv", "**/*.tsv", "**/*.jsonl", "**/*.ndjson", "**/*.xlsx", "**/*.xls", "**/*.parquet", "data/**/*.json", "**/*.pdf"]` | Glob patterns for data files to include |
| `dataExclude` | string[] | `["node_modules/**", ...]` | Glob patterns for data files to exclude |
| `dataLinkCode` | boolean | `true` | Auto-link data files to code symbols via path detection |
| `dataContextLimit` | number | `0` | Max datasets in `kirograph_context` (0 = disabled). For PDF datasets, keep this at `0`–`1`; PDF `content` columns are verbose and will inflate context significantly. |
| `dataMaxFileSize` | number | `52428800` | Max data file size in bytes (50MB) |
| `dataMaxRows` | number | `1000000` | Max rows to index per file |
| `dataQueryLimit` | number | `500` | Max rows returned per query (hard cap) |
| `dataMaxResponseTokens` | number | `8000` | Max token budget per data tool response |
| **Agent Behavior** | | | |
| `cavemanMode` | string | `off` | Communication style: `off`, `lite`, `full`, `ultra` |
| `shellCompressionLevel` | string | `normal` | Shell compression: `off`, `normal`, `aggressive`, `ultra` |
| `minLogLevel` | string | `warn` | Log level: `debug`, `info`, `warn`, `error` |

Default exclude patterns: `node_modules/**`, `dist/**`, `build/**`, `.git/**`, `*.min.js`, `.kirograph/**`

---

## Semantic Search

By default, KiroGraph uses exact name lookup and full-text search. Enable semantic search for natural-language queries:

```json
{
  "enableEmbeddings": true
}
```

This generates vector embeddings for all functions, methods, classes, interfaces, type aliases, components, and modules using a local embedding model (downloaded automatically to `~/.kirograph/models/` on first use).

### Embedding Models

`kirograph install` offers a curated selection of models compatible with `@huggingface/transformers`:

| Model | Dim | Size | Notes |
|-------|-----|------|-------|
| `nomic-ai/nomic-embed-text-v1.5` | 768 | ~130MB | **Default.** Best quality for code search. |
| `onnx-community/embeddinggemma-300m-ONNX` | 768 | ~300MB | Google Gemma-based. Multilingual, 2048-token context window. |
| `Xenova/all-MiniLM-L6-v2` | 384 | ~23MB | Lightweight, fast. Lower accuracy. |
| `BAAI/bge-base-en-v1.5` | 768 | ~110MB | Strong general-purpose alternative to nomic. |
| Custom | any | - | Any HuggingFace `feature-extraction` model. Provide ID + output dimension. |

Switching models requires a full re-index (`kirograph index --force`).

### Semantic Engines

#### turboquant

ANN index powered by [turboquant-js](https://github.com/danilodevhub/turboquant-js), a TypeScript implementation of [Google's TurboQuant algorithm](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/). **Zero native dependencies.** Compresses each embedding at index time via Walsh-Hadamard rotation + Lloyd-Max scalar quantization.

```json
{ "enableEmbeddings": true, "semanticEngine": "turboquant" }
```

```bash
npm install turboquant-js
```

A 768-dim `Float32Array` (3,072 bytes) is stored as ~120 bytes at 3 bits — roughly **25× smaller**. Falls back silently to `cosine` if `turboquant-js` is not installed.

#### turbovec

Same TurboQuant algorithm implemented in Rust via [turbovec](https://github.com/RyanCodrai/turbovec) and exposed to Node.js via a **napi-rs native addon** (`native/turbovec-node/`). SIMD-accelerated: **NEON on ARM64** (Apple Silicon, AWS Graviton), **AVX-512BW on x86-64**. On macOS links Apple's Accelerate framework; on Linux links OpenBLAS; on Windows uses pure-Rust matrixmultiply (no extra deps).

```json
{ "enableEmbeddings": true, "semanticEngine": "turbovec", "turbovecBits": 4 }
```

```bash
# Build the native addon once (requires Rust toolchain — https://rustup.rs)
# Linux only: sudo apt install libopenblas-dev
cd native/turbovec-node && npm install && npm run build
```

`turbovecBits` accepts 2, 3, or 4 (tighter range than turboquant's 1–8 due to Rust-level validation). Falls back silently to `cosine` if the addon is not built.

**Why `native/turbovec-node/` is outside `src/`:** it is a separate Rust crate with its own build system (Cargo + napi-rs), not TypeScript compiled by `tsc`. It has its own `Cargo.toml`, `package.json`, and produces a platform-specific `.node` binary. The TypeScript wrapper that loads that binary lives at `src/vectors/turbovec-index.ts` — that is the integration boundary. The `kirograph install` command handles the Rust toolchain and addon build automatically on macOS and Linux; on Windows, install Rust manually from https://rustup.rs first.

#### cosine (default)

In-process cosine similarity over all stored embeddings. No extra dependencies.

```json
{ "enableEmbeddings": true, "semanticEngine": "cosine" }
```

#### sqlite-vec

Approximate nearest-neighbour (ANN) index. Sub-linear search time.

```json
{ "enableEmbeddings": true, "semanticEngine": "sqlite-vec" }
```

```bash
npm install better-sqlite3 sqlite-vec
```

#### orama

Hybrid search (full-text + vector) powered by [Orama](https://github.com/oramasearch/orama). Pure JS.

```json
{ "enableEmbeddings": true, "semanticEngine": "orama" }
```

```bash
npm install @orama/orama @orama/plugin-data-persistence
```

#### pglite

Hybrid search powered by [PGlite](https://github.com/electric-sql/pglite) (WASM PostgreSQL + pgvector). Exact results.

```json
{ "enableEmbeddings": true, "semanticEngine": "pglite" }
```

```bash
npm install @electric-sql/pglite
```

#### lancedb

ANN vector search powered by [LanceDB](https://github.com/lancedb/lancedb). Pure JS, Apache Lance format.

```json
{ "enableEmbeddings": true, "semanticEngine": "lancedb" }
```

```bash
npm install @lancedb/lancedb
```

#### qdrant

ANN vector search powered by [Qdrant](https://github.com/qdrant/qdrant) in embedded mode. HNSW index.

```json
{ "enableEmbeddings": true, "semanticEngine": "qdrant" }
```

```bash
npm install qdrant-local
```

#### typesense

ANN vector search powered by [Typesense](https://github.com/typesense/typesense) in embedded mode. Auto-downloaded binary.

```json
{ "enableEmbeddings": true, "semanticEngine": "typesense" }
```

```bash
npm install typesense
```

### Engine Comparison

| Engine | Search type | Extra deps | Native? | Best for |
|--------|-------------|------------|---------|----------|
| `cosine` | Exact cosine, linear scan | none | - | Small/medium projects, zero setup |
| `turboquant` | ANN, sub-linear | `turboquant-js` | no (pure JS) | ANN without native deps, CI/ARM, large codebases with 20–30× RAM savings |
| `turbovec` | ANN, sub-linear | napi-rs build (`rustc`) | yes (Rust) | Faster SIMD search than turboquant-js; one-time Rust build; macOS/Linux/Windows |
| `sqlite-vec` | ANN, sub-linear | `better-sqlite3`, `sqlite-vec` | yes | Large codebases, fast ANN |
| `orama` | Hybrid (FTS + vector) | `@orama/orama`, `@orama/plugin-data-persistence` | no (JS) | Best result quality, no native deps |
| `pglite` | Hybrid (FTS + vector), exact | `@electric-sql/pglite` | no (WASM) | Exact results, PostgreSQL semantics |
| `lancedb` | ANN, sub-linear | `@lancedb/lancedb` | no (JS) | Fast ANN, no native compilation |
| `qdrant` | ANN (HNSW), sub-linear | `qdrant-local` | yes (binary) | Full Qdrant feature set, embedded |
| `typesense` | ANN (HNSW), sub-linear | `typesense` | yes (binary) | Fast ANN, auto-downloaded binary |

All non-cosine engines fall back silently to `cosine` if their optional dependencies are not installed.

### Storage Architecture

| Engine | Graph store | Vector store |
|--------|-------------|--------------|
| `cosine` | `kirograph.db` (SQLite) | `kirograph.db` (`vectors` table) |
| `turboquant` | `kirograph.db` (SQLite) | `.kirograph/turboquant.bin` (+ `turboquant-mem.bin`, `turboquant-doc.bin` if `turboquantMemDocs: true`) |
| `turbovec` | `kirograph.db` (SQLite) | `.kirograph/turbovec.tvim` + `turbovec.tvim.ids` (string-ID sidecar) |
| `sqlite-vec` | `kirograph.db` (SQLite) | `.kirograph/vec.db` |
| `orama` | `kirograph.db` (SQLite) | `.kirograph/orama.json` |
| `pglite` | `kirograph.db` (SQLite) | `.kirograph/pglite/` |
| `lancedb` | `kirograph.db` (SQLite) | `.kirograph/lancedb/` |
| `qdrant` | `kirograph.db` (SQLite) | `.kirograph/qdrant/` |
| `typesense` | `kirograph.db` (SQLite) | `.kirograph/typesense/` |

---

## TurboQuant

TurboQuant is an optional upgrade that **compresses your vector embeddings at storage time** and replaces the default linear scan with an approximate nearest-neighbour (ANN) index — with **zero native dependencies**.

Built on [turboquant-js](https://github.com/danilodevhub/turboquant-js) by Danilo Dev, a TypeScript implementation of [Google's TurboQuant algorithm](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/). Embeddings are compressed immediately when they are generated:

![KiroGraph TurboQuant](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/turboquant.png)

1. **Random rotation** via Walsh-Hadamard transform with random sign flips in O(d log d). Distributes energy uniformly across all coordinates before quantization.
2. **Lloyd-Max scalar quantization** per rotated coordinate. Each value is encoded in `turboquantBits` bits (default: 3) using optimal codebooks derived from Beta/Gaussian approximations.

### What gets compressed

A 768-dim `Float32Array` produced by the embedding model is 3,072 bytes (768 × 4). TurboQuant stores it as ~120 bytes at 3 bits — roughly **25× smaller**:

| Vectors | Raw Float32 in RAM | TurboQuant (3 bit) | Reduction |
|---------|-------------------|-------------------|-----------|
| 1,000   | ~3 MB             | ~120 KB            | 25×       |
| 10,000  | ~30 MB            | ~1.2 MB            | 25×       |
| 100,000 | ~300 MB           | ~12 MB             | 25×       |

The compressed index is the only thing stored on disk (`.kirograph/turboquant.bin`). Raw `Float32` values are **never written to disk or held in RAM** when TurboQuant is active as the code-node engine.

For memory observations and doc sections, the raw Float32 stays in SQLite (needed for re-embedding with a different model), but TurboQuant replaces the bulk RAM load that happens on every search query.

### When to use TurboQuant

| Situation | Recommendation |
|-----------|---------------|
| Small project, < 5,000 symbols | `cosine` is fine |
| Large project, native modules OK | `sqlite-vec` or `lancedb` |
| Large project, **no native modules** (CI, ARM, restricted env) | **`turboquant`** |
| Memory or docs search getting slow | `turboquantMemDocs: true` |

### Code node search

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "turboquant"
}
```

```bash
npm install turboquant-js
```

Each embedding is compressed immediately on `kirograph index`. The index is serialized to `.kirograph/turboquant.bin` at the end of indexing and reloaded in milliseconds on startup. Falls back silently to `cosine` if `turboquant-js` is not installed.

### Memory and doc section search

`MemoryVectorManager` and `DocsVectorManager` always use an implicit linear cosine scan regardless of `semanticEngine`. Enable TurboQuant independently for them:

```json
{
  "turboquantMemDocs": true
}
```

This replaces the O(n) bulk RAM load on every query:
- **Memory** (`kirograph_mem_search`, `kirograph_mem_context`) → `.kirograph/turboquant-mem.bin`
- **Docs** (`kirograph_docs_search`) → `.kirograph/turboquant-doc.bin`

Can be combined with any code-node engine:

```json
{
  "enableEmbeddings": true,
  "semanticEngine": "cosine",
  "turboquantMemDocs": true
}
```

### Compression tuning

The `turboquantBits` field (default: `3`, range: `1–8`) controls the quality/compression tradeoff:

| Bits | Compression | Recall quality | Best for |
|------|-------------|----------------|----------|
| `1`  | ~100×       | low            | extreme memory constraints |
| `3`  | ~25×        | good (default) | balanced |
| `4`  | ~20×        | better         | more recall needed |
| `8`  | ~8×         | high           | near-exact results |

```json
{ "turboquantBits": 4 }
```

Changing `turboquantBits` invalidates the existing `.bin` files — run `kirograph index --force` to rebuild.

### Storage

| Context | File | Estimated size (10K vectors, 768 dim, 3 bit) |
|---------|------|----------------------------------------------|
| Code nodes | `.kirograph/turboquant.bin` | ~1.2 MB |
| Memory | `.kirograph/turboquant-mem.bin` | ~1.2 MB |
| Docs | `.kirograph/turboquant-doc.bin` | ~1.2 MB |

Delete any `.bin` file to force a full rebuild on the next index run.

---

## Architecture Analysis

When `enableArchitecture: true` is set, KiroGraph analyses the high-level structure of your project during indexing and populates `arch_*` tables in `kirograph.db`.

### What it detects

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

**Coupling metrics** computed per package:
- **Ca** (afferent): how many other packages depend on this one
- **Ce** (efferent): how many packages this one depends on
- **Instability** (`Ce / (Ca + Ce)`): 0 = maximally stable, 1 = maximally unstable

### Custom Layer Definitions

Override or extend the auto-detected layer patterns:

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

### Storage

| Table | Contents |
|-------|---------|
| `arch_packages` | Package definitions (id, name, path, source, language, version, deps) |
| `arch_layers` | Layer definitions (id, name, patterns) |
| `arch_file_packages` | File → package assignments |
| `arch_file_layers` | File → layer assignments (with confidence score) |
| `arch_package_deps` | Package → package dependency edges (with import count) |
| `arch_layer_deps` | Layer → layer dependency edges |
| `arch_coupling` | Per-package Ca, Ce, instability metrics |

---

## Token Savings Heuristics

`kirograph gain` tracks two types of savings: compression (measured exactly) and graph tools (estimated via heuristics). For graph tools, the system estimates what the agent *would have spent* doing the same work without KiroGraph:

| Tool | Estimated naive cost |
|------|---------------------|
| `kirograph_context` | ~7,500-15,000 tokens |
| `kirograph_search` | ~3,300 tokens |
| `kirograph_callers` | ~8,300 tokens |
| `kirograph_callees` | ~3,900 tokens |
| `kirograph_impact` | ~6,900 × depth |
| `kirograph_node` | ~1,500 tokens |
| `kirograph_files` | ~2,000 tokens |
| `kirograph_path` | ~7,700 tokens |
| `kirograph_type_hierarchy` | ~5,400 tokens |
| `kirograph_dead_code` | 5× output, min 15,000 |
| `kirograph_hotspots` | 5× output, min 15,000 |
| `kirograph_architecture` | 4× output, min 7,500 |
| `kirograph_mem_search` | ~5,800 tokens |
| `kirograph_data_describe` | ~45,000 tokens |
| `kirograph_data_query` | ~45,000 tokens |
| `kirograph_data_aggregate` | ~52,500 tokens |

Constants used: 1,500 tokens per average source file (~200 lines), 800 tokens per grep result set, 2,000 tokens per directory listing.
