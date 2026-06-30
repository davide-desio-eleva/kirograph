import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Command } from 'commander';

const TOOL_CATEGORIES: Record<string, string> = {
  kirograph_context: 'Core', kirograph_search: 'Core', kirograph_node: 'Core',
  kirograph_callers: 'Navigation', kirograph_callees: 'Navigation', kirograph_impact: 'Navigation',
  kirograph_status: 'Navigation', kirograph_files: 'Navigation',
  kirograph_complexity: 'Code Health', kirograph_health: 'Code Health', kirograph_dsm: 'Code Health',
  kirograph_test_risk: 'Code Health', kirograph_hotspots: 'Code Health', kirograph_dead_code: 'Code Health',
  kirograph_diff_context: 'Git Context', kirograph_commit_context: 'Git Context', kirograph_pr_context: 'Git Context',
  kirograph_test_coverage: 'Git Context', kirograph_test_map: 'Git Context', kirograph_changelog: 'Git Context',
  kirograph_str_replace: 'Edit', kirograph_multi_str_replace: 'Edit', kirograph_insert_at: 'Edit',
  kirograph_architecture: 'Architecture', kirograph_coupling: 'Architecture', kirograph_package: 'Architecture',
  kirograph_mem_store: 'Memory', kirograph_mem_search: 'Memory', kirograph_mem_timeline: 'Memory',
};

function getCategory(toolName: string): string {
  if (TOOL_CATEGORIES[toolName]) return TOOL_CATEGORIES[toolName];
  if (toolName.startsWith('kirograph_mem_')) return 'Memory';
  if (toolName.startsWith('kirograph_wiki_')) return 'Wiki';
  if (toolName.startsWith('kirograph_data_')) return 'Data';
  if (toolName.startsWith('kirograph_docs_')) return 'Docs';
  if (toolName.startsWith('kirograph_security') || toolName.startsWith('kirograph_vuln') || toolName.startsWith('kirograph_sbom')) return 'Security';
  if (toolName.startsWith('kirograph_')) return 'Other';
  return 'Non-KiroGraph';
}

function getSessionDir(): string {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'claude-code', 'sessions');
  }
  return path.join(process.env.APPDATA ?? os.homedir(), 'Claude', 'sessions');
}

export function register(program: Command): void {
  program.command('cost [sessionDir]')
    .description('Report KiroGraph MCP tool usage cost from Claude Code session transcripts')
    .option('--last <n>', 'Only analyze last N session files', '10')
    .option('--category', 'Group by category instead of tool')
    .action((sessionDir: string | undefined, opts: { last: string; category?: boolean }) => {
      const dir = sessionDir ? path.resolve(sessionDir) : getSessionDir();
      if (!fs.existsSync(dir)) {
        console.log('  Session directory not found: ' + dir);
        console.log('  Provide path to Claude Code sessions directory as argument.');
        return;
      }

      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, parseInt(opts.last) || 10)
        .map(x => x.f);

      if (files.length === 0) { console.log('  No session files found in: ' + dir); return; }

      const toolCounts: Record<string, number> = {};
      let totalCalls = 0;

      for (const file of files) {
        const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const content = Array.isArray(entry.content) ? entry.content : [];
            for (const item of content) {
              if (item.type === 'tool_use' && typeof item.name === 'string' && item.name.startsWith('kirograph_')) {
                toolCounts[item.name] = (toolCounts[item.name] ?? 0) + 1;
                totalCalls++;
              }
            }
          } catch { /* skip malformed lines */ }
        }
      }

      if (totalCalls === 0) { console.log('  No KiroGraph tool calls found in last ' + files.length + ' sessions.'); return; }

      console.log('\n  KiroGraph tool usage (' + files.length + ' sessions, ' + totalCalls + ' calls total):\n');

      if (opts.category) {
        const catCounts: Record<string, number> = {};
        for (const [tool, count] of Object.entries(toolCounts)) {
          const cat = getCategory(tool);
          catCounts[cat] = (catCounts[cat] ?? 0) + count;
        }
        const sorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
        for (const [cat, count] of sorted) {
          const pct = Math.round(count / totalCalls * 100);
          console.log('  ' + cat.padEnd(20) + count.toString().padStart(6) + ' calls  (' + pct + '%)');
        }
      } else {
        const sorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
        for (const [tool, count] of sorted) {
          const pct = Math.round(count / totalCalls * 100);
          const cat = getCategory(tool);
          console.log('  ' + tool.padEnd(40) + count.toString().padStart(6) + '  [' + cat + ']  (' + pct + '%)');
        }
      }
      console.log('');
    });
}
