import { Command } from 'commander';
import * as path from 'path';
import { dim, reset, violet, bold, green, label, value, section, renderTable } from '../ui';
import { loadConfig } from '../../config';
import { readTurboQuantStats } from '../../vectors/turboquant-index';

export function register(program: Command): void {
  program
    .command('status [projectPath]')
    .description('Show index statistics')
    .option('--integrations', 'Show detected and configured platforms')
    .action(async (projectPath: string | undefined, opts: { integrations?: boolean }) => {
      const target = path.resolve(projectPath ?? process.cwd());

      if (opts.integrations) {
        await showIntegrations(target);
        return;
      }

      const KiroGraph = (await import('../../index')).default;
      const cg = await KiroGraph.open(target);
      const stats = await cg.getStats();

      console.log();
      console.log(section('  Graph'));
      console.log(`  ${label('Files')}      ${value(String(stats.files))}`);
      console.log(`  ${label('Symbols')}    ${value(String(stats.nodes))}`);
      console.log(`  ${label('Edges')}      ${value(String(stats.edges))}`);

      if (stats.frameworks.length > 0) {
        console.log(`  ${label('Frameworks')} ${value(stats.frameworks.join(', '))}`);
      }

      const kindEntries = Object.entries(stats.nodesByKind).sort((a, b) => b[1] - a[1]);
      if (kindEntries.length > 0) {
        console.log(`\n  ${label('By kind')}`);
        console.log(renderTable(kindEntries.map(([k, v]) => [k, String(v)])));
      }

      const langEntries = Object.entries(stats.filesByLanguage ?? {}).sort((a, b) => b[1] - a[1]);
      if (langEntries.length > 0) {
        console.log(`\n  ${label('By language')}`);
        console.log(renderTable(langEntries.map(([k, v]) => [k, String(v)])));
      }

      // Sync state
      const threshold = stats.syncWarningThreshold ?? 10;
      const pendingFiles: number = stats.pendingFiles ?? 0;
      const syncRunning: boolean = stats.syncRunning ?? false;
      console.log();
      console.log(section('  Sync'));
      if (syncRunning) {
        console.log(`  ${'\x1b[33m'}⚠ Sync is currently running in the background.${reset}`);
      } else {
        console.log(`  ${label('Status')}     ${dim}idle${reset}`);
      }
      if (pendingFiles > 0) {
        const warn = threshold > 0 && pendingFiles >= threshold;
        const pendingLabel = warn ? `${'\x1b[33m'}${pendingFiles} files pending${reset}` : `${dim}${pendingFiles} files pending${reset}`;
        console.log(`  ${label('Pending')}    ${pendingLabel}`);
        if (warn) {
          console.log(`  ${'\x1b[33m'}⚠ Index may be stale. Run \`kirograph sync\` to update.${reset}`);
        }
      } else {
        console.log(`  ${label('Pending')}    ${green}up to date${reset}`);
      }

      console.log();
      console.log(section('  Semantic Search'));
      if (stats.embeddingsEnabled) {
        const tqStats = stats.semanticEngine === 'turboquant'
          ? readTurboQuantStats(path.join(target, '.kirograph'))
          : null;
        const engineLabel =
          stats.semanticEngine === 'turboquant' ? `turboquant  ${dim}(${stats.vecIndexCount} entries · ${tqStats ? `${tqStats.bits} bits · ${tqStats.compressionRatio.toFixed(1)}× compression` : 'not yet indexed'})${reset}` :
          stats.semanticEngine === 'sqlite-vec' ? `sqlite-vec  ${dim}(${stats.vecIndexCount} entries in ANN index)${reset}` :
          stats.semanticEngine === 'orama'      ? `orama  ${dim}(hybrid — ${stats.vecIndexCount} docs in index)${reset}` :
          stats.semanticEngine === 'pglite'     ? `pglite+pgvector  ${dim}(hybrid — ${stats.vecIndexCount} rows in DB)${reset}` :
          stats.semanticEngine === 'lancedb'    ? `lancedb  ${dim}(${stats.vecIndexCount} entries in ANN index)${reset}` :
          stats.semanticEngine === 'qdrant'     ? `qdrant  ${dim}(${stats.vecIndexCount} points in collection)${reset}` :
          stats.semanticEngine === 'typesense'  ? `typesense  ${dim}(${stats.vecIndexCount} documents in collection)${reset}` :
          stats.semanticEngine === 'turbovec'   ? `turbovec  ${dim}(${stats.vecIndexCount} entries · ${stats.turbovecBits ?? 4} bits · Rust/SIMD)${reset}` :
          `in-process cosine`;
        const total = stats.embeddableNodeCount > 0 ? stats.embeddableNodeCount : stats.nodes;
        const displayed = Math.min(stats.embeddingCount, total);
        const coverage = total > 0 ? Math.min(100, Math.round((stats.embeddingCount / total) * 100)) : 0;
        console.log(`  ${label('Status')}     ${green}${bold}enabled${reset}`);
        console.log(`  ${label('Model')}      ${value(stats.embeddingModel)}`);
        console.log(`  ${label('Engine')}     ${violet}${engineLabel}${reset}`);
        if (stats.engineFallback) {
          console.log(`  ${'\x1b[33m'}⚠ engine fallback: ${stats.engineFallback}${reset}`);
        }
        console.log(`  ${label('Indexed')}    ${value(`${displayed} / ${total}`)}  ${dim}(${coverage}%)${reset}`);
        if (tqStats) {
          const rawMB = (tqStats.rawBytes / 1_048_576).toFixed(1);
          const compMB = (tqStats.actualBytes / 1_048_576).toFixed(1);
          const savedMB = (tqStats.savedBytes / 1_048_576).toFixed(1);
          console.log(`  ${label('Raw size')}    ${dim}${rawMB} MB  →  compressed  ${compMB} MB  (${savedMB} MB saved)${reset}`);
          if (tqStats.memEnabled && tqStats.memCount > 0) {
            const mRawMB = (tqStats.memRawBytes / 1_048_576).toFixed(1);
            const mCompMB = (tqStats.memActualBytes / 1_048_576).toFixed(1);
            console.log(`  ${label('Memory')}     ${dim}${tqStats.memCount} observations  →  ${mRawMB} MB → ${mCompMB} MB${reset}`);
          }
          if (tqStats.docsEnabled && tqStats.docsCount > 0) {
            const dRawMB = (tqStats.docsRawBytes / 1_048_576).toFixed(1);
            const dCompMB = (tqStats.docsActualBytes / 1_048_576).toFixed(1);
            console.log(`  ${label('Docs')}       ${dim}${tqStats.docsCount} sections  →  ${dRawMB} MB → ${dCompMB} MB${reset}`);
          }
          const totalSaved = tqStats.savedBytes + (tqStats.memRawBytes - tqStats.memActualBytes) + (tqStats.docsRawBytes - tqStats.docsActualBytes);
          if (totalSaved > 0) {
            console.log(`  ${label('Total RAM')}  ${green}${(totalSaved / 1_048_576).toFixed(1)} MB saved${reset}  ${dim}(TurboQuant compression)${reset}`);
          }
        }
      } else {
        console.log(`  ${label('Status')}     ${dim}disabled${reset}`);
      }

      // Pattern SAST section
      try {
        const patConfig = await loadConfig(target);
        if (patConfig.enablePatterns) {
          const db2 = cg.getDatabase();
          (db2 as any).applyPatternsSchema?.();
          const rawDb2 = db2.getRawDb();
          const tableExists = rawDb2.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
          if (tableExists) {
            const matchCount = (rawDb2.get('SELECT COUNT(*) as cnt FROM pattern_matches') as any)?.cnt ?? 0;
            const fileCount = (rawDb2.get('SELECT COUNT(DISTINCT file_path) as cnt FROM pattern_matches') as any)?.cnt ?? 0;
            const ruleCount = (rawDb2.get('SELECT COUNT(DISTINCT pattern_id) as cnt FROM pattern_matches') as any)?.cnt ?? 0;
            console.log();
            console.log(section('  Patterns'));
            console.log(`  ${label('Status')}     ${green}${bold}enabled${reset}`);
            if (matchCount > 0) {
              console.log(`  ${label('Matches')}    ${value(String(matchCount))}  ${dim}across ${fileCount} files, ${ruleCount} rules triggered${reset}`);
            } else {
              console.log(`  ${label('Matches')}    ${dim}none yet — run kirograph index${reset}`);
            }
          } else {
            console.log();
            console.log(section('  Patterns'));
            console.log(`  ${label('Status')}     ${green}${bold}enabled${reset}  ${dim}(not yet indexed — run kirograph index)${reset}`);
          }
        }
      } catch { /* non-critical */ }

      // Security stats (conditional on enableSecurity)
      try {
        const config = await loadConfig(target);
        if (config.enableSecurity) {
          const db = cg.getDatabase();
          db.applySecuritySchema();
          const rawDb = db.getRawDb();

          const depCount: number = rawDb.get('SELECT COUNT(*) as cnt FROM sec_dependencies')?.cnt ?? 0;
          const vulnCount: number = rawDb.get('SELECT COUNT(*) as cnt FROM sec_vulnerabilities')?.cnt ?? 0;
          const affectedCount: number = rawDb.get("SELECT COUNT(*) as cnt FROM sec_reachability WHERE verdict = 'affected'")?.cnt ?? 0;
          const notAffectedCount: number = rawDb.get("SELECT COUNT(*) as cnt FROM sec_reachability WHERE verdict = 'not_affected'")?.cnt ?? 0;
          const investigatingCount: number = rawDb.get("SELECT COUNT(*) as cnt FROM sec_reachability WHERE verdict = 'under_investigation'")?.cnt ?? 0;
          const staleCount: number = rawDb.get('SELECT COUNT(*) as cnt FROM sec_dependencies WHERE vuln_data_stale = 1')?.cnt ?? 0;

          console.log();
          console.log(section('  🔒 Security'));
          console.log(`  ${label('Dependencies')}  ${value(String(depCount))}`);
          console.log(`  ${label('Vulnerabilities')} ${value(String(vulnCount))}`);

          if (vulnCount > 0) {
            const affectedLabel = affectedCount > 0
              ? `${'\x1b[31m'}${affectedCount} affected${reset}`
              : `${dim}0 affected${reset}`;
            console.log(`  ${label('Affected')}     ${affectedLabel}`);
            console.log(`  ${label('Not Affected')} ${dim}${notAffectedCount}${reset}`);
            console.log(`  ${label('Investigating')} ${dim}${investigatingCount}${reset}`);
          }

          if (staleCount > 0) {
            console.log(`  ${'\x1b[33m'}⚠ ${staleCount} dependenc${staleCount === 1 ? 'y has' : 'ies have'} stale vulnerability data. Run \`kirograph vulns --refresh\` to update.${reset}`);
          }
        }
      } catch { /* non-critical */ }

      console.log();
      cg.close();
    });
}

