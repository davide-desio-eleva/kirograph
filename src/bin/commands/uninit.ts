import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { printBanner } from '../banner';
import { dim, reset, violet, bold, green } from '../ui';
import { askToggle } from '../installer/prompts';
import type { InstallTarget } from '../installer/common';
import { getTargetInstaller } from '../installer/targets';

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

const ALL_TARGETS: InstallTarget[] = [
  'kiro', 'claude', 'codex', 'cursor', 'antigravity', 'opencode',
  'windsurf', 'cline', 'copilot', 'junie', 'gemini-cli',
  'continue', 'roo', 'warp', 'aider', 'trae',
  'augment', 'kilo', 'amp', 'devin', 'replit', 'goose', 'openhands', 'tabnine',
  'mistral-vibe', 'ibm-bob', 'crush', 'droid-factory', 'forgecode', 'iflow', 'qwen', 'rovo', 'qoder',
];

function isValidTarget(t: string): t is InstallTarget | 'all' {
  return t === 'all' || ALL_TARGETS.includes(t as InstallTarget);
}

function uninitKiro(projectRoot: string): void {
  // Remove .kiro hooks created by kirograph (v2 .json format)
  const kiroHooks = [
    'kirograph-sync-if-dirty.json',
    'kirograph-compress-hint.json',
    'kirograph-mem-capture.json',
    'kirograph-watchmen.json',
    'kirograph-wiki-ingest.json',
    'kirograph-wiki-lint.json',
    // Legacy v1 .kiro.hook filenames
    'kirograph-mark-dirty-on-save.kiro.hook',
    'kirograph-mark-dirty-on-create.kiro.hook',
    'kirograph-sync-on-delete.kiro.hook',
    'kirograph-sync-if-dirty.kiro.hook',
    'kirograph-compress-hint.kiro.hook',
    'kirograph-mem-capture.kiro.hook',
    'kirograph-watchmen.kiro.hook',
    'kirograph-wiki-ingest.kiro.hook',
    'kirograph-wiki-lint.kiro.hook',
    // Legacy pre-v1 .json filenames (different schema)
    'kirograph-mark-dirty-on-save.json',
    'kirograph-mark-dirty-on-create.json',
    'kirograph-sync-on-delete.json',
    'kirograph-sync-on-save.json',
    'kirograph-sync-on-create.json',
  ];
  const hooksDir = path.join(projectRoot, '.kiro', 'hooks');
  let removedHooks = 0;
  for (const hook of kiroHooks) {
    const p = path.join(hooksDir, hook);
    if (fs.existsSync(p)) { fs.unlinkSync(p); removedHooks++; }
  }
  if (removedHooks > 0) console.log(`  ${green}✓${reset} Removed ${removedHooks} hook(s) from .kiro/hooks/`);

  // Remove .kiro/steering/kirograph*.md (main + all workflow files)
  const steeringDir = path.join(projectRoot, '.kiro', 'steering');
  let removedSteering = 0;
  if (fs.existsSync(steeringDir)) {
    for (const entry of fs.readdirSync(steeringDir)) {
      if (entry.startsWith('kirograph') && entry.endsWith('.md')) {
        fs.unlinkSync(path.join(steeringDir, entry));
        removedSteering++;
      }
    }
  }
  if (removedSteering > 0) {
    console.log(`  ${green}✓${reset} Removed ${removedSteering} steering file(s) from .kiro/steering/`);
  }

  // Remove .kiro/agents/kirograph.json
  const agentPath = path.join(projectRoot, '.kiro', 'agents', 'kirograph.json');
  if (fs.existsSync(agentPath)) {
    fs.unlinkSync(agentPath);
    console.log(`  ${green}✓${reset} Removed .kiro/agents/kirograph.json`);
  }

  // Remove kirograph server from .kiro/settings/mcp.json
  const { removeMcpServersConfig } = require('../installer/common');
  const mcpPath = path.join(projectRoot, '.kiro', 'settings', 'mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ${green}✓${reset} Removed kirograph from .kiro/settings/mcp.json`);
  }
}

async function runUninit(projectPath: string | undefined, opts: { force?: boolean; target?: string }): Promise<void> {
  const projectRoot = path.resolve(projectPath ?? process.cwd());
  const targetName = (opts.target ?? 'kiro').toLowerCase();

  if (!isValidTarget(targetName)) {
    console.error(`Unknown uninit target: ${opts.target}. Choose from: ${ALL_TARGETS.join(', ')}, all`);
    process.exit(1);
  }

  const dir = path.join(projectRoot, '.kirograph');
  if (!fs.existsSync(dir)) { console.log('Not initialized.'); return; }

  let removeIntegration = true;
  let removeGraph = opts.force === true;

  if (!opts.force) {
    printBanner();
    const farewell = UNINIT_FAREWELLS[Math.floor(Math.random() * UNINIT_FAREWELLS.length)]!;
    console.log(`  ${violet}${bold}${farewell}${reset}`);
    console.log(`\n  ${dim}This can remove ${targetName} integration files and, separately, the shared .kirograph/ data.${reset}`);
    console.log(`  ${dim}Your source code is untouched.${reset}`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    removeIntegration = await askToggle(rl, `Remove ${targetName} integration files?`, 'Removes hooks, MCP config, rules, and agent instructions for this target.', false);
    removeGraph = await askToggle(rl, 'Remove shared .kirograph/ data too?', 'Deletes the graph database, snapshots, and all indexed data. Cannot be undone.', false);

    rl.close();

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

  if (removeIntegration) {
    const targets: InstallTarget[] = targetName === 'all' ? [...ALL_TARGETS] : [targetName as InstallTarget];

    for (const t of targets) {
      if (t === 'kiro') {
        uninitKiro(projectRoot);
      } else {
        const installer = getTargetInstaller(t);
        installer.uninit?.(projectRoot);
      }
    }
  }

  console.log(`\n  ${dim}Done. Run ${violet}kirograph install --target ${targetName === 'all' ? 'kiro' : targetName}${reset}${dim} to come back anytime.${reset}\n`);
}

export function register(program: Command): void {
  program
    .command('uninit [projectPath]')
    .description('Remove KiroGraph from a project')
    .option('--force', 'Skip confirmation')
    .option('--target <target>', `Integration target to clean up (or "all"): ${ALL_TARGETS.slice(0, 6).join(', ')}, ...`, 'kiro')
    .action(runUninit);

  program
    .command('uninstall [projectPath]')
    .description('Alias for uninit. Remove KiroGraph from a project')
    .option('--force', 'Skip confirmation')
    .option('--target <target>', `Integration target to clean up (or "all"): ${ALL_TARGETS.slice(0, 6).join(', ')}, ...`, 'kiro')
    .action(runUninit);
}
