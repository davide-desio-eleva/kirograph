import { Command } from 'commander';
import * as path from 'path';
import { dim, reset, violet, bold, green } from '../ui';

export function register(program: Command): void {
  const refactorCmd = program
    .command('refactor')
    .description('Refactoring tools: rename preview and suggestions');

  refactorCmd
    .command('rename <symbol> [projectPath]')
    .description('Preview all locations that reference a symbol (rename preview)')
    .option('--json', 'Output as JSON')
    .action(async (symbol: string, projectPath: string | undefined, opts: { json?: boolean }) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);
      const { renamePreview } = await import('../../graph/refactor');
      const db = cg.getDatabase();

      const preview = renamePreview(db, symbol);

      if (!preview) {
        console.error(`  Symbol "${symbol}" not found in index.`);
        cg.close();
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(preview, null, 2));
        cg.close();
        return;
      }

      console.log(`\n  ${bold}Rename Preview:${reset} ${violet}${preview.symbol}${reset} (${preview.kind})`);
      console.log(`  ${dim}Defined at: ${preview.filePath}:${preview.line}${reset}`);
      console.log(`  ${dim}Total references: ${preview.totalReferences}${reset}\n`);

      if (preview.references.length === 0) {
        console.log(`  ${green}✓${reset} No references found — safe to rename without affecting other code.\n`);
      } else {
        // Group by file
        const byFile = new Map<string, typeof preview.references>();
        for (const ref of preview.references) {
          if (!byFile.has(ref.filePath)) byFile.set(ref.filePath, []);
          byFile.get(ref.filePath)!.push(ref);
        }

        for (const [file, refs] of byFile) {
          console.log(`  ${bold}${file}${reset} (${refs.length})`);
          for (const ref of refs.slice(0, 10)) {
            console.log(`    ${dim}line ${ref.line}:${reset} ${ref.context} ${dim}(${ref.edgeKind})${reset}`);
          }
          if (refs.length > 10) console.log(`    ${dim}…and ${refs.length - 10} more${reset}`);
          console.log();
        }
      }

      cg.close();
    });

  refactorCmd
    .command('suggest [projectPath]')
    .description('Get community-driven refactoring suggestions')
    .option('--limit <n>', 'Max suggestions', '10')
    .option('--json', 'Output as JSON')
    .action(async (projectPath: string | undefined, opts: { limit: string; json?: boolean }) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);
      const { suggestRefactorings } = await import('../../graph/refactor');
      const db = cg.getDatabase();

      const suggestions = suggestRefactorings(db, parseInt(opts.limit));

      if (opts.json) {
        console.log(JSON.stringify(suggestions, null, 2));
        cg.close();
        return;
      }

      if (suggestions.length === 0) {
        console.log(`\n  ${green}✓${reset} No refactoring suggestions — the codebase structure looks clean.\n`);
        cg.close();
        return;
      }

      console.log(`\n  ${bold}Refactoring Suggestions${reset} (${suggestions.length})\n`);

      for (const s of suggestions) {
        const icon = s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '🟢';
        console.log(`  ${icon} ${bold}${s.type}${reset} [${s.priority}]`);
        console.log(`     ${s.description}`);
        console.log(`     ${dim}${s.rationale}${reset}`);
        console.log();
      }

      cg.close();
    });
}
