import { Command } from 'commander';

const INSTALL_TARGETS = [
  'kiro', 'claude', 'codex', 'cursor', 'antigravity', 'opencode',
  'windsurf', 'cline', 'copilot', 'junie', 'gemini-cli',
  'continue', 'roo', 'warp', 'aider', 'trae',
  'augment', 'kilo', 'amp', 'devin', 'replit', 'goose', 'openhands', 'tabnine',
  'mistral-vibe', 'ibm-bob', 'crush', 'droid-factory', 'forgecode', 'iflow', 'qwen', 'rovo', 'qoder',
];

export function register(program: Command): void {
  program
    .command('install')
    .description('Configure KiroGraph for an agent workspace')
    .option('--target <target>', `Integration target: ${INSTALL_TARGETS.join(', ')}`, 'kiro')
    .action(async (opts: { target: string }) => {
      const target = opts.target.toLowerCase();
      if (!INSTALL_TARGETS.includes(target)) {
        console.error(`Unknown install target: ${opts.target}. Choose from: ${INSTALL_TARGETS.join(', ')}`);
        process.exit(1);
      }
      const { runInstaller } = await import('../installer/index');
      await runInstaller(target as any);
    });
}
