import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';

export function register(program: Command): void {
  program.command('monitor [projectPath]')
    .description('Live tail of MCP call log (.kirograph/mcp-calls.jsonl)')
    .option('--lines <n>', 'Show last N lines on start', '20')
    .action(async (projectPath: string | undefined, opts: { lines: string }) => {
      const target = path.resolve(projectPath ?? process.cwd());
      const logFile = path.join(target, '.kirograph', 'mcp-calls.jsonl');

      if (!fs.existsSync(logFile)) {
        console.log('  No MCP call log found at: ' + logFile);
        console.log('  KiroGraph MCP call logging is not yet enabled in this project.');
        console.log('  Note: this feature requires the MCP server to be configured to write call logs.');
        return;
      }

      const lines = parseInt(opts.lines) || 20;
      // Show last N lines
      const content = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
      const recent = content.slice(-lines);

      console.log('  Showing last ' + recent.length + ' MCP calls (tailing ' + logFile + '):\n');
      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          const ts = new Date(entry.timestamp).toISOString().slice(11, 23);
          const tool = entry.tool ?? entry.toolName ?? '?';
          const dur = entry.durationMs ? entry.durationMs + 'ms' : '';
          const tok = entry.outputTokens ? entry.outputTokens + ' tok' : '';
          console.log('  [' + ts + '] ' + tool + (dur ? '  ' + dur : '') + (tok ? '  ' + tok : ''));
        } catch {
          console.log('  ' + line);
        }
      }

      console.log('\n  Watching for new calls... (Ctrl+C to stop)\n');

      // Tail using fs.watch
      let offset = fs.statSync(logFile).size;
      fs.watch(logFile, () => {
        const stat = fs.statSync(logFile);
        if (stat.size <= offset) return;
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        for (const line of buf.toString().split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            const ts = new Date(entry.timestamp).toISOString().slice(11, 23);
            const tool = entry.tool ?? entry.toolName ?? '?';
            const dur = entry.durationMs ? entry.durationMs + 'ms' : '';
            const tok = entry.outputTokens ? entry.outputTokens + ' tok' : '';
            console.log('  [' + ts + '] ' + tool + (dur ? '  ' + dur : '') + (tok ? '  ' + tok : ''));
          } catch {
            console.log('  ' + line);
          }
        }
      });
    });
}
