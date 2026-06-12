![KiroGraph terminal](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/logo.png)

# KiroGraph

![KiroGraph terminal](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/terminal.png)

Semantic code knowledge graph for [Kiro](https://kiro.dev): fewer tool calls, instant symbol lookups, 100% local.

Inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) by [colbymchenry](https://github.com/colbymchenry) for Claude Code, rebuilt natively for Kiro's MCP and hooks system.

> **Full support is for Kiro only.** Experimental integrations for 34 other MCP-capable tools (Cursor, Copilot, Claude Code, Windsurf, Cline, and more) are available with auto-detection. See [Integrations](docs/guide/integrations.md) for the full list.

## Why KiroGraph?

When you ask Kiro to work on a complex task, it explores your codebase using file reads, grep, and glob searches. Every one of those is a tool call, and tool calls consume context and slow things down.

KiroGraph gives Kiro a semantic knowledge graph that's pre-indexed and always up to date. Instead of scanning files to understand your code, Kiro queries the graph instantly: symbol relationships, call graphs, type hierarchies, impact radius, all in a single MCP tool call.

The result is fewer tool calls, less context used, and faster responses on complex tasks.

## Features

| Feature | Description |
|---------|-------------|
| <h4>Graph & Analysis (KiroGraph-Core)</h4> | |
| 🕸️ **Semantic Graph** | tree-sitter AST parsing across 33+ languages — functions, classes, call edges, type hierarchies, all in SQLite |
| 🎯 **Context Building** | One tool call returns entry points, related symbols, and code snippets for any task description |
| 💥 **Impact Analysis** | Blast-radius traversal before making changes — know what breaks at any depth |
| 🧬 **Type Hierarchy** | Traverse inheritance chains — base types, derived types, implementations |
| 🔄 **Circular Dependency Detection** | Find import cycles using Tarjan's SCC algorithm |
| 💀 **Dead Code Detection** | Find unexported symbols with zero incoming references |
| 🔥 **Hotspots & Surprises** | Identify most-connected symbols and unexpected cross-module coupling |
| 🧪 **Affected Tests** | Find test files impacted by source changes — useful in CI and pre-commit hooks |
| 🌐 **Graph Export** | Interactive browser dashboard with search, clustering, path finding, and analytics |
| <h4>Semantic Search</h4> | |
| ⚡ **9 Semantic Engines** | Cosine, TurboQuant, TurboVec, sqlite-vec, Orama, PGlite, LanceDB, Qdrant, Typesense — pick the best fit for your project |
| 🗜️ **TurboQuant Embedding Compression** | Compresses embeddings 20–30× at index time using [Google's TurboQuant algorithm](https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/) (Walsh-Hadamard rotation + Lloyd-Max quantization). A 768-dim `Float32` vector (3,072 bytes) becomes ~120 bytes — 300 MB of raw embeddings shrinks to ~12 MB in RAM. ANN search with **zero native dependencies**, pure TypeScript. Configurable via `turboquantBits`. Powered by [turboquant-js](https://github.com/danilodevhub/turboquant-js) by Danilo Dev. |
| ⚡ **TurboVec (Rust/SIMD)** | Same TurboQuant algorithm in Rust via napi-rs — NEON on ARM64, AVX-512BW on x86. Faster search at the cost of a one-time Rust build. Configurable via `turbovecBits` (2–4). Powered by [turbovec](https://github.com/RyanCodrai/turbovec) by Ryan Codrai. The native addon (`native/turbovec-node/`) is a Rust crate with its own Cargo build — it lives outside `src/` because it is not TypeScript. `kirograph install` builds it automatically. |
| 🤖 **Custom Embedding Models** | Use any HuggingFace `feature-extraction` model — nomic, Gemma, MiniLM, BGE, or bring your own |
| <h4>Architecture (KiroGraph-Arch opt-in  module)</h4> | |
| 🏛️ **Architecture Analysis** | Package graph, layer detection, coupling metrics (Ca/Ce/instability) |
| 📸 **Snapshots & Diff** | Save graph state before refactors, diff after to verify structural changes |
| <h4>Security</h4> | |
| 🔒 **Security (KiroGraph-Sec opt-in  module)** | Goes beyond "this dependency has a CVE" — uses the call graph to determine if vulnerable code is **actually reachable** from your entry points. Maps your **attack surface** (which HTTP routes reach vulnerable deps). Detects **hardcoded secrets** and shows how many entry points expose them. **SAST-lite** finds SQL injection, path traversal, and dangerous eval in your code. **AST-based SAST (opt-in via `enablePatterns`)** runs 10 bundled structural pattern rules via `@ast-grep/napi` — matches actual code structure, not just symbol names. **Supply chain health** checks OpenSSF Scorecard scores and detects dependency confusion attacks. Covers 14 ecosystems, outputs CycloneDX SBOM/VEX and CI-ready SARIF reports. |
| <h4>Knowledge & Data</h4> | |
| 🧠 **Persistent Memor (KiroGraph-Mem opt-in module)** | Cross-session observations — decisions, errors, patterns — auto-linked to code symbols |
| 👁️ **Watchmen (KiroGraph-Watchmen opt-in module)** ⚠️ *experimental* | Auto-synthesizes accumulated memory observations into workspace briefs and `inclusion: manual` skill files. Fires via the `watchmenReady` signal in `kirograph_mem_store` when threshold is reached. **Local model** (default, `watchmenSynthesisMode: 'local'`): runs `gemma-4-E4B-it-ONNX` on-device via `@huggingface/transformers` — ~3–4 GB one-time download, ~3–5 GB RAM, 8–15 s on Apple Silicon M1+. No API key, no background daemon, no external calls. **Agent mode** also available for Kiro (`watchmenSynthesisMode: 'agent'`, uses active session). ⚠️ **Experimental:** output quality in local mode depends heavily on the model chosen and your hardware. Smaller models or slower machines may produce incomplete briefs and lower-quality skill files. Use `agent` mode for best results. |
| 📖 **Documentation Indexing (KiroGraph-Doc opt-in  module)** | Section-level retrieval from Markdown, MDX, RST, AsciiDoc, OpenAPI — 92-97% token savings |
| 📊 **Data Navigation (KiroGraph-Data opt-in  module)** | Query CSV/JSON/Excel/Parquet/**PDF** with filters, aggregations, joins — all server-side in SQLite |
| <h4>Token Optimization</h4> | |
| 🗜️ **Shell Compression (KiroGraph-RTK opt-in  module)** | Token-optimized command output (git, tests, linters, docker, AWS) — 60-90% savings |
| 🪨 **Caveman Mode (KiroGraph-Caveman opt-in module)** 🪨 | Agent prose compression (lite → ultra) — fewer tokens on explanations without touching code |
| 📈 **Token Analytics (KiroGraph-Gain core module)** | Track cumulative savings from graph tools and shell compression over time |
| <h4>Integration (KiroGraph-Integration core module)</h4> | |
| 🔌 **Multi-tool Support** | Native Kiro + 32 experimental targets (Cursor, Copilot, Claude Code, Codex, Windsurf, Cline, and more) |

## Quick Start

```bash
kirograph install        # auto-detects your AI tools and configures them all
```

Or target a specific platform:

```bash
kirograph install --target kiro       # Kiro only
kirograph install --target cursor     # Cursor only
kirograph install --target claude     # Claude Code only
kirograph install --all               # all detected platforms (no prompt)
```

Or using the short alias:

```bash
kg install
```

All Kiro integration files are written to `.kiro/`. Restart Kiro IDE, or switch to the `kirograph` agent in Kiro CLI.

## Documentation

📖 **[Full documentation on GitHub Pages](https://davide-desio-eleva.github.io/kirograph/)**

| Page | Description |
|------|-------------|
| [Installation](docs/guide/installation.md) | Install from npm or source, uninstall, verify |
| [How It Works](docs/guide/how-it-works.md) | Indexing layers (structural, semantic, architecture, memory, docs, data) |
| [Integrations](docs/guide/integrations.md) | Kiro setup, 34 other tools, auto-detection |
| [Comparison](docs/guide/comparison.md) | Feature comparison vs CodeGraph, code-review-graph, and others |
| [MCP Tools](docs/guide/mcp-tools.md) | Full reference for all MCP tools |
| [CLI Reference](docs/guide/cli.md) | All CLI commands with examples |
| [Configuration](docs/guide/configuration.md) | Config fields, semantic engines, architecture analysis |
| [Security](docs/guide/security.md) | Full SCA+: 14 ecosystems, EPSS, reachability, attack surface, secrets, SAST-lite, AST pattern matching (opt-in), supply chain, SBOM/VEX/SARIF |
| [Languages & Frameworks](docs/guide/languages.md) | Supported languages, frameworks, and detection |
| [Changelog](CHANGELOG.md) | Release history |
| [Contributing](CONTRIBUTING.md) | How to contribute |
| [Code of Conduct](CODE_OF_CONDUCT.md) | Community guidelines |
| [Security](SECURITY.md) | Security policy |

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

## What Gets Indexed?

KiroGraph uses [tree-sitter](https://tree-sitter.github.io/tree-sitter/) to parse your source files into an AST and extract:

- **Nodes**: functions, methods, classes, interfaces, types, enums, variables, constants, routes, components, dependencies, vulnerabilities, and more (26 node kinds total)
- **Edges**: calls, imports, exports, extends, implements, contains, references, instantiates, overrides, decorates, type_of, returns

Everything is stored in a local SQLite database (`.kirograph/kirograph.db`). **Nothing leaves your machine.** No API keys. No external services.

## Requirements

- Node.js >= 18
- Kiro IDE (fully supported)
- Other MCP-capable tools (experimental — see [Integrations](docs/guide/integrations.md))

## Credits

KiroGraph is inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) by [Colby McHenry](https://www.linkedin.com/in/colby-mchenry/). The original concept of building a semantic code graph for AI coding agents comes from his work.

### Inspirations

- [cavemem](https://github.com/JuliusBrussee/cavemem) by [Julius Brussee](https://www.linkedin.com/in/julius-brussee/): the memory module's hook-based observation capture, deterministic compression, and SQLite storage pattern.
- [watchmen](https://github.com/firstbatchxyz/watchmen) by [firstbatch](https://github.com/firstbatchxyz): the watchmen module's session-mining concept, workspace brief generation, and `AGENTS.md` mirroring pattern.
- [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/): the documentation module's section-first retrieval approach, stable section IDs, and byte-offset addressing.
- [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) by [J. Gravelle](https://www.linkedin.com/in/j-gravelle-2778223/): the data module's column profiling, streaming parsers, and server-side aggregation approach.
- [code-review-graph](https://github.com/tirth8205/code-review-graph) by [Tirth Kanani](https://github.com/tirth8205): community detection, execution flow tracing, refactoring tools, and multi-platform auto-detection patterns.
- [lean-ctx](https://github.com/yvgude/lean-ctx) by [Yves Gugger](https://github.com/yvgude): file read caching, multiple read modes, and context budget governance concepts.

### Contributors

- [Alessandro Franceschi](https://www.linkedin.com/in/alessandrofranceschi/) — Claude Code and Codex integration, Elixir/Phoenix language and framework support.
- [Mauro Argo](https://www.linkedin.com/in/argomauro/) — original idea for the architecture layer analysis feature.

## How It Compares

KiroGraph combines capabilities from 7 separate tools into one integrated MCP server:

| Capability | Inspired by | What KiroGraph adds |
|-----------|-------------|---------------------|
| Code graph | [CodeGraph](https://github.com/colbymchenry/codegraph) | Architecture metrics, community detection, execution flows |
| Memory | [cavemem](https://github.com/JuliusBrussee/cavemem) | Symbol-linked observations, 7 semantic engines |
| Docs | [jDocMunch-MCP](https://github.com/jgravelle/jdocmunch-mcp) | Code ↔ docs cross-references |
| Data | [jDataMunch-MCP](https://github.com/jgravelle/jdatamunch-mcp) | Unified with code graph in one server |
| Shell compression | [rtk](https://github.com/rtk-ai/rtk) | Integrated as MCP tool, no separate binary |
| Prose compression | [caveman](https://github.com/JuliusBrussee/caveman) | Multi-level (lite/full/ultra) via steering |
| Context layer | [lean-ctx](https://github.com/yvgude/lean-ctx) | File caching, read modes, budget governance |

See the [full comparison](docs/guide/comparison.md) for a detailed feature matrix against CodeGraph, code-review-graph, jCodeMunch, and others.

## Star History

<a href="https://www.star-history.com/?repos=davide-desio-eleva%2Fkirograph&type=date&legend=top-left"><picture><source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=davide-desio-eleva/kirograph&type=date&theme=dark&legend=top-left" /><source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=davide-desio-eleva/kirograph&type=date&legend=top-left" /><img alt="Star History Chart" src="https://api.star-history.com/chart?repos=davide-desio-eleva/kirograph&type=date&legend=top-left" /></picture></a>

## License

[MIT](LICENSE)

| Document | Description |
|----------|-------------|
| [License](LICENSE) | MIT License — permissions, conditions, copyright |
| [Disclaimer](DISCLAIMER.md) | Limitations of use, no professional advice, data handling |
| [Warranty Disclaimer](WARRANTY.md) | Software provided "as is", no warranties of any kind |
| [Limitation of Liability](LIABILITY.md) | Exclusion of liability for damages arising from use |
| [Terms of Use](TERMS.md) | Permitted and prohibited use, user obligations, privacy |
