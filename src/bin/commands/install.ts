import { Command } from 'commander';

export function register(program: Command): void {
  program
    .command('install')
    .description('Configure KiroGraph for the current Kiro workspace')
    .action(async () => {
      const { runInstaller } = await import('../installer/index');
      await runInstaller();
    });
}
