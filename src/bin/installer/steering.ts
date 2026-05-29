/**
 * KiroGraph Installer: Kiro steering file
 */

import * as fs from 'fs';
import * as path from 'path';
import { CAVEMAN_RULES, CavemanMode } from './caveman';

const STEERING_CONTENT = `---
inclusion: always
---

# KiroGraph

KiroGraph builds a semantic knowledge graph of your codebase. Use its MCP tools instead of grep/glob/file reads whenever \`.kirograph/\` exists in the project.

## Quick decision guide

| Question | Tool |
|----------|------|
| Where do I start on this task? | \`kirograph_context\` |
| What is this symbol / show me its code | \`kirograph_node\` with \`includeCode: true\` |
| Find a symbol by name | \`kirograph_search\` |
| Who calls function X? | \`kirograph_callers\` |
| What does function X call? | \`kirograph_callees\` |
| What breaks if I change X? | \`kirograph_impact\` |
| How are X and Y connected? | \`kirograph_path\` |
| What extends / implements this type? | \`kirograph_type_hierarchy\` |
| Which code is never called? | \`kirograph_dead_code\` |
| Are there import cycles? | \`kirograph_circular_deps\` |
| What files are indexed? | \`kirograph_files\` |
| Is the index healthy? | \`kirograph_status\` |
| What are the most critical symbols? | \`kirograph_hotspots\` |
| Any unexpected cross-module coupling? | \`kirograph_surprising\` |
| What changed since the last snapshot? | \`kirograph_diff\` |
| What packages/layers exist? | \`kirograph_architecture\` |
| How coupled is package X? | \`kirograph_coupling\` |
| What does package X depend on? | \`kirograph_package\` |
| Run a command with token savings | \`kirograph_exec\` |
| Check token savings stats | \`kirograph_gain\` |
| What data files are indexed? | \`kirograph_data_list\` |
| What columns does this dataset have? | \`kirograph_data_describe\` |
| Query rows with filters | \`kirograph_data_query\` |
| Aggregate data (sum, avg, count) | \`kirograph_data_aggregate\` |
| Are there vulnerable dependencies? | \`kirograph_security\` |
| Which CVEs affect my project? | \`kirograph_vulns\` |
| Is this vulnerability reachable? | \`kirograph_reachability\` |
| What licenses do my dependencies use? | \`kirograph_licenses\` |
| Are dependencies outdated? | \`kirograph_staleness\` |
| Generate SBOM/VEX | \`kirograph_sbom\` / \`kirograph_vex\` |
| Add a private CVE | \`kirograph_vuln_add\` |

---

## Tool reference

### \`kirograph_context\`: **start here for any code task**

Returns entry points, related symbols, and code snippets for a natural-language task description. Usually enough to orient without any additional tool calls.

\`\`\`
kirograph_context(task: "fix the auth token expiry bug")
kirograph_context(task: "add dark mode", maxNodes: 30)
kirograph_context(task: "refactor payment service", includeCode: false)
\`\`\`

### \`kirograph_search\`: find symbols by name

Exact match → FTS → LIKE fallback → vector (last resort). Use instead of grep.

\`\`\`
kirograph_search(query: "signIn")
kirograph_search(query: "UserService", kind: "class")
kirograph_search(query: "auth", limit: 20)
\`\`\`

Supported kinds: \`function\`, \`method\`, \`class\`, \`interface\`, \`type_alias\`, \`variable\`, \`route\`, \`component\`

### \`kirograph_node\`: inspect a symbol

Returns kind, file, signature, docstring. Add \`includeCode: true\` to get the full source.

\`\`\`
kirograph_node(symbol: "validateToken")
kirograph_node(symbol: "AuthService", includeCode: true)
\`\`\`

### \`kirograph_callers\`: who calls this?

BFS over incoming \`calls\` edges (depth 1).

\`\`\`
kirograph_callers(symbol: "processPayment", limit: 30)
\`\`\`

### \`kirograph_callees\`: what does this call?

BFS over outgoing \`calls\` edges (depth 1).

\`\`\`
kirograph_callees(symbol: "handleRequest")
\`\`\`

### \`kirograph_impact\`: blast radius before a change

Traverses all incoming edges up to \`depth\` hops. Call this before editing a symbol.

\`\`\`
kirograph_impact(symbol: "UserRepository", depth: 3)
\`\`\`

### \`kirograph_path\`: how are two symbols connected?

BFS shortest path across all edge types.

\`\`\`
kirograph_path(from: "LoginController", to: "DatabasePool")
\`\`\`

### \`kirograph_type_hierarchy\`: class/interface inheritance

\`\`\`
kirograph_type_hierarchy(symbol: "BaseRepository", direction: "down")  // derived types
kirograph_type_hierarchy(symbol: "PaymentService", direction: "up")    // base types
kirograph_type_hierarchy(symbol: "IUserStore", direction: "both")      // all
\`\`\`

### \`kirograph_dead_code\`: unreferenced symbols

Returns unexported symbols with zero incoming edges. Good first step when cleaning up.

\`\`\`
kirograph_dead_code(limit: 50)
\`\`\`

### \`kirograph_circular_deps\`: import cycles

Runs Tarjan's SCC over import edges. No parameters needed.

\`\`\`
kirograph_circular_deps()
\`\`\`

### \`kirograph_files\`: indexed file structure

\`\`\`
kirograph_files(format: "tree")                          // default
kirograph_files(format: "flat")                          // one path per line
kirograph_files(format: "grouped")                       // by directory
kirograph_files(filterPath: "src/auth", maxDepth: 2)
kirograph_files(pattern: "**/*.test.ts")
\`\`\`

### \`kirograph_status\`: index health

Returns file count, symbol count, edge count, embedding coverage, DB size. Call when something feels off.

### \`kirograph_hotspots\`: most-connected symbols

Returns the top-N symbols by total edge degree (in + out, excluding structural \`contains\` edges). Use to find core abstractions, identify high blast-radius symbols before a refactor, or understand what the codebase revolves around.

\`\`\`
kirograph_hotspots(limit: 20)
\`\`\`

### \`kirograph_surprising\`: unexpected cross-module coupling

Finds direct edges between symbols in structurally distant files, scored by path distance × edge-kind weight. Use before a refactor to discover hidden dependencies that will break. High score = more unexpected.

\`\`\`
kirograph_surprising(limit: 20)
\`\`\`

### \`kirograph_diff\`: what changed since a snapshot?

Compares the current graph against a saved snapshot. Shows added/removed symbols and edges. A snapshot must exist: the user saves one with \`kirograph snapshot save <label>\` before making changes.

\`\`\`
kirograph_diff()                              // vs latest snapshot
kirograph_diff(snapshot: "pre-refactor")     // vs named snapshot
\`\`\`

---

## Architecture tools *(require \`enableArchitecture: true\` in config)*

### \`kirograph_architecture\`: **start here for architectural questions**

Returns the full package graph, detected layers (api/service/data/ui/shared), and their dependency edges.

\`\`\`
kirograph_architecture()                    // packages + layers
kirograph_architecture(level: "packages")
kirograph_architecture(level: "layers")
kirograph_architecture(includeFiles: true)  // add file→package assignments
\`\`\`

### \`kirograph_coupling\`: stability metrics per package

Returns Ca (afferent: depended on by), Ce (efferent: depends on), and instability (Ce/(Ca+Ce)).
- High Ca + low instability = load-bearing, safe to depend on, risky to change interface.
- High Ce + high instability = depends on many things, safe to refactor internals.

\`\`\`
kirograph_coupling()                        // all packages, sorted by instability
kirograph_coupling(sortBy: "afferent")     // most depended-on first
kirograph_coupling(sortBy: "efferent")     // most outgoing deps first
\`\`\`

### \`kirograph_package\`: drill into one package

Returns metadata, coupling metrics, outgoing deps, incoming dependents, and file list.

\`\`\`
kirograph_package(package: "auth")
kirograph_package(package: "src/services", includeFiles: false)
\`\`\`

---

## Workflows

**Bug fix or feature:**
1. \`kirograph_context\`: orient, find entry points.
2. \`kirograph_node\` with \`includeCode: true\`: read the relevant symbol.
3. \`kirograph_callers\` / \`kirograph_callees\`: trace the call flow.
4. \`kirograph_impact\`: check blast radius before editing.

**Refactor planning:**
1. \`kirograph_hotspots\`: identify the most-connected symbols; changing these is risky.
2. \`kirograph_surprising\`: surface hidden coupling that will break.
3. \`kirograph_impact\` on specific targets: confirm blast radius.
4. \`kirograph_diff\` after the refactor: verify the structural change matches intent.

**Architectural review:**
1. \`kirograph_architecture\`: get the package and layer map.
2. \`kirograph_coupling\`: find the most stable (high Ca) and most volatile (high instability) packages.
3. \`kirograph_package\`: drill into any package of interest.
4. \`kirograph_circular_deps\`: check for import cycles.

**Code cleanup:**
1. \`kirograph_dead_code\`: find unreferenced unexported symbols.
2. \`kirograph_circular_deps\`: find import cycles to untangle.
3. \`kirograph_surprising\`: find unexpected coupling to decouple.

---

## Workflow steering files

KiroGraph installs task-specific steering files in \`.kiro/steering/\`. They are not always active — load them on demand.

**In Kiro IDE:** type \`/kirograph-review\`, \`/kirograph-security\`, etc. to activate a workflow for the current session.

**In Kiro CLI / other agents:** when the user asks for a specific workflow or you recognize the intent, read the file directly:

\`\`\`
Read file: .kiro/steering/kirograph-security.md
Read file: .kiro/steering/kirograph-review.md
\`\`\`

| User intent | File to load |
|-------------|-------------|
| security audit, check vulnerabilities, CVE review | \`.kiro/steering/kirograph-security.md\` *(requires enableSecurity)* |
| code review, review this PR | \`.kiro/steering/kirograph-review.md\` |
| debug, trace this bug, root cause | \`.kiro/steering/kirograph-debug.md\` |
| architecture, understand structure, package map | \`.kiro/steering/kirograph-architecture.md\` *(requires enableArchitecture)* |
| onboard, understand this codebase | \`.kiro/steering/kirograph-onboard.md\` |
| refactor, rename, safe refactoring | \`.kiro/steering/kirograph-refactor.md\` |

Each file contains numbered steps, exact tool calls, and an interpretation reference. Follow the steps in order.

---

## If \`.kirograph/\` does NOT exist

Ask the user: "This project doesn't have KiroGraph initialized. Run \`kirograph init -i\` to build a code knowledge graph for faster exploration?"
`;

