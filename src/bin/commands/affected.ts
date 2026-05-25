import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { dim, reset, violet, bold, section } from '../ui';

export function register(program: Command): void {
  program
    .command('affected [files...]')
    .description('Find test files affected by changed source files')
    .option('--stdin', 'Read file list from stdin (one per line)')
    .option('-d, --depth <n>', 'Max dependency traversal depth', '5')
    .option('-f, --filter <glob>', 'Custom glob to identify test files')
    .option('-j, --json', 'Output as JSON')
    .option('-q, --quiet', 'Output file paths only')
    .option('-p, --path <path>', 'Project path')
    .action(async (files: string[], opts: {
      stdin?: boolean; depth: string; filter?: string;
      json?: boolean; quiet?: boolean; path?: string;
    }) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(opts.path ?? process.cwd());
      const cg = await KiroGraph.open(target);

      let changedFiles = [...files];

      if (opts.stdin) {
        const lines = fs.readFileSync('/dev/stdin', 'utf8').split('\n').map((l: string) => l.trim()).filter(Boolean);
        changedFiles.push(...lines);
      }

      if (changedFiles.length === 0) {
        console.error('No files provided. Pass files as arguments or use --stdin.');
        cg.close(); process.exit(1);
      }

      const affected = cg.getAffectedTests(changedFiles, {
        depth: parseInt(opts.depth),
        testPattern: opts.filter,
      });

      // Data file awareness: if a changed file is a data file referenced by test files,
      // include those test files in the affected list.
      const affectedSet = new Set(affected);
      try {
        const { loadConfig } = await import('../../config');
        const config = await loadConfig(target);
        if (config.enableData) {
          const db = cg.getDatabase();
          db.applyDataSchema();
          const rawDb = db.getRawDb();

          // Check if data_code_refs table exists
          const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='data_code_refs'");
          if (tableExists) {
            for (const file of changedFiles) {
              const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
              // Check if this file is a data file
              const dataset = rawDb.get('SELECT id FROM data_datasets WHERE file_path = ?', [rel]);
              if (dataset) {
                // Find code files that reference this dataset
                const refs = rawDb.all(
                  'SELECT qualified_name FROM data_code_refs WHERE dataset_id = ?',
                  [dataset.id],
                ) as Array<{ qualified_name: string }>;

                for (const ref of refs) {
                  // qualified_name might be a file path or a symbol — check if it's a test file
                  const picomatch = require('picomatch');
                  const isTest = picomatch(
                    opts.filter ?? '{**/*.spec.*,**/*.test.*,**/*_test.*,**/*Test.*,**/*Spec.*,**/*.t.sol,**/*.bats,**/e2e/**,**/test/**,**/tests/**,**/spec/**,**/__tests__/**,**/src/test/**}'
                  );
                  // Look up the file path for this qualified name from the nodes table
                  const node = rawDb.get('SELECT file_path FROM nodes WHERE qualified_name = ?', [ref.qualified_name]);
                  if (node && isTest(node.file_path)) {
                    affectedSet.add(node.file_path);
                  }
                }
              }
            }
          }
        }
      } catch { /* data awareness is non-critical */ }

      const finalAffected = [...affectedSet].sort();

      if (opts.json) {
        console.log(JSON.stringify({ changedFiles, affectedTests: finalAffected }, null, 2));
      } else if (opts.quiet) {
        for (const f of finalAffected) console.log(f);
      } else {
        if (finalAffected.length === 0) {
          console.log(`  ${dim}No affected test files found.${reset}`);
        } else {
          console.log(`\n  ${section('Affected test files')}  ${dim}(${finalAffected.length})${reset}\n`);
          for (const f of finalAffected) console.log(`  ${violet}${bold}${f}${reset}`);
          console.log();
        }
      }
      cg.close();
    });
}
