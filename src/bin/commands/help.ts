import { Command } from 'commander';
import { printBanner } from '../banner';

type CommandEntry = { name: string; args?: string; desc: string; opts?: string[] };
type Group = { title: string; commands: CommandEntry[] };

export function printColoredHelp(): void {
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
  };

  const groups: Group[] = [
    {
      title: '🔧 Workspace Setup',
      commands: [
        { name: 'install',       desc: 'Wire up MCP/instructions for an agent workspace', opts: ['--target <t>  kiro | claude | codex'] },
        { name: 'init',          args: '[path]', desc: 'Initialize KiroGraph in a project', opts: ['-i, --index  Index immediately after init'] },
        { name: 'uninit',        args: '[path]', desc: 'Remove KiroGraph from a project',   opts: ['--force      Skip confirmation', '--target <t>  kiro | claude | codex | all'] },
        { name: 'uninstall',     args: '[path]', desc: 'Alias for uninit',                  opts: ['--force      Skip confirmation', '--target <t>  kiro | claude | codex | all'] },
      ],
    },
    {
      title: '📦 Indexing',
      commands: [
        { name: 'index',         args: '[path]', desc: 'Full re-index of a project',             opts: ['--force     Force re-index all files'] },
        { name: 'sync',          args: '[path]', desc: 'Incremental sync of changed files',       opts: ['--files <f> Specific files to sync'] },
        { name: 'sync-if-dirty', args: '[path]', desc: 'Sync only if a dirty marker is present', opts: ['-q, --quiet  Suppress output'] },
        { name: 'mark-dirty',    args: '[path]', desc: 'Write a dirty marker for deferred sync' },
        { name: 'unlock',        args: '[path]', desc: 'Force-release a stale lock file' },
      ],
    },
    {
      title: '🔍 Search & Exploration',
      commands: [
        { name: 'status',   args: '[path]',    desc: 'Show index statistics and health' },
        { name: 'query',    args: '<search>',  desc: 'Search for symbols by name',          opts: ['--kind <k>      Filter by kind', '--limit <n>     Max results (default 10)'] },
        { name: 'context',  args: '<task>',    desc: 'Build relevant code context for a task', opts: ['--max-nodes <n>  Max symbols (default 20)', '--no-code        Exclude code snippets', '--format <fmt>   markdown | json'] },
        { name: 'files',    args: '[path]',    desc: 'Show project file structure from the index', opts: ['--format <fmt>   tree | flat | grouped', '--filter <path>  Filter by directory prefix', '--pattern <glob> Filter by glob', '--max-depth <n>  Limit tree depth', '--json           Output as JSON'] },
        { name: 'path',     args: '<from> <to>', desc: 'Find the shortest path between two symbols',         opts: ['--format <fmt>   table | json'] },
        { name: 'export build', args: '[path]', desc: 'Generate the interactive graph dashboard (.kirograph/export/)', opts: ['-o, --output <dir>  Custom output directory', '--include-contains  Include structural contains edges'] },
        { name: 'export start', args: '[path]', desc: 'Generate and open the dashboard in the browser',               opts: ['-o, --output <dir>  Custom output directory', '--include-contains  Include structural contains edges'] },
        { name: 'affected', args: '[files...]', desc: 'Find test files affected by changed source files', opts: ['--stdin          Read file list from stdin', '-d, --depth <n>  Max traversal depth (default 5)', '-f, --filter <g> Custom test file glob', '-j, --json       Output as JSON', '-q, --quiet      File paths only'] },
      ],
    },
    {
      title: '📊 Graph Insights',
      commands: [
        { name: 'hotspots',   args: '[path]', desc: 'Find most-connected symbols by edge degree',          opts: ['--limit <n>    Max results (default 20)', '--format <f>  table | json'] },
        { name: 'surprising', args: '[path]', desc: 'Find non-obvious cross-file connections',             opts: ['--limit <n>    Max results (default 20)', '--format <f>  table | json'] },
        { name: 'dead-code',  args: '[path]', desc: 'Find unexported symbols with no incoming references', opts: ['--limit <n>    Max results (default 50)', '--format <f>  table | json'] },
        { name: 'snapshot',   desc:           'Save or list graph snapshots for structural diffing',       opts: ['save [label]  Save current graph state', 'list          List saved snapshots', 'diff [label]  Diff current graph vs a snapshot  --format summary|full|json'] },
      ],
    },
    {
      title: '🏛️ Architecture Analysis',
      commands: [
        { name: 'architecture', args: '[path]', desc: 'Show package graph and layer map',          opts: ['--packages     Show packages only', '--layers       Show layers only', '--format <f>   json'] },
        { name: 'coupling',     args: '[path]', desc: 'Show coupling metrics per package',         opts: ['--sort <s>     instability | ca | ce | name', '--package <n>  Detail view for one package', '--format <f>   json'] },
        { name: 'package',      args: '<name>', desc: 'Inspect a package: deps, files, metrics',  opts: ['--no-files     Omit file list', '--format <f>   json'] },
      ],
    },
    {
      title: '⚙️ Agent & Configuration',
      commands: [
        { name: 'caveman', args: '[mode]', desc: 'Set agent communication style (off | lite | full | ultra)' },
        { name: 'compression', args: '[level]', desc: 'Set output compression level (off | normal | aggressive | ultra)' },
        { name: 'exec', args: '<command...>', desc: 'Run a shell command with token-optimized output', opts: ['-l, --level <l>  normal | aggressive | ultra', '-t, --timeout <s> Timeout in seconds (default 60)', '--raw         Show raw + compressed for comparison', '--json        Output as JSON'] },
        { name: 'gain', desc: 'Show token savings from compressed command outputs', opts: ['--graph       ASCII graph (last 30 days)', '--history     Recent command history', '--daily       Day-by-day breakdown', '--period <p>  session | today | week | all'] },
        { name: 'serve',   desc: 'Start the MCP server', opts: ['--mcp        Run as MCP stdio server', '--path <p>   Project path'] },
        { name: 'dashboard', desc: 'Manage the Qdrant or Typesense dashboard server', opts: ['start [path]  Start server and open dashboard', 'stop [path]   Stop the running server'] },
      ],
    },
  ];

  console.log(`\n${c.bold}${c.paleLavender}USAGE${c.reset}`);
  console.log(`  ${c.lavender}kirograph${c.reset} ${c.gray}<command>${c.reset} ${c.dim}[options]${c.reset}\n`);

  // Compute max name+args width across ALL groups for alignment
  const allCmds = groups.flatMap(g => g.commands);
  const nameWidth = Math.max(...allCmds.map(cmd => (cmd.name + (cmd.args ? ' ' + cmd.args : '')).length)) + 2;

  for (const group of groups) {
    console.log(`${c.bold}${c.paleLavender}${group.title.toUpperCase()}${c.reset}\n`);
    for (const cmd of group.commands) {
      const signature = cmd.name + (cmd.args ? ' ' + cmd.args : '');
      const isCaveman = cmd.name === 'caveman';
      const nameColor = isCaveman ? c.brown : c.lavender;
      const prefix = isCaveman ? '🪨 ' : '  ';
      const namePart = `${nameColor}${cmd.name}${c.reset}${cmd.args ? ' ' + c.dim + cmd.args + c.reset : ''}`;
      const pad = ' '.repeat(Math.max(0, nameWidth - signature.length));
      console.log(`${prefix}${namePart}${pad}${c.gray}${cmd.desc}${c.reset}`);
      if (isCaveman) {
        // desc starts at: emoji prefix (3 display cols: 🪨 + space) + nameWidth
        const inspiredPad = ' '.repeat(3 + nameWidth);
        console.log(`${inspiredPad}${c.dim}Inspired by Caveman , original idea by github.com/JuliusBrussee/caveman${c.reset}`);
        console.log();
      }
      if (cmd.opts) {
        for (const opt of cmd.opts) {
          const [flag, ...rest] = opt.split(/  +/);
          const optPad = ' '.repeat(nameWidth + 2);
          console.log(`  ${optPad}${c.purple}${flag}${c.reset}${rest.length ? '  ' + c.dim + rest.join('  ') + c.reset : ''}`);
        }
        console.log();
      }
    }
    if (!groups[groups.length - 1].commands.includes(group.commands[group.commands.length - 1])) {
      // extra spacing between groups handled by opts blank line; add one if no opts
      const lastHasOpts = group.commands[group.commands.length - 1].opts;
      if (!lastHasOpts) console.log();
    }
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
  program.helpInformation = () => {
    printBanner();
    printColoredHelp();
    return '';
  };
}
