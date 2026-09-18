import { Command } from 'commander';

const INSTALL_TARGETS = [
  'kiro', 'claude', 'codex', 'cursor', 'antigravity', 'opencode',
  'windsurf', 'cline', 'copilot', 'copilot-cli', 'junie', 'gemini-cli',
  'continue', 'roo', 'warp', 'aider', 'trae',
  'augment', 'kilo', 'amp', 'devin', 'replit', 'goose', 'openhands', 'tabnine',
  'mistral-vibe', 'ibm-bob', 'crush', 'droid-factory', 'forgecode', 'iflow', 'qwen', 'rovo', 'qoder', 'commandcode',
];

export function register(program: Command): void {
  program
    .command('install')
    .description('Configure KiroGraph for an agent workspace')
    .option('--target <target>', `Integration target: ${INSTALL_TARGETS.join(', ')}`)
    .option('--all', 'Install for all auto-detected platforms without prompting')
    .option('--yes', 'Skip confirmation prompts and use existing config (non-interactive mode)')
    .option('--dry-run', 'Show what would be written without making changes')
    .action(async (opts: { target?: string; all?: boolean; yes?: boolean; dryRun?: boolean }) => {
      if (opts.target) {
        // Explicit target: validate and install
        const target = opts.target.toLowerCase();
        if (target !== 'all' && !INSTALL_TARGETS.includes(target)) {
          console.error(`Unknown install target: ${opts.target}. Choose from: ${INSTALL_TARGETS.join(', ')}`);
          process.exit(1);
        }

        if (target === 'all') {
          // --target all is an alias for --all
          const { runAutoDetectInstaller } = await import('../installer/auto-detect');
          await runAutoDetectInstaller({ skipPrompt: true, dryRun: opts.dryRun });
        } else {
          const { runInstaller } = await import('../installer/index');
          await runInstaller(target as any, { yes: opts.yes });
        }
      } else if (opts.all) {
        // --all flag: auto-detect and install all without prompting
        const { runAutoDetectInstaller } = await import('../installer/auto-detect');
        await runAutoDetectInstaller({ skipPrompt: true, dryRun: opts.dryRun });
      } else {
        // No target specified: ask Kiro-only vs auto-detect
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const bold = '\x1b[1m';
        const dim = '\x1b[2m';
        const violet = '\x1b[38;5;99m';
        const reset = '\x1b[0m';
        const { printBanner } = await import('../banner');
        printBanner();
        console.log(`  ${bold}How do you want to install KiroGraph?${reset}\n`);
        console.log(`  ${violet}1${reset}  Kiro only ${dim}(recommended — full support with IDE hooks, steering, CLI agent)${reset}`);
        console.log(`  ${violet}2${reset}  Auto-detect ${dim}(configure all AI tools found in this environment)${reset}\n`);
        const answer = await new Promise<string>((resolve) => {
          rl.question(`  Choose [1/2]: `, resolve);
        });
        rl.close();
        console.log();
        const choice = answer.trim();
        if (choice === '2') {
          const { runAutoDetectInstaller } = await import('../installer/auto-detect');
          await runAutoDetectInstaller({ skipPrompt: false, skipBanner: true, dryRun: opts.dryRun });
        } else {
          // Default to Kiro (choice === '1' or Enter)
          const { runInstaller } = await import('../installer/index');
          await runInstaller('kiro', { yes: opts.yes });
        }
      }
    });
}
