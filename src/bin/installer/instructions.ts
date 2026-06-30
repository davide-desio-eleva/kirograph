import { CAVEMAN_RULES, CavemanMode } from './caveman';

export interface InstructionOptions {
  cavemanMode?: CavemanMode | 'off';
  shellCompressionLevel?: 'off' | 'normal' | 'aggressive' | 'ultra';
  enableArchitecture?: boolean;
  enableMemory?: boolean;
  enableDocs?: boolean;
  enableData?: boolean;
  enableSecurity?: boolean;
  enablePatterns?: boolean;
  enableWiki?: boolean;
  enableCodeHealth?: boolean;
  enableNavigation?: boolean;
  enableComplexity?: boolean;
  enableGitContext?: boolean;
  enableEditPrimitives?: boolean;
  enableBranch?: boolean;
  enableAgentUtils?: boolean;
  enableGeneralCompression?: boolean;
  trackCallSites?: boolean;
  hasHooks?: boolean;
}

const LEVEL_DESCRIPTIONS: Record<string, string> = {
  normal: 'Balanced: removes noise, keeps structure.',
  aggressive: 'Compact: groups by category, limits output.',
  ultra: 'Maximum compression: counts and summaries only.',
};

const LEVEL_EXAMPLES: Record<string, string> = {
  normal: `\`\`\`
kirograph_exec(command: "git status")
kirograph_exec(command: "npm test")
kirograph_exec(command: "cargo build")
kirograph_exec(command: "ls -la src/")
\`\`\``,
  aggressive: `\`\`\`
kirograph_exec(command: "git status", level: "aggressive")
kirograph_exec(command: "npm test", level: "aggressive")
kirograph_exec(command: "eslint .", level: "aggressive")
kirograph_exec(command: "find . -name '*.ts'", level: "aggressive")
\`\`\``,
  ultra: `\`\`\`
kirograph_exec(command: "git status", level: "ultra")
kirograph_exec(command: "npm test", level: "ultra")
kirograph_exec(command: "docker ps", level: "ultra")
kirograph_exec(command: "ls -la src/", level: "ultra")
\`\`\``,
};