// ── Compression section builder (level-aware) ─────────────────────────────────

const LEVEL_DESCRIPTIONS: Record<string, string> = {
  normal: 'Balanced: removes noise, keeps structure.',
  aggressive: 'Compact: groups by category, limits output.',
  ultra: 'Maximum compression: counts and summaries only.',
};

const LEVEL_EXAMPLES: Record<string, string> = {
  normal: `\\\`\\\`\\\`
kirograph_exec(command: "git status")
kirograph_exec(command: "npm test")
kirograph_exec(command: "cargo build")
kirograph_exec(command: "ls -la src/")
\\\`\\\`\\\``,
  aggressive: `\\\`\\\`\\\`
kirograph_exec(command: "git status", level: "aggressive")
kirograph_exec(command: "npm test", level: "aggressive")
kirograph_exec(command: "eslint .", level: "aggressive")
kirograph_exec(command: "find . -name '*.ts'", level: "aggressive")
\\\`\\\`\\\``,
  ultra: `\\\`\\\`\\\`
kirograph_exec(command: "git status", level: "ultra")
kirograph_exec(command: "npm test", level: "ultra")
kirograph_exec(command: "docker ps", level: "ultra")
kirograph_exec(command: "ls -la src/", level: "ultra")
\\\`\\\`\\\``,
};

