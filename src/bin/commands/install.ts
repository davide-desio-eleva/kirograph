import { Command } from 'commander';

const INSTALL_TARGETS = ['kiro', 'claude', 'codex'];

export function register(program: Command): void {
  program
    .command('install')
    .description('Configure KiroGraph for an agent workspace')
    .option('--target <target>', 'Integration target: kiro, claude, or codex', 'kiro')
    .action(async (opts: { target: string }) => {
      const target = opts.target.toLowerCase();
      if (!INSTALL_TARGETS.includes(target)) {
        console.error(`Unknown install target: ${opts.target}. Choose from: kiro, claude, codex`);
        process.exit(1);
      }
      const { runInstaller } = await import('../installer/index');
      await runInstaller(target as 'kiro' | 'claude' | 'codex');
    });
}
