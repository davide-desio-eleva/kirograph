import { Command } from 'commander';
import { printBanner } from '../banner';

type CommandEntry = { name: string; args?: string; desc: string; opts?: string[] };
type Group = { icon: string; title: string; commands: CommandEntry[]; examples: [string, string][] };

const c = {
  reset:        '\x1b[0m',
  bold:         '\x1b[1m',
  dim:          '\x1b[2m',
  violet:       '\x1b[38;5;99m',
  purple:       '\x1b[38;5;135m',
  lavender:     '\x1b[38;5;141m',
  paleLavender: '\x1b[38;5;183m',
  gray:         '\x1b[90m',
  brown:        '\x1b[38;5;130m',
  green:        '\x1b[32m',
  cyan:         '\x1b[36m',
  underline:    '\x1b[4m',
};

const GROUPS: Group[] = [
  {
    icon: '🔧', title: 'Setup',
    commands: [
      { name: 'install',       desc: 'Wire up MCP/instructions for an agent workspace', opts: ['--target <t>  kiro | cursor | claude | windsurf | ...', 'Kiro install: prompts to import global hooks'] },
      { name: 'init',          args: '[path]', desc: 'Initialize KiroGraph in a project', opts: ['-i, --index  Index immediately after init'] },
      { name: 'uninit',        args: '[path]', desc: 'Remove KiroGraph from a project',   opts: ['--force      Skip confirmation', '--target <t>  Target to clean up (or "all")'] },
      { name: 'hook',          desc: 'Manage global Kiro hooks in ~/.kirograph/hooks/', opts: ['save [path]    Save workspace hooks to global store', 'import [path]  Import global hooks into workspace', 'list           List saved global hooks', '--all          Save or import all without prompting (save/import)'] },
      { name: 'doctor',        args: '[path]', desc: 'Health check: index, config, hooks, and permissions', opts: ['--fix  Auto-repair fixable issues'] },
    ],
    examples: [
      ['kirograph install', 'Wire up Kiro MCP + hooks + steering'],
      ['kirograph install --target claude', 'Wire up Claude Code MCP + project memory'],
      ['kirograph init --index', 'Init and immediately index'],
      ['kirograph hook save', 'Save workspace hooks to your global library'],
      ['kirograph hook import', 'Import global hooks into this project'],
      ['kirograph doctor --fix', 'Check and auto-repair installation issues'],
    ],
  },
  {
    icon: '📦', title: 'Indexing',
    commands: [
      { name: 'index',         args: '[path]', desc: 'Full re-index of a project',             opts: ['--force     Force re-index all files'] },
      { name: 'sync',          args: '[path]', desc: 'Incremental sync of changed files',       opts: ['--files <f> Specific files to sync'] },
      { name: 'sync-if-dirty', args: '[path]', desc: 'Sync only if a dirty marker is present', opts: ['-q, --quiet  Suppress output'] },
      { name: 'mark-dirty',    args: '[path]', desc: 'Write a dirty marker for deferred sync' },
      { name: 'unlock',        args: '[path]', desc: 'Force-release a stale lock file' },
    ],
    examples: [
      ['kirograph sync', 'Incremental sync of changed files'],
      ['kirograph index --force', 'Force full re-index'],
    ],
  },
  {
    icon: '🔍', title: 'Search',
    commands: [
      { name: 'status',   args: '[path]',    desc: 'Show index statistics and health' },
      { name: 'query',    args: '<search>',  desc: 'Search for symbols by name',                        opts: ['--kind <k>   Filter by kind', '--limit <n>  Max results'] },
      { name: 'context',  args: '<task>',    desc: 'Build relevant code context for a task',            opts: ['--max-nodes <n>  Max symbols', '--no-code  Exclude code', '--format <f>  markdown | json'] },
      { name: 'files',    args: '[path]',    desc: 'Show project file structure',                        opts: ['--format <f>  tree | flat | grouped | compact', '--filter <p>  Directory prefix', '--pattern <g>  Glob'] },
      { name: 'path',     args: '<from> <to>', desc: 'Shortest dependency path between two symbols' },
      { name: 'affected', args: '[files...]', desc: 'Find test files affected by changed source files', opts: ['--stdin  Read from stdin', '-d <n>  Depth', '-q  Quiet'] },
      { name: 'callers',  args: '<symbol>',  desc: 'List symbols that call a given function or method', opts: ['--limit <n>  Max results'] },
      { name: 'callees',  args: '<symbol>',  desc: 'List symbols called by a given function or method', opts: ['--limit <n>  Max results'] },
      { name: 'impact',   args: '<symbol>',  desc: 'Show symbols affected by changing a given symbol',  opts: ['-d, --depth <n>  Max traversal depth'] },
    ],
    examples: [
      ['kirograph query useState', 'Find symbols named useState'],
      ['kirograph context "add dark mode"', 'Get context for a task'],
      ['kirograph callers parseToken', 'Who calls parseToken?'],
      ['kirograph callees handleRequest', 'What does handleRequest call?'],
      ['kirograph impact UserService', 'What breaks if UserService changes?'],
      ['git diff --name-only | kirograph affected --stdin', 'Affected tests from git diff'],
    ],
  },
  {
    icon: '📊', title: 'Insights',
    commands: [
      { name: 'hotspots',          args: '[path]', desc: 'Most-connected symbols by edge degree',           opts: ['--limit <n>  Max results', '--format <f>  table | json'] },
      { name: 'surprising',        args: '[path]', desc: 'Non-obvious cross-file connections',              opts: ['--limit <n>  Max results'] },
      { name: 'dead-code',         args: '[path]', desc: 'Unreferenced unexported symbols',                 opts: ['--limit <n>  Max results'] },
      { name: 'circular-deps',     args: '[path]', desc: 'Find circular dependency cycles',                 opts: ['-j, --json  JSON output'] },
      { name: 'largest',           args: '[path]', desc: 'Symbols ranked by lines of code',                 opts: ['--limit <n>  Max results'] },
      { name: 'rank',              args: '[path]', desc: 'Symbols ranked by fan-in or fan-out edge count',  opts: ['--by <by>  fan-in | fan-out'] },
      { name: 'distribution',      args: '[dir]',  desc: 'Symbol-kind breakdown per file or directory',     opts: ['--limit <n>  Max results'] },
      { name: 'god-class',         args: '[path]', desc: 'Classes ranked by member count (god-class risk)', opts: ['--limit <n>  Max results'] },
      { name: 'gini',              args: '[path]', desc: 'Gini inequality coefficient of a metric',         opts: ['--metric <m>  loc | fan-in | fan-out'] },
      { name: 'snapshot',          desc: 'Save/list/diff graph snapshots',                                  opts: ['save [label]', 'list', 'diff [label]  --format summary|full|json'] },
      { name: 'export',            desc: 'Interactive graph dashboard',                                     opts: ['build [path]  Generate HTML', 'start [path]  Generate and open'] },
    ],
    examples: [
      ['kirograph hotspots --limit 10', 'Top 10 most-connected symbols'],
      ['kirograph circular-deps', 'Find all circular dependency cycles'],
      ['kirograph largest --limit 20', 'Biggest functions by LOC'],
      ['kirograph god-class', 'Find potential god classes'],
      ['kirograph snapshot save pre-refactor', 'Save before a refactor'],
      ['kirograph export start', 'Open the graph dashboard'],
    ],
  },
  {
    icon: '🏛️', title: 'Architecture',
    commands: [
      { name: 'architecture',    args: '[path]',   desc: 'Package graph and layer map',                                opts: ['--packages  Packages only', '--layers  Layers only'] },
      { name: 'coupling',        args: '[path]',   desc: 'Coupling metrics per package',                              opts: ['--sort <s>  instability | ca | ce | name', '--package <n>  Detail view'] },
      { name: 'package',         args: '<name>',   desc: 'Inspect a package',                                         opts: ['--no-files  Omit file list'] },
      { name: 'type-hierarchy',  args: '<symbol>', desc: 'Traverse base/derived types of a class or interface',       opts: ['--direction <dir>  up | down | both'] },
      { name: 'communities',     args: '[path]',   desc: 'Detect code communities (clusters of related symbols)' },
      { name: 'manifest',        args: '[path]',   desc: 'Workspace manifest: packages, versions, licenses, version drift' },
    ],
    examples: [
      ['kirograph architecture --packages', 'List all detected packages'],
      ['kirograph coupling --sort instability', 'Packages ranked by instability'],
      ['kirograph type-hierarchy UserRepository --direction up', 'What interfaces does this implement?'],
      ['kirograph communities', 'Find tightly coupled clusters'],
      ['kirograph manifest', 'Show all dependency versions and drift'],
    ],
  },
  {
    icon: '🏥', title: 'Code Health',
    commands: [
      { name: 'module-api',         args: '[path]',          desc: 'List all exported symbols in a file or directory',                  opts: ['--limit <n>  Max results'] },
      { name: 'rename-preview',     args: '<symbol>',        desc: 'Show all reference sites for a symbol before renaming',            opts: ['--limit <n>  Max results'] },
      { name: 'doc-coverage',       args: '[path]',          desc: 'Find exported symbols missing docstrings',                         opts: ['--limit <n>  Max results'] },
      { name: 'inheritance-depth',  args: '[path]',          desc: 'Find deepest inheritance chains',                                  opts: ['--limit <n>  Max results'] },
      { name: 'recursion',          args: '[path]',          desc: 'Find recursive and mutually-recursive functions',                  opts: ['--limit <n>  Max results'] },
      { name: 'annotations',        args: '[path]',          desc: 'Decorator/attribute histogram across the codebase',               opts: ['--decorator <name>  Filter by name'] },
      { name: 'unused-imports',     args: '[path]',          desc: 'Find import nodes with zero resolved downstream edges',           opts: ['--limit <n>  Max results'] },
      { name: 'dependency-depth',   args: '[path]',          desc: 'Topological depth of each file in the import graph',             opts: ['--limit <n>  Max files'] },
      { name: 'session',            desc: 'Save or compare session baselines for tracking changes',                                   opts: ['start  Start a session baseline', 'end    Compare current state to baseline'] },
      { name: 'refactor',           desc: 'Refactoring tools: rename preview and community-driven suggestions',                       opts: ['rename <symbol>  Preview rename locations', 'suggest  Get refactoring suggestions'] },
    ],
    examples: [
      ['kirograph module-api src/auth', 'List public API of the auth module'],
      ['kirograph rename-preview handleLogin', 'Find all sites before renaming'],
      ['kirograph doc-coverage', 'Find undocumented exports'],
      ['kirograph unused-imports', 'Find dead import statements'],
      ['kirograph session start && <edit> && kirograph session end', 'Diff graph before and after a change'],
    ],
  },
  {
    icon: '🔬', title: 'Analysis',
    commands: [
      { name: 'complexity',      args: '[path]', desc: 'Rank functions by cyclomatic, cognitive, and maintainability score', opts: ['--limit <n>  Max results'] },
      { name: 'simplify-scan',   args: '[path]', desc: 'Find candidates for simplification by complexity and dead code',    opts: ['--limit <n>  Max results'] },
      { name: 'health',          args: '[path]', desc: 'Composite codebase health score (0-10000) with grade' },
      { name: 'dsm',             args: '[path]', desc: 'Design Structure Matrix — detect strongly coupled module groups',   opts: ['--limit <n>  Max groups'] },
      { name: 'test-risk',       args: '[path]', desc: 'Rank untested code by risk score (complexity × fan-in)',           opts: ['--limit <n>  Max results'] },
      { name: 'test-coverage',   args: '[path]', desc: 'Show test coverage gaps from lcov/Istanbul reports',              opts: ['--sort <order>  asc (worst first) | desc'] },
    ],
    examples: [
      ['kirograph health', 'Get overall health score and grade'],
      ['kirograph complexity --limit 10', 'Top 10 most complex functions'],
      ['kirograph test-risk', 'Which untested code is highest risk?'],
      ['kirograph test-coverage', 'Show worst-covered files first'],
      ['kirograph dsm', 'Find tightly coupled module groups'],
    ],
  },
  {
    icon: '🌿', title: 'Git',
    commands: [
      { name: 'diff-context',    args: '[path]',           desc: 'Changed symbols, their callers/callees, and affected tests', opts: ['--staged  Use staged changes only'] },
      { name: 'commit-context',  args: '[path]',           desc: 'Structured summary of staged changes for a commit message' },
      { name: 'pr-context',      args: '<base> [head]',    desc: 'Semantic diff between two git refs for PR descriptions',    opts: ['--format <fmt>  text | json'] },
      { name: 'changelog',       args: '<ref1> <ref2>',    desc: 'Human-readable semantic diff between two git refs' },
      { name: 'test-map',        args: '[symbol]',         desc: 'Map symbols to test files; show uncovered symbols',         opts: ['--limit <n>  Max results'] },
    ],
    examples: [
      ['kirograph diff-context --staged', 'What does my staged diff actually change?'],
      ['kirograph commit-context', 'Generate a structured commit message draft'],
      ['kirograph pr-context main', 'Semantic PR description vs main'],
      ['kirograph changelog v1.0 v1.1', 'What changed between two tags?'],
      ['kirograph test-map', 'Which symbols have no test coverage?'],
    ],
  },
  {
    icon: '✏️', title: 'Edit',
    commands: [
      { name: 'str-replace',   args: '<file> <old> <new>', desc: 'Replace unique string anchor in a file; fails on 0 or >1 matches' },
      { name: 'multi-replace', args: '<file> <pairs-json>', desc: 'Multiple string replacements as an all-or-nothing transaction' },
      { name: 'insert-at',     args: '<file> <anchor> <content>', desc: 'Insert content before or after an anchor or line number', opts: ['--after  Insert after anchor', '--line  Treat anchor as line number'] },
      { name: 'ast-rewrite',   args: '<file> <pattern> <rewrite>', desc: 'Structural rewrite via ast-grep (requires ast-grep on PATH)' },
    ],
    examples: [
      ['kirograph str-replace auth.ts "return null" "return undefined"', 'Safe replace a unique string'],
      ['kirograph insert-at server.ts "app.listen" "app.use(logger());" --before', 'Insert before a line'],
      ['kirograph ast-rewrite src/api.ts "console.log($MSG)" "logger.debug($MSG)"', 'Structural rewrite'],
    ],
  },
  {
    icon: '🌲', title: 'Branch',
    commands: [
      { name: 'branch list',          desc: 'List tracked branches with size and last-sync time' },
      { name: 'branch add',           args: '[name]', desc: 'Start tracking a branch (copies current index)' },
      { name: 'branch remove',        args: '<name>', desc: 'Stop tracking a branch and delete its DB' },
      { name: 'branch gc',            desc: 'Remove DBs for branches that no longer exist in git' },
      { name: 'branch diff',          args: '<a> <b>', desc: 'Symbol diff between two tracked branch DBs' },
      { name: 'branch search',        args: '<name> <query>', desc: 'Search symbols in a branch DB without switching' },
    ],
    examples: [
      ['kirograph branch list', 'See all tracked branches'],
      ['kirograph branch add feature/auth', 'Track the auth branch'],
      ['kirograph branch diff main feature/auth', 'What symbols changed?'],
      ['kirograph branch search feature/auth "handleLogin"', 'Search in branch without switching'],
      ['kirograph branch gc', 'Clean up deleted branches'],
    ],
  },
  {
    icon: '📚', title: 'Docs',
    commands: [
      { name: 'docs toc',      args: '[file]',  desc: 'Table of contents for a file or the whole project' },
      { name: 'docs search',   args: '<query>', desc: 'Full-text search over documentation sections',        opts: ['--limit <n>  Max results', '--section <id>  Restrict to section'] },
      { name: 'docs section',  args: '<id>',    desc: 'Print the full content of a section by ID' },
      { name: 'docs outline',  args: '<file>',  desc: 'Print heading hierarchy for a document' },
      { name: 'docs refs',     args: '<id>',    desc: 'Show code-to-doc and doc-to-code cross-references' },
      { name: 'docs reindex',  desc: 'Force re-index all documentation files' },
      { name: 'docs lint',     desc: 'Find broken refs, stale sections, FTS desync' },
    ],
    examples: [
      ['kirograph docs toc', 'Table of contents for the project'],
      ['kirograph docs search "authentication"', 'Find docs about auth'],
      ['kirograph docs section api.auth.login', 'Read a specific section'],
      ['kirograph docs refs api.auth.login', 'Which code references this doc section?'],
    ],
  },
  {
    icon: '🗄️', title: 'Data',
    commands: [
      { name: 'data list',           desc: 'List all indexed datasets' },
      { name: 'data describe',       args: '<dataset>', desc: 'Show schema and column profiles',                     opts: ['--format <f>  table | json'] },
      { name: 'data query',          args: '<dataset>', desc: 'Query rows with filters',                             opts: ['--filter <f>  col:op:val', '--limit <n>  Max rows', '--format <f>  table | json | csv'] },
      { name: 'data aggregate',      args: '<dataset>', desc: 'Server-side GROUP BY aggregation',                   opts: ['--group-by <col>', '--metric <agg:col>  sum|avg|count|min|max'] },
      { name: 'data search',         args: '<dataset> <q>', desc: 'Search column names and sample values' },
      { name: 'data join',           args: '<left> <right>', desc: 'SQL JOIN across two indexed datasets',          opts: ['--left-col <c>  Join key', '--right-col <c>  Join key', '--type inner|left|right'] },
      { name: 'data correlations',   args: '<dataset>', desc: 'Pairwise Pearson correlations between numeric columns' },
      { name: 'data quality',        args: '<dataset>', desc: 'Data quality triage: rank columns by risk' },
      { name: 'data drift',          args: '<dataset>', desc: 'Show schema drift between last two indexes' },
      { name: 'data history',        args: '<dataset>', desc: 'Show history of schema changes for a dataset' },
    ],
    examples: [
      ['kirograph data list', 'List all indexed datasets'],
      ['kirograph data describe orders', 'Schema and column profiles for orders'],
      ['kirograph data query orders --filter status:eq:shipped', 'Filter rows'],
      ['kirograph data aggregate orders --group-by region --metric sum:amount', 'Aggregate by region'],
      ['kirograph data join users orders --left-col id --right-col user_id', 'Join datasets'],
    ],
  },
  {
    icon: '📖', title: 'Wiki',
    commands: [
      { name: 'wiki init',       desc: 'Initialize wiki: create SCHEMA.md and MANIFEST.md' },
      { name: 'wiki ingest',     args: '[source]', desc: 'Print the ingest prompt for the LLM (reads file or stdin)' },
      { name: 'wiki search',     args: '<query>',  desc: 'Full-text search over wiki pages',                           opts: ['--limit <n>  Max results'] },
      { name: 'wiki page',       args: '<slug>',   desc: 'Print the full content of a wiki page' },
      { name: 'wiki list',       desc: 'List all wiki pages' },
      { name: 'wiki lint',       desc: 'Health check the wiki for broken links, orphans, contradictions' },
      { name: 'wiki reindex',    desc: 'Rebuild SQLite index from .kirograph/wiki/*.md files' },
      { name: 'wiki status',     desc: 'Wiki subsystem stats: page count, source count, oldest/newest page' },
      { name: 'wiki synthesize', desc: 'Run local-model wiki synthesis over the pending source queue' },
      { name: 'wiki apply-diff', args: '[diff]',   desc: 'Apply a WIKI_DIFF string to the wiki' },
    ],
    examples: [
      ['kirograph wiki init', 'Initialize the wiki in this project'],
      ['kirograph wiki search "authentication flow"', 'Find wiki pages about auth'],
      ['kirograph wiki page arch-overview', 'Read a specific wiki page'],
      ['kirograph wiki lint', 'Check wiki health'],
      ['kirograph wiki status', 'How many pages and sources?'],
    ],
  },
  {
    icon: '🧠', title: 'Memory',
    commands: [
      { name: 'mem search',   args: '<query>', desc: 'Search past observations',                  opts: ['--kind <k>  Filter by kind', '--limit <n>  Max results'] },
      { name: 'mem store',    args: '<text>',  desc: 'Store an observation',                      opts: ['--kind <k>  decision | error | pattern | architecture | note'] },
      { name: 'mem capture',  args: '<text>',  desc: 'Passively extract multiple observations from free-form text' },
      { name: 'mem timeline', desc: 'List recent sessions and observations' },
      { name: 'mem status',   desc: 'Memory health dashboard' },
      { name: 'mem prune',    desc: 'Remove old observations',                                    opts: ['--older-than <d>  Duration (e.g. 90d)'] },
      { name: 'mem export',   desc: 'Export observations',                                        opts: ['--format <f>  jsonl | md'] },
      { name: 'mem lint',     desc: 'Health check and auto-repair',                               opts: ['--fix  Auto-fix issues'] },
      { name: 'mem reembed',  desc: 'Re-embed all observations after model change' },
      { name: 'mem conflicts list',   desc: 'List pending conflict relations' },
      { name: 'mem conflicts ignore', args: '<id>', desc: 'Dismiss a pending conflict relation' },
      { name: 'mem watchmen status',    desc: 'Show watchmen observation counter and last synthesis time' },
      { name: 'mem watchmen synthesize', desc: 'Run watchmen synthesis: produce brief and/or skill files' },
      { name: 'mem watchmen reset',     desc: 'Reset the watchmen observation counter to zero' },
    ],
    examples: [
      ['kirograph mem search "auth decision"', 'Search for past decisions'],
      ['kirograph mem store "use idempotency keys" --kind decision', 'Store a decision'],
      ['kirograph mem prune --older-than 90d', 'Remove observations older than 90 days'],
      ['kirograph mem conflicts list', 'See pending conflict relations'],
      ['kirograph mem watchmen status', 'Check watchmen counter and last synthesis'],
      ['kirograph mem watchmen synthesize', 'Trigger watchmen synthesis manually'],
    ],
  },
  {
    icon: '🔒', title: 'Security',
    commands: [
      { name: 'security', args: '[path]', desc: 'Security overview: vulnerabilities, verdicts, stale-data warnings' },
      { name: 'vulns',    args: '[path]', desc: 'List vulnerabilities with reachability verdicts and severity',
        opts: [
          '--severity <level>  Filter by severity: critical, high, medium, low',
          '--verdict <verdict>  Filter by verdict: affected, not_affected, under_investigation',
          '--refresh  Trigger fresh vulnerability enrichment before listing',
          '--add <cveId>  Manually register a CVE (requires --package and --version)',
        ],
      },
      { name: 'reachability', args: '<target>', desc: 'Check reachability for a CVE or dependency: verdict, call paths, impact' },
      { name: 'vuln suppress',   args: '<cveId>', desc: 'Mark a CVE as suppressed (false positive or accepted risk)',
        opts: [
          '--reason <text>   Reason for suppression',
          '--expires <date>  Expiry date (e.g. 2026-12-31)',
        ],
      },
      { name: 'vuln unsuppress', args: '<cveId>', desc: 'Remove a suppression' },
      { name: 'vuln suppressions', desc: 'List all active suppressions', opts: ['--format json  JSON output'] },
      { name: 'licenses', args: '[path]', desc: 'Show dependency licenses and check against policy (deny/warn lists)',
        opts: [
          '--policy             Show only policy violations',
          '--deny <patterns>    Override deny list (comma-separated SPDX patterns)',
          '--warn <patterns>    Override warn list (comma-separated SPDX patterns)',
          '--format json        JSON output',
        ],
      },
      { name: 'vex',       args: '[path]', desc: 'Export a VEX document (Vulnerability Exploitability eXchange)', opts: ['--output <file>  Write to file instead of stdout'] },
      { name: 'sbom',      args: '[path]', desc: 'Export a Software Bill of Materials',                           opts: ['--output <file>  Write to file instead of stdout'] },
      { name: 'staleness', args: '[path]', desc: 'Check dependency freshness — packages behind their latest version',
        opts: [
          '--threshold <n>  Show only packages with staleness_score >= n (default: 0.3)',
          '--refresh        Fetch latest version info from registries before listing',
          '--format <fmt>   table | json',
        ],
      },
      { name: 'security export',     args: '[path]', desc: 'Generate HTML security dashboard', opts: ['--output <file>  Output path', '--open  Open in browser'] },
      { name: 'security secrets',    args: '[path]', desc: 'Scan for hardcoded secrets with call-graph blast radius', opts: ['--include-tests  Include test files', '--severity <s>  Filter level', '--format json'] },
      { name: 'security flows',      args: '[path]', desc: 'SAST-lite: detect dangerous data flows (SQL injection, eval, path traversal, etc.)', opts: ['--type sql|eval|deserialize|path|all', '--format json'] },
      { name: 'security ci-report',  args: '[path]', desc: 'Generate CI/CD security report (JSON, SARIF for GitHub, or text)', opts: ['--format json|sarif|text', '--fail-on affected|any|critical', '--output <file>'] },
      { name: 'attack-surface',      args: '[path]', desc: 'Map attack surface: routes → vulnerable deps with hop count and auth status', opts: ['--limit <n>', '--public-only', '--format json'] },
      { name: 'supply-chain',        args: '[path]', desc: 'Supply chain health: OpenSSF Scorecard, maintainer count, abandoned packages', opts: ['--threshold critical|high|medium', '--refresh', '--format json'] },
      { name: 'dep-confusion',       args: '[path]', desc: 'Detect dependency confusion: internal packages that exist in public registries', opts: ['--format json'] },
      { name: 'remediation',         args: '[path]', desc: 'Remediation SLA tracking: days open, fix available since, overdue alerts', opts: ['--overdue-only', '--format json'] },
      { name: 'pattern', args: '[pattern]', desc: 'AST structural search: live pattern search or library rule runner',
        opts: [
          '--list             Show all bundled SAST rules',
          '--library <id>    Run a specific library rule',
          '--lang <l>        Language filter (js, ts, python, go, ...)',
          '--format json     JSON output',
        ],
      },
    ],
    examples: [
      ['kirograph security', 'Overview: dep count, vuln count, verdict breakdown'],
      ['kirograph security --refresh-staleness', 'Overview including stale dependency count'],
      ['kirograph vulns', 'List all vulnerabilities with severity and verdict'],
      ['kirograph vulns --stale', 'Show staleness score alongside each CVE'],
      ['kirograph vulns --verdict under_investigation', 'Show only vulnerabilities still being investigated'],
      ['kirograph vulns --severity critical --verdict affected', 'Critical confirmed vulnerabilities'],
      ['kirograph vulns --refresh', 'Re-query OSV before listing'],
      ['kirograph staleness', 'Show packages with staleness_score >= 0.3'],
      ['kirograph staleness --refresh --threshold 0.5', 'Fetch latest versions and show very stale packages'],
      ['kirograph reachability CVE-2023-12345', 'Check reachability for a specific CVE'],
      ['kirograph reachability lodash', 'Check reachability for a dependency by package name'],
      ['kirograph licenses', 'Show all dependency licenses'],
      ['kirograph licenses --policy', 'Show only license policy violations'],
      ['kirograph licenses --deny "GPL-*,AGPL-*"', 'Block all GPL/AGPL licenses'],
      ['kirograph vex --output vex.json', 'Export CycloneDX VEX document'],
      ['kirograph sbom --output sbom.json', 'Export SPDX SBOM'],
      ['kirograph security export --open', 'Generate and open HTML security dashboard'],
      ['kirograph security secrets', 'Scan for hardcoded secrets with call-graph blast radius'],
      ['kirograph security flows', 'Detect dangerous data flows (SQL injection, eval, etc.)'],
      ['kirograph security ci-report --format sarif --output results.sarif', 'SARIF report for GitHub Security tab'],
      ['kirograph attack-surface --public-only', 'Show public routes reaching vulnerable deps'],
      ['kirograph supply-chain --threshold high', 'Show high-risk supply chain findings'],
      ['kirograph dep-confusion', 'Detect dependency confusion attack vectors'],
      ['kirograph remediation --overdue-only', 'Show CVEs past their remediation SLA'],
      ['kirograph vuln suppress CVE-2024-1234 --reason "not in code path"', 'Suppress a false positive CVE'],
      ['kirograph vuln unsuppress CVE-2024-1234', 'Remove a suppression'],
      ['kirograph vuln suppressions', 'List all active suppressions'],
      ['kirograph pattern "eval($X)"', 'Find all eval() calls'],
      ['kirograph pattern --list', 'Show all bundled SAST rules'],
      ['kirograph pattern --library dangerous-eval-js', 'Run the dangerous-eval library rule'],
    ],
  },
  {
    icon: '⚙️', title: 'Agent',
    commands: [
      { name: 'caveman',     args: '[mode]',  desc: 'Communication style (off | lite | full | ultra)' },
      { name: 'compression', args: '[level]', desc: 'Shell compression level (off | normal | aggressive | ultra)' },
      { name: 'exec',        args: '<cmd>',   desc: 'Run command with token-optimized output',              opts: ['-l <level>  Compression level', '-t <sec>  Timeout'] },
      { name: 'gain',        desc: 'Token savings statistics',                                              opts: ['--graph  ASCII chart', '--history  Recent commands', '--daily  Day breakdown'] },
      { name: 'bench',       desc: 'Run local token-efficiency benchmark across KiroGraph tools',           opts: ['--quiet  Suppress per-tool output'] },
      { name: 'monitor',     desc: 'Live tail of mcp-calls.jsonl — watch MCP tool usage in real time',     opts: ['--lines <n>  Initial lines to show'] },
      { name: 'upgrade',     desc: 'Update KiroGraph to the latest version',                               opts: ['--dry-run  Show what would change without installing'] },
      { name: 'cost',        args: '[sessionDir]', desc: 'Analyze MCP tool usage and token cost from Claude session transcripts', opts: ['--last <n>  Last N sessions', '--category  Group by tool category'] },
      { name: 'serve',       desc: 'Start the MCP server',                                                 opts: ['--mcp  Run as stdio MCP', '--path <p>  Project path'] },
    ],
    examples: [
      ['kirograph caveman lite', 'Enable lite caveman mode'],
      ['kirograph exec git status', 'Run git status with compression'],
      ['kirograph gain --graph', 'Show token savings graph'],
      ['kirograph bench', 'Run token-efficiency benchmark'],
      ['kirograph monitor', 'Watch MCP tool calls live'],
      ['kirograph cost --last 5', 'Cost breakdown for the last 5 sessions'],
      ['kirograph upgrade --dry-run', 'Preview available KiroGraph update'],
    ],
  },
];