function buildCompressionSection(level: 'normal' | 'aggressive' | 'ultra'): string {
  return `
---

## Shell Compression (\\\`kirograph_exec\\\`)

When running shell commands, prefer \\\`kirograph_exec\\\` over raw shell execution for:
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

**Do NOT re-run commands:** When \\\`kirograph_exec\\\` returns a result, treat it as the final answer. Never re-run the same command with raw shell execution to "get more details." The compressed output preserves all essential information. If you genuinely need something missing from the output, explain what's missing before making a second call.

Use \\\`kirograph_gain\\\` to check token savings statistics.`;
}

export interface SteeringOptions {
  cavemanMode?: CavemanMode | 'off';
  enableCompression?: boolean;
  shellCompressionLevel?: 'off' | 'normal' | 'aggressive' | 'ultra';
  enableArchitecture?: boolean;
  enableMemory?: boolean;
  enableDocs?: boolean;
  enableData?: boolean;
  enableSecurity?: boolean;
}

function buildSteeringContent(opts?: SteeringOptions): string {
  const cavemanMode = opts?.cavemanMode;
  const enableCompression = opts?.enableCompression !== false && opts?.shellCompressionLevel !== 'off';
  const shellCompressionLevel = opts?.shellCompressionLevel ?? 'normal';

  let content = STEERING_CONTENT;

  // Insert compression section before the "If .kirograph/ does NOT exist" section
  if (enableCompression && shellCompressionLevel !== 'off') {
    const section = buildCompressionSection(shellCompressionLevel as 'normal' | 'aggressive' | 'ultra');
    content = content.replace(
      '---\n\n## If `.kirograph/` does NOT exist',
      section.trim() + '\n\n---\n\n## If `.kirograph/` does NOT exist',
    );
  }

  // Remove compression tools from decision guide if disabled
  if (!enableCompression) {
    content = content.replace('| Run a command with token savings | `kirograph_exec` |\n', '');
    content = content.replace('| Check token savings stats | `kirograph_gain` |\n', '');
  }

  // Remove security tools from decision guide if disabled
  if (!opts?.enableSecurity) {
    content = content.replace('| Are there vulnerable dependencies? | `kirograph_security` |\n', '');
    content = content.replace('| Which CVEs affect my project? | `kirograph_vulns` |\n', '');
    content = content.replace('| Is this vulnerability reachable? | `kirograph_reachability` |\n', '');
    content = content.replace('| What licenses do my dependencies use? | `kirograph_licenses` |\n', '');
    content = content.replace('| Are dependencies outdated? | `kirograph_staleness` |\n', '');
    content = content.replace('| Generate SBOM/VEX | `kirograph_sbom` / `kirograph_vex` |\n', '');
    content = content.replace('| Add a private CVE | `kirograph_vuln_add` |\n', '');
  }

  const caveman = cavemanMode && cavemanMode !== 'off' ? CAVEMAN_RULES[cavemanMode] : null;
  if (caveman) {
    content = content.trimEnd() + '\n\n' + caveman + '\n';
  }

  // Memory section
  if (opts?.enableMemory) {
    const memorySection = `
## Memory

KiroGraph has persistent memory. Use \`kirograph_mem_search\` to recall past decisions,
errors, and patterns before making changes. Use \`kirograph_mem_store\` to save important
observations (architecture decisions, bug root causes, patterns discovered).

Memory is searchable via hybrid FTS + vector search. Observations are automatically
linked to code symbols in the graph and surface in \`kirograph_context\` and
\`kirograph_impact\` results when relevant.

**When to store:** After fixing a bug, making an architecture decision, discovering a pattern,
encountering a non-obvious error, or learning something about the codebase that future sessions
should know. Keep observations concise — one fact per store call. A hook will also remind you
at session end.
`;
    content = content.trimEnd() + '\n\n' + memorySection.trim() + '\n';
  }

  // Documentation section
  if (opts?.enableDocs) {
    const docsSection = `
## Documentation

KiroGraph indexes project documentation by heading structure. Use \`kirograph_docs_search\`
to find relevant doc sections instead of reading entire files. Use \`kirograph_docs_section\`
to retrieve the exact section you need by ID.

**Available tools:**
- \`kirograph_docs_toc\` — table of contents for a file or the whole project
- \`kirograph_docs_search\` — search sections by query (independent from code search)
- \`kirograph_docs_section\` — retrieve full content of a section by ID
- \`kirograph_docs_outline\` — heading hierarchy for a single document
- \`kirograph_docs_refs\` — find code symbols referenced by a doc section (or vice versa)

**When to use:** Before reading a documentation file directly, check if \`kirograph_docs_search\`
or \`kirograph_docs_outline\` can give you the specific section you need. This saves tokens
and gives you structured navigation instead of raw file content.
`;
    content = content.trimEnd() + '\n\n' + docsSection.trim() + '\n';
  }

  // Data section
  if (opts?.enableData) {
    const dataSection = `
## Data

KiroGraph indexes tabular data files (CSV, TSV, JSONL, JSON, Excel, Parquet) for structured
querying. Use \`kirograph_data_describe\` to understand a dataset's schema without loading
the file. Use \`kirograph_data_query\` with filters to retrieve specific rows.

**Available tools:**
- \`kirograph_data_list\` — list all indexed datasets with row/column counts
- \`kirograph_data_describe\` — full schema profile: column names, types, cardinality, null%, samples
- \`kirograph_data_query\` — filtered row retrieval with structured operators (eq, gt, contains, in, between)
- \`kirograph_data_aggregate\` — server-side GROUP BY: count, sum, avg, min, max, count_distinct
- \`kirograph_data_search\` — search column names and sample values by keyword

**When to use:** Instead of reading a CSV/data file directly (which floods context with raw rows),
use \`kirograph_data_describe\` to understand the schema, then \`kirograph_data_query\` with
filters to get only the rows you need. For summary statistics, use \`kirograph_data_aggregate\`
to compute results server-side. This saves 95-99% of tokens compared to reading raw data files.

\`\`\`
kirograph_data_list()
kirograph_data_describe(dataset: "tests-fixtures-users")
kirograph_data_query(dataset: "tests-fixtures-users", filters: [{column: "role", op: "eq", value: "admin"}])
kirograph_data_aggregate(dataset: "data-orders", groupBy: ["region"], metrics: [{column: "amount", op: "sum"}])
\`\`\`
`;
    content = content.trimEnd() + '\n\n' + dataSection.trim() + '\n';
  }

  // Security section
  if (opts?.enableSecurity) {
    const securitySection = `
## Security

KiroGraph scans dependency manifests across 14 ecosystems for known vulnerabilities, performs
call-graph reachability analysis, tracks exploitation probability (EPSS), checks license
compliance, and monitors dependency staleness.

**Available tools:**
- \`kirograph_security\` — overview: dep count, CVE count, verdict breakdown, stale warnings
- \`kirograph_vulns\` — list CVEs with severity, EPSS score, reachability verdict, fix suggestion
- \`kirograph_reachability\` — deep-dive: call paths, entry points, affected layers for one CVE or package
- \`kirograph_licenses\` — list dependency licenses; flag policy violations (deny/warn by SPDX pattern)
- \`kirograph_staleness\` — identify outdated dependencies (staleness score 0.0–1.0)
- \`kirograph_sbom\` — export CycloneDX 1.5 SBOM for compliance/auditing
- \`kirograph_vex\` — export CycloneDX 1.5 VEX with reachability-derived analysis states
- \`kirograph_vuln_add\` — manually register a private/internal CVE not in public databases

**Proactive triggers — run \`kirograph_security\` when:**
- You or the user add/update/remove a dependency
- Before a production deploy or release branch cut
- The user asks about security, compliance, or "is it safe to upgrade X"
- \`kirograph_context\` surfaces a ⚠ Security warning in its output

**Interpreting verdicts:**
- \`affected\` — a call path exists from an entry point to the vulnerable code. Act on this.
- \`not_affected\` — no reachable path found, no unresolved imports. Strong signal: likely safe.
- \`under_investigation\` — traversal hit unresolved symbols (dynamic dispatch, reflection). Treat with caution.

**Interpreting EPSS scores** (shown by \`kirograph_vulns\`):
- \`>= 0.5\` — actively exploited or very likely to be. Patch immediately regardless of CVSS.
- \`0.1 – 0.5\` — elevated risk. Prioritize over low-EPSS vulns with higher CVSS.
- \`< 0.1\` — low exploitation probability. Use CVSS + reachability for triage.

**Recommended workflow:**
1. \`kirograph_security\` — get the big picture before diving in
2. \`kirograph_vulns --verdict affected\` — focus only on confirmed reachable CVEs
3. For each high-EPSS or high-CVSS result: \`kirograph_reachability <cve>\` to see exact call paths
4. \`kirograph_licenses --policy\` — check for license violations before shipping
5. \`kirograph_staleness --threshold 0.5\` — flag severely outdated dependencies
6. Fix, then \`kirograph_vulns --refresh\` to re-query OSV and confirm resolution
7. \`kirograph_vex\` / \`kirograph_sbom\` for compliance artifacts

**Staleness score guide:** 0.0 = current; 0.3+ = worth reviewing; 0.7+ = significantly behind.
A high staleness score alone is not a security issue, but old dependencies accumulate CVEs over time.
`;
    content = content.trimEnd() + '\n\n' + securitySection.trim() + '\n';
  }

  return content;
}

