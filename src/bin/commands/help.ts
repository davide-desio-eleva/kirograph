import { Command } from 'commander';
import { printBanner } from '../banner';

export function printColoredHelp(): void {
  const c = {
    reset:        '\x1b[0m',
    bold:         '\x1b[1m',
    dim:          '\x1b[2m',
    violet:       '\x1b[38;5;99m',   // dark violet  — command names, $ prompt
    purple:       '\x1b[38;5;135m',  // medium purple — flags/options
    lavender:     '\x1b[38;5;141m',  // light purple  — usage keyword
    paleLavender: '\x1b[38;5;183m',  // pale lavender — section headers
    gray:         '\x1b[90m',
    white:        '\x1b[97m',
  };

  const commands: Array<{ name: string; args?: string; desc: string; opts?: string[] }> = [
    { name: 'install',       desc: 'Configure KiroGraph for the current Kiro workspace' },
    { name: 'init',          args: '[path]',    desc: 'Initialize KiroGraph in a project', opts: ['-i, --index  Index immediately after init'] },
    { name: 'uninit',        args: '[path]',    desc: 'Remove KiroGraph from a project',   opts: ['--force     Skip confirmation'] },
    { name: 'uninstall',     args: '[path]',    desc: 'Alias for uninit',                  opts: ['--force     Skip confirmation'] },
    { name: 'index',         args: '[path]',    desc: 'Full re-index of a project',        opts: ['--force     Force re-index all files'] },
    { name: 'sync',          args: '[path]',    desc: 'Incremental sync of changed files', opts: ['--files <f> Specific files to sync'] },
    { name: 'sync-if-dirty', args: '[path]',    desc: 'Sync only if a dirty marker is present', opts: ['-q, --quiet  Suppress output'] },
    { name: 'mark-dirty',    args: '[path]',    desc: 'Write a dirty marker for deferred sync' },
    { name: 'status',        args: '[path]',    desc: 'Show index statistics' },
    { name: 'query',         args: '<search>',  desc: 'Search for symbols',                opts: ['--kind <k>  Filter by kind', '--limit <n> Max results (default 10)'] },
    { name: 'context',       args: '<task>',    desc: 'Build relevant code context for a task', opts: ['--max-nodes <n>  Max symbols (default 20)', '--no-code        Exclude code snippets', '--format <fmt>   markdown | json'] },
    { name: 'files',         args: '[path]',    desc: 'Show project file structure from the index', opts: ['--format <fmt>   tree | flat | grouped', '--filter <path>  Filter by directory prefix', '--pattern <glob> Filter by glob', '--max-depth <n>  Limit tree depth', '--json           Output as JSON'] },
    { name: 'affected',      args: '[files...]', desc: 'Find test files affected by changed source files', opts: ['--stdin      Read file list from stdin', '-d, --depth <n>  Max traversal depth (default 5)', '-f, --filter <g> Custom glob for test files', '-j, --json       Output as JSON', '-q, --quiet      File paths only'] },
    { name: 'unlock',        args: '[path]',    desc: 'Force-release a stale lock file' },
    { name: 'serve',         desc: 'Start the MCP server',                                opts: ['--mcp        Run as MCP stdio server', '--path <p>   Project path'] },
  ];

  console.log(`\n${c.bold}${c.paleLavender}USAGE${c.reset}`);
  console.log(`  ${c.lavender}kirograph${c.reset} ${c.gray}<command>${c.reset} ${c.dim}[options]${c.reset}\n`);

  console.log(`${c.bold}${c.paleLavender}COMMANDS${c.reset}\n`);

  const nameWidth = Math.max(...commands.map(cmd => (cmd.name + (cmd.args ? ' ' + cmd.args : '')).length)) + 2;

  for (const cmd of commands) {
    const signature = cmd.name + (cmd.args ? ' ' + cmd.args : '');
    const namePart = `${c.lavender}${cmd.name}${c.reset}${cmd.args ? ' ' + c.dim + cmd.args + c.reset : ''}`;
    const pad = ' '.repeat(Math.max(0, nameWidth - signature.length));
    console.log(`  ${namePart}${pad}${c.gray}${cmd.desc}${c.reset}`);
    if (cmd.opts) {
      for (const opt of cmd.opts) {
        const [flag, ...rest] = opt.split(/  +/);
        const optPad = ' '.repeat(nameWidth + 2);
        console.log(`  ${optPad}${c.purple}${flag}${c.reset}${rest.length ? '  ' + c.dim + rest.join('  ') + c.reset : ''}`);
      }
      console.log();
    }
  }

  console.log(`${c.bold}${c.paleLavender}GLOBAL FLAGS${c.reset}\n`);
  console.log(`  ${c.purple}-h, --help${c.reset}     ${c.gray}Show this help${c.reset}`);
  console.log(`  ${c.purple}-V, --version${c.reset}  ${c.gray}Show version number${c.reset}`);
  console.log();

  console.log(`${c.bold}${c.paleLavender}EXAMPLES${c.reset}\n`);
  const examples = [
    ['kirograph install',                              'Wire up MCP + hooks + steering for the current workspace'],
    ['kirograph init --index',                         'Init and immediately index the project'],
    ['kirograph query useState',                       'Find all symbols named useState'],
    ['kirograph context "add dark mode"',              'Get relevant code context for a task'],
    ['kirograph affected src/auth.ts',                 'Find tests affected by a change'],
    ['git diff --name-only | kirograph affected --stdin', 'Affected tests from a git diff'],
    ['kirograph files --format grouped',               'Show files grouped by language'],
    ['kirograph serve --mcp',                          'Start the MCP server'],
  ];
  for (const [ex, desc] of examples) {
    console.log(`  ${c.violet}$${c.reset} ${c.lavender}${ex}${c.reset}`);
    console.log(`    ${c.dim}${desc}${c.reset}`);
  }
  console.log();
}

export function register(program: Command): void {
  // Override --help / help command with colored output
  program.configureHelp({ formatHelp: () => '' });
  program.addHelpText('afterAll', '');
  program.helpInformation = () => {
    printBanner();
    printColoredHelp();
    return '';
  };
}