function renderGroup(group: Group, highlightIdx: number, interactive = false): string[] {
  const lines: string[] = [];
  const nameWidth = Math.max(...group.commands.map(cmd => (cmd.name + (cmd.args ? ' ' + cmd.args : '')).length)) + 2;

  lines.push('');
  lines.push(`  ${c.bold}${c.paleLavender}COMMANDS${c.reset}  ${c.dim}↑↓ select · enter to copy · q quit${c.reset}`);
  lines.push('');

  for (let i = 0; i < group.commands.length; i++) {
    const cmd = group.commands[i]!;
    const signature = cmd.name + (cmd.args ? ' ' + cmd.args : '');
    const isHighlighted = i === highlightIdx;
    const prefix = isHighlighted ? `${c.green}${c.bold}❯${c.reset} ` : '  ';
    const namePart = isHighlighted
      ? `${c.bold}${c.lavender}${cmd.name}${c.reset}${cmd.args ? ' ' + c.bold + cmd.args + c.reset : ''}`
      : `${c.lavender}${cmd.name}${c.reset}${cmd.args ? ' ' + c.dim + cmd.args + c.reset : ''}`;
    const pad = ' '.repeat(Math.max(0, nameWidth - signature.length));
    lines.push(`${prefix}${namePart}${pad}${c.gray}${cmd.desc}${c.reset}`);
    // In interactive mode show only the highlighted command's opts
    if (cmd.opts && (!interactive || isHighlighted)) {
      for (const opt of cmd.opts) {
        const [flag, ...rest] = opt.split(/  +/);
        lines.push(`    ${c.purple}${flag}${c.reset}${rest.length ? '  ' + c.dim + rest.join('  ') + c.reset : ''}`);
      }
    }
  }

  if (!interactive && group.examples.length > 0) {
    lines.push('');
    lines.push(`  ${c.bold}${c.paleLavender}EXAMPLES${c.reset}`);
    lines.push('');
    for (const [ex, desc] of group.examples) {
      lines.push(`  ${c.violet}$${c.reset} ${c.lavender}${ex}${c.reset}`);
      lines.push(`    ${c.dim}${desc}${c.reset}`);
    }
  }

  return lines;
}


