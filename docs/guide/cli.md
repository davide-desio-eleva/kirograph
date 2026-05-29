# CLI Reference

## Setup

```bash
kirograph install                 # Wire up MCP + hooks + steering in .kiro/
kirograph install --target kiro   # Same as above (explicit)
kirograph install --target claude # Wire up Claude Code MCP + project memory
kirograph install --target codex  # Write Codex instructions and print MCP config
kirograph init [path]             # Initialize .kirograph/ in a project
kirograph init --index            # Initialize and index immediately
kirograph uninit [path]           # Prompts to remove integration files and .kirograph/ data
kirograph uninit --force          # Remove everything without confirmation
```

## Indexing

```bash
kirograph index [path]            # Full re-index of the project
kirograph index --force           # Force re-index all files (ignore hash cache)
kirograph sync [path]             # Incremental sync of changed files
kirograph sync --files a.ts b.ts  # Sync specific files only
kirograph sync-if-dirty [path]    # Sync only if a dirty marker is present
kirograph mark-dirty [path]       # Write a dirty marker for deferred sync
```

## Status & Maintenance

```bash
kirograph status [path]           # Show index stats (files, symbols, edges, frameworks)
kirograph unlock [path]           # Force-release a stale lock file
```

## Search & Exploration

```bash
kirograph query <term>                    # Search symbols by name
kirograph query <term> --kind class       # Filter by kind
kirograph query <term> --limit 20         # Limit results (default: 10)
```

Supported kinds: `function`, `method`, `class`, `struct`, `interface`, `trait`, `protocol`, `enum`, `type_alias`, `property`, `field`, `variable`, `constant`, `enum_member`, `parameter`, `import`, `export`, `route`, `component`, `file`, `module`, `namespace`

## File Structure

```bash
kirograph files [path]                     # Show indexed file tree
kirograph files --format flat              # Flat list of all files
kirograph files --format grouped           # Files grouped by language
kirograph files --filter src/components    # Filter by directory prefix
kirograph files --pattern "**/*.test.ts"   # Filter by glob pattern
kirograph files --max-depth 2              # Limit tree depth
kirograph files --no-metadata              # Hide language/symbol counts
kirograph files --json                     # Output as JSON
```

## Context Building

```bash
kirograph context "fix checkout bug"
kirograph context "add user authentication" --format json
kirograph context "refactor payment service" --max-nodes 30
kirograph context "validate token" --no-code
```

## Affected Tests

Find test files that depend on changed source files, useful in CI or pre-commit hooks.

```bash
kirograph affected src/utils.ts src/api.ts           # Pass files as arguments
git diff --name-only | kirograph affected --stdin     # Pipe from git diff
kirograph affected --stdin --json < changed.txt       # JSON output
kirograph affected src/auth.ts --filter "e2e/**"      # Custom test file glob
kirograph affected src/lib.ts --depth 3 --quiet       # Paths only, shallow traversal
```

| Option | Description | Default |
|--------|-------------|---------|
| `--stdin` | Read file list from stdin, one per line | false |
| `-d, --depth <n>` | Max dependency traversal depth | 5 |
| `-f, --filter <glob>` | Custom glob to identify test files | auto-detect |
| `-j, --json` | Output as JSON | false |
| `-q, --quiet` | Output file paths only | false |
| `-p, --path <path>` | Project path | cwd |

Example CI integration:

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | kirograph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

## Path

Find the shortest connection between any two symbols.

```bash
kirograph path <from> <to>            # Find path between two symbols
kirograph path LoginController Pool   # Example: how are these connected?
kirograph path --format json          # JSON output
```

## Hotspots

```bash
kirograph hotspots [path]             # Top 20 most-connected symbols
kirograph hotspots --limit 10         # Limit results
kirograph hotspots --format json      # JSON output
```

## Surprising Connections

```bash
kirograph surprising [path]           # Top 20 surprising connections
kirograph surprising --limit 10       # Limit results
kirograph surprising --format json    # JSON output
```

## Dead Code

```bash
kirograph dead-code [path]            # List dead code grouped by file
kirograph dead-code --limit 20        # Limit results
kirograph dead-code --format json     # JSON output
```

## Snapshots & Diff

```bash
kirograph snapshot save [label]       # Save current graph state with optional label
kirograph snapshot save pre-refactor  # Named snapshot
kirograph snapshot list               # List all saved snapshots
kirograph snapshot diff               # Diff current graph vs latest snapshot
kirograph snapshot diff pre-refactor  # Diff current graph vs named snapshot
kirograph snapshot diff --format full # Show full added/removed symbol lists
kirograph snapshot diff --format json # JSON output
```

## Caveman Mode 🪨

![KiroGraph caveman](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/caveman.png)

Caveman mode compresses the agent's communication style, cutting token usage on responses without affecting tool calls or code output. Inspired by [caveman](https://github.com/JuliusBrussee/caveman) 🪨 by [JuliusBrussee](https://github.com/JuliusBrussee).

Four levels:

| Mode | Style |
|------|-------|
| `off` | Normal responses *(default)* |
| `lite` | Compact, no filler, full sentences |
| `full` | Fragments, no articles, short synonyms |
| `ultra` | Maximum compression, abbreviations, `→` for causality |

