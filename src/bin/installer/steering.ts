/**
 * KiroGraph Installer: Kiro steering file
 */

import * as fs from 'fs';
import * as path from 'path';
import { CAVEMAN_RULES, CavemanMode } from './caveman';


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
}

function buildSteeringContent(opts?: SteeringOptions): string {
  const cavemanMode = opts?.cavemanMode;
  const enableCompression = opts?.enableCompression !== false && opts?.shellCompressionLevel !== 'off';
  const shellCompressionLevel = opts?.shellCompressionLevel ?? 'normal';
  const enableArchitecture = opts?.enableArchitecture ?? false;
  const enableMemory = opts?.enableMemory ?? false;
  const enableDocs = opts?.enableDocs ?? false;
  const enableData = opts?.enableData ?? false;
  const enableSecurity = opts?.enableSecurity ?? false;
  const enablePatterns = opts?.enablePatterns ?? false;
  const enableWiki = opts?.enableWiki ?? false;
  const enableCodeHealth = opts?.enableCodeHealth ?? false;
  const enableNavigation = opts?.enableNavigation ?? false;
  const enableGitContext = opts?.enableGitContext ?? false;
  const enableComplexity = opts?.enableComplexity ?? false;
  const enableEditPrimitives = opts?.enableEditPrimitives ?? false;
  const enableBranch = opts?.enableBranch ?? false;
  const enableAgentUtils = opts?.enableAgentUtils ?? false;
  const enableGeneralCompression = opts?.enableGeneralCompression ?? false;
  const trackCallSites = opts?.trackCallSites ?? false;

  // Build guide rows
  const guideRows: string[] = [
    '| Where do I start on this task? | `kirograph_context` |',
    '| What is this symbol / show me its code | `kirograph_node` with `includeCode: true` |',
    '| Find a symbol by name | `kirograph_search` |',
    ...(trackCallSites ? [
      '| Who calls function X? | `kirograph_callers` |',
      '| What does function X call? | `kirograph_callees` |',
    ] : []),
    ...(enableNavigation ? [
      '| What breaks if I change X? | `kirograph_impact` |',
      '| What files are indexed? | `kirograph_files` |',
      '| Is the index healthy? | `kirograph_status` |',
    ] : []),
    ...(enableCodeHealth ? [
      '| How are X and Y connected? | `kirograph_path` |',
      '| What extends / implements this type? | `kirograph_type_hierarchy` |',
      '| Which code is never called? | `kirograph_dead_code` |',
      '| Are there import cycles? | `kirograph_circular_deps` |',
    ] : []),
    ...(enableCodeHealth ? [
      '| What are the most critical symbols? | `kirograph_hotspots` |',
      '| Any unexpected cross-module coupling? | `kirograph_surprising` |',
      '| What changed since the last snapshot? | `kirograph_diff` |',
    ] : []),
    ...(enableArchitecture ? [
      '| What packages/layers exist? | `kirograph_architecture` |',
      '| How coupled is package X? | `kirograph_coupling` |',
      '| What does package X depend on? | `kirograph_package` |',
    ] : []),
    ...(enableCompression ? ['| Run a command with token savings | `kirograph_exec` |'] : []),
    ...(enableGeneralCompression ? ['| Compress text or shell output before sending | `kirograph_compress` |'] : []),
    ...(enableAgentUtils ? ['| Check token savings stats | `kirograph_gain` |'] : []),
    ...(enableData ? [
      '| What data files are indexed? | `kirograph_data_list` |',
      '| What columns does this dataset have? | `kirograph_data_describe` |',
      '| Query rows with filters | `kirograph_data_query` |',
      '| Aggregate data (sum, avg, count) | `kirograph_data_aggregate` |',
    ] : []),
    ...(enableSecurity ? [
      '| Are there vulnerable dependencies? | `kirograph_security` |',
      '| Which CVEs affect my project? | `kirograph_vulns` |',
      '| Is this vulnerability reachable? | `kirograph_reachability` |',
      '| What licenses do my dependencies use? | `kirograph_licenses` |',
      '| Are dependencies outdated? | `kirograph_staleness` |',
      '| Generate SBOM/VEX | `kirograph_sbom` / `kirograph_vex` |',
      '| Add a private CVE | `kirograph_vuln_add` |',
    ] : []),
    ...(enablePatterns ? ['| Find structural code patterns? | `kirograph_live_search` |'] : []),
    ...(enableComplexity ? [
      '| Overall graph health score | `kirograph_health` |',
      '| Most complex functions? | `kirograph_complexity` |',
      '| Which functions are highest risk to change? | `kirograph_test_risk` |',
      '| How are modules coupled? | `kirograph_dsm` |',
    ] : []),
    ...(enableGitContext ? [
      '| What symbols did I change? | `kirograph_diff_context` |',
      '| Build commit message context | `kirograph_commit_context` |',
      '| Generate PR description | `kirograph_pr_context` |',
      '| What tests cover symbol X? | `kirograph_test_map` |',
      '| Show per-file coverage report | `kirograph_test_coverage` |',
    ] : []),
    ...(enableEditPrimitives ? [
      '| Replace a unique string in a file | `kirograph_str_replace` |',
      '| Insert content before/after an anchor | `kirograph_insert_at` |',
      '| Atomic multi-replacement in a file | `kirograph_multi_str_replace` |',
    ] : []),
    ...(enableBranch ? [
      '| List tracked branches | `kirograph_branch_list` |',
      '| What changed between branches? | `kirograph_branch_diff` |',
      '| Search symbols in another branch | `kirograph_branch_search` |',
    ] : []),
  ];

  // Build tool reference sections
  let toolRef = `
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
\`\`\``;

  if (trackCallSites) {
    toolRef += `

### \`kirograph_callers\`: who calls this?

BFS over incoming \`calls\` edges (depth 1).

\`\`\`
kirograph_callers(symbol: "processPayment", limit: 30)
\`\`\`

### \`kirograph_callees\`: what does this call?

BFS over outgoing \`calls\` edges (depth 1).

\`\`\`
kirograph_callees(symbol: "handleRequest")
\`\`\``;
  }

  if (enableNavigation) {
    toolRef += `

### \`kirograph_impact\`: blast radius before a change

Traverses all incoming edges up to \`depth\` hops. Call this before editing a symbol.

\`\`\`
kirograph_impact(symbol: "UserRepository", depth: 3)
\`\`\``;
  }

  if (enableCodeHealth) {
    toolRef += `

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
\`\`\``;
  }

  if (enableCodeHealth) {
    toolRef += `

### \`kirograph_dead_code\`: unreferenced symbols

Returns unexported symbols with zero incoming edges. Good first step when cleaning up.

\`\`\`
kirograph_dead_code(limit: 50)
\`\`\`

### \`kirograph_circular_deps\`: import cycles

Runs Tarjan's SCC over import edges. No parameters needed.

\`\`\`
kirograph_circular_deps()
\`\`\``;
  }

  toolRef += `

${enableNavigation ? `
### \`kirograph_files\`: indexed file structure

\`\`\`
kirograph_files(format: "tree")                          // default
kirograph_files(format: "flat")                          // one path per line
kirograph_files(format: "grouped")                       // by directory
kirograph_files(filterPath: "src/auth", maxDepth: 2)
kirograph_files(pattern: "**/*.test.ts")
\`\`\`

### \`kirograph_status\`: index health

Returns file count, symbol count, edge count, embedding coverage, DB size. Call when something feels off.` : ''}`;

  if (enableCodeHealth) {
    toolRef += `

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
\`\`\``;
  }

  // Architecture tools block
  if (enableArchitecture) {
    toolRef += `

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
\`\`\``;
  }

  // Complexity tools block
  if (enableComplexity) {
    toolRef += `

---

## Complexity tools *(require \`enableComplexity: true\` in config)*

### \`kirograph_health\`: composite graph health score

Returns a 0–10000 score across four dimensions: complexity, dead code, coupling, circular deps.
Higher is better. Excellent ≥ 9000 · Good ≥ 7000 · Fair ≥ 5000 · Poor ≥ 3000 · Critical < 3000.

\`\`\`
kirograph_health()
\`\`\`

### \`kirograph_complexity\`: rank functions by complexity

Returns cyclomatic complexity (CC), cognitive complexity, maintainability index (MI), and nesting depth, sorted by chosen metric.

\`\`\`
kirograph_complexity(metric: "cyclomatic", limit: 30, threshold: 10)
kirograph_complexity(metric: "cognitive")
kirograph_complexity(metric: "maintainability")  // sort ASC — lowest MI first
\`\`\`

### \`kirograph_dsm\`: design structure matrix

Groups nodes by top-level directory and shows a dependency count matrix between groups. Reveals which modules depend on which others and where tight coupling lives.

\`\`\`
kirograph_dsm()
kirograph_dsm(limit: 10)  // cap number of groups shown
\`\`\`

### \`kirograph_test_risk\`: risk-ranked functions

Risk = complexity × fan-in. Highest-risk functions are most likely to cause failures when changed.

\`\`\`
kirograph_test_risk(limit: 20)
kirograph_test_risk(threshold: 50)  // only show risk score ≥ 50
\`\`\``;
  }

  // Git context tools block
  if (enableGitContext) {
    toolRef += `

---

## Git Context tools *(require \`enableGitContext: true\` in config)*

### \`kirograph_diff_context\`: changed symbols in working tree

Returns symbols whose definitions overlap with \`git diff\` line ranges, plus their callers and callees. Use before a commit to understand what you actually changed.

\`\`\`
kirograph_diff_context()              // unstaged changes
kirograph_diff_context(staged: true)  // staged changes only
\`\`\`

### \`kirograph_commit_context\`: staged changes summary

Returns staged files, diff stat, and affected symbols. Ready to paste into a commit message prompt.

\`\`\`
kirograph_commit_context()
\`\`\`

### \`kirograph_pr_context\`: semantic diff between two refs

Returns symbols added/removed/changed between two git refs. Use for PR descriptions.

\`\`\`
kirograph_pr_context(base: "main", head: "HEAD")
kirograph_pr_context(base: "v1.2.0")
\`\`\`

### \`kirograph_test_map\`: symbol → test file mapping

Shows which test files cover a symbol (by caller graph), and which symbols have no test coverage at all.

\`\`\`
kirograph_test_map()                         // all uncovered symbols
kirograph_test_map(symbol: "processPayment") // tests for a specific symbol
\`\`\`

### \`kirograph_test_coverage\`: per-file coverage report

Parses lcov/Istanbul/Cobertura files. Sorted worst-first by default.

\`\`\`
kirograph_test_coverage()
kirograph_test_coverage(sortBy: "desc", limit: 20)  // best coverage first
\`\`\``;
  }

  // Edit primitives tools block
  if (enableEditPrimitives) {
    toolRef += `

---

## Edit Primitives *(require \`enableEditPrimitives: true\` in config)*

Atomic file edit tools. Each validates the anchor is unique before writing, then triggers \`kirograph sync\` to keep the graph up to date.

### \`kirograph_str_replace\`: replace a unique string

Fails on 0 or >1 matches — safe to use without counting occurrences first.

\`\`\`
kirograph_str_replace(file: "src/auth.ts", old_str: "const timeout = 5000", new_str: "const timeout = 10000")
\`\`\`

### \`kirograph_multi_str_replace\`: N replacements as one transaction

All-or-nothing: if any replacement fails, none are applied.

\`\`\`
kirograph_multi_str_replace(file: "src/auth.ts", pairs: [
  { old_str: "oldFunctionName", new_str: "newFunctionName" },
  { old_str: "OldClass", new_str: "NewClass" }
])
\`\`\`

### \`kirograph_insert_at\`: insert before/after an anchor

\`\`\`
kirograph_insert_at(file: "src/routes.ts", anchor: "// END ROUTES", content: "router.get('/health', healthCheck);", position: "before")
\`\`\`

### \`kirograph_refactor\`: structured search-and-replace across the graph

\`\`\`
kirograph_refactor(symbol: "OldName", newName: "NewName", kind: "function")
\`\`\``;
  }

  // Branch tools block
  if (enableBranch) {
    toolRef += `

---

## Branch tools *(require \`enableBranch: true\` in config)*

Each branch gets its own SQLite DB at \`.kirograph/branch-<name>.db\`. Use \`kirograph branch add\` to start tracking a branch.

### \`kirograph_branch_list\`: tracked branches

\`\`\`
kirograph_branch_list()
\`\`\`

### \`kirograph_branch_diff\`: symbols added/removed/changed between branches

\`\`\`
kirograph_branch_diff(branchA: "feature/new-auth", branchB: "main")
\`\`\`

### \`kirograph_branch_search\`: search symbols in another branch

\`\`\`
kirograph_branch_search(query: "processPayment", branch: "main")
\`\`\``;
  }

  // Build bug fix workflow
  let bugFixWorkflow = `**Bug fix or feature:**
1. \`kirograph_context\`: orient, find entry points.
2. \`kirograph_node\` with \`includeCode: true\`: read the relevant symbol.`;
  if (trackCallSites) {
    bugFixWorkflow += `
3. \`kirograph_callers\` / \`kirograph_callees\`: trace the call flow.
4. \`kirograph_impact\`: check blast radius before editing.`;
  } else {
    bugFixWorkflow += `
3. \`kirograph_impact\`: check blast radius before editing.`;
  }

  // Build workflows section
  let workflows = `

---

## Workflows

${bugFixWorkflow}`;

  if (enableCodeHealth) {
    workflows += `

**Refactor planning:**
1. \`kirograph_hotspots\`: identify the most-connected symbols; changing these is risky.
2. \`kirograph_surprising\`: surface hidden coupling that will break.
3. \`kirograph_impact\` on specific targets: confirm blast radius.
4. \`kirograph_diff\` after the refactor: verify the structural change matches intent.`;
  }

  if (enableArchitecture) {
    workflows += `

**Architectural review:**
1. \`kirograph_architecture\`: get the package and layer map.
2. \`kirograph_coupling\`: find the most stable (high Ca) and most volatile (high instability) packages.
3. \`kirograph_package\`: drill into any package of interest.
4. \`kirograph_circular_deps\`: check for import cycles.`;
  }

  if (enableCodeHealth) {
    workflows += `

**Code cleanup:**
1. \`kirograph_dead_code\`: find unreferenced unexported symbols.
2. \`kirograph_circular_deps\`: find import cycles to untangle.
3. \`kirograph_surprising\`: find unexpected coupling to decouple.`;
  }

  if (enableComplexity) {
    workflows += `

**Code quality audit:**
1. \`kirograph_health\`: get overall health score and breakdown.
2. \`kirograph_complexity\`: rank functions by cyclomatic complexity — focus on CC > 10.
3. \`kirograph_test_risk\`: find highest-risk functions (complexity × fan-in) to prioritize test coverage.
4. \`kirograph_dsm\`: check architectural coupling — high off-diagonal counts = tight coupling.`;
  }

  if (enableGitContext) {
    workflows += `

**Pre-commit / pre-push review:**
1. \`kirograph_diff_context\`: understand what symbols changed and who calls them.
2. \`kirograph_test_map\`: verify changed symbols have test coverage.
3. \`kirograph_commit_context\`: build a structured commit message.

**PR description:**
1. \`kirograph_pr_context(base: "main")\`: get semantic diff between branches.
2. Use the output as structured context for the PR summary.`;
  }

  if (enableEditPrimitives) {
    workflows += `

**Safe atomic edit:**
1. \`kirograph_impact\`: check blast radius before editing.
2. \`kirograph_str_replace\` or \`kirograph_insert_at\`: apply atomic change — validates uniqueness first.
3. After edit: \`kirograph_diff\` to verify only intended symbols changed.`;
  }

  if (enableBranch) {
    workflows += `

**Cross-branch investigation:**
1. \`kirograph_branch_list\`: see which branches are tracked.
2. \`kirograph_branch_diff\`: find symbols added/removed/changed vs target branch.
3. \`kirograph_branch_search\`: locate a symbol in another branch's graph.`;
  }

  // Workflow steering files require at least navigation/call-sites/code-health to be useful
  const hasRichFeatures = enableNavigation || enableCodeHealth || trackCallSites;

  // Build workflow steering rows
  const workflowRows: string[] = [
    ...(enableSecurity ? ['| security audit, check vulnerabilities, CVE review | `.kiro/steering/kirograph-security.md` |'] : []),
    ...(hasRichFeatures ? ['| code review, review this PR | `.kiro/steering/kirograph-review.md` |'] : []),
    ...(hasRichFeatures ? ['| debug, trace this bug, root cause | `.kiro/steering/kirograph-debug.md` |'] : []),
    ...(enableArchitecture ? ['| architecture, understand structure, package map | `.kiro/steering/kirograph-architecture.md` |'] : []),
    ...(hasRichFeatures ? ['| onboard, understand this codebase | `.kiro/steering/kirograph-onboard.md` |'] : []),
    ...(hasRichFeatures ? ['| refactor, rename, safe refactoring | `.kiro/steering/kirograph-refactor.md` |'] : []),
    ...(enableGitContext ? ['| git diff review, PR context, commit message | `.kiro/steering/kirograph-git-context.md` |'] : []),
    ...(enableComplexity ? ['| code quality audit, complexity, health score | `.kiro/steering/kirograph-complexity.md` |'] : []),
    ...(enableMemory ? ['| memory, recall decisions, conflict detection | `.kiro/steering/kirograph-mem-workflow.md` |'] : []),
    ...(enableWiki ? ['| wiki, update knowledge base, ingest docs | `.kiro/steering/kirograph-wiki-workflow.md` |'] : []),
  ];

  const workflowSection = `

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
${workflowRows.join('\n')}

Each file contains numbered steps, exact tool calls, and an interpretation reference. Follow the steps in order.

---

## If \`.kirograph/\` does NOT exist

Ask the user: "This project doesn't have KiroGraph initialized. Run \`kirograph init -i\` to build a code knowledge graph for faster exploration?"`;

  // Compose the full content
  let content = `---
inclusion: always
---

# KiroGraph

KiroGraph builds a semantic knowledge graph of your codebase. Use its MCP tools instead of grep/glob/file reads whenever \`.kirograph/\` exists in the project.

## Quick decision guide

| Question | Tool |
|----------|------|
${guideRows.join('\n')}

---
${toolRef}
${workflows}
${workflowSection}
`;

  // Insert compression section before the "If .kirograph/ does NOT exist" section
  if (enableCompression && shellCompressionLevel !== 'off') {
    const section = buildCompressionSection(shellCompressionLevel as 'normal' | 'aggressive' | 'ultra');
    content = content.replace(
      '---\n\n## If `.kirograph/` does NOT exist',
      section.trim() + '\n\n---\n\n## If `.kirograph/` does NOT exist',
    );
  }

  const caveman = cavemanMode && cavemanMode !== 'off' ? CAVEMAN_RULES[cavemanMode] : null;
  if (caveman) {
    content = content.trimEnd() + '\n\n' + caveman + '\n';
  }

  // Memory section
  if (enableMemory) {
    const memorySection = `
## Memory

KiroGraph has persistent memory. Use it to recall past decisions and store new ones.

| Question | Tool |
|----------|------|
| What did we decide about X? | \`kirograph_mem_search\` |
| Store a decision / bug fix / pattern | \`kirograph_mem_store\` |
| Does this contradict something stored? | \`kirograph_mem_conflicts_scan\` |
| Two observations conflict — which wins? | \`kirograph_mem_compare\` → \`kirograph_mem_judge\` |
| Extract observations from structured text | \`kirograph_mem_capture\` |
| Which observations need re-evaluation? | \`kirograph_mem_review\` |
| Mark an observation as still valid | \`kirograph_mem_mark_reviewed\` |

Memory is searchable via hybrid FTS + vector search. Observations surface automatically in
\`kirograph_context\` and \`kirograph_impact\` results when linked to relevant code symbols.

**When to store:** After fixing a bug, making an architecture decision, discovering a pattern,
or learning something future sessions should know. One fact per store call. A hook reminds you
at session end.

**topicKey:** Use a stable semantic key (e.g. \`"architecture/auth-model"\`) when storing a
decision that may be superseded or revisited. Lets you address the same concept across sessions.

**reviewAfter:** Pass an epoch-ms timestamp when an observation should expire or be re-evaluated
(e.g. after a planned migration, a library upgrade, or a time-boxed experiment).

For the full conflict-detection workflow, load: \`.kiro/steering/kirograph-mem-workflow.md\`
`;
    content = content.trimEnd() + '\n\n' + memorySection.trim() + '\n';
  }

  // Documentation section
  if (enableDocs) {
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
  if (enableData) {
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

  // Patterns section
  if (enablePatterns) {
    const patternsSection = `
## Pattern Matching

KiroGraph can search for structural code patterns using @ast-grep/napi.

**Available tools (only when enablePatterns: true and @ast-grep/napi installed):**
- \`kirograph_live_search\` — search for any AST pattern across the codebase at query time

**CLI commands:**
- \`kirograph pattern "<pattern>"\` — live structural search
- \`kirograph pattern --list\` — browse bundled SAST rules
- \`kirograph pattern --library <id>\` — run a specific library rule

**When to use:** When you need to find code patterns that can't be expressed as symbol names or semantic queries — "all eval() calls", "all SQL string concatenation", "all readFile with request parameters".
`;
    content = content.trimEnd() + '\n\n' + patternsSection.trim() + '\n';
  }

  // General compression section
  if (enableGeneralCompression) {
    const generalCompressionSection = `
## General-purpose compression

\`kirograph_compress\` is an on-demand tool for reducing token usage before content reaches the model.
Call it whenever you receive large input that you need to reason over but not reproduce verbatim.

**Two engines — auto-routed by the \`command\` parameter:**

| Scenario | Call |
|----------|------|
| Paste of shell output (git log, npm install, test run, docker ps…) | \`kirograph_compress(text: "...", command: "git log")\` |
| Prose text, RAG chunk, observation, or mixed content | \`kirograph_compress(text: "...")\` |

- **With \`command\`:** rtk-style structural filters — pattern-matched to the command family (git, test, lint, docker, etc.), removes noise, deduplicates repeated lines, keeps structure.
- **Without \`command\`:** caveman grammar — removes filler words, articles, hedging phrases, and (at ultra level) applies standard abbreviations. Preserves code blocks, paths, URLs, and identifiers unchanged.

**Compression levels** (same enum for both engines):
- \`lite\` / \`normal\` — light touch: remove noise and filler only
- \`full\` / \`aggressive\` — default: also remove articles, hedging, group repeated output
- \`ultra\` — maximum: abbreviations, causality arrows (→), conjunction compression (+)

**When to use:**
- You received a large file diff, log dump, or search result and only need the structure
- You want to store an observation in memory and the text is verbose
- A tool output is close to or over budget and you need to trim before reasoning

**When NOT to use:**
- Content that must be reproduced exactly (code to be written to disk, user quotes)
- Short content (< 200 tokens) — overhead not worth it
- Already-compressed output (kirograph_exec already applies rtk filters automatically)

**Savings are reported inline:** \`[42% saved | 1800→1044 | rtk:git:aggressive]\`
`;
    content = content.trimEnd() + '\n\n' + generalCompressionSection.trim() + '\n';
  }

  // Wiki section
  if (enableWiki) {
    const wikiSection = `
## Wiki

KiroGraph maintains a structured LLM wiki — a set of markdown pages that compound knowledge
across sessions. Use it to look up project decisions, architecture facts, and domain knowledge
before starting work. Use it to save knowledge that should survive context resets.

**Available tools:**
- \`kirograph_wiki_ingest\` — build an ingest prompt for a source text; pass the result to yourself to generate a WIKI_DIFF
- \`kirograph_wiki_apply_diff\` — apply a WIKI_DIFF to create or update wiki pages
- \`kirograph_wiki_search\` — full-text search over wiki pages
- \`kirograph_wiki_page\` — retrieve the full content of a page by slug
- \`kirograph_wiki_list\` — list all pages with metadata
- \`kirograph_wiki_lint\` — health check: broken links, orphan pages, contradictions

**When to consult the wiki:**
- Before starting a complex feature or bug fix: \`kirograph_wiki_search(query: "<topic>")\`
- When the user references a concept you don't recognize from the code graph alone
- After \`kirograph_context\` returns wiki enrichments (pages above threshold score)

**When to update the wiki:**
- End of a session that produced durable knowledge (architecture decision, API contract, process)
- The ingest hook will remind you at agentStop if \`enableWiki: true\` is set

**Quick workflow:**
1. \`kirograph_wiki_ingest\` — get the prompt with SCHEMA + MANIFEST + your source text
2. Generate a \`WIKI_DIFF\` block (create/upsert/append per page)
3. \`kirograph_wiki_apply_diff\` — apply it; review any pending conflicts in the response
`;
    content = content.trimEnd() + '\n\n' + wikiSection.trim() + '\n';
  }

  // Security section
  if (enableSecurity) {
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
  const trackCallSites = opts?.trackCallSites ?? false;
  const enableCodeHealth = opts?.enableCodeHealth ?? false;
  const enableArchitecture = opts?.enableArchitecture ?? false;
  const enableNavigation = opts?.enableNavigation ?? false;
  const enableGitContext = opts?.enableGitContext ?? false;
  const enableComplexity = opts?.enableComplexity ?? false;
  const enableEditPrimitives = opts?.enableEditPrimitives ?? false;

  // Only write review/debug/onboard/refactor workflows when the install has meaningful tool groups.
  // Core-only (3 tools) doesn't have kirograph_impact, kirograph_files etc. that these workflows depend on.
  const hasRichFeatures = enableNavigation || enableCodeHealth || trackCallSites;

  if (hasRichFeatures) {
  // kirograph-review.md
  const reviewSteps: string[] = [
    `1. **Understand the change scope**
   \`\`\`
   kirograph_context(task: "<describe what changed>")
   \`\`\``,
  ];
  if (enableGitContext) {
    reviewSteps.push(`2. **See exactly what symbols changed**
   \`\`\`
   kirograph_diff_context(staged: true)
   \`\`\`
   Lists changed symbols, their callers (who may break), and callees (what they depend on).`);
  }
  reviewSteps.push(`${reviewSteps.length + 1}. **Analyze blast radius**
   For each key symbol that was modified:
   \`\`\`
   kirograph_impact(symbol: "<changed symbol>", depth: 2)
   \`\`\``);
  if (enableGitContext) {
    reviewSteps.push(`${reviewSteps.length + 1}. **Verify test coverage for changed symbols**
   \`\`\`
   kirograph_test_map(symbol: "<changed symbol>")
   \`\`\`
   Flag any changed symbols with no test files in their caller graph.`);
  } else if (trackCallSites) {
    reviewSteps.push(`${reviewSteps.length + 1}. **Check test coverage**
   \`\`\`
   kirograph_callers(symbol: "<changed symbol>")
   \`\`\`
   Look for test files among the callers. Flag untested changes.`);
  }
  if (enableComplexity) {
    reviewSteps.push(`${reviewSteps.length + 1}. **Check risk score of changed functions**
   \`\`\`
   kirograph_test_risk(limit: 10)
   \`\`\`
   High risk (complexity × fan-in) = extra scrutiny warranted.`);
  }
  if (enableCodeHealth) {
    reviewSteps.push(`${reviewSteps.length + 1}. **Look for surprising coupling**
   \`\`\`
   kirograph_surprising(limit: 10)
   \`\`\``);
  }
  const findingsN = reviewSteps.length + 1;
  reviewSteps.push(`${findingsN}. **Produce findings** grouped by risk level (high/medium/low) with:
   - What changed and why it matters
   - Test coverage status
   - Suggested improvements
   - Overall merge recommendation`);
  fs.writeFileSync(path.join(steeringDir, 'kirograph-review.md'), `---
inclusion: manual
---

# KiroGraph: Code Review Workflow

Follow these steps for a structured, risk-aware code review using the knowledge graph.

## Steps

${reviewSteps.join('\n\n')}
`);

  // kirograph-debug.md
  const debugSteps: string[] = [
    `1. **Find related code**
   \`\`\`
   kirograph_search(query: "<error message or symptom keywords>")
   \`\`\``,
    `2. **Get full context**
   \`\`\`
   kirograph_context(task: "<describe the bug>")
   \`\`\``,
  ];
  if (enableGitContext) {
    debugSteps.push(`3. **Check what recently changed in related symbols**
   \`\`\`
   kirograph_diff_context()
   \`\`\`
   Most bugs trace back to recent changes — this surfaces them immediately.`);
  } else if (enableCodeHealth) {
    debugSteps.push(`3. **Check what changed recently**
   \`\`\`
   kirograph_diff()
   \`\`\``);
  }
  if (trackCallSites) {
    const n = debugSteps.length + 1;
    debugSteps.push(`${n}. **Trace the call chain**
   \`\`\`
   kirograph_callers(symbol: "<suspected function>")
   kirograph_callees(symbol: "<suspected function>")
   \`\`\``);
  }
  const blastN = debugSteps.length + 1;
  debugSteps.push(`${blastN}. **Understand blast radius**
   \`\`\`
   kirograph_impact(symbol: "<root cause symbol>", depth: 3)
   \`\`\``);
  const debugTips: string[] = [];
  if (trackCallSites) debugTips.push('- Check both callers and callees to understand the full context');
  if (enableGitContext) debugTips.push('- `kirograph_diff_context` is the fastest way to spot a regression — check it first');
  else if (enableCodeHealth) debugTips.push('- Recent changes (via diff) are the most common source of new issues');
  debugTips.push('- Use `kirograph_path` to trace how two symbols are connected');
  fs.writeFileSync(path.join(steeringDir, 'kirograph-debug.md'), `---
inclusion: manual
---

# KiroGraph: Debug Workflow

Follow these steps to systematically trace and debug issues using the knowledge graph.

## Steps

${debugSteps.join('\n\n')}

## Tips
${debugTips.join('\n')}
`);

  // kirograph-onboard.md
  const onboardSteps: string[] = [
    `1. **Project overview**
   \`\`\`
   kirograph_status()
   \`\`\``,
    `2. **File structure**
   \`\`\`
   kirograph_files(format: "tree", maxDepth: 2)
   \`\`\``,
  ];
  if (enableCodeHealth) {
    onboardSteps.push(`3. **Key entry points**
   \`\`\`
   kirograph_hotspots(limit: 15)
   \`\`\``);
  }
  if (enableArchitecture) {
    const n = onboardSteps.length + 1;
    onboardSteps.push(`${n}. **Architecture layers**
   \`\`\`
   kirograph_architecture()
   \`\`\``);
  }
  const exploreN = onboardSteps.length + 1;
  onboardSteps.push(`${exploreN}. **Explore a specific area**
   \`\`\`
   kirograph_context(task: "<area you want to understand>")
   \`\`\``);
  const symbolN = onboardSteps.length + 1;
  onboardSteps.push(`${symbolN}. **Understand a key symbol**
   \`\`\`
   kirograph_node(symbol: "<symbol name>", includeCode: true)
   \`\`\``);
  const onboardTips: string[] = ['- Start broad (status, files) then narrow down'];
  if (enableCodeHealth) onboardTips[0] = '- Start broad (status, files, hotspots) then narrow down';
  if (enableCodeHealth) onboardTips.push('- Use `kirograph_type_hierarchy` to understand inheritance patterns');
  if (trackCallSites) onboardTips.push('- Use `kirograph_callees` on entry points to trace execution flow');
  fs.writeFileSync(path.join(steeringDir, 'kirograph-onboard.md'), `---
inclusion: manual
---

# KiroGraph: Onboarding Workflow

Follow these steps to quickly understand a new codebase.

## Steps

${onboardSteps.join('\n\n')}

## Tips
${onboardTips.join('\n')}
`);

  // kirograph-refactor.md
  const refactorSteps: string[] = [
    `1. **Understand what you're changing**
   \`\`\`
   kirograph_node(symbol: "<target symbol>", includeCode: true)
   \`\`\``,
    `2. **Check blast radius**
   \`\`\`
   kirograph_impact(symbol: "<target symbol>", depth: 3)
   \`\`\``,
  ];
  if (trackCallSites) {
    refactorSteps.push(`3. **Find all callers (rename preview)**
   \`\`\`
   kirograph_callers(symbol: "<target symbol>", limit: 50)
   \`\`\``);
  }
  if (enableCodeHealth) {
    let n = refactorSteps.length + 1;
    refactorSteps.push(`${n}. **Check for cycles that might complicate the refactor**
   \`\`\`
   kirograph_circular_deps()
   \`\`\``);
    n++;
    refactorSteps.push(`${n}. **Find dead code to clean up**
   \`\`\`
   kirograph_dead_code(limit: 30)
   \`\`\``);
    n++;
    refactorSteps.push(`${n}. **Verify after changes**
   Run \`kirograph sync\` then:
   \`\`\`
   kirograph_diff()
   \`\`\``);
  }
  const refactorChecks: string[] = ['- Always check `kirograph_impact` before major refactors'];
  if (trackCallSites) refactorChecks.push('- Use `kirograph_callers` as a rename preview (all locations that reference the symbol)');
  if (enableCodeHealth) refactorChecks.push('- After changes, use `kirograph_diff` to verify only intended symbols changed');
  if (enableEditPrimitives) refactorChecks.push('- Use `kirograph_str_replace` / `kirograph_multi_str_replace` for atomic edits that auto-sync the graph');
  fs.writeFileSync(path.join(steeringDir, 'kirograph-refactor.md'), `---
inclusion: manual
---

# KiroGraph: Refactoring Workflow

Follow these steps to plan and execute safe refactoring.

## Steps

${refactorSteps.join('\n\n')}

## Safety Checks
${refactorChecks.join('\n')}
`);

  } // end hasRichFeatures

  // kirograph-architecture.md only when enableArchitecture is true
  if (enableArchitecture) {
    const archSteps: string[] = [
      `1. **Get project overview**
   \`\`\`
   kirograph_status()
   \`\`\``,
      `2. **View architecture**
   \`\`\`
   kirograph_architecture()
   \`\`\``,
      `3. **Check coupling health**
   \`\`\`
   kirograph_coupling(sortBy: "instability")
   \`\`\``,
    ];
    if (enableCodeHealth) {
      let n = archSteps.length + 1;
      archSteps.push(`${n}. **Find core abstractions**
   \`\`\`
   kirograph_hotspots(limit: 20)
   \`\`\``);
      n++;
      archSteps.push(`${n}. **Detect hidden dependencies**
   \`\`\`
   kirograph_surprising(limit: 15)
   \`\`\``);
      n++;
      archSteps.push(`${n}. **Check for cycles**
   \`\`\`
   kirograph_circular_deps()
   \`\`\``);
    }
    if (enableComplexity) {
      let n = archSteps.length + 1;
      archSteps.push(`${n}. **Module coupling matrix (DSM)**
   \`\`\`
   kirograph_dsm()
   \`\`\`
   High off-diagonal counts = tight coupling. Complements \`kirograph_coupling\` (package-level) with a symbol-level view.`);
      n++;
      archSteps.push(`${n}. **Overall health score**
   \`\`\`
   kirograph_health()
   \`\`\`
   The circular deps and coupling components directly reflect architectural quality.`);
    }
    const archInterpretation = [
      '- High Ca (afferent) = load-bearing, risky to change interface',
      '- High Ce (efferent) = depends on many things, safe to refactor internals',
      ...(enableCodeHealth ? ['- Surprising edges = hidden coupling that may break during refactoring'] : []),
      ...(enableComplexity ? ['- DSM diagonal = self-coupling (normal). Off-diagonal = cross-module coupling (minimize).'] : []),
      ...(enableComplexity ? ['- Health circular_score < 1500 = architectural debt requiring attention'] : []),
    ];
    fs.writeFileSync(path.join(steeringDir, 'kirograph-architecture.md'), `---
inclusion: manual
---

# KiroGraph: Architecture Exploration Workflow

Follow these steps to understand the high-level structure of the codebase.

## Steps

${archSteps.join('\n\n')}

## Interpretation
${archInterpretation.join('\n')}
`);
  }

  // Security workflow — only when enableSecurity is true
  if (opts?.enableSecurity) {
    const securityPatternsStep = opts?.enablePatterns ? `
### 5b. Structural vulnerability patterns (AST search)
\`\`\`
kirograph_live_search(pattern: "eval($X)", language: "javascript")
kirograph_live_search(pattern: "$OBJ.query($A + $B)", language: "typescript")
\`\`\`
Use \`kirograph pattern --list\` to browse bundled SAST rules (SQL injection, path traversal, hardcoded secrets, etc.).
These patterns find code issues missed by dependency scanning.` : '';

    const securityComplexityStep = enableComplexity ? `
### 5c. High-complexity code in security-critical paths
\`\`\`
kirograph_test_risk(limit: 15)
\`\`\`
High risk (complexity × fan-in) in auth/payment/session code = higher attack surface. Cross-reference with reachability results.` : '';

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
${securityPatternsStep}${securityComplexityStep}

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
| License DENY | Policy violation | Must resolve before release |${opts?.enablePatterns ? '\n| Pattern match in security-critical code | Code-level vulnerability pattern found | Review context with `kirograph_node` |' : ''}
`);
    console.log(`  ✓ Security workflow steering file written`);
  }

  // Patterns workflow — only when enablePatterns is true
  if (opts?.enablePatterns) {
    fs.writeFileSync(path.join(steeringDir, 'kirograph-patterns.md'), `---
inclusion: manual
---

# KiroGraph: Pattern Search Workflow

Use this workflow to find structural code patterns using AST matching.
Activate with \`/kirograph-patterns\` in Kiro IDE or CLI.

## Steps

### 1. Browse available rules
\`\`\`
kirograph_live_search(pattern: "--list")
\`\`\`
Or use the CLI: \`kirograph pattern --list\`

### 2. Search for a specific structural pattern
\`\`\`
kirograph_live_search(pattern: "eval($X)", language: "typescript")
\`\`\`

### 3. Run a bundled library rule
\`\`\`
kirograph pattern --library sql-injection-concat-js
\`\`\`

### 4. Add a custom rule
Create a YAML file in your \`patternLibraryPath\` directory:
\`\`\`yaml
id: my-custom-rule
language: [javascript, typescript]
severity: high
owaspCategory: A03
description: Custom pattern description
fixHint: How to fix this issue.
rule:
  pattern: dangerousFunction($ARG)
\`\`\`

## Pattern syntax examples

| Pattern | Matches |
|---------|---------|
| \`eval($X)\` | Any eval() call |
| \`$OBJ.query($A + $B)\` | String concat in any query method |
| \`fs.$F(req.$P, $$$)\` | Any fs method with request param |
| \`createHash('md5')\` | Hardcoded MD5 usage |

## Interpretation

- Findings mean the pattern was found in the AST — not a false positive from symbol name matching
- Check the surrounding context: \`kirograph_node(symbol: "...", includeCode: true)\`
- Use \`kirograph_callers\` to understand how the affected function is reached
`);
    console.log(`  ✓ Patterns workflow steering file written`);
  }

  // Wiki workflow — only when enableWiki is true
  if (opts?.enableWiki) {
    fs.writeFileSync(path.join(steeringDir, 'kirograph-wiki-workflow.md'), `---
inclusion: manual
---

# KiroGraph: Wiki Workflow

Use this workflow when you need to consult or update the project wiki.
Activate with \`/kirograph-wiki-workflow\` in Kiro IDE or read the file directly.

## When to use

- Before a complex task: look up relevant wiki pages
- After a session with durable knowledge: ingest it into the wiki
- After a source file is added: run ingest to capture its content
- Periodically: run lint to catch broken links or contradictions

## Steps

### 1. Look up existing knowledge before starting work

\`\`\`
kirograph_wiki_search(query: "<topic or keyword>")
\`\`\`

Read any relevant pages:

\`\`\`
kirograph_wiki_page(slug: "<slug from search results>")
\`\`\`

### 2. Ingest new knowledge (two-tool flow)

**a. Get the ingest prompt:**

\`\`\`
kirograph_wiki_ingest(source: "<text, notes, or paste from docs>", sourceName: "<descriptive name>")
\`\`\`

The tool returns a structured prompt containing the wiki SCHEMA, the current MANIFEST, and your source text.

**b. Generate the WIKI_DIFF:**

Pass the returned prompt to yourself. Produce a \`WIKI_DIFF_START ... WIKI_DIFF_END\` block following the schema. Each entry should have a JSON header with \`action\`, \`slug\`, \`title\`, and \`section\` (optional), followed by markdown content.

**c. Apply the diff:**

\`\`\`
kirograph_wiki_apply_diff(diff: "<the WIKI_DIFF block you generated>")
\`\`\`

Review the response for any pending conflicts and resolve them.

### 3. List all pages

\`\`\`
kirograph_wiki_list()
\`\`\`

### 4. Health check (periodic)

\`\`\`
kirograph_wiki_lint()
\`\`\`

Issues to look for:
- \`broken_link\`: a \`[[slug]]\` reference that points to a non-existent page → fix the slug or create the page
- \`orphan\`: a page with no Related section and no incoming links → add Related or merge into another page
- \`stale_source\`: a source with no date metadata → add a date to the source header
- \`contradiction\`: two pages make semantically opposite claims → resolve via ingest or manual edit

## WIKI_DIFF format reference

\`\`\`
WIKI_DIFF_START
{"action": "create", "slug": "auth-flow", "title": "Authentication Flow"}
# Authentication Flow

The login flow validates credentials via JWT...

## Related
- [[user-model]]
WIKI_DIFF_END
\`\`\`

Supported actions: \`create\`, \`upsert\` (merge into existing), \`append\` (add to specific section).

For append, include \`"section": "Known Issues"\` in the header.

## Conflict handling

If a diff contradicts an existing page, the tool reports it as a conflict:
- With \`wikiAutoResolveConflicts: true\`: the newer source wins automatically
- Without: the conflict is listed in the response — read both sides and ingest a resolution

## CLI commands

\`\`\`bash
kirograph wiki search "<query>"
kirograph wiki page <slug>
kirograph wiki list
kirograph wiki lint
kirograph wiki status
kirograph wiki reindex
\`\`\`
`);
    console.log(`  ✓ Wiki workflow steering file written`);
  }

  // Memory workflow — only when enableMemory is true
  if (opts?.enableMemory) {
    fs.writeFileSync(path.join(steeringDir, 'kirograph-mem-workflow.md'), `---
inclusion: manual
---

# KiroGraph: Memory Workflow

Use this workflow to recall past knowledge, store new observations, and keep the memory base
consistent by detecting and resolving conflicts.

## 1. Recall before acting

Before making an architecture decision or fixing a bug, search what's already known:

\`\`\`
kirograph_mem_search(query: "<topic or keywords>", kind: "decision")
kirograph_mem_search(query: "<error symptom>", kind: "error")
\`\`\`

Results include inline conflict annotations (⚡) — review them before proceeding.

## 2. Store a new observation

After a decision, bug fix, or discovery:

\`\`\`
kirograph_mem_store(
  content: "<one concise fact>",
  kind: "decision" | "error" | "pattern" | "architecture" | "note",
  topicKey: "<category/slug>",      // optional: stable semantic key for revisitable decisions
  reviewAfter: <epoch-ms>           // optional: schedule re-evaluation after a migration/upgrade
)
\`\`\`

**topicKey examples:** \`"architecture/auth-model"\`, \`"infra/db-choice"\`, \`"pattern/error-handling"\`

## 3. Capture observations from structured text

If you have a markdown block with bullet points under headings like \`## Key Learnings\` or
\`## Decisions\`, extract them all at once:

\`\`\`
kirograph_mem_capture(content: "<markdown text>", kind: "decision")
\`\`\`

## 4. Detect conflicts

After storing related observations, scan for potential contradictions:

\`\`\`
kirograph_mem_conflicts_scan(limit: 20)
\`\`\`

Returns candidate pairs ranked by similarity. Review each one.

## 5. Compare two observations

To understand if two observations conflict, are compatible, or one supersedes the other:

\`\`\`
kirograph_mem_compare(observationA: "<id or topicKey>", observationB: "<id or topicKey>")
\`\`\`

Returns both observations side by side. Read them, then judge.

## 6. Judge a relation

\`\`\`
kirograph_mem_judge(
  relationId: "<id>",
  relation: "supersedes" | "conflicts_with" | "compatible" | "scoped" | "related" | "not_conflict",
  confidence: 0.0–1.0,
  reason: "<why>"
)
\`\`\`

Use \`supersedes\` when a newer decision replaces an older one. Use \`not_conflict\` to dismiss
false positives so they don't reappear in scans.

## 7. Review stale observations

Find observations scheduled for re-evaluation:

\`\`\`
kirograph_mem_review(limit: 20)
\`\`\`

For each: verify it's still accurate. If valid, mark it reviewed:

\`\`\`
kirograph_mem_mark_reviewed(id: "<observation-id>")
\`\`\`

If outdated, store a new observation with the correct information and judge the old one as
superseded via \`kirograph_mem_judge\`.

## Quick reference

| Situation | Action |
|-----------|--------|
| About to make a decision | \`mem_search\` first |
| Made a decision | \`mem_store\` with \`kind: "decision"\` and \`topicKey\` |
| Fixed a non-obvious bug | \`mem_store\` with \`kind: "error"\` |
| Two things seem to contradict | \`mem_compare\` → \`mem_judge\` |
| Knowledge base getting stale | \`mem_review\` → \`mem_mark_reviewed\` |
| Structured notes to extract | \`mem_capture\` |
| Regular conflict hygiene | \`mem_conflicts_scan\` |
`);
    console.log(`  ✓ Memory workflow steering file written`);
  }

  // kirograph-git-context.md — only when enableGitContext is true
  if (enableGitContext) {
    fs.writeFileSync(path.join(steeringDir, 'kirograph-git-context.md'), `---
inclusion: manual
---

# KiroGraph: Git Context Workflow

Use this workflow for pre-commit reviews, PR descriptions, and understanding what changed.

## 1. Before committing — understand what you changed

\`\`\`
kirograph_diff_context()              // unstaged — see what's touched
kirograph_diff_context(staged: true)  // staged — final check before commit
\`\`\`

This shows changed symbols, their callers (who might break), and their callees (what they call).

## 2. Build commit message context

\`\`\`
kirograph_commit_context()
\`\`\`

Returns staged files, diff stat, and affected symbols. Feed into commit message generation.

## 3. Check test coverage for changed symbols

\`\`\`
kirograph_test_map()                          // all symbols with no test coverage
kirograph_test_map(symbol: "<changed fn>")    // tests for a specific symbol
\`\`\`

## 4. PR description

\`\`\`
kirograph_pr_context(base: "main", head: "HEAD")
\`\`\`

Returns symbols added/removed/changed between refs. Use as structured context for PR summary.

## 5. Coverage report (if lcov/Istanbul files exist)

\`\`\`
kirograph_test_coverage()                    // worst-covered files first
kirograph_test_coverage(sortBy: "desc")      // best-covered files first
\`\`\`

## Quick reference

| Intent | Tool |
|--------|------|
| What did I change? | \`kirograph_diff_context\` |
| Commit message | \`kirograph_commit_context\` |
| PR description | \`kirograph_pr_context\` |
| Are my changes tested? | \`kirograph_test_map\` |
| Per-file coverage % | \`kirograph_test_coverage\` |
| Semantic changelog | \`kirograph_changelog\` |
`);
    console.log(`  ✓ Git context workflow steering file written`);
  }

  // kirograph-complexity.md — only when enableComplexity is true
  if (enableComplexity) {
    fs.writeFileSync(path.join(steeringDir, 'kirograph-complexity.md'), `---
inclusion: manual
---

# KiroGraph: Code Quality Workflow

Use this workflow to audit code quality, find high-risk functions, and track health over time.

## 1. Get an overall health score

\`\`\`
kirograph_health()
\`\`\`

Returns a 0–10000 score across complexity, dead code, coupling, and circular dependencies.
Check all four components — a high total can mask one very low component.

## 2. Find complex functions

\`\`\`
kirograph_complexity(metric: "cyclomatic", threshold: 10)
kirograph_complexity(metric: "maintainability")  // lowest MI first — most unmaintainable
\`\`\`

**Thresholds:** CC > 10 = review candidate. CC > 20 = refactor. MI < 50 = unmaintainable.

## 3. Find highest-risk functions to change

\`\`\`
kirograph_test_risk(limit: 20)
\`\`\`

Risk = complexity × fan-in. These functions will have the widest blast radius if they break.

## 4. Check architectural coupling

\`\`\`
kirograph_dsm()
\`\`\`

High off-diagonal counts = tight coupling. Aim for low counts outside the diagonal.

## 5. Scan for simplification candidates

\`\`\`
kirograph_simplify_scan()
\`\`\`

Lists functions that fail on CC, MI, or LOC thresholds.

## Quick reference

| Intent | Tool |
|--------|------|
| Overall health | \`kirograph_health\` |
| Most complex functions | \`kirograph_complexity\` |
| Highest-risk to change | \`kirograph_test_risk\` |
| Module coupling matrix | \`kirograph_dsm\` |
| Simplification candidates | \`kirograph_simplify_scan\` |
`);
    console.log(`  ✓ Complexity workflow steering file written`);
  }

  const written: string[] = [];
  if (hasRichFeatures) written.push('review', 'debug', 'onboard', 'refactor');
  if (opts?.enableArchitecture) written.push('architecture');
  if (opts?.enableSecurity) written.push('security');
  if (opts?.enablePatterns) written.push('patterns');
  if (enableGitContext) written.push('git-context');
  if (enableComplexity) written.push('complexity');
  if (opts?.enableMemory) written.push('memory');
  if (opts?.enableWiki) written.push('wiki');
  if (written.length > 0) {
    console.log(`  ✓ Workflow steering files written (${written.join(', ')})`);
  }
}