async function showIntegrations(projectRoot: string): Promise<void> {
  const fs = await import('fs');
  const { detectPlatforms } = await import('../installer/detect');
  const { readJson, KIROGRAPH_SERVER_NAME } = await import('../installer/common');

  const detected = detectPlatforms(projectRoot);
  const home = process.env.HOME || process.env.USERPROFILE || '';

  // Map of target → config path to check if kirograph is configured
  const configChecks: Record<string, { path: string; key: string }> = {
    'kiro': { path: path.join(projectRoot, '.kiro', 'settings', 'mcp.json'), key: 'mcpServers' },
    'claude': { path: path.join(projectRoot, '.mcp.json'), key: 'mcpServers' },
    'cursor': { path: path.join(projectRoot, '.cursor', 'mcp.json'), key: 'mcpServers' },
    'windsurf': { path: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
    'codex': { path: path.join(projectRoot, '.codex', 'hooks.json'), key: 'hooks' },
    'copilot': { path: path.join(projectRoot, '.vscode', 'mcp.json'), key: 'servers' },
    'copilot-cli': { path: path.join(home, '.copilot', 'mcp-config.json'), key: 'servers' },
    'gemini-cli': { path: path.join(projectRoot, '.gemini', 'settings.json'), key: 'mcpServers' },
    'continue': { path: path.join(projectRoot, '.continue', 'mcpServers', 'kirograph.json'), key: 'mcpServers' },
    'opencode': { path: path.join(projectRoot, '.opencode.json'), key: 'mcp' },
    'antigravity': { path: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), key: 'mcpServers' },
    'roo': { path: path.join(projectRoot, '.roo', 'mcp.json'), key: 'mcpServers' },
    'warp': { path: path.join(projectRoot, '.warp', '.mcp.json'), key: 'mcpServers' },
    'trae': { path: path.join(projectRoot, '.trae', 'mcp.json'), key: 'mcpServers' },
    'amp': { path: path.join(projectRoot, '.amp', 'config.json'), key: 'mcpServers' },
    'cline': { path: path.join(projectRoot, '.cline', 'mcp_settings.json'), key: 'mcpServers' },
    'qoder': { path: path.join(projectRoot, '.qoder', 'mcp.json'), key: 'mcpServers' },
    'qwen': { path: path.join(home, '.qwen', 'settings.json'), key: 'mcpServers' },
  };

  function isConfigured(target: string): boolean {
    const check = configChecks[target];
    if (!check) return false;
    if (!fs.existsSync(check.path)) return false;
    const config = readJson(check.path);
    const container = config[check.key];
    if (!container) return false;
    if (typeof container === 'object' && !Array.isArray(container)) {
      return KIROGRAPH_SERVER_NAME in container;
    }
    return false;
  }

  const configured = detected.filter(d => isConfigured(d.target));
  const notConfigured = detected.filter(d => !isConfigured(d.target));

  console.log();
  console.log(section('  Integrations'));
  console.log();

  if (configured.length > 0) {
    console.log(`  ${label('Configured:')}`);
    for (const d of configured) {
      const check = configChecks[d.target];
      const configPath = check ? check.path.replace(projectRoot, '.').replace(home, '~') : '';
      console.log(`    ${green}✓${reset} ${d.label.padEnd(20)} ${dim}${configPath}${reset}`);
    }
  }

  if (notConfigured.length > 0) {
    if (configured.length > 0) console.log();
    console.log(`  ${label('Detected but not configured:')}`);
    for (const d of notConfigured) {
      const check = configChecks[d.target];
      const configPath = check ? check.path.replace(projectRoot, '.').replace(home, '~') : '';
      console.log(`    ${dim}○${reset} ${d.label.padEnd(20)} ${dim}${configPath}${reset}`);
    }
    console.log();
    console.log(`  ${dim}Run \`kirograph install\` to configure detected platforms.${reset}`);
  }

  if (detected.length === 0) {
    console.log(`  ${dim}No AI coding platforms detected.${reset}`);
  }

  console.log();
}