```bash
kirograph caveman lite    # compact, still readable
kirograph caveman full    # fragments, no articles
kirograph caveman ultra   # maximum compression
kirograph caveman off     # back to normal
kirograph caveman         # show current mode
```

Caveman mode never touches code blocks, file paths, URLs, or technical terms — only prose.

**Auto-clarity exceptions:** the agent temporarily reverts to normal prose for security warnings, confirmations of irreversible actions, and multi-step sequences where fragment order could cause misunderstanding.

## Shell Compression (`kirograph exec`)

![KiroGraph RTK](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/rtk.png)

Run shell commands with token-optimized output, saving 60-90% of tokens on verbose commands. Inspired by [rtk](https://github.com/rtk-ai/rtk).

Supported command families:

| Family | Commands | Typical savings |
|--------|----------|----------------|
| Git | status, log, diff, push, pull, commit, add, fetch, branch, stash | 75-96% |
| GitHub CLI | gh pr list/view, gh issue list, gh run list/view | 60-80% |
| Test runners | jest, vitest, pytest, cargo test, go test, rspec, minitest, playwright | 80-90% |
| Linters/build | eslint, tsc, ruff, clippy, cargo build, prettier, biome, golangci-lint, rubocop, next build | 70-85% |
| File listings | ls, find, tree | 60-80% |
| Search | grep, rg/ripgrep (grouped by file) | 60-80% |
| Diff | diff file1 file2 (condensed context) | 50-70% |
| Docker/k8s | docker ps, images, logs, compose ps, kubectl pods, logs, services | 70-80% |
| Package managers | npm/pnpm install/list, pip list/install/outdated, bundle install/list, prisma generate | 75-92% |
| AWS | sts, ec2, lambda, logs, cloudformation, dynamodb, iam, s3, ecs, sqs, sns | 60-88% |
| Network | curl (strip progress/headers), wget (strip progress bars) | 50-70% |

Three compression levels:

| Level | Style |
|-------|-------|
| `normal` | Balanced: removes noise, keeps structure *(default)* |
| `aggressive` | More compact: groups by category, limits output |
| `ultra` | Maximum compression: counts and summaries only |

```bash
kirograph compression normal     # balanced (default)
kirograph compression aggressive # more compact
kirograph compression ultra      # maximum compression
kirograph compression off        # disable hook (tool still available)
kirograph compression            # show current level
```

**Error preservation:** Failed commands always show full diagnostic output regardless of compression level.

**Token analytics:**

```bash
kirograph gain               # summary stats
kirograph gain --graph       # ASCII graph (last 30 days)
kirograph gain --history     # recent command history
kirograph gain --daily       # day-by-day breakdown
kirograph gain --json        # JSON export
```

## Architecture *(requires `enableArchitecture: true`)*

```bash
kirograph architecture [path]              # Show packages + layers + all deps
kirograph architecture --packages          # Show packages section only
kirograph architecture --layers            # Show layers section only
kirograph architecture --format json       # JSON output
```

### Package Inspection

```bash
kirograph package <name>                   # Inspect a package by name or path fragment
kirograph package auth                     # Partial match accepted
kirograph package src/auth --no-files      # Omit file list
kirograph package auth --format json       # JSON output
```

### Coupling Metrics

```bash
kirograph coupling [path]                  # All packages, sorted by instability
kirograph coupling --sort ca               # Sort by afferent coupling
kirograph coupling --sort ce               # Sort by efferent coupling
kirograph coupling --sort name             # Sort alphabetically
kirograph coupling --package auth          # Detail view for a single package
kirograph coupling --format json           # JSON output
```

## Security *(requires `enableSecurity: true`)*

![KiroGraph Security](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/sec.png)

### Security Overview

```bash
kirograph security [path]                  # Vulnerability status overview
kirograph security --refresh-staleness     # Re-query registries for latest versions first
```

Shows: total dependencies, vulnerabilities found, verdict breakdown (affected/not_affected/under_investigation), stale data warnings, stale dependency count.

### SBOM Export

```bash
kirograph sbom [path]                      # Export CycloneDX 1.5 SBOM to stdout
kirograph sbom --output sbom.json          # Export to file
```

### VEX Export

```bash
kirograph vex [path]                       # Export CycloneDX 1.5 VEX to stdout
kirograph vex --output vex.json            # Export to file
```

### Vulnerability Management

```bash
kirograph vulns [path]                     # List all vulnerabilities
kirograph vulns --severity critical        # Filter by severity
kirograph vulns --verdict affected         # Filter by reachability verdict
kirograph vulns --refresh                  # Refresh from vulnerability databases first
kirograph vulns --add CVE-2024-1234 --package lodash --version 4.17.20  # Register private CVE
```

| Flag | Description |
|------|-------------|
| `--severity <level>` | Filter: `critical`, `high`, `medium`, `low` |
| `--verdict <verdict>` | Filter: `affected`, `not_affected`, `under_investigation` |
| `--epss <threshold>` | Filter by EPSS exploitation probability >= threshold (0.0–1.0) |
| `--stale` | Show staleness score of the dependency alongside each CVE |
| `--refresh` | Trigger fresh enrichment from configured databases before listing |
| `--add <cveId>` | Manually register a CVE (requires `--package` and `--version`) |
| `--package <name>` | Package name for manual CVE registration |
| `--version <ver>` | Package version for manual CVE registration |

### Reachability Analysis

```bash
kirograph reachability <target> [path]     # Check reachability for a CVE or dependency
kirograph reachability CVE-2023-12345      # By CVE ID
kirograph reachability lodash              # By package name
```

Shows: verdict (`affected` / `not affected` / `under investigation`), reaching entry point count, call paths (up to 5), unresolved symbols, and impact summary (affected layers, entry points, distinct paths) when verdict is `affected`.

### License Compliance

```bash
kirograph licenses [path]                  # List all dependency licenses
kirograph licenses --policy                # Show only policy violations
kirograph licenses --deny "GPL-*,AGPL-3.0" # Override deny list (comma-separated SPDX patterns)
kirograph licenses --warn "LGPL-*"         # Override warn list
kirograph licenses --format json
```

### Dependency Staleness

```bash
kirograph staleness [path]                 # Check freshness against registries
kirograph staleness --threshold 0.5        # Only show staleness_score >= 0.5
kirograph staleness --refresh              # Re-query registries first
kirograph staleness --format json
```

Staleness score 0.0–1.0: `0` = current, `1` = very stale. Supports npm, PyPI, crates.io, RubyGems, Packagist.

## Memory *(requires `enableMemory: true`)*

![KiroGraph Memory](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/mem.png)

```bash
# Search
kirograph mem search "payment retry"              # hybrid FTS + vector search
kirograph mem search "auth bug" --kind error      # filter by kind
kirograph mem search "refactor" --limit 5         # limit results

# Store
kirograph mem store "decided to use idempotency keys for payments"
kirograph mem store "auth bug: token refresh missing" --kind error
kirograph mem store --kind decision < decision.txt   # pipe from stdin

# Timeline
kirograph mem timeline                    # last 5 sessions
kirograph mem timeline --limit 10         # more sessions
kirograph mem timeline --session <id>     # specific session

# Status
kirograph mem status                      # health dashboard

# Maintenance
kirograph mem prune --older-than 90d      # cleanup old observations
kirograph mem export --format jsonl       # machine-readable export
kirograph mem export --format md          # human-readable export
kirograph mem import backup.jsonl         # restore from backup
kirograph mem reembed                     # re-embed after model change
kirograph mem lint                        # find stale links, model mismatch
kirograph mem lint --fix                  # auto-repair issues
```

## Documentation *(requires `enableDocs: true`)*

```bash
# Table of contents
kirograph docs toc                          # whole project
kirograph docs toc README.md                # single file
kirograph docs toc README.md --tree         # nested tree structure

# Search
kirograph docs search "authentication"
kirograph docs search "config" --file docs/guide.md

# Retrieve a section
kirograph docs section "README.md::installation#1"
kirograph docs section "README.md::installation#1" --context

# Outline
kirograph docs outline docs/api.md

# Cross-references
kirograph docs refs "docs/auth.md::oauth/token-refresh#2"

# Maintenance
kirograph docs reindex                      # force full re-index
kirograph docs lint                         # health checks
kirograph docs reembed                      # re-embed with current model
```

## Data *(requires `enableData: true`)*

```bash
# List datasets
kirograph data list

# Describe schema
kirograph data describe tests-fixtures-users
kirograph data describe tests-fixtures-users --column email

# Query rows
kirograph data query orders --filter status:eq:shipped --limit 10
kirograph data query users --filter age:gt:18 --columns name,email

# Aggregate
kirograph data aggregate orders --group-by region --metric sum:amount
kirograph data aggregate users --group-by role --metric count:id --metric avg:age

# Search columns
kirograph data search orders "price"

# Join two datasets
kirograph data join users orders --left-col id --right-col user_id

# Correlations & quality
kirograph data correlations sales-data --threshold 0.5
kirograph data quality orders

# Maintenance
kirograph data index                        # incremental index
kirograph data reindex                      # force re-index all
kirograph data lint                         # validate integrity
```

## Graph Export

Export the full graph as an interactive dashboard.

```bash
kirograph export build [path]             # Generate .kirograph/export/{index.html,app.css,app.js}
kirograph export start [path]             # Generate and open in browser
kirograph export build -o /tmp/myexport   # Custom output directory
kirograph export build --include-contains # Include structural contains edges
```

![KiroGraph export](https://raw.githubusercontent.com/davide-desio-eleva/kirograph/main/assets/export.gif)

## Dashboard

When `semanticEngine` is set to `qdrant` or `typesense`:

```bash
kirograph dashboard start [path]   # Start server and open dashboard
kirograph dashboard stop [path]    # Stop the running engine server
```

## MCP Server

```bash
kirograph serve --mcp                      # Start MCP server (used by Kiro)
kirograph serve --mcp --path /my/project   # Specify project path
```
