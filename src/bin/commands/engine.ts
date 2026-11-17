/**
 * kg engine            — show the index engine in use, and whether the native one is available
 * kg engine node|rust  — set it for this project
 */

import { Command } from 'commander';
import { loadConfig, updateConfig } from '../../config';
import { effectiveEngine, loadRustEngine, rustEngineFallback } from '../../core/rust-engine';
import { bold, dim, green, reset, violet } from '../ui';

const ENGINES = [
  { name: 'node', desc: 'TypeScript + WASM. Works everywhere.' },
  { name: 'rust', desc: 'native: parsing, writing and resolution on every core; same graph, faster on large repositories' },
] as const;

export function register(program: Command): void {
  program
    .command('engine [name]')
    .description('Show or set the index engine (node | rust)')
    .action(async (name: string | undefined) => {
      const cwd = process.cwd();
      const config = await loadConfig(cwd);

      if (!name) {
        const configured = config.engine ?? 'node';
        const inUse = effectiveEngine(config);
        const fallback = rustEngineFallback(config);
        console.log();
        console.log(`  ${dim}Index engine${reset}  ${violet}${bold}${fallback ? 'node' : inUse}${reset}`);
        if (inUse !== configured) console.log(`  ${dim}(KIROGRAPH_ENGINE overrides "${configured}" from config.json)${reset}`);
        if (fallback) console.log(`  \x1b[33m⚠ ${fallback}${reset}`);
        console.log();
        for (const e of ENGINES) {
          const active = e.name === configured;
          const marker = active ? `${green}●${reset}` : `${dim}○${reset}`;
          const label = active ? `${violet}${bold}${e.name}${reset}` : `${dim}${e.name}${reset}`;
          console.log(`    ${marker} ${label}${' '.repeat(6 - e.name.length)}${dim}${e.desc}${reset}`);
        }
        const native = loadRustEngine();
        console.log();
        console.log(`  ${dim}Native module:${reset} ${native ? `${green}available${reset} ${dim}(${native.nativeLanguages().length} languages)${reset}` : `${dim}not installed for ${process.platform}-${process.arch}${reset}`}`);
        console.log(`  ${dim}Change:${reset} kg engine ${dim}<node|rust>${reset}`);
        console.log();
        return;
      }

      const engine = name.toLowerCase();
      if (engine !== 'node' && engine !== 'rust') {
        console.error(`  ${dim}Unknown engine:${reset} ${name}${dim}. Choose node or rust.${reset}`);
        process.exit(1);
      }
      await updateConfig(cwd, { engine });
      console.log();
      console.log(`  ${green}✓${reset} Index engine set to ${violet}${bold}${engine}${reset}`);
      if (engine === 'rust') {
        if (loadRustEngine()) {
          console.log(`  ${dim}The native module is available. Index and sync use it from now on; the graph stays as it is.${reset}`);
        } else {
          console.log(`  \x1b[33m⚠ No native module for ${process.platform}-${process.arch}: index and sync keep using node.${reset}`);
          console.log(`  ${dim}From a source checkout: cd native/kirograph-rust && npm install && npm run build${reset}`);
        }
      }
      console.log();
    });
}
