import { Command } from 'commander';
import * as path from 'path';
import { dim, reset, violet, bold, green, label, value, section, renderTable } from '../ui';

export function register(program: Command): void {
  program
    .command('status [projectPath]')
    .description('Show index statistics')
    .action(async (projectPath: string | undefined) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
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
        const engineLabel =
          stats.semanticEngine === 'sqlite-vec' ? `sqlite-vec  ${dim}(${stats.vecIndexCount} entries in ANN index)${reset}` :
          stats.semanticEngine === 'orama'      ? `orama  ${dim}(hybrid — ${stats.vecIndexCount} docs in index)${reset}` :
          stats.semanticEngine === 'pglite'     ? `pglite+pgvector  ${dim}(hybrid — ${stats.vecIndexCount} rows in DB)${reset}` :
          stats.semanticEngine === 'lancedb'    ? `lancedb  ${dim}(${stats.vecIndexCount} entries in ANN index)${reset}` :
          stats.semanticEngine === 'qdrant'     ? `qdrant  ${dim}(${stats.vecIndexCount} points in collection)${reset}` :
          stats.semanticEngine === 'typesense'  ? `typesense  ${dim}(${stats.vecIndexCount} documents in collection)${reset}` :
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
      } else {
        console.log(`  ${label('Status')}     ${dim}disabled${reset}`);
      }

      console.log();
      cg.close();
    });
}