function renderTabs(selectedIdx: number): string {
  return GROUPS.map((g, i) => {
    if (i === selectedIdx) {
      return `${c.bold}${c.violet}${c.underline}${g.icon} ${g.title}${c.reset}`;
    }
    return `${c.dim}${g.icon} ${g.title}${c.reset}`;
  }).join('  ');
}

/**
 * Interactive tabbed help — left/right for tabs, up/down for commands, enter to copy.
 */
export function printInteractiveHelp(): void {
  let selectedTab = 0;
  let selectedCmd = 0;

  function render() {
    // Move to top-left and clear from cursor to end of screen
    process.stdout.write('\x1b[H\x1b[J');

    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${renderTabs(selectedTab)}`);
    lines.push(`  ${c.dim}← → tabs · ↑ ↓ commands · enter to use · q quit${c.reset}`);
    lines.push(...renderGroup(GROUPS[selectedTab]!, selectedCmd, true));

    process.stdout.write(lines.join('\n') + '\n');
  }

  // Enter alternate screen + hide cursor so rendering never scrolls or flickers
  process.stdout.write('\x1b[?1049h\x1b[?25l');

  printBanner();
  console.log(`\n${c.bold}${c.paleLavender}USAGE${c.reset}  ${c.lavender}kirograph${c.reset} ${c.gray}<command>${c.reset} ${c.dim}[options]${c.reset}`);

  render();

  // Enter raw mode for interactive navigation
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Non-interactive: leave alternate screen and print all groups normally
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    for (let i = 1; i < GROUPS.length; i++) {
      const lines = renderGroup(GROUPS[i]!, -1);
      for (const line of lines) console.log(line);
    }
    return;
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  function cleanup() {
    stdin.removeListener('data', onData);
    stdin.setRawMode(false);
    stdin.pause();
    // Leave alternate screen and restore cursor
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }

  function onData(key: string) {
    // Arrow keys and other escape sequences start with \x1b[
    if (key.startsWith('\x1b[')) {
      if (key === '\x1b[C') { // right arrow — next tab
        selectedTab = (selectedTab + 1) % GROUPS.length;
        selectedCmd = 0;
        render();
      } else if (key === '\x1b[D') { // left arrow — prev tab
        selectedTab = (selectedTab - 1 + GROUPS.length) % GROUPS.length;
        selectedCmd = 0;
        render();
      } else if (key === '\x1b[B') { // down arrow — next command
        const maxCmd = GROUPS[selectedTab]!.commands.length - 1;
        selectedCmd = Math.min(selectedCmd + 1, maxCmd);
        render();
      } else if (key === '\x1b[A') { // up arrow — prev command
        selectedCmd = Math.max(selectedCmd - 1, 0);
        render();
      }
      // Ignore other escape sequences
      return;
    }

    if (key === '\r' || key === '\n') { // enter — copy command to terminal
      cleanup();
      const cmd = GROUPS[selectedTab]!.commands[selectedCmd]!;
      const fullCmd = `kirograph ${cmd.name}${cmd.args ? ' ' + cmd.args : ''}`;
      console.log(`\n  ${c.green}${c.bold}$${c.reset} ${fullCmd}\n`);
      process.exit(0);
    } else if (key === 'q' || key === '\x03') { // q, ctrl+c
      cleanup();
      console.log();
      process.exit(0);
    }
  }

  stdin.on('data', onData);
}

/**
 * Non-interactive full help (for piping, --help flag).
 */
export function printColoredHelp(): void {

  console.log(`\n${c.bold}${c.paleLavender}USAGE${c.reset}`);
  console.log(`  ${c.lavender}kirograph${c.reset} ${c.gray}<command>${c.reset} ${c.dim}[options]${c.reset}\n`);

  for (const group of GROUPS) {
    console.log(`${c.bold}${c.paleLavender}${group.icon} ${group.title.toUpperCase()}${c.reset}\n`);
    const nameWidth = Math.max(...group.commands.map(cmd => (cmd.name + (cmd.args ? ' ' + cmd.args : '')).length)) + 2;
    for (const cmd of group.commands) {
      const signature = cmd.name + (cmd.args ? ' ' + cmd.args : '');
      const namePart = `${c.lavender}${cmd.name}${c.reset}${cmd.args ? ' ' + c.dim + cmd.args + c.reset : ''}`;
      const pad = ' '.repeat(Math.max(0, nameWidth - signature.length));
      console.log(`  ${namePart}${pad}${c.gray}${cmd.desc}${c.reset}`);
      if (cmd.opts) {
        for (const opt of cmd.opts) {
          const [flag, ...rest] = opt.split(/  +/);
          console.log(`    ${c.purple}${flag}${c.reset}${rest.length ? '  ' + c.dim + rest.join('  ') + c.reset : ''}`);
        }
      }
    }
    console.log();
  }

  console.log(`${c.bold}${c.paleLavender}GLOBAL FLAGS${c.reset}\n`);
  console.log(`  ${c.purple}-h, --help${c.reset}     ${c.gray}Show this help${c.reset}`);
  console.log(`  ${c.purple}-V, --version${c.reset}  ${c.gray}Show version number${c.reset}\n`);


  console.log(`${c.bold}${c.paleLavender}EXAMPLES${c.reset}\n`);

  const exampleGroups: Array<{ title: string; examples: [string, string][] }> = [
    {
      title: '🔧 Setup & indexing',
      examples: [
        ['kirograph install',                              'Wire up Kiro MCP + hooks + steering for the current workspace'],
        ['kirograph install --target claude',              'Wire up Claude Code MCP + project memory'],
        ['kirograph install --target codex',               'Install Codex project instructions and print MCP config'],
        ['kirograph init --index',                         'Init and immediately index the project'],
        ['kirograph hook save',                            'Save workspace hooks to ~/.kirograph/hooks/'],
        ['kirograph hook import',                          'Import global hooks into .kiro/hooks/'],
        ['kirograph sync',                                 'Incremental sync of changed files'],
      ],
    },
    {
      title: '🔍 Search & exploration',
      examples: [
        ['kirograph query useState',                       'Find all symbols named useState'],
        ['kirograph context "add dark mode"',              'Get relevant code context for a task'],
        ['kirograph files --format grouped',               'Show files grouped by directory'],
        ['kirograph path LoginController DatabasePool',     'Find how two symbols are connected'],
        ['kirograph affected src/auth.ts',                 'Find tests affected by a change'],
        ['git diff --name-only | kirograph affected --stdin', 'Affected tests from a git diff'],
        ['kirograph export start',                         'Open the interactive graph dashboard in the browser'],
        ['kirograph export build -o /tmp/graph',           'Export the dashboard to a custom directory'],
      ],
    },
    {
      title: '📊 Graph insights',
      examples: [
        ['kirograph hotspots --limit 10',                  'Top 10 most-connected symbols'],
        ['kirograph surprising',                           'Find unexpected cross-module connections'],
        ['kirograph dead-code',                            'Find unreferenced unexported symbols'],
        ['kirograph snapshot save pre-refactor',           'Save a named snapshot before a refactor'],
        ['kirograph snapshot diff pre-refactor',           'Diff current graph vs the named snapshot'],
      ],
    },
    {
      title: '🏛️ Architecture',
      examples: [
        ['kirograph architecture --packages',              'List all detected packages'],
        ['kirograph coupling --sort instability',          'Show packages ranked by instability'],
        ['kirograph package src/auth',                     'Inspect the auth package'],
      ],
    },
    {
      title: '🔒 Security',
      examples: [
        ['kirograph security',                                        'Overview: dep count, vuln count, verdict breakdown'],
        ['kirograph security --refresh-staleness',                   'Overview including stale dependency count'],
        ['kirograph vulns',                                           'List all vulnerabilities'],
        ['kirograph vulns --stale',                                   'Show staleness score alongside each CVE'],
        ['kirograph vulns --verdict under_investigation',             'Vulnerabilities still being investigated'],
        ['kirograph vulns --severity critical --verdict affected',    'Critical confirmed vulnerabilities'],
        ['kirograph vulns --refresh',                                 'Re-query OSV then list'],
        ['kirograph staleness',                                       'Show packages with staleness_score >= 0.3'],
        ['kirograph staleness --refresh --threshold 0.5',            'Fetch latest versions and show very stale packages'],
        ['kirograph reachability CVE-2023-12345',                     'Check reachability for a specific CVE'],
        ['kirograph reachability lodash',                             'Check reachability for a dependency by package name'],
        ['kirograph licenses',                                        'Show all dependency licenses'],
        ['kirograph licenses --policy',                              'Show only license policy violations'],
        ['kirograph licenses --deny "GPL-*,AGPL-*"',                 'Block all GPL/AGPL licenses'],
        ['kirograph vex --output vex.json',                          'Export CycloneDX VEX document'],
        ['kirograph sbom --output sbom.json',                        'Export SPDX SBOM'],
        ['kirograph vuln suppress CVE-2024-1234 --reason "not in code path"', 'Suppress a false positive CVE'],
        ['kirograph vuln suppress CVE-2024-1234 --expires 2026-12-31', 'Suppress with expiry date'],
        ['kirograph vuln unsuppress CVE-2024-1234',                  'Remove a suppression'],
        ['kirograph vuln suppressions',                              'List all active suppressions'],
        ['kirograph pattern "eval($X)"',                             'Find all eval() calls (requires enablePatterns: true)'],
        ['kirograph pattern --list',                                 'Show all bundled SAST pattern rules'],
        ['kirograph pattern --library dangerous-eval-js',            'Run a specific library rule'],
      ],
    },
    {
      title: '⚙️ Agent',
      examples: [
        ['kirograph caveman full',                         'Enable full caveman mode for the agent'],
        ['kirograph caveman off',                          'Disable caveman mode'],
        ['kirograph compression aggressive',              'Set compression to aggressive level'],
        ['kirograph compression off',                      'Disable compression hook (tool still available)'],
        ['kirograph exec git status',                      'Run git status with compression'],
        ['kirograph exec --level ultra npm test',          'Run tests with ultra compression'],
        ['kirograph exec --raw cargo build',               'Show raw vs compressed comparison'],
        ['kirograph gain --graph',                         'Show token savings graph'],
        ['kirograph mem search "auth decision"',            'Search memory for past decisions'],
        ['kirograph mem store "use idempotency keys" --kind decision', 'Store a decision'],
        ['kirograph data list',                             'List all indexed datasets'],
        ['kirograph data describe tests-fixtures-users',    'Show schema and column profiles'],
        ['kirograph data query orders --filter status:eq:shipped --limit 10', 'Query rows with filters'],
        ['kirograph data aggregate orders --group-by region --metric sum:amount', 'Server-side aggregation'],
        ['kirograph serve --mcp',                          'Start the MCP server'],
      ],
    },
  ];

  for (const eg of exampleGroups) {
    console.log(`  ${c.dim}${eg.title}${c.reset}`);
    for (const [ex, desc] of eg.examples) {
      console.log(`  ${c.violet}$${c.reset} ${c.lavender}${ex}${c.reset}`);
      console.log(`    ${c.dim}${desc}${c.reset}`);
    }
    console.log();
  }
}

export function register(program: Command): void {
  program.configureHelp({ formatHelp: () => '' });
  program.addHelpText('afterAll', '');
  // Disable Commander's built-in --help to prevent process.exit
  program.helpOption(false);
}
