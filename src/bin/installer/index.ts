/**
 * KiroGraph Installer
 *
 * The default target wires up Kiro:
 *  1. .kiro/settings/mcp.json        — registers the MCP server (IDE + CLI)
 *  2. .kiro/hooks/*.json             — auto-sync hooks for Kiro IDE
 *  3. .kiro/steering/kirograph.md    — teaches Kiro to use the graph tools (IDE + CLI)
 *  4. .kiro/agents/kirograph.json    — custom agent config for Kiro CLI
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { loadConfig, updateConfig } from '../../config';
import { printBanner } from '../banner';
import { renderIndexProgress } from '../progress';
import { dim, reset } from '../ui';
import { ask } from './prompts';
import { promptConfigOptions } from './config-prompt';
import { openTypesenseDashboard } from './dashboard';
import { ensureQdrantUI, openQdrantDashboard } from './qdrant-dashboard';
import type { InstallTarget } from './common';
import { getTargetInstaller } from './targets';
import type { CavemanMode } from './caveman';

export async function runInstaller(target: InstallTarget = 'kiro'): Promise<void> {
  printBanner();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const cwd = process.cwd();
    const installer = getTargetInstaller(target);

    console.log(`  Workspace: ${cwd}\n`);

    const proceed = await ask(rl, `  Install KiroGraph for ${installer.label}? (Y/n) `);
    if (proceed.toLowerCase() === 'n') { console.log('  Cancelled.'); rl.close(); return; }
    console.log();

    installer.installEarly(cwd);

    const alreadyInitialized = fs.existsSync(path.join(cwd, '.kirograph'));
    let cavemanMode: CavemanMode | 'off' = 'off';
    let shouldOfferIndex = false;
    let typesenseDashboard = false;
    let qdrantDashboard = false;

    try {
      if (alreadyInitialized) {
        const config = await loadConfig(cwd);
        cavemanMode = config.cavemanMode ?? 'off';
        console.log(`  ✓ Reusing existing KiroGraph data in ${cwd}/.kirograph/`);
        console.log(`  • semanticEngine: ${config.semanticEngine}`);
        console.log(`  • enableEmbeddings: ${config.enableEmbeddings}`);
        console.log(`  • enableArchitecture: ${config.enableArchitecture}`);
        console.log(`  • cavemanMode: ${cavemanMode}`);
      } else {
        shouldOfferIndex = true;
        const patch = await promptConfigOptions(rl);
        await updateConfig(cwd, patch);
        cavemanMode = patch.cavemanMode ?? 'off';
        typesenseDashboard = patch.typesenseDashboard;
        qdrantDashboard = patch.qdrantDashboard;

        console.log(`\n  Configuration saved to ${cwd}/.kirograph/config.json`);
        console.log(`  • enableEmbeddings: ${patch.enableEmbeddings}`);
        if ('embeddingModel' in patch) {
          console.log(`  • embeddingModel: ${patch.embeddingModel}  ${dim}(${patch.embeddingDim}-dim)${reset}`);
        }
        if (patch.enableEmbeddings) {
          console.log(`  • semanticEngine: ${patch.semanticEngine}`);
          if (patch.semanticEngine === 'sqlite-vec') {
            console.log(`\n  Installing sqlite-vec dependencies...`);
            const result = spawnSync('npm', ['install', 'better-sqlite3', 'sqlite-vec'], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
              console.log(`  ✓ better-sqlite3 and sqlite-vec installed`);
            } else {
              console.warn(`  ✗ npm install failed (exit ${result.status}). Run manually:`);
              console.warn(`    npm install better-sqlite3 sqlite-vec`);
            }
          } else if (patch.semanticEngine === 'orama') {
            console.log(`\n  Installing Orama dependencies...`);
            const result = spawnSync('npm', ['install', '@orama/orama', '@orama/plugin-data-persistence'], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
              console.log(`  ✓ @orama/orama and @orama/plugin-data-persistence installed`);
            } else {
              console.warn(`  ✗ npm install failed (exit ${result.status}). Run manually:`);
              console.warn(`    npm install @orama/orama @orama/plugin-data-persistence`);
            }
          } else if (patch.semanticEngine === 'pglite') {
            console.log(`\n  Installing PGlite dependencies...`);
            const result = spawnSync('npm', ['install', '@electric-sql/pglite'], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
              console.log(`  ✓ @electric-sql/pglite installed`);
            } else {
              console.warn(`  ✗ npm install failed (exit ${result.status}). Run manually:`);
              console.warn(`    npm install @electric-sql/pglite`);
            }
          } else if (patch.semanticEngine === 'lancedb') {
            console.log(`\n  Installing LanceDB dependencies...`);
            const result = spawnSync('npm', ['install', '@lancedb/lancedb'], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
              console.log(`  ✓ @lancedb/lancedb installed`);
            } else {
              console.warn(`  ✗ npm install failed (exit ${result.status}). Run manually:`);
              console.warn(`    npm install @lancedb/lancedb`);
            }
          } else if (patch.semanticEngine === 'qdrant') {
            console.log(`\n  Installing Qdrant dependencies...`);
            const result = spawnSync('npm', ['install', 'qdrant-local'], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
              console.log(`  ✓ qdrant-local installed`);
            } else {
              console.warn(`  ✗ npm install failed (exit ${result.status}). Run manually:`);
              console.warn(`    npm install qdrant-local`);
            }
          } else if (patch.semanticEngine === 'typesense') {
            console.log(`\n  Installing Typesense dependencies...`);
            const result = spawnSync('npm', ['install', 'typesense'], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
              console.log(`  ✓ typesense installed`);
              console.log(`  ℹ  The Typesense binary (~37MB) will be auto-downloaded on first index run.`);
            } else {
              console.warn(`  ✗ npm install failed (exit ${result.status}). Run manually:`);
              console.warn(`    npm install typesense`);
            }
          }
        }
        console.log(`  • extractDocstrings: ${patch.extractDocstrings}`);
        console.log(`  • trackCallSites: ${patch.trackCallSites}`);
        console.log(`  • enableArchitecture: ${patch.enableArchitecture}`);
        console.log(`  • cavemanMode: ${cavemanMode}`);
      }

      installer.installLate(cwd, cavemanMode);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Failed to write configuration: ${reason}`);
      process.exit(1);
    }

    // 5. Pre-download Qdrant UI before indexing so Qdrant starts with static content dir
    if (qdrantDashboard) {
      await ensureQdrantUI(cwd);
    }

    // 6. Optionally init + index
    if (shouldOfferIndex && (await ask(rl, '\n  Initialize and index this project now? (Y/n) ')).toLowerCase() !== 'n') {
      const KiroGraph = (await import('../../index')).default;

      const fileBytes = new Map<string, { loaded: number; total: number }>();
      const modelProgress = (file: string, loaded: number, total: number, done: boolean): void => {
        const entry = fileBytes.get(file) ?? { loaded: 0, total: 0 };
        if (total > 0) entry.total = total;
        entry.loaded = done ? entry.total : loaded;
        fileBytes.set(file, entry);

        // Only count files where we know the size (content-length was present)
        const knownFiles = Array.from(fileBytes.values()).filter(f => f.total > 0);
        const totalLoaded = knownFiles.reduce((s, f) => s + f.loaded, 0);
        const totalBytes = knownFiles.reduce((s, f) => s + f.total, 0);
        const pct = totalBytes > 0 ? Math.min((totalLoaded / totalBytes) * 100, 100) : 0;

        const filled = Math.round(pct / 5);
        const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
        const mb = (totalLoaded / 1024 / 1024).toFixed(1);
        const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
        process.stdout.write(`\r  [${bar}] ${pct.toFixed(0).padStart(3)}%  ${mb} / ${totalMb} MB   `);
      };

      // Suppress noisy internal warnings from @huggingface/transformers during download
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      const stderrFilter = (chunk: unknown, ...args: unknown[]): boolean => {
        const str = typeof chunk === 'string' ? chunk : String(chunk);
        if (str.includes('content-length') || str.includes('dtype not specified')) return true;
        return (originalStderrWrite as (...a: unknown[]) => boolean)(chunk, ...args);
      };
      process.stderr.write = stderrFilter as typeof process.stderr.write;

      let cg;
      try {
        if (!KiroGraph.isInitialized(cwd)) {
          process.stdout.write('  Downloading embedding model…\n');
          cg = await KiroGraph.init(cwd, undefined, modelProgress);
          process.stdout.write('\n');
          console.log('  ✓ Created .kirograph/');
        } else {
          cg = await KiroGraph.open(cwd, modelProgress);
          if (fileBytes.size > 0) process.stdout.write('\n');
        }
      } finally {
        process.stderr.write = originalStderrWrite;
      }
      console.log('  Indexing...');
      const result = await cg.indexAll({ onProgress: renderIndexProgress });
      process.stdout.write('\n');
      console.log(`  ✓ Indexed ${result.filesIndexed} files, ${result.nodesCreated} symbols, ${result.edgesCreated} edges`);
      cg.close();

      if (typesenseDashboard) {
        const dashboardServer = await openTypesenseDashboard(cwd);
        console.log(`  ${dim}Press Ctrl+C to stop the dashboard server when done.${reset}`);
        await new Promise<void>(resolve => {
          process.on('SIGINT', () => {
            if (dashboardServer) {
              dashboardServer.close(() => resolve());
            } else {
              resolve();
            }
          });
        });
        return; // rl.close() handled in finally
      }

      if (qdrantDashboard) {
        await openQdrantDashboard(cwd);
      }
    }

    installer.printNextSteps(cwd);
  } finally {
    rl.close();
  }
}
