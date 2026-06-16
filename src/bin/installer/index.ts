/**
 * KiroGraph Installer
 *
 * The default target wires up Kiro:
 *  1. .kiro/settings/mcp.json        — registers the MCP server (IDE + CLI)
 *  2. .kiro/hooks/*.kiro.hook       — auto-sync hooks for Kiro IDE
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
import { ask, askToggle } from './prompts';
import { promptConfigOptions } from './config-prompt';
import { openTypesenseDashboard } from './dashboard';
import { ensureQdrantUI, openQdrantDashboard } from './qdrant-dashboard';
import type { InstallTarget } from './common';
import { getTargetInstaller } from './targets';
import type { CavemanMode } from './caveman';
import { applyImportedGlobalHooks } from '../../hooks/import-prompt';

function _findRustc(): string | null {
  // Check PATH first, then the default rustup install location
  const inPath = spawnSync('rustc', ['--version'], { encoding: 'utf8', shell: true });
  if (inPath.status === 0) return 'rustc';
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const cargoRustc = path.join(home, '.cargo', 'bin', 'rustc');
  if (fs.existsSync(cargoRustc)) return cargoRustc;
  return null;
}

function _installTurbovecAddon(): void {
  const nativeDir = path.join(__dirname, '..', '..', '..', 'native', 'turbovec-node');
  const hasAddon = fs.existsSync(nativeDir) &&
    fs.readdirSync(nativeDir).some(f => f.startsWith('turbovec_node.') && f.endsWith('.node'));

  if (hasAddon) {
    console.log(`  ✓ turbovec-node addon already built`);
    return;
  }

  // Ensure Rust toolchain — install via rustup if missing
  let rustc = _findRustc();
  if (!rustc) {
    console.log(`\n  Rust toolchain not found. Installing via rustup...`);
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      console.warn(`  ✗ Automated rustup install is not supported on Windows.`);
      console.warn(`    Download rustup-init.exe from https://rustup.rs and re-run kirograph install.`);
      return;
    }
    const rustup = spawnSync(
      'sh',
      ['-c', 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path'],
      { stdio: 'inherit', shell: false },
    );
    if (rustup.status !== 0) {
      console.warn(`  ✗ rustup install failed. Install Rust manually: https://rustup.rs`);
      console.warn(`    Then: cd native/turbovec-node && npm install && npm run build`);
      return;
    }
    rustc = _findRustc();
    if (!rustc) {
      console.warn(`  ✗ rustc still not found after rustup install. Re-run kirograph install in a new shell.`);
      return;
    }
    console.log(`  ✓ Rust installed: ${spawnSync(rustc, ['--version'], { encoding: 'utf8' }).stdout?.trim()}`);
  } else {
    console.log(`  ✓ Rust: ${spawnSync(rustc, ['--version'], { encoding: 'utf8' }).stdout?.trim()}`);
  }

  // Ensure ~/.cargo/bin is on PATH for child processes so cargo/napi-rs cli can find it
  if (!process.env.PATH?.includes('.cargo')) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    process.env.PATH = `${path.join(home, '.cargo', 'bin')}:${process.env.PATH ?? ''}`;
  }

  console.log(`\n  Building turbovec-node native addon (Rust/napi-rs)...`);
  console.log(`  This may take a few minutes on first build.`);

  const npmInstall = spawnSync('npm', ['install'], { cwd: nativeDir, stdio: 'inherit', shell: true });
  if (npmInstall.status !== 0) {
    console.warn(`  ✗ npm install failed in native/turbovec-node`);
    return;
  }

  const build = spawnSync('npm', ['run', 'build'], { cwd: nativeDir, stdio: 'inherit', shell: true });
  if (build.status === 0) {
    console.log(`  ✓ turbovec-node addon built`);
  } else {
    console.warn(`  ✗ Build failed (exit ${build.status}). Run manually:`);
    console.warn(`    cd native/turbovec-node && npm install && npm run build`);
  }
}

export async function runInstaller(target: InstallTarget = 'kiro', opts: { yes?: boolean } = {}): Promise<void> {
  printBanner();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const cwd = process.cwd();
    const installer = getTargetInstaller(target);

    console.log(`  Workspace: ${cwd}\n`);

    if (!opts.yes) {
      const proceed = await askToggle(rl, `Install KiroGraph for ${installer.label}?`, 'Registers the MCP server and writes integration files for this workspace.');
      if (!proceed) { console.log('  Cancelled.'); rl.close(); return; }
    } else {
      console.log(`  Installing KiroGraph for ${installer.label} (--yes)`);
    }
    console.log();

    installer.installEarly(cwd);

    const alreadyInitialized = fs.existsSync(path.join(cwd, '.kirograph'));
    let cavemanMode: CavemanMode | 'off' = 'off';
    let shellCompressionLevel: 'off' | 'normal' | 'aggressive' | 'ultra' = 'normal';
    let enableMemory = false;
    let enableDocs = false;
    let enableData = false;
    let enableSecurity = false;
    let enablePatterns = false;
    let enableArchitecture = false;
    let enableWatchmen = false;
    let watchmenSynthesisMode: 'local' | 'agent' = 'local';
    let enableWiki = false;
    let wikiSynthesisMode: 'local' | 'agent' = 'agent';
    let wikiLocalModel = 'onnx-community/gemma-4-E4B-it-ONNX';
    let shouldOfferIndex = false;
    let typesenseDashboard = false;
    let qdrantDashboard = false;
    let hooksToImport: string[] | null = null;

    try {
      if (alreadyInitialized) {
        const config = await loadConfig(cwd);
        cavemanMode = config.cavemanMode ?? 'off';
        shellCompressionLevel = config.shellCompressionLevel ?? 'normal';
        enableMemory = config.enableMemory ?? false;
        enableDocs = config.enableDocs ?? false;
        enableData = (config as any).enableData ?? false;
        enableSecurity = (config as any).enableSecurity ?? false;
        enableWatchmen = config.enableWatchmen ?? false;
        watchmenSynthesisMode = config.watchmenSynthesisMode ?? 'local';
        enablePatterns = (config as any).enablePatterns ?? false;
        enableArchitecture = config.enableArchitecture ?? false;
        enableWiki = config.enableWiki ?? false;
        wikiSynthesisMode = config.wikiSynthesisMode ?? 'agent';
        wikiLocalModel = config.wikiLocalModel ?? 'onnx-community/gemma-4-E4B-it-ONNX';
        console.log(`  ✓ Reusing existing KiroGraph data in ${cwd}/.kirograph/`);
        console.log(`  • semanticEngine: ${config.semanticEngine}`);
        console.log(`  • enableEmbeddings: ${config.enableEmbeddings}`);
        if (config.enableEmbeddings && config.semanticEngine === 'turboquant') {
          let tqAvailable = false;
          try { require('turboquant-js'); tqAvailable = true; } catch { /* not installed */ }
          if (!tqAvailable) {
            console.log(`\n  Installing TurboQuant dependencies...`);
            const result = spawnSync('npm', ['install', 'turboquant-js'], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
              console.log(`  ✓ turboquant-js installed`);
            } else {
              console.warn(`  ✗ npm install failed (exit ${result.status}). Run manually:`);
              console.warn(`    npm install turboquant-js`);
            }
          }
        }
        if (config.enableEmbeddings && config.semanticEngine === 'turbovec') {
          _installTurbovecAddon();
        }
        console.log(`  • enableArchitecture: ${config.enableArchitecture}`);
        console.log(`  • cavemanMode: ${cavemanMode}`);
        console.log(`  • shellCompressionLevel: ${shellCompressionLevel}`);
        console.log(`  • enableMemory: ${enableMemory}`);
        console.log(`  • enableDocs: ${enableDocs}`);
        console.log(`  • enableData: ${enableData}`);
        console.log(`  • enableSecurity: ${enableSecurity}`);
        console.log(`  • enablePatterns: ${enablePatterns}`);
      } else {
        shouldOfferIndex = true;
        const promptResult = await promptConfigOptions(rl, {
          projectRoot: cwd,
          offerHookImport: target === 'kiro' && !opts.yes,
        });
        const patch = promptResult.patch;
        hooksToImport = promptResult.hooksToImport;
        await updateConfig(cwd, patch);
        cavemanMode = patch.cavemanMode ?? 'off';
        shellCompressionLevel = patch.shellCompressionLevel ?? 'normal';
        enableMemory = patch.enableMemory ?? false;
        enableDocs = patch.enableDocs ?? false;
        enableData = patch.enableData ?? false;
        enableSecurity = patch.enableSecurity ?? false;
        enablePatterns = patch.enablePatterns ?? false;
        enableArchitecture = patch.enableArchitecture ?? false;
        enableWatchmen = patch.enableWatchmen ?? false;
        watchmenSynthesisMode = patch.watchmenSynthesisMode ?? 'local';
        enableWiki = patch.enableWiki ?? false;
        wikiSynthesisMode = (patch as any).wikiSynthesisMode ?? 'agent';
        wikiLocalModel = (patch as any).wikiLocalModel ?? 'onnx-community/gemma-4-E4B-it-ONNX';
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
          } else if (patch.semanticEngine === 'turboquant') {
            console.log(`\n  Installing TurboQuant dependencies...`);
            const result = spawnSync('npm', ['install', 'turboquant-js'], { stdio: 'inherit', shell: true });
            if (result.status === 0) {
              console.log(`  ✓ turboquant-js installed`);
            } else {
              console.warn(`  ✗ npm install failed (exit ${result.status}). Run manually:`);
              console.warn(`    npm install turboquant-js`);
            }
          } else if (patch.semanticEngine === 'turbovec') {
            _installTurbovecAddon();
          }
        }
        console.log(`  • extractDocstrings: ${patch.extractDocstrings}`);
        console.log(`  • trackCallSites: ${patch.trackCallSites}`);
        console.log(`  • enableArchitecture: ${patch.enableArchitecture}`);
        console.log(`  • cavemanMode: ${cavemanMode}`);
        console.log(`  • shellCompressionLevel: ${shellCompressionLevel}`);
        console.log(`  • enableMemory: ${enableMemory}`);
        console.log(`  • enableDocs: ${enableDocs}`);
        console.log(`  • enableData: ${enableData}`);
        console.log(`  • enableSecurity: ${enableSecurity}`);
        console.log(`  • enablePatterns: ${enablePatterns}`);

        // Install optional data format deps if enableData is on
        if (enableData) {
          if ((patch as any).dataInstallExcel) {
            console.log(`\n  Installing xlsx...`);
            const xlsxResult = spawnSync('npm', ['install', 'xlsx'], { stdio: 'inherit', shell: true });
            if (xlsxResult.status === 0) {
              console.log(`  ✓ xlsx installed`);
            } else {
              console.warn(`  ✗ npm install failed. Run manually: npm install xlsx`);
            }
          }
          if ((patch as any).dataInstallParquet) {
            console.log(`\n  Installing parquetjs-lite...`);
            const pqResult = spawnSync('npm', ['install', 'parquetjs-lite'], { stdio: 'inherit', shell: true });
            if (pqResult.status === 0) {
              console.log(`  ✓ parquetjs-lite installed`);
            } else {
              console.warn(`  ✗ npm install failed. Run manually: npm install parquetjs-lite`);
            }
          }
          if ((patch as any).dataInstallPdf) {
            console.log(`\n  Installing @firecrawl/pdf-inspector...`);
            const pdfResult = spawnSync('npm', ['install', '--save-optional', '@firecrawl/pdf-inspector'], { stdio: 'inherit', shell: true });
            if (pdfResult.status === 0) {
              console.log(`  ✓ @firecrawl/pdf-inspector installed`);
            } else {
              console.warn(`  ✗ npm install failed. Run manually: npm install --save-optional @firecrawl/pdf-inspector`);
            }
          }
        }

        if (enablePatterns) {
          console.log(`\n  Installing @ast-grep/napi...`);
          const astGrepResult = spawnSync('npm', ['install', '@ast-grep/napi', '--save-optional'], {
            stdio: 'inherit',
            shell: true,
          });
          if (astGrepResult.status === 0) {
            console.log(`  ✓ @ast-grep/napi installed`);

            // Install tree-sitter grammar packages for languages beyond the built-in
            // JS/TS/HTML/CSS set. These are optional — missing packages are silently
            // skipped at runtime, so a failed install here isn't fatal.
            const langPackages = [
              '@ast-grep/lang-go',
              '@ast-grep/lang-python',
              '@ast-grep/lang-java',
              '@ast-grep/lang-rust',
              '@ast-grep/lang-c',
              '@ast-grep/lang-cpp',
              '@ast-grep/lang-csharp',
              '@ast-grep/lang-kotlin',
              '@ast-grep/lang-swift',
              '@ast-grep/lang-ruby',
              '@ast-grep/lang-php',
              '@ast-grep/lang-bash',
              '@ast-grep/lang-scala',
              '@ast-grep/lang-dart',
              '@ast-grep/lang-lua',
              '@ast-grep/lang-elixir',
              '@ast-grep/lang-haskell',
            ];
            const langResult = spawnSync('npm', ['install', ...langPackages, '--save-optional'], {
              stdio: 'inherit',
              shell: true,
            });
            if (langResult.status === 0) {
              console.log(`  ✓ @ast-grep language grammars installed`);
            } else {
              console.warn(`  ✗ Language grammar install failed. Pattern matching will be limited to JS/TS/HTML/CSS.`);
              console.warn(`    Run manually: npm install ${langPackages.join(' ')}`);
            }
          } else {
            console.warn(`  ✗ @ast-grep/napi install failed. Run manually: npm install @ast-grep/napi`);
            console.warn(`  KiroGraph will continue but kirograph pattern and kirograph_live_search will be unavailable.`);
          }
        }
      }

      installer.installLate(cwd, cavemanMode, shellCompressionLevel, enableMemory, enableDocs, enableData, enableSecurity, enableArchitecture, enablePatterns, enableWatchmen, watchmenSynthesisMode, enableWiki, wikiSynthesisMode, wikiLocalModel);
      if (target === 'kiro' && hooksToImport && hooksToImport.length > 0) {
        applyImportedGlobalHooks(cwd, hooksToImport);
      }
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
    const doIndex = shouldOfferIndex && (opts.yes || await askToggle(rl, 'Initialize and index this project now?', 'Creates .kirograph/ and indexes all source files. Takes a few seconds for small projects, longer for large ones.'));
    if (doIndex) {
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
      } else if (qdrantDashboard) {
        await openQdrantDashboard(cwd);
      }
    }

    installer.printNextSteps(cwd);
  } finally {
    rl.close();
  }
}
