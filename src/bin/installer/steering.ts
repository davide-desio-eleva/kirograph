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

## Output Compression (\\\`kirograph_exec\\\`)

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

Use \\\`kirograph_gain\\\` to check token savings statistics.`;
}

export interface SteeringOptions {
  cavemanMode?: CavemanMode | 'off';
  enableCompression?: boolean;
  compressionLevel?: 'off' | 'normal' | 'aggressive' | 'ultra';
}

function buildSteeringContent(opts?: SteeringOptions): string {
  const cavemanMode = opts?.cavemanMode;
  const enableCompression = opts?.enableCompression !== false && opts?.compressionLevel !== 'off';
  const compressionLevel = opts?.compressionLevel ?? 'normal';

  let content = STEERING_CONTENT;

  // Insert compression section before the "If .kirograph/ does NOT exist" section
  if (enableCompression && compressionLevel !== 'off') {
    const section = buildCompressionSection(compressionLevel as 'normal' | 'aggressive' | 'ultra');
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

  const caveman = cavemanMode && cavemanMode !== 'off' ? CAVEMAN_RULES[cavemanMode] : null;
  if (caveman) {
    content = content.trimEnd() + '\n\n' + caveman + '\n';
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
}