export function writeSteering(kiroDir: string, opts?: SteeringOptions | CavemanMode | 'off'): void {
  const steeringDir = path.join(kiroDir, 'steering');
  fs.mkdirSync(steeringDir, { recursive: true });
  const steeringPath = path.join(steeringDir, 'kirograph.md');

  // Support both old signature (cavemanMode string) and new signature (options object)
  const resolvedOpts: SteeringOptions = typeof opts === 'string'
    ? { cavemanMode: opts }
    : opts ?? {};

  fs.writeFileSync(steeringPath, buildSteeringContent(resolvedOpts));
  console.log(`  ✓ Steering file written to ${steeringPath}`);

  // Write workflow-specific steering files
  writeWorkflowSteering(steeringDir, resolvedOpts);
}

function writeWorkflowSteering(steeringDir: string, opts?: SteeringOptions): void {
  const workflows: Record<string, string> = {
    'kirograph-review.md': `---
inclusion: manual
---

# KiroGraph: Code Review Workflow

Follow these steps for a structured, risk-aware code review using the knowledge graph.

## Steps

1. **Understand the change scope**
   \`\`\`
   kirograph_context(task: "<describe what changed>")
   \`\`\`

2. **Analyze blast radius**
   For each key symbol that was modified:
   \`\`\`
   kirograph_impact(symbol: "<changed symbol>", depth: 2)
   \`\`\`

3. **Check test coverage**
   \`\`\`
   kirograph_callers(symbol: "<changed symbol>")
   \`\`\`
   Look for test files among the callers. Flag untested changes.

4. **Look for surprising coupling**
   \`\`\`
   kirograph_surprising(limit: 10)
   \`\`\`

5. **Produce findings** grouped by risk level (high/medium/low) with:
   - What changed and why it matters
   - Test coverage status
   - Suggested improvements
   - Overall merge recommendation
`,

    'kirograph-debug.md': `---
inclusion: manual
---

# KiroGraph: Debug Workflow

Follow these steps to systematically trace and debug issues using the knowledge graph.

## Steps

1. **Find related code**
   \`\`\`
   kirograph_search(query: "<error message or symptom keywords>")
   \`\`\`

2. **Get full context**
   \`\`\`
   kirograph_context(task: "<describe the bug>")
   \`\`\`

3. **Trace the call chain**
   \`\`\`
   kirograph_callers(symbol: "<suspected function>")
   kirograph_callees(symbol: "<suspected function>")
   \`\`\`

4. **Check what changed recently**
   \`\`\`
   kirograph_diff()
   \`\`\`

5. **Understand blast radius**
   \`\`\`
   kirograph_impact(symbol: "<root cause symbol>", depth: 3)
   \`\`\`

## Tips
- Check both callers and callees to understand the full context
- Recent changes (via diff) are the most common source of new issues
- Use \`kirograph_path\` to trace how two symbols are connected
`,

    'kirograph-architecture.md': `---
inclusion: manual
---

# KiroGraph: Architecture Exploration Workflow

Follow these steps to understand the high-level structure of the codebase.

## Steps

1. **Get project overview**
   \`\`\`
   kirograph_status()
   \`\`\`

2. **View architecture**
   \`\`\`
   kirograph_architecture()
   \`\`\`

3. **Check coupling health**
   \`\`\`
   kirograph_coupling(sortBy: "instability")
   \`\`\`

4. **Find core abstractions**
   \`\`\`
   kirograph_hotspots(limit: 20)
   \`\`\`

5. **Detect hidden dependencies**
   \`\`\`
   kirograph_surprising(limit: 15)
   \`\`\`

6. **Check for cycles**
   \`\`\`
   kirograph_circular_deps()
   \`\`\`

## Interpretation
- High Ca (afferent) = load-bearing, risky to change interface
- High Ce (efferent) = depends on many things, safe to refactor internals
- Surprising edges = hidden coupling that may break during refactoring
`,

    'kirograph-onboard.md': `---
inclusion: manual
---

# KiroGraph: Onboarding Workflow

Follow these steps to quickly understand a new codebase.

## Steps

1. **Project overview**
   \`\`\`
   kirograph_status()
   \`\`\`

2. **File structure**
   \`\`\`
   kirograph_files(format: "tree", maxDepth: 2)
   \`\`\`

3. **Key entry points**
   \`\`\`
   kirograph_hotspots(limit: 15)
   \`\`\`

4. **Architecture layers**
   \`\`\`
   kirograph_architecture()
   \`\`\`

5. **Explore a specific area**
   \`\`\`
   kirograph_context(task: "<area you want to understand>")
   \`\`\`

6. **Understand a key symbol**
   \`\`\`
   kirograph_node(symbol: "<symbol name>", includeCode: true)
   \`\`\`

## Tips
- Start broad (status, files, hotspots) then narrow down
- Use \`kirograph_type_hierarchy\` to understand inheritance patterns
- Use \`kirograph_callees\` on entry points to trace execution flow
`,

    'kirograph-refactor.md': `---
inclusion: manual
---

# KiroGraph: Refactoring Workflow

Follow these steps to plan and execute safe refactoring.

## Steps

1. **Understand what you're changing**
   \`\`\`
   kirograph_node(symbol: "<target symbol>", includeCode: true)
   \`\`\`

2. **Check blast radius**
   \`\`\`
   kirograph_impact(symbol: "<target symbol>", depth: 3)
   \`\`\`

3. **Find all callers (rename preview)**
   \`\`\`
   kirograph_callers(symbol: "<target symbol>", limit: 50)
   \`\`\`

4. **Check for cycles that might complicate the refactor**
   \`\`\`
   kirograph_circular_deps()
   \`\`\`

5. **Find dead code to clean up**
   \`\`\`
   kirograph_dead_code(limit: 30)
   \`\`\`

6. **Verify after changes**
   Run \`kirograph sync\` then:
   \`\`\`
   kirograph_diff()
   \`\`\`

## Safety Checks
- Always check \`kirograph_impact\` before major refactors
- Use \`kirograph_callers\` as a rename preview (all locations that reference the symbol)
- After changes, use \`kirograph_diff\` to verify only intended symbols changed
`,
  };

  // kirograph-architecture.md only when enableArchitecture is true
  if (opts?.enableArchitecture) {
    fs.writeFileSync(path.join(steeringDir, 'kirograph-architecture.md'), workflows['kirograph-architecture.md']!);
  }

  // Always write the non-conditional workflow files
  for (const [filename, content] of Object.entries(workflows)) {
    if (filename === 'kirograph-architecture.md') continue; // handled above
    fs.writeFileSync(path.join(steeringDir, filename), content);
  }

  // Security workflow — only when enableSecurity is true
  if (opts?.enableSecurity) {
    fs.writeFileSync(path.join(steeringDir, 'kirograph-security.md'), `---
inclusion: manual
---

# KiroGraph: Security Audit Workflow

Follow these steps for a structured security audit using the knowledge graph.
Activate this workflow before a release, after adding dependencies, or when asked to review security posture.

## Steps

### 1. Overview
\`\`\`
kirograph_security()
\`\`\`
Note: total dependencies, vulnerability count, verdict breakdown, stale warning count.

### 2. Triage reachable vulnerabilities
\`\`\`
kirograph_vulns(verdict: "affected")
\`\`\`
Focus only on confirmed reachable CVEs. Sort output by EPSS score (exploitation probability) first, then CVSS severity.

**Act immediately on:** EPSS >= 0.5 (actively exploited). Patch regardless of CVSS.
**Prioritize:** EPSS 0.1–0.5 over low-EPSS high-CVSS entries.
**Low urgency:** EPSS < 0.1 — use CVSS + reachability for triage.

### 3. Deep-dive reachability for critical CVEs
For each high-priority CVE from step 2:
\`\`\`
kirograph_reachability(target: "<CVE-ID or package name>")
\`\`\`
This shows: exact call paths from entry points, affected architectural layers, distinct path count.

- \`affected\` verdict with known entry points → fix this dependency
- \`not_affected\` → no reachable path, document and move on
- \`under_investigation\` → unresolved symbols, treat conservatively

### 4. Check for under-investigation CVEs
\`\`\`
kirograph_vulns(verdict: "under_investigation")
\`\`\`
For each: run \`kirograph_reachability\` to see what symbols are unresolved. If you can determine
the symbol is not called, you can downgrade to not_affected manually.

### 5. License compliance
\`\`\`
kirograph_licenses(policy: true)
\`\`\`
Review any DENY violations — these must be resolved before shipping.
WARN violations should be documented and approved by the team.

### 6. Dependency staleness
\`\`\`
kirograph_staleness(threshold: 0.5)
\`\`\`
Score guide: 0.3+ = worth reviewing, 0.7+ = significantly behind.
Cross-reference with step 2 results: stale + vulnerable = highest priority.

### 7. Refresh data if needed
If vulnerability data looks stale (flagged in step 1) or dependencies changed recently:
\`\`\`
kirograph_vulns(refresh: true)
\`\`\`

### 8. Export compliance artifacts
\`\`\`
kirograph_sbom()   // Software Bill of Materials
kirograph_vex()    // Vulnerability Exploitability eXchange
\`\`\`

## Interpretation Reference

| Signal | Meaning | Action |
|--------|---------|--------|
| \`affected\` + EPSS >= 0.5 | Actively exploited, reachable | Patch immediately |
| \`affected\` + CVSS >= 9.0 | Critical, reachable | Patch this sprint |
| \`affected\` + CVSS 7.0–8.9 | High, reachable | Plan fix within 2 weeks |
| \`not_affected\` | No reachable path found | Document, no action needed |
| \`under_investigation\` | Reachability unclear | Manual review required |
| Stale >= 0.7 | Very outdated | Review for accumulated CVEs |
| License DENY | Policy violation | Must resolve before release |
`);
    console.log(`  ✓ Security workflow steering file written`);
  }

  const written = ['review', 'debug', 'onboard', 'refactor'];
  if (opts?.enableArchitecture) written.push('architecture');
  if (opts?.enableSecurity) written.push('security');
  console.log(`  ✓ Workflow steering files written (${written.join(', ')})`);
}