export function buildAgentInstructions(cavemanModeOrOpts?: CavemanMode | 'off' | InstructionOptions): string {
  // Support both old signature (cavemanMode string) and new signature (options object)
  const opts: InstructionOptions = typeof cavemanModeOrOpts === 'object' && cavemanModeOrOpts !== null
    ? cavemanModeOrOpts
    : { cavemanMode: cavemanModeOrOpts ?? undefined };

  const cavemanMode = opts.cavemanMode;
  const enableCompression = opts.shellCompressionLevel && opts.shellCompressionLevel !== 'off';
  const shellCompressionLevel = opts.shellCompressionLevel ?? 'normal';
  const enableArchitecture = opts.enableArchitecture ?? false;
  const enableMemory = opts.enableMemory ?? false;
  const enableDocs = opts.enableDocs ?? false;
  const enableData = opts.enableData ?? false;
  const enableSecurity = opts.enableSecurity ?? false;
  const enablePatterns = opts.enablePatterns ?? false;
  const enableWiki = opts.enableWiki ?? false;
  const enableCodeHealth = opts.enableCodeHealth ?? false;
  const enableNavigation = opts.enableNavigation ?? false;
  const enableComplexity = opts.enableComplexity ?? false;
  const enableGitContext = opts.enableGitContext ?? false;
  const enableEditPrimitives = opts.enableEditPrimitives ?? false;
  const enableAgentUtils = opts.enableAgentUtils ?? false;
  const enableGeneralCompression = opts.enableGeneralCompression ?? false;
  const trackCallSites = opts.trackCallSites ?? false;

  let content = `# KiroGraph

KiroGraph builds a local semantic knowledge graph of this codebase. When the \`kirograph\` MCP server is available, prefer its tools over broad grep/glob/file-read exploration.

## Quick decision guide

| Question | Tool |
|----------|------|
| Where do I start on this task? | \`kirograph_context\` |
| What is this symbol / show me its code | \`kirograph_node\` with \`detail: "signatures"\` |
| Find a symbol by name | \`kirograph_search\` |
${trackCallSites ? '| Who calls function X? | `kirograph_callers` |\n| What does function X call? | `kirograph_callees` |\n' : ''}${enableNavigation ? '| What breaks if I change X? | `kirograph_impact` |\n| What files are indexed? | `kirograph_files` |\n| Is the index healthy? | `kirograph_status` |\n' : ''}${enableCodeHealth ? '| How are X and Y connected? | `kirograph_path` |\n| Which code is never called? | `kirograph_dead_code` |\n| Are there import cycles? | `kirograph_circular_deps` |\n| What extends / implements this type? | `kirograph_type_hierarchy` |\n' : ''}
${enableCodeHealth ? '| What are the most critical symbols? | `kirograph_hotspots` |\n| Any unexpected cross-module coupling? | `kirograph_surprising` |\n| What changed since the last snapshot? | `kirograph_diff` |\n' : ''}${enableGitContext ? '| Semantic context for my current changes? | `kirograph_flows` |\n' : ''}${enableArchitecture ? '| What packages/layers exist? | `kirograph_architecture` |\n| How coupled is package X? | `kirograph_coupling` |\n| What does package X depend on? | `kirograph_package` |\n' : ''}${enableCompression ? '| Run a command with token savings | `kirograph_exec` |\n' : ''}${enableAgentUtils ? '| Check token savings stats | `kirograph_gain` |\n| Read a file (cached) | `kirograph_read` |\n' : ''}${enableGeneralCompression ? '| Compress text or shell output before sending | `kirograph_compress` |\n' : ''}${enableMemory ? '| Search past decisions/patterns | `kirograph_mem_search` |\n| Store an observation | `kirograph_mem_store` |\n' : ''}${enableDocs ? '| Find a doc section | `kirograph_docs_search` |\n| Get doc table of contents | `kirograph_docs_toc` |\n' : ''}${enableData ? '| What datasets are indexed? | `kirograph_data_list` |\n| Query rows with filters | `kirograph_data_query` |\n| Aggregate data server-side | `kirograph_data_aggregate` |\n' : ''}${enableSecurity ? '| Are there vulnerable dependencies? | `kirograph_security` |\n| Which CVEs affect my project? | `kirograph_vulns` |\n| Is this vulnerability reachable? | `kirograph_reachability` |\n| What licenses do my deps use? | `kirograph_licenses` |\n| Are dependencies outdated? | `kirograph_staleness` |\n' : ''}${enablePatterns ? '| Find structural code patterns? | `kirograph_live_search` |\n| Browse SAST rules | `kirograph pattern --list` |\n' : ''}${enableWiki ? '| Look up project knowledge | `kirograph_wiki_search` |\n| Update wiki with new knowledge | `kirograph_wiki_ingest` + `kirograph_wiki_apply_diff` |\n' : ''}
## Tool selection

- Start code tasks with \`kirograph_context\`; use \`detail: "signatures"\` to reduce tokens when full source isn't needed yet.
- Find symbols by name with \`kirograph_search\`.
- Inspect a symbol with \`kirograph_node\`; use \`detail: "full"\` only when source is needed.
${trackCallSites ? '- Trace call flow with `kirograph_callers` and `kirograph_callees`.\n' : ''}${enableNavigation ? '- Check blast radius before edits with `kirograph_impact`.\n- Use `kirograph_files` to inspect indexed file structure.\n- Use `kirograph_status` if results seem stale or incomplete.\n' : ''}${enableCodeHealth ? '- Use `kirograph_path` to explain how two symbols connect.\n- Use `kirograph_type_hierarchy` for inheritance/interface questions.\n- Use `kirograph_hotspots`, `kirograph_surprising`, and `kirograph_diff` for refactor planning and review.\n' : ''}${enableArchitecture ? '- Use `kirograph_architecture`, `kirograph_coupling`, and `kirograph_package` for package/layer questions.\n' : ''}

## Workflow

1. Call \`kirograph_context\` for orientation.
2. Drill into specific symbols with \`kirograph_node\`.
3. Use graph traversal tools before reading unrelated files.
4. Fall back to normal filesystem tools only when the graph is missing, stale, or lacks the needed detail.

If \`.kirograph/\` does not exist, ask whether to run \`kirograph init --index\`.
`;

  // Shell compression section
  if (enableCompression) {
    const level = shellCompressionLevel as 'normal' | 'aggressive' | 'ultra';
    content += `
## Shell Compression (\`kirograph_exec\`)

When running shell commands, prefer \`kirograph_exec\` over raw shell execution for:
- **git** operations (status, log, diff, push, pull, commit, add, fetch, branch)
- **GitHub CLI** (gh pr list/view, gh issue list, gh run list)
- **test runners** (jest, vitest, pytest, cargo test, go test, rspec, minitest, playwright)
- **linters/build** (eslint, tsc, ruff, clippy, cargo build, prettier, biome, golangci-lint, rubocop, next build)
- **file listings** (ls, find, tree)
- **search** (grep, rg/ripgrep: grouped by file)
- **diff** (diff file1 file2: condensed context)
- **docker/k8s** (docker ps, images, logs, compose ps, kubectl pods, logs, services)
- **package managers** (npm/pnpm install/list, pip list/install, bundle install, prisma generate)
- **AWS CLI** (sts, ec2, lambda, logs, cloudformation, dynamodb, iam, s3, ecs, sqs, sns)
- **network** (curl, wget: strip progress bars and headers)

This saves 60-90% of tokens compared to raw output.

Compression level: **${level}**: ${LEVEL_DESCRIPTIONS[level]}

${LEVEL_EXAMPLES[level]}

**Important:** Error details are always preserved. Failed commands show full diagnostic output regardless of level.

**Do NOT re-run commands:** When \`kirograph_exec\` returns a result, treat it as the final answer. Never re-run the same command with raw shell execution to "get more details." The compressed output preserves all essential information. If you genuinely need something missing from the output, explain what's missing before making a second call.

Use \`kirograph_gain\` to check token savings statistics.
`;
  }

  // Memory section
  if (enableMemory) {
    content += `
## Memory

KiroGraph has persistent memory. Use \`kirograph_mem_search\` to recall past decisions,
errors, and patterns before making changes. Use \`kirograph_mem_store\` to save important
observations (architecture decisions, bug root causes, patterns discovered).

Memory is searchable via hybrid FTS + vector search. Observations are automatically
linked to code symbols in the graph and surface in \`kirograph_context\` and
\`kirograph_impact\` results when relevant.

**When to store:** After fixing a bug, making an architecture decision, discovering a pattern,
encountering a non-obvious error, or learning something about the codebase that future sessions
should know. Keep observations concise — one fact per store call.
`;
  }

  // Architecture section
  if (enableArchitecture) {
    content += `
## Architecture

KiroGraph analyzes the package structure and layer dependencies of the codebase.

- \`kirograph_architecture\` — full package graph, detected layers (api/service/data/ui/shared), dependency edges
- \`kirograph_coupling\` — Ca (afferent), Ce (efferent), instability per package; high Ca = load-bearing, high Ce = volatile
- \`kirograph_package\` — drill into a single package: coupling metrics, deps, dependents, files

Use \`kirograph_architecture\` for architectural questions instead of reading directory trees.
High Ca + low instability = risky to change interface. High Ce + high instability = safe to refactor internals.
`;
  }

  // Documentation section
  if (enableDocs) {
    content += `
## Documentation

KiroGraph indexes project documentation by heading structure. Use \`kirograph_docs_search\`
to find relevant sections instead of reading entire files.

- \`kirograph_docs_toc\` — table of contents for a file or the whole project
- \`kirograph_docs_search\` — search sections by query
- \`kirograph_docs_section\` — retrieve full section content by ID
- \`kirograph_docs_outline\` — heading hierarchy for a single file
- \`kirograph_docs_refs\` — code ↔ doc cross-references

Before reading a doc file directly, try \`kirograph_docs_search\` or \`kirograph_docs_outline\` first.
`;
  }

  // Data section
  if (enableData) {
    content += `
## Data

KiroGraph indexes tabular data files (CSV, TSV, JSONL, JSON, Excel, Parquet).

- \`kirograph_data_list\` — list all indexed datasets
- \`kirograph_data_describe\` — schema profile: column names, types, cardinality, samples
- \`kirograph_data_query\` — filtered row retrieval (eq, gt, contains, in, between)
- \`kirograph_data_aggregate\` — server-side GROUP BY: count, sum, avg, min, max

Use \`kirograph_data_describe\` before reading a data file. Use \`kirograph_data_query\` with
filters instead of loading all rows. Use \`kirograph_data_aggregate\` for statistics.
This saves 95-99% of tokens compared to reading raw data files.
`;
  }

  // Security section
  if (enableSecurity) {
    content += `
## Security

KiroGraph scans dependency manifests across 14 ecosystems for known vulnerabilities, performs
call-graph reachability analysis, tracks EPSS exploitation probability, checks license
compliance, and monitors dependency staleness.

**Available tools:**
- \`kirograph_security\` — overview: dep count, CVE count, verdict breakdown, stale warnings
- \`kirograph_vulns\` — list CVEs with severity, EPSS score, reachability verdict, fix suggestion
- \`kirograph_reachability\` — call paths, entry points, affected layers for one CVE or package
- \`kirograph_licenses\` — list dependency licenses; flag policy violations
- \`kirograph_staleness\` — identify outdated dependencies (staleness score 0.0–1.0)
- \`kirograph_sbom\` / \`kirograph_vex\` — export CycloneDX 1.5 SBOM and VEX documents
- \`kirograph_vuln_add\` — manually register a private/internal CVE

**Proactive triggers:** Run \`kirograph_security\` when a dependency is added/updated, before a
production deploy, or when the user asks about security/compliance.

**Interpreting verdicts:**
- \`affected\` — a call path exists from an entry point to the vulnerable code. Act on this.
- \`not_affected\` — no reachable path found. Strong signal: likely safe.
- \`under_investigation\` — unresolved symbols in traversal. Treat with caution.

**EPSS scores:** >= 0.5 = patch immediately; 0.1–0.5 = elevated risk; < 0.1 = low probability.

**Workflow:** \`kirograph_security\` → \`kirograph_vulns --verdict affected\` → \`kirograph_reachability <cve>\` → fix → \`kirograph_vulns --refresh\`
`;
  }

  // Wiki section
  if (enableWiki) {
    content += `
## Wiki

KiroGraph maintains a structured LLM wiki — a set of markdown pages that compound knowledge
across sessions. Consult it before starting a complex task, and update it after sessions that
produce durable knowledge.

**Available tools:**
- \`kirograph_wiki_search\` — full-text search over wiki pages
- \`kirograph_wiki_page\` — retrieve a page by slug
- \`kirograph_wiki_list\` — list all pages
- \`kirograph_wiki_ingest\` — build an ingest prompt for a source text
- \`kirograph_wiki_apply_diff\` — apply a WIKI_DIFF to create or update pages
- \`kirograph_wiki_lint\` — health check: broken links, orphans, contradictions

**Ingest workflow (two-tool):**
1. \`kirograph_wiki_ingest(source: "...", sourceName: "...")\` — get the structured prompt
2. Generate a \`WIKI_DIFF_START ... WIKI_DIFF_END\` block from the prompt
3. \`kirograph_wiki_apply_diff(diff: "...")\` — apply it; review conflicts in the response

**When to consult:** Before starting complex work, search for relevant wiki pages.
**When to update:** After sessions with architecture decisions, API contracts, or process knowledge.
`;
  }

  // Pattern matching section
  if (enablePatterns) {
    content += `
## Pattern Search

KiroGraph supports AST structural pattern search via \`kirograph_live_search\` (only available when \`enablePatterns: true\` and \`@ast-grep/napi\` is installed).

- \`kirograph_live_search\` — find any structural code pattern across the indexed file list
- \`kirograph pattern --list\` — browse 10 bundled SAST rules (SQL injection, eval, path traversal, etc.)
- \`kirograph pattern --library <id>\` — run a specific library rule

Use \`kirograph_live_search\` when you need to find patterns that can't be expressed as symbol names: anonymous functions, specific code structures, or security anti-patterns.
`;
  }

  // Session hygiene for tools without hooks
  if (!opts.hasHooks) {
    content += `
## Session Hygiene

This tool does not have automatic sync hooks. To keep the index fresh:
- Run \`kirograph sync\` at the **start** of each session if files changed outside the agent.
- Run \`kirograph sync\` at the **end** of each session after making changes.
- If results from graph tools seem stale, run \`kirograph sync\` before retrying.
${enableMemory ? '- Store important observations with `kirograph_mem_store` before ending your session.\n' : ''}`;
  }

  // Caveman mode
  const caveman = cavemanMode && cavemanMode !== 'off' ? CAVEMAN_RULES[cavemanMode] : null;
  if (caveman) {
    content = content.trimEnd() + '\n\n' + caveman + '\n';
  }

  return content;
}
