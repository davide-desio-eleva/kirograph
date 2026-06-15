/**
 * KiroGraph Memory CLI — mirrors MCP tools + maintenance commands
 *
 * kirograph mem search <query>
 * kirograph mem store <content>
 * kirograph mem timeline
 * kirograph mem status
 * kirograph mem prune
 * kirograph mem export
 * kirograph mem import
 * kirograph mem reembed
 * kirograph mem lint
 */

import { Command } from 'commander';
import { dim, reset, violet, bold, section } from '../ui';

export function register(program: Command): void {
  const mem = program
    .command('mem')
    .description('Persistent cross-session memory (requires enableMemory: true)');

  // ── search ─────────────────────────────────────────────────────────────────

  mem
    .command('search <query>')
    .description('Search memory observations (hybrid FTS + vector)')
    .option('--kind <kind>', 'Filter by kind: decision, error, pattern, architecture, summary, note')
    .option('--limit <n>', 'Max results', '10')
    .option('--session <id>', 'Filter to specific session')
    .option('--format <fmt>', 'Output format: text, json', 'text')
    .action(async (query: string, opts: { kind?: string; limit: string; session?: string; format: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const { trackCliToolSaving } = await import('./utils');

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled. Set enableMemory: true in .kirograph/config.json');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const results = await mem.search(query, {
        limit: parseInt(opts.limit),
        kind: opts.kind as any,
        sessionId: opts.session,
      });

      if (opts.format === 'json') {
        console.log(JSON.stringify(results.map(r => ({
          id: r.observation.id,
          kind: r.observation.kind,
          content: r.observation.content,
          score: r.score,
          createdAt: r.observation.createdAt,
          sessionId: r.observation.sessionId,
        })), null, 2));
      } else {
        if (results.length === 0) {
          console.log(`\n  ${dim}No observations found for "${query}"${reset}\n`);
        } else {
          console.log(`\n  ${section('Memory Search:')} ${violet}${bold}${query}${reset}\n`);
          for (const r of results) {
            const age = formatAge(r.observation.createdAt);
            console.log(`  ${violet}[${r.observation.kind}]${reset} ${r.observation.content}`);
            console.log(`  ${dim}${age} · score: ${r.score.toFixed(3)}${reset}\n`);
          }
        }
      }

      const output = results.map(r => `[${r.observation.kind}] ${r.observation.content}`).join('\n');
      trackCliToolSaving(cwd, 'kirograph_mem_search', output, { limit: parseInt(opts.limit) });
      cg.close();
    });

  // ── store ──────────────────────────────────────────────────────────────────

  mem
    .command('store [content]')
    .description('Store an observation in memory')
    .option('--kind <kind>', 'Observation kind', 'note')
    .action(async (content: string | undefined, opts: { kind: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled. Set enableMemory: true in .kirograph/config.json');
        process.exit(1);
      }

      // Read from stdin if no content argument
      let text = content;
      if (!text) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        text = Buffer.concat(chunks).toString('utf8').trim();
      }

      if (!text) {
        console.error('  ✖ No content provided. Pass as argument or pipe from stdin.');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const result = await mem.store({ content: text, kind: opts.kind as any, source: 'manual' });

      if (!result) {
        console.log(`  ${dim}Duplicate observation — already stored.${reset}`);
      } else if (typeof result === 'object' && result.watchmenReady) {
        console.log(`  ✓ Stored observation ${dim}${result.id}${reset} [${violet}${opts.kind}${reset}]`);
        console.log(`\n  ${violet}⚡ Watchmen ready${reset} — ${result.pendingCount} observations since last synthesis`);
        console.log(`  Target files:`);
        for (const f of result.targetFiles) {
          console.log(`    ${dim}·${reset} ${f}`);
        }
        if (result.skillTargetDir) {
          console.log(`  Skill dir:    ${dim}${result.skillTargetDir}/watchmen-<slug>.md${reset} (inclusion: manual)`);
        }
        console.log(`\n  ${dim}Run synthesis manually or let the agentStop hook handle it.${reset}`);
      } else {
        console.log(`  ✓ Stored observation ${dim}${result}${reset} [${violet}${opts.kind}${reset}]`);
      }

      cg.close();
    });

  // ── timeline ───────────────────────────────────────────────────────────────

  mem
    .command('timeline')
    .description('List recent sessions and observations')
    .option('--limit <n>', 'Number of sessions', '5')
    .option('--session <id>', 'Show observations for a specific session')
    .option('--format <fmt>', 'Output format: text, json', 'text')
    .action(async (opts: { limit: string; session?: string; format: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const { trackCliToolSaving } = await import('./utils');

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled. Set enableMemory: true in .kirograph/config.json');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const { sessions, observations } = mem.timeline({
        limit: parseInt(opts.limit),
        sessionId: opts.session,
      });

      if (opts.format === 'json') {
        console.log(JSON.stringify({
          sessions: sessions.map(s => ({
            id: s.id,
            ide: s.ide,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            observations: (observations.get(s.id) ?? []).map(o => ({
              id: o.id, kind: o.kind, content: o.content, createdAt: o.createdAt,
            })),
          })),
        }, null, 2));
      } else {
        if (sessions.length === 0) {
          console.log(`\n  ${dim}No memory sessions found.${reset}\n`);
        } else {
          console.log(`\n  ${section('Memory Timeline')}\n`);
          for (const session of sessions) {
            const start = new Date(session.startedAt).toISOString().slice(0, 16).replace('T', ' ');
            const status = session.endedAt ? dim + 'ended' + reset : violet + 'active' + reset;
            const obs = observations.get(session.id) ?? [];
            console.log(`  ${bold}${start}${reset} [${session.ide ?? 'unknown'}] ${status} · ${obs.length} observations`);
            for (const o of obs.slice(0, 5)) {
              console.log(`    ${dim}·${reset} ${violet}[${o.kind}]${reset} ${o.content.slice(0, 100)}`);
            }
            if (obs.length > 5) console.log(`    ${dim}…and ${obs.length - 5} more${reset}`);
            console.log('');
          }
        }
      }

      const output = sessions.map(s => s.id).join('\n');
      trackCliToolSaving(cwd, 'kirograph_mem_timeline', output, { limit: parseInt(opts.limit) });
      cg.close();
    });

  // ── status ─────────────────────────────────────────────────────────────────

  mem
    .command('status')
    .description('Show memory subsystem health')
    .action(async () => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled. Set enableMemory: true in .kirograph/config.json');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const stats = mem.getStats();
      console.log(`\n  ${section('Memory Status')}\n`);
      console.log(`  Sessions:       ${bold}${stats.sessions}${reset} (${stats.activeSessions} active)`);
      console.log(`  Observations:   ${bold}${stats.observations}${reset}`);
      console.log(`  Symbol links:   ${bold}${stats.links}${reset}`);
      console.log(`  Embeddings:     ${bold}${stats.vectors}${reset} / ${stats.embeddableCount}`);
      console.log(`  Model mismatch: ${stats.modelMismatch ? violet + '⚠ yes — run kirograph mem reembed' + reset : dim + 'no' + reset}`);
      console.log(`  Compression:    ${config.cavemanMode !== 'off' ? violet + config.cavemanMode + reset : dim + 'off (storing raw)' + reset}`);
      console.log('');

      cg.close();
    });

  // ── prune ──────────────────────────────────────────────────────────────────

  mem
    .command('prune')
    .description('Remove old observations')
    .option('--older-than <duration>', 'Duration (e.g. 90d, 6m)', '90d')
    .action(async (opts: { olderThan: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled.');
        process.exit(1);
      }

      const ms = parseDuration(opts.olderThan);
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const deleted = mem.prune(ms);
      console.log(`  ✓ Pruned ${deleted} observation(s) older than ${opts.olderThan}`);

      cg.close();
    });

  // ── export ─────────────────────────────────────────────────────────────────

  mem
    .command('export')
    .description('Export memory observations')
    .option('--format <fmt>', 'Output format: jsonl, md', 'jsonl')
    .action(async (opts: { format: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled.');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const { sessions, observations } = mem.timeline({ limit: 1000 });

      if (opts.format === 'jsonl') {
        for (const session of sessions) {
          const obs = observations.get(session.id) ?? [];
          for (const o of obs) {
            console.log(JSON.stringify({
              id: o.id,
              content: o.content,
              content_raw: o.contentRaw,
              kind: o.kind,
              tags: o.tags,
              created_at: o.createdAt,
              session_id: o.sessionId,
            }));
          }
        }
      } else {
        // Markdown format
        for (const session of sessions) {
          const start = new Date(session.startedAt).toISOString().slice(0, 10);
          console.log(`## Session ${start} (${session.ide ?? 'unknown'})\n`);
          const obs = observations.get(session.id) ?? [];
          for (const o of obs) {
            const time = new Date(o.createdAt).toISOString().slice(11, 16);
            console.log(`### [${o.kind}] ${time}`);
            console.log(o.content);
            console.log('');
          }
        }
      }

      cg.close();
    });

  // ── import ─────────────────────────────────────────────────────────────────

  mem
    .command('import <file>')
    .description('Import observations from JSONL backup')
    .action(async (file: string) => {
      const fs = await import('fs');
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled.');
        process.exit(1);
      }

      if (!fs.existsSync(file)) {
        console.error(`  ✖ File not found: ${file}`);
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
      let imported = 0;
      let skipped = 0;

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          const id = await mem.store({
            content: data.content_raw || data.content,
            kind: data.kind ?? 'note',
            source: 'manual',
            tags: data.tags,
          });
          if (id) imported++;
          else skipped++;
        } catch {
          skipped++;
        }
      }

      console.log(`  ✓ Imported ${imported} observation(s), skipped ${skipped} (duplicates/errors)`);
      cg.close();
    });

  // ── reembed ────────────────────────────────────────────────────────────────

  mem
    .command('reembed')
    .description('Re-embed all observations with the current model')
    .option('--batch <n>', 'Batch size', '32')
    .action(async (opts: { batch: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled.');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      console.log('  Re-embedding all observations...');
      const count = await mem.reembed(parseInt(opts.batch));
      console.log(`  ✓ Re-embedded ${count} observation(s)`);

      cg.close();
    });

  // ── lint ───────────────────────────────────────────────────────────────────

  mem
    .command('lint')
    .description('Health check: find stale links, model mismatch, orphans')
    .option('--fix', 'Auto-fix issues (remove stale links, close stale sessions)')
    .action(async (opts: { fix?: boolean }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled.');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const result = mem.lint();

      console.log(`\n  ${section('Memory Lint')}\n`);
      console.log(`  Stale links:    ${result.staleLinks > 0 ? violet + result.staleLinks + reset : dim + '0' + reset}`);
      console.log(`  Model mismatch: ${result.modelMismatch ? violet + 'yes' + reset : dim + 'no' + reset}`);
      console.log(`  Stale sessions: ${result.staleSessions > 0 ? violet + String(result.staleSessions) + ' (auto-closed)' + reset : dim + '0' + reset}`);

      if (opts.fix && result.staleLinks > 0) {
        const removed = mem.removeStaleLinks();
        console.log(`\n  ✓ Removed ${removed} stale link(s)`);
      } else if (result.staleLinks > 0) {
        console.log(`\n  ${dim}Run with --fix to remove stale links${reset}`);
      }

      if (result.modelMismatch) {
        console.log(`  ${dim}Run 'kirograph mem reembed' to fix model mismatch${reset}`);
      }

      console.log('');
      cg.close();
    });

  // ── review ─────────────────────────────────────────────────────────────────

  mem
    .command('review')
    .description('List observations past their review_after date')
    .option('--limit <n>', 'Max results', '20')
    .option('--format <fmt>', 'Output format: text, json', 'text')
    .action(async (opts: { limit: string; format: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      const obs = mem.getObservationsForReview(parseInt(opts.limit));
      if (opts.format === 'json') {
        console.log(JSON.stringify(obs));
      } else if (obs.length === 0) {
        console.log(`\n  ${dim}No overdue observations.${reset}\n`);
      } else {
        console.log(`\n  ${section('Memory Review Queue')} — ${obs.length} overdue\n`);
        const now = Date.now();
        for (const o of obs) {
          const daysOverdue = Math.floor((now - (o.reviewAfter ?? now)) / 86400000);
          console.log(`  ${violet}[${o.kind}]${reset}${o.topicKey ? ` ${dim}(${o.topicKey})${reset}` : ''} ${o.content.slice(0, 120)}`);
          console.log(`  ${dim}Overdue by ${daysOverdue}d · ID: ${o.id}${reset}\n`);
        }
      }
      cg.close();
    });

  // ── mark-reviewed ──────────────────────────────────────────────────────────

  mem
    .command('mark-reviewed <id>')
    .description('Mark an observation as reviewed — clears its review_after date')
    .action(async (id: string) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      mem.markReviewed(id);
      console.log(`  ✓ Observation ${dim}${id}${reset} marked as reviewed`);
      cg.close();
    });

  // ── suggest-topic-key ──────────────────────────────────────────────────────

  mem
    .command('suggest-topic-key')
    .description('Suggest a stable topic_key for an observation')
    .requiredOption('--kind <kind>', 'Observation kind: decision, error, pattern, architecture, summary, note')
    .requiredOption('--title <title>', 'Short title or first sentence')
    .action(async (opts: { kind: string; title: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      const key = mem.suggestTopicKey(opts.kind, opts.title);
      console.log(`  ${violet}${key}${reset}`);
      cg.close();
    });

  // ── capture ────────────────────────────────────────────────────────────────

  mem
    .command('capture [content]')
    .description('Extract and store structured learnings from text (## Key Learnings, ## Decisions, etc.)')
    .action(async (content: string | undefined) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      let text = content;
      if (!text) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        text = Buffer.concat(chunks).toString('utf8').trim();
      }
      if (!text) { console.error('  ✖ No content provided.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      const results = mem.capturePassive(text);
      if (results.length === 0) {
        console.log(`  ${dim}No structured sections found. Use ## Key Learnings, ## Observations, ## Decisions headings.${reset}`);
      } else {
        console.log(`\n  ${section('Passive Capture')} — ${results.length} observation(s)\n`);
        for (const r of results) {
          console.log(`  ${violet}[${r.kind}]${reset} ${r.content.slice(0, 100)}${r.id ? '' : ` ${dim}(duplicate)${reset}`}`);
        }
        console.log('');
      }
      cg.close();
    });

  // ── save-prompt ────────────────────────────────────────────────────────────

  mem
    .command('save-prompt [content]')
    .description('Save the current user prompt to session memory')
    .action(async (content: string | undefined) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      let text = content;
      if (!text) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        text = Buffer.concat(chunks).toString('utf8').trim();
      }
      if (!text) { console.error('  ✖ No content provided.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      const id = await mem.savePrompt(text);
      console.log(`  ✓ Prompt saved ${dim}${id}${reset}`);
      cg.close();
    });

  // ── conflicts ──────────────────────────────────────────────────────────────

  const conflicts = mem
    .command('conflicts')
    .description('Manage conflict relations between memory observations');

  conflicts
    .command('list')
    .description('List pending conflict relations')
    .option('--limit <n>', 'Max results', '20')
    .option('--format <fmt>', 'Output format: text, json', 'text')
    .action(async (opts: { limit: string; format: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      const pending = mem.getPendingRelations(parseInt(opts.limit));
      if (opts.format === 'json') {
        console.log(JSON.stringify(pending, null, 2));
      } else if (pending.length === 0) {
        console.log(`\n  ${dim}No pending conflict relations.${reset}\n`);
      } else {
        console.log(`\n  ${section('Pending Relations')} — ${pending.length}\n`);
        for (const r of pending) {
          console.log(`  ${violet}${r.relation}${reset} [${dim}${r.id}${reset}]`);
          console.log(`  A: ${r.observationA}`);
          console.log(`  B: ${r.observationB}`);
          if (r.reason) console.log(`  Reason: ${dim}${r.reason}${reset}`);
          console.log('');
        }
      }
      cg.close();
    });

  conflicts
    .command('scan')
    .description('Scan recent observations for potential conflicts using FTS similarity')
    .option('--limit <n>', 'Max observations to scan', '50')
    .option('--format <fmt>', 'Output format: text, json', 'text')
    .action(async (opts: { limit: string; format: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      const candidates = mem.scanConflicts(parseInt(opts.limit));
      if (opts.format === 'json') {
        console.log(JSON.stringify(candidates.map(c => ({ a: c.observationA.id, b: c.observationB.id, similarity: c.similarity })), null, 2));
      } else if (candidates.length === 0) {
        console.log(`\n  ${dim}No potential conflicts found.${reset}\n`);
      } else {
        console.log(`\n  ${section('Conflict Scan')} — ${candidates.length} candidate(s)\n`);
        for (const c of candidates) {
          console.log(`  ${violet}↔${reset} [${c.observationA.kind}] "${c.observationA.content.slice(0, 80)}"`);
          console.log(`     [${c.observationB.kind}] "${c.observationB.content.slice(0, 80)}"`);
          console.log(`  ${dim}Similarity: ${c.similarity.toFixed(2)} · Use 'kirograph mem compare' to establish a relation${reset}\n`);
        }
      }
      cg.close();
    });

  conflicts
    .command('compare <observationA> <observationB>')
    .description('Establish a typed relation between two observations (IDs or topic_keys)')
    .requiredOption('--relation <type>', 'Relation: supersedes, conflicts_with, compatible, scoped, related, not_conflict')
    .option('--confidence <n>', 'Confidence 0.0–1.0', '1.0')
    .option('--reason <text>', 'Explanation')
    .option('--evidence <text>', 'Supporting evidence')
    .action(async (observationA: string, observationB: string, opts: { relation: string; confidence: string; reason?: string; evidence?: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      const id = mem.compareObservations({
        observationA,
        observationB,
        relation: opts.relation as any,
        confidence: parseFloat(opts.confidence),
        reason: opts.reason,
        evidence: opts.evidence,
      });
      console.log(`  ✓ Relation ${dim}${id}${reset} created: ${violet}${opts.relation}${reset} (confidence: ${opts.confidence})`);
      cg.close();
    });

  conflicts
    .command('judge <relationId>')
    .description('Finalize a pending relation')
    .requiredOption('--relation <type>', 'Final relation type')
    .requiredOption('--confidence <n>', 'Final confidence 0.0–1.0')
    .option('--reason <text>', 'Reasoning')
    .option('--evidence <text>', 'Evidence')
    .action(async (relationId: string, opts: { relation: string; confidence: string; reason?: string; evidence?: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      mem.judgeRelation(relationId, opts.relation as any, parseFloat(opts.confidence), opts.reason, opts.evidence);
      console.log(`  ✓ Relation ${dim}${relationId}${reset} judged as ${violet}${opts.relation}${reset} (confidence: ${opts.confidence})`);
      cg.close();
    });

  conflicts
    .command('ignore <relationId>')
    .description('Ignore a pending relation (mark as not relevant)')
    .action(async (relationId: string) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;
      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) { console.error('  ✖ Not initialized.'); process.exit(1); }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) { console.error('  ✖ Memory not enabled.'); process.exit(1); }
      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb()); mem.initialize();
      mem.ignoreRelation(relationId);
      console.log(`  ✓ Relation ${dim}${relationId}${reset} ignored`);
      cg.close();
    });

  // ── watchmen ──────────────────────────────────────────────────────────────

  const watchmen = mem
    .command('watchmen')
    .description('Watchmen — workspace brief synthesis from memory observations (requires enableWatchmen: true)');

  watchmen
    .command('status')
    .description('Show pending observation count and which files would be written on next synthesis')
    .action(async () => {
      const { MemoryManager } = await import('../../memory/index');
      const { WatchmenChecker } = await import('../../watchmen/index');
      const { MemoryDatabase } = await import('../../memory/database');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled. Set enableMemory: true in .kirograph/config.json');
        process.exit(1);
      }
      if (!config.enableWatchmen) {
        console.error('  ✖ Watchmen is not enabled. Set enableWatchmen: true in .kirograph/config.json');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const memDb = new MemoryDatabase(db.getRawDb());
      memDb.initialize();

      const checker = new WatchmenChecker(config.watchmenThreshold);
      const { ready, pendingCount } = checker.shouldSynthesize(memDb);
      const { targetFiles } = checker.buildReadyResponse('', pendingCount, cwd);

      console.log(`\n  ${section('Watchmen Status')}\n`);
      console.log(`  Pending observations: ${bold}${pendingCount}${reset} / ${config.watchmenThreshold} threshold`);
      console.log(`  Ready to synthesize:  ${ready ? violet + 'yes' + reset : dim + 'no' + reset}`);
      console.log(`  Target files:`);
      for (const f of targetFiles) {
        console.log(`    ${dim}·${reset} ${f}`);
      }
      console.log('');

      cg.close();
    });

  watchmen
    .command('synthesize')
    .description('Run local model synthesis immediately (requires watchmenSynthesisMode: local)')
    .option('--force', 'Run even if below threshold')
    .option('--quiet', 'Suppress output (used by runCommand hook)')
    .action(async (opts: { force?: boolean; quiet?: boolean }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { WatchmenChecker } = await import('../../watchmen/index');
      const { MemoryDatabase } = await import('../../memory/database');
      const { runLocalSynthesis } = await import('../../watchmen/synthesize');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        if (!opts.quiet) console.error('  ✖ KiroGraph is not initialized.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory || !config.enableWatchmen) {
        if (!opts.quiet) console.error('  ✖ Watchmen is not enabled (enableMemory + enableWatchmen required).');
        process.exit(1);
      }
      if (config.watchmenSynthesisMode !== 'local') {
        if (!opts.quiet) console.error('  ✖ watchmenSynthesisMode is not "local" — use the agent hook instead.');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const memDb = new MemoryDatabase(db.getRawDb());
      memDb.initialize();

      const checker = new WatchmenChecker(config.watchmenThreshold);
      const { ready, pendingCount } = checker.shouldSynthesize(memDb);

      if (!ready && !opts.force) {
        if (!opts.quiet) console.log(`  ${dim}Watchmen: ${pendingCount}/${config.watchmenThreshold} observations — threshold not reached.${reset}`);
        cg.close();
        return;
      }

      const observations = memDb.getObservationsSinceLastSummary(50);
      if (observations.length === 0) {
        if (!opts.quiet) console.log(`  ${dim}No observations to synthesize.${reset}`);
        cg.close();
        return;
      }

      if (!opts.quiet) {
        console.log(`\n  ${section('Watchmen Synthesis')}\n`);
        console.log(`  Synthesizing ${observations.length} observations with ${dim}${config.watchmenLocalModel}${reset}`);
        const cacheDir = require('path').join(require('os').homedir(), '.kirograph', 'models');
        const cached = require('fs').existsSync(require('path').join(cacheDir, config.watchmenLocalModel));
        if (!cached) console.log(`  ${dim}Downloading model — first run only (cached in ~/.kirograph/models/)${reset}`);
        console.log('');
      }

      const readyResult = checker.buildReadyResponse('', pendingCount, cwd);
      const result = await runLocalSynthesis(observations, readyResult, config.watchmenLocalModel, cwd, !!opts.quiet);

      // Store summary observation to reset counter
      const mgr = new MemoryManager(config, db.getRawDb(), cwd);
      mgr.initialize();
      await mgr.store({ content: result.summaryObservation, kind: 'summary', source: 'agent' });

      if (!opts.quiet) {
        if (result.filesWritten.length) console.log(`  ✓ Brief written to: ${result.filesWritten.map(f => violet + f + reset).join(', ')}`);
        if (result.skillsWritten.length) console.log(`  ✓ Skills written:   ${result.skillsWritten.map(f => violet + f + reset).join(', ')}`);
        if (result.skillsPruned.length)  console.log(`  ${dim}✗ Pruned stale:     ${result.skillsPruned.join(', ')}${reset}`);
        console.log('');
      }

      cg.close();
    });

  watchmen
    .command('reset')
    .description('Store a summary observation to reset the synthesis counter without running synthesis')
    .action(async () => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) {
        console.error('  ✖ KiroGraph is not initialized. Run `kirograph init` first.');
        process.exit(1);
      }
      const config = await loadConfig(cwd);
      if (!config.enableMemory) {
        console.error('  ✖ Memory is not enabled.');
        process.exit(1);
      }
      if (!config.enableWatchmen) {
        console.error('  ✖ Watchmen is not enabled.');
        process.exit(1);
      }

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mgr = new MemoryManager(config, db.getRawDb(), cwd);
      mgr.initialize();

      // Bypass watchmen check by storing directly as summary
      const id = await mgr.store({ content: `Watchmen counter reset manually via CLI at ${new Date().toISOString()}.`, kind: 'summary', source: 'manual' });
      if (id) {
        console.log(`  ✓ Counter reset — pending observations set back to 0`);
      } else {
        console.log(`  ${dim}Already at zero — nothing to reset.${reset}`);
      }

      cg.close();
    });

  // ── session management (for hooks) ─────────────────────────────────────────

  mem
    .command('session-start')
    .description('Start a new memory session (called by hooks)')
    .option('--ide <name>', 'IDE name', 'kiro')
    .action(async (opts: { ide: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) return;
      const config = await loadConfig(cwd);
      if (!config.enableMemory) return;

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      // getOrCreateSession handles auto-creation
      const { MemoryDatabase } = await import('../../memory/database');
      const memDb = new MemoryDatabase(db.getRawDb());
      memDb.initialize();
      const sessionId = memDb.getOrCreateSession(opts.ide, cwd);
      console.log(sessionId);

      cg.close();
    });

  mem
    .command('session-end')
    .description('End the current memory session (called by hooks)')
    .option('--ide <name>', 'IDE name', 'kiro')
    .action(async (opts: { ide: string }) => {
      const { MemoryManager } = await import('../../memory/index');
      const { loadConfig } = await import('../../config');
      const KiroGraph = (await import('../../index')).default;

      const cwd = process.cwd();
      if (!KiroGraph.isInitialized(cwd)) return;
      const config = await loadConfig(cwd);
      if (!config.enableMemory) return;

      const cg = await KiroGraph.open(cwd);
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      mem.endCurrentSession(opts.ide);

      cg.close();
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(d|m|w|h)$/);
  if (!match) return 90 * 24 * 60 * 60 * 1000; // default 90 days

  const value = parseInt(match[1]);
  switch (match[2]) {
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'w': return value * 7 * 24 * 60 * 60 * 1000;
    case 'm': return value * 30 * 24 * 60 * 60 * 1000;
    default: return 90 * 24 * 60 * 60 * 1000;
  }
}
