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

async function runUninit(projectPath: string | undefined, opts: { force?: boolean; target?: string }): Promise<void> {
  const target = path.resolve(projectPath ?? process.cwd());
  const integration = (opts.target ?? 'kiro').toLowerCase() as UninitTarget;
  if (!UNINIT_TARGETS.includes(integration)) {
    console.error(`Unknown uninit target: ${opts.target}. Choose from: kiro, claude, codex, all`);
    process.exit(1);
  }
  const dir = path.join(target, '.kirograph');
  if (!fs.existsSync(dir)) { console.log('Not initialized.'); return; }
  if (!opts.force) {
    printBanner();
    const farewell = UNINIT_FAREWELLS[Math.floor(Math.random() * UNINIT_FAREWELLS.length)]!;
    console.log(`  ${violet}${bold}${farewell}${reset}`);
    console.log(`\n  ${dim}This will remove .kirograph/ and ${integration} integration files.${reset}`);
    console.log(`  ${dim}Your source code is untouched.${reset}\n`);
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>(resolve => rl.question(`  ${violet}Remove KiroGraph from this project?${reset} ${dim}(y/N)${reset} `, ans => {
      rl.close();
      if (ans.toLowerCase() !== 'y') {
        console.log(`\n  ${dim}Cancelled. The graph lives on.${reset}\n`);
        process.exit(0);
      }
      resolve();
    }));
    console.log();
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`  ${green}✓${reset} Removed .kirograph/`);

  if (integration === 'kiro' || integration === 'all') {
    // Remove .kiro hooks created by kirograph
    const kiroHooks = [
      'kirograph-mark-dirty-on-save.json',
      'kirograph-mark-dirty-on-create.json',
      'kirograph-sync-on-delete.json',
      'kirograph-sync-if-dirty.json',
      'kirograph-sync-on-save.json',
      'kirograph-sync-on-create.json',
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
  }

  if (integration === 'claude' || integration === 'all') {
    const { uninitClaude } = await import('../installer/targets/claude');
    uninitClaude(target);
  }

  if (integration === 'codex' || integration === 'all') {
    const { uninitCodex } = await import('../installer/targets/codex');
    uninitCodex(target);
  }

  console.log(`\n  ${dim}Done. Run ${violet}kirograph install${reset}${dim} to come back anytime.${reset}\n`);
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
    .description('Alias for uninit — remove KiroGraph from a project')
    .option('--force', 'Skip confirmation')
    .option('--target <target>', 'Integration target to clean up: kiro, claude, codex, or all', 'kiro')
    .action(runUninit);
}
