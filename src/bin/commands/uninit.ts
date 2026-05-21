import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { printBanner } from '../banner';
import { dim, reset, violet, bold, green } from '../ui';

export const UNINIT_FAREWELLS = [
  "Oh. So it's come to this.",
  "We're sorry to see you go. (Are we? Yes. We are.)",
  "Deleting months of carefully indexed knowledge. Bold move.",
  "Fine. We'll just sit here in the dark.",
  "You can always come back. We won't mention this.",
  "The graph remembers everything. Except, soon, anything.",
  "Somewhere a tree-sitter is crying.",
  "Uninstalling... and pretending it doesn't hurt.",
  "574 embeddings. Gone. Just like that.",
  "See you on the other side of `kirograph install`.",
];

type UninitTarget = 'kiro' | 'claude' | 'codex' | 'all';

const UNINIT_TARGETS: UninitTarget[] = ['kiro', 'claude', 'codex', 'all'];

async function confirm(question: string): Promise<boolean> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>(resolve => rl.question(question, ans => {
    rl.close();
    resolve(ans.toLowerCase() === 'y');
  }));
}

async function runUninit(projectPath: string | undefined, opts: { force?: boolean; target?: string }): Promise<void> {
  const target = path.resolve(projectPath ?? process.cwd());
  const integration = (opts.target ?? 'kiro').toLowerCase() as UninitTarget;
  if (!UNINIT_TARGETS.includes(integration)) {
    console.error(`Unknown uninit target: ${opts.target}. Choose from: kiro, claude, codex, all`);
    process.exit(1);
  }
  const dir = path.join(target, '.kirograph');
  if (!fs.existsSync(dir)) { console.log('Not initialized.'); return; }

  let removeIntegration = true;
  let removeGraph = opts.force === true;

  if (!opts.force) {
    printBanner();
    const farewell = UNINIT_FAREWELLS[Math.floor(Math.random() * UNINIT_FAREWELLS.length)]!;
    console.log(`  ${violet}${bold}${farewell}${reset}`);
    console.log(`\n  ${dim}This can remove ${integration} integration files and, separately, the shared .kirograph/ data.${reset}`);
    console.log(`  ${dim}Your source code is untouched.${reset}\n`);

    removeIntegration = await confirm(`  ${violet}Remove ${integration} integration files?${reset} ${dim}(y/N)${reset} `);
    removeGraph = await confirm(`  ${violet}Remove shared .kirograph/ data too?${reset} ${dim}(y/N)${reset} `);

    if (!removeIntegration && !removeGraph) {
      console.log(`\n  ${dim}Cancelled. Nothing removed.${reset}\n`);
      return;
    }
    console.log();
  }

  if (removeGraph) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  ${green}✓${reset} Removed .kirograph/`);
  }

  if (removeIntegration && (integration === 'kiro' || integration === 'all')) {
    // Remove .kiro hooks created by kirograph
    const kiroHooks = [
      'kirograph-mark-dirty-on-save.kiro.hook',
      'kirograph-mark-dirty-on-create.kiro.hook',
      'kirograph-sync-on-delete.kiro.hook',
      'kirograph-sync-if-dirty.kiro.hook',
      'kirograph-compress-hint.kiro.hook',
      // Legacy .json filenames
      'kirograph-mark-dirty-on-save.json',
      'kirograph-mark-dirty-on-create.json',
      'kirograph-sync-on-delete.json',
      'kirograph-sync-if-dirty.json',
      'kirograph-sync-on-save.json',
      'kirograph-sync-on-create.json',
      'kirograph-compress-hint.json',
    ];
    const hooksDir = path.join(target, '.kiro', 'hooks');
    let removedHooks = 0;
    for (const hook of kiroHooks) {
      const p = path.join(hooksDir, hook);
      if (fs.existsSync(p)) { fs.unlinkSync(p); removedHooks++; }
    }
    if (removedHooks > 0) console.log(`  ${green}✓${reset} Removed ${removedHooks} hook(s) from .kiro/hooks/`);

    // Remove .kiro/steering/kirograph.md
    const steeringPath = path.join(target, '.kiro', 'steering', 'kirograph.md');
    if (fs.existsSync(steeringPath)) {
      fs.unlinkSync(steeringPath);
      console.log(`  ${green}✓${reset} Removed .kiro/steering/kirograph.md`);
    }

    // Remove .kiro/agents/kirograph.json
    const agentPath = path.join(target, '.kiro', 'agents', 'kirograph.json');
    if (fs.existsSync(agentPath)) {
      fs.unlinkSync(agentPath);
      console.log(`  ${green}✓${reset} Removed .kiro/agents/kirograph.json`);
    }

    // Remove kirograph server from .kiro/settings/mcp.json
    const { removeMcpServersConfig } = await import('../installer/common');
    const mcpPath = path.join(target, '.kiro', 'settings', 'mcp.json');
    if (removeMcpServersConfig(mcpPath)) {
      console.log(`  ${green}✓${reset} Removed kirograph from .kiro/settings/mcp.json`);
    }
  }

  if (removeIntegration && (integration === 'claude' || integration === 'all')) {
    const { uninitClaude } = await import('../installer/targets/claude');
    uninitClaude(target);
  }

  if (removeIntegration && (integration === 'codex' || integration === 'all')) {
    const { uninitCodex } = await import('../installer/targets/codex');
    uninitCodex(target);
  }

  console.log(`\n  ${dim}Done. Run ${violet}kirograph install --target ${integration === 'all' ? 'kiro' : integration}${reset}${dim} to come back anytime.${reset}\n`);
}

export function register(program: Command): void {
  program
    .command('uninit [projectPath]')
    .description('Remove KiroGraph from a project')
    .option('--force', 'Skip confirmation')
    .option('--target <target>', 'Integration target to clean up: kiro, claude, codex, or all', 'kiro')
    .action(runUninit);

  program
    .command('uninstall [projectPath]')
    .description('Alias for uninit. Remove KiroGraph from a project')
    .option('--force', 'Skip confirmation')
    .option('--target <target>', 'Integration target to clean up: kiro, claude, codex, or all', 'kiro')
    .action(runUninit);
}
