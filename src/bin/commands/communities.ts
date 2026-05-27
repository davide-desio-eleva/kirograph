import { Command } from 'commander';
import * as path from 'path';
import { dim, reset, violet, bold, green, renderTable } from '../ui';

export function register(program: Command): void {
  program
    .command('communities [projectPath]')
    .description('Detect code communities (clusters of related symbols)')
    .option('--resolution <n>', 'Resolution parameter (higher = more communities)', '1.0')
    .option('--limit <n>', 'Max communities to show', '15')
    .option('--json', 'Output as JSON')
    .action(async (projectPath: string | undefined, opts: { resolution: string; limit: string; json?: boolean }) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);
      const { detectCommunities } = await import('../../graph/communities');
      const db = cg.getDatabase();

      const result = detectCommunities(db, {
        resolution: parseFloat(opts.resolution),
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        cg.close();
        return;
      }

      if (result.communities.length === 0) {
        console.log('\n  No communities detected. The graph may be too small or have no edges.\n');
        cg.close();
        return;
      }

      const limit = Math.min(parseInt(opts.limit), result.communities.length);

      console.log(`\n  ${bold}Communities${reset} (${result.communities.length} detected, modularity: ${result.modularity.toFixed(3)})`);
      console.log(`  ${dim}${result.totalNodes} nodes, ${result.totalEdges} edges${reset}\n`);

      for (const c of result.communities.slice(0, limit)) {
        console.log(`  ${green}${c.label}${reset} — ${c.memberCount} symbols`);
        console.log(`  ${dim}dir: ${c.dominantDirectory} | lang: ${c.dominantLanguage} | cross-edges: ${c.interCommunityEdges}${reset}`);
        for (const m of c.members.slice(0, 5)) {
          console.log(`    ${dim}${m.kind}${reset} ${violet}${m.name}${reset} ${dim}— ${m.filePath}${reset}`);
        }
        if (c.memberCount > 5) console.log(`    ${dim}…and ${c.memberCount - 5} more${reset}`);
        console.log();
      }

      cg.close();
    });
}
