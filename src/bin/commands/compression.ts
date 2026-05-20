/**
 * kg compression [off|normal|aggressive|ultra]   — set compression level for this project
 * kg compression                                 — show current level
 */

import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import { loadConfig, updateConfig, KiroGraphConfig } from '../../config';
import { writeSteering } from '../installer/steering';
import { writeHooks } from '../installer/hooks';
import { bold, dim, green, reset, violet } from '../ui';

type CompressionLevel = KiroGraphConfig['compressionLevel'];

const LEVELS: Array<{ name: string; desc: string }> = [
  { name: 'off',        desc: 'no compression hook or steering (tool still available)' },
  { name: 'normal',     desc: 'balanced: removes noise, keeps structure' },
  { name: 'aggressive', desc: 'more compact: groups by category, limits output' },
  { name: 'ultra',      desc: 'maximum compression: counts and summaries only' },
];

export function register(program: Command): void {
  program
    .command('compression [level]')
    .description('Set output compression level for kirograph_exec (off | normal | aggressive | ultra)')
    .action(async (level: string | undefined) => {
      const cwd = process.cwd();

      // No argument: show current status
      if (!level) {
        let current: CompressionLevel = 'normal';
        try {
          const config = await loadConfig(cwd);
          current = config.compressionLevel ?? 'normal';
        } catch { /* no .kirograph/ */ }

        console.log();
        console.log(`  ${dim}Output compression${reset}  ${violet}${bold}${current}${reset}`);
        console.log();
        console.log(`  ${dim}Available levels:${reset}`);
        for (const l of LEVELS) {
          const active = l.name === current;
          const marker = active ? `${green}●${reset}` : `${dim}○${reset}`;
          const nameStr = active ? `${violet}${bold}${l.name}${reset}` : `${dim}${l.name}${reset}`;
          const nameW = l.name.length;
          const pad = ' '.repeat(12 - nameW);
          console.log(`    ${marker} ${nameStr}${pad}${dim}${l.desc}${reset}`);
        }
        console.log();
        console.log(`  ${dim}Change:${reset} kg compression ${dim}<level>${reset}`);
        console.log();
        return;
      }

      // Support legacy "on" → "normal"
      const normalized = level.toLowerCase() === 'on' ? 'normal' : level.toLowerCase();
      const valid = LEVELS.map(l => l.name);
      if (!valid.includes(normalized)) {
        console.error(`  ${dim}Unknown level:${reset} ${normalized}${dim}. Choose from: off, normal, aggressive, ultra${reset}`);
        process.exit(1);
      }

      const compressionLevel = normalized as CompressionLevel;
      const config = await updateConfig(cwd, { compressionLevel });
      const enableCompression = compressionLevel !== 'off';

      const kiroDir = path.join(cwd, '.kiro');

      // Regenerate steering file if it exists
      const steeringPath = path.join(kiroDir, 'steering', 'kirograph.md');
      if (fs.existsSync(steeringPath)) {
        writeSteering(kiroDir, { cavemanMode: config.cavemanMode, enableCompression, compressionLevel });
      }

      // Regenerate hooks if hooks dir exists
      const hooksDir = path.join(kiroDir, 'hooks');
      if (fs.existsSync(hooksDir)) {
        writeHooks(kiroDir, { enableCompression });
      }

      console.log();
      if (compressionLevel === 'off') {
        console.log(`  ${green}✓${reset} Output compression ${violet}${bold}off${reset}`);
        console.log(`  ${dim}kirograph_exec is still available but the agent won't be prompted to use it.${reset}`);
        console.log(`  ${dim}The compression hook and steering section have been removed.${reset}`);
      } else {
        console.log(`  ${green}✓${reset} Output compression set to ${violet}${bold}${compressionLevel}${reset}`);
        console.log(`  ${dim}kirograph_exec will use "${compressionLevel}" as the default level.${reset}`);
        console.log(`  ${dim}The agent will be guided to use it for git, test, lint, build, and docker commands.${reset}`);
      }
      console.log(`  ${dim}Takes effect on next agent session.${reset}`);
      console.log();
    });
}
