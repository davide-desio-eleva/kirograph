import { CAVEMAN_RULES, CavemanMode } from './caveman';

export interface InstructionOptions {
  cavemanMode?: CavemanMode | 'off';
  shellCompressionLevel?: 'off' | 'normal' | 'aggressive' | 'ultra';
  enableMemory?: boolean;
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
  const enableMemory = opts.enableMemory ?? false;

  let content = `# KiroGraph

KiroGraph builds a local semantic knowledge graph of this codebase. When the \`kirograph\` MCP server is available, prefer its tools over broad grep/glob/file-read exploration.

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
${enableCompression ? '| Run a command with token savings | `kirograph_exec` |\n| Check token savings stats | `kirograph_gain` |\n' : ''}${enableMemory ? '| Search past decisions/patterns | `kirograph_mem_search` |\n| Store an observation | `kirograph_mem_store` |\n' : ''}
## Tool selection

- Start code tasks with \`kirograph_context\`.
- Find symbols by name with \`kirograph_search\`.
- Inspect a symbol with \`kirograph_node\`; set \`includeCode: true\` only when source is needed.
- Trace call flow with \`kirograph_callers\` and \`kirograph_callees\`.
- Check blast radius before edits with \`kirograph_impact\`.
- Use \`kirograph_path\` to explain how two symbols connect.
- Use \`kirograph_type_hierarchy\` for inheritance/interface questions.
- Use \`kirograph_files\` to inspect indexed file structure.
- Use \`kirograph_status\` if results seem stale or incomplete.
- Use \`kirograph_architecture\`, \`kirograph_coupling\`, and \`kirograph_package\` for package/layer questions when architecture analysis is enabled.
- Use \`kirograph_hotspots\`, \`kirograph_surprising\`, and \`kirograph_diff\` for refactor planning and review.

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

  // Caveman mode
  const caveman = cavemanMode && cavemanMode !== 'off' ? CAVEMAN_RULES[cavemanMode] : null;
  if (caveman) {
    content = content.trimEnd() + '\n\n' + caveman + '\n';
  }

  return content;
}
