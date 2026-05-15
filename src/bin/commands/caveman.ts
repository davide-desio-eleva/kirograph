/**
 * kg caveman [off|lite|full|ultra]   — set caveman mode for this project
 * kg caveman                        — show current mode
 */

import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { loadConfig, updateConfig } from '../../config';
import { CAVEMAN_RULES, CavemanMode } from '../installer/caveman';
import { writeSteering } from '../installer/steering';
import { writeCliAgent } from '../installer/cli-agent';
import { upsertGeneratedBlock } from '../installer/common';
import { buildAgentInstructions } from '../installer/instructions';
import { bold, dim, green, reset, violet } from '../ui';

const JOKES = [
  'Ugh. Words hard. Code easy.',
  'Caveman not need article. Caveman have rock.',
  'Why say lot word when few word do trick?',
  'Token saved = mammoth fed.',
  'Caveman compress speech. Caveman also compress mammoth.',
  'Me not lazy. Me efficient.',
  'Short answer good answer. Long answer... ugh.',
  'Caveman invent fire. Caveman invent brief response.',
  'No filler word. Only meat.',
  'Grunt once. Mean much.',
];

function joke(): string {
  const line = JOKES[Math.floor(Math.random() * JOKES.length)];
  return `\n  ${violet}🪨  ${line}${reset}`;
}

const MODES: Array<{ name: string; desc: string }> = [
  { name: 'off',   desc: 'normal responses' },
  { name: 'lite',  desc: 'compact, no filler, full sentences' },
  { name: 'full',  desc: 'fragments, no articles, short synonyms' },
  { name: 'ultra', desc: 'maximum compression, abbreviations, → for causality' },
];

export function register(program: Command): void {
  program
    .command('caveman [mode]')
    .description('Set caveman communication style for the Kiro agent (off | lite | full | ultra)')
    .action(async (mode: string | undefined) => {
      const cwd = process.cwd();

      // No mode argument: show current status
      if (!mode) {
        let current = 'off';
        try {
          const config = await loadConfig(cwd);
          current = config.cavemanMode ?? 'off';
        } catch { /* no .kirograph/ */ }

        console.log();
        console.log(`  ${dim}Caveman mode${reset}  ${violet}${bold}${current}${reset}`);
        console.log();
        console.log(`  ${dim}Available modes:${reset}`);
        for (const m of MODES) {
          const active = m.name === current;
          const marker = active ? `${green}●${reset}` : `${dim}○${reset}`;
          const nameStr = active ? `${violet}${bold}${m.name}${reset}` : `${dim}${m.name}${reset}`;
          const nameW = m.name.length;
          const pad = ' '.repeat(6 - nameW);
          console.log(`    ${marker} ${nameStr}${pad}${dim}${m.desc}${reset}`);
        }
        console.log();
        console.log(`  ${dim}Change:${reset} kg caveman ${dim}<mode>${reset}`);
        console.log(joke());
        console.log();
        return;
      }

      const normalized = mode.toLowerCase();
      const valid = MODES.map(m => m.name);
      if (!valid.includes(normalized)) {
        console.error(`  ${dim}Unknown mode:${reset} ${normalized}${dim}. Choose from: off, lite, full, ultra${reset}`);
        process.exit(1);
      }

      await updateConfig(cwd, { cavemanMode: normalized as CavemanMode | 'off' });

      const kiroDir = path.join(cwd, '.kiro');

      // Regenerate steering file if .kiro/steering/kirograph.md exists
      const steeringPath = path.join(kiroDir, 'steering', 'kirograph.md');
      if (fs.existsSync(steeringPath)) {
        writeSteering(kiroDir, normalized as CavemanMode | 'off');
      }

      // Regenerate CLI agent config if .kiro/agents/kirograph.json exists
      const agentPath = path.join(kiroDir, 'agents', 'kirograph.json');
      if (fs.existsSync(agentPath)) {
        writeCliAgent(kiroDir);
      }

      for (const file of ['claude.md', 'codex.md']) {
        const instructionsPath = path.join(cwd, '.kirograph', file);
        if (fs.existsSync(instructionsPath)) {
          fs.writeFileSync(instructionsPath, buildAgentInstructions(normalized as CavemanMode | 'off'));
        }
      }
      const agentsPath = path.join(cwd, 'AGENTS.md');
      if (fs.existsSync(agentsPath) && fs.readFileSync(agentsPath, 'utf8').includes('<!-- kirograph:codex:start -->')) {
        upsertGeneratedBlock(agentsPath, 'codex', '## KiroGraph', buildAgentInstructions(normalized as CavemanMode | 'off'));
      }

      console.log();
      if (normalized === 'off') {
        console.log(`  ${green}✓${reset} Caveman mode ${violet}${bold}off${reset}${dim} — agent will respond normally from next session.${reset}`);
        console.log(joke());
      } else {
        console.log(`  ${green}✓${reset} Caveman mode set to ${violet}${bold}${normalized}${reset}`);
        console.log(`  ${dim}Takes effect on next agent session.${reset}`);
        console.log();
        console.log(`  ${dim}Rules preview:${reset}`);
        console.log();
        for (const line of CAVEMAN_RULES[normalized].split('\n')) {
          if (line.startsWith('## ')) {
            console.log(`  ${violet}${bold}${line.slice(3)}${reset}`);
          } else if (line === '') {
            console.log();
          } else {
            console.log(`  ${dim}${line}${reset}`);
          }
        }
        console.log(joke());
      }
      console.log();
    });
}
