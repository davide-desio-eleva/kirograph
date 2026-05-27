/**
 * kirograph budget — Context budget governance CLI command
 */

import { Command } from 'commander';

export function register(program: Command): void {
  program
    .command('budget')
    .description('Show current session context budget usage')
    .option('--reset', 'Reset session budget counters')
    .option('--json', 'Output as JSON')
    .action(async (opts: { reset?: boolean; json?: boolean }) => {
      const { BudgetTracker } = await import('../../compression/tracker');
      const projectRoot = process.cwd();

      // Load budget config from .kirograph/config.json if available
      let budgetConfig: { maxTokensPerSession?: number; warnAt?: number; throttleAt?: number } | undefined;
      try {
        const { loadConfig } = await import('../../config');
        const config = await loadConfig(projectRoot);
        if (config.contextBudget) {
          budgetConfig = config.contextBudget;
        }
      } catch { /* no config — use defaults */ }

      const budget = BudgetTracker.getInstance(projectRoot, budgetConfig);

      if (opts.reset) {
        budget.reset();
        if (opts.json) {
          console.log(JSON.stringify({ reset: true }));
        } else {
          console.log('  Context budget counters reset.');
        }
        return;
      }

      const status = budget.getStatus();

      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      console.log(`\n  Context Budget:`);
      console.log(`  ${'─'.repeat(40)}`);
      console.log(`  Tokens consumed: ${status.consumed.toLocaleString()}`);
      console.log(`  Budget limit:    ${status.limit > 0 ? status.limit.toLocaleString() : 'unlimited'}`);
      console.log(`  Remaining:       ${status.limit > 0 ? status.remaining.toLocaleString() : '∞'}`);
      console.log(`  Utilization:     ${status.utilization}%`);

      if (status.warning) {
        console.log(`\n  ⚠ ${status.warning}`);
      }

      console.log();
    });
}
