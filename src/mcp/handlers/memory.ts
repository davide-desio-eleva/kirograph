import KiroGraph from '../../index';
import { clampLimit, formatAge } from './utils';

export async function handleMemory(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_mem_search': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';

      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const results = await mem.search(args.query as string, {
        limit: (args.limit as number) ?? 10,
        kind: args.kind as any,
        sessionId: args.sessionId as string | undefined,
        asOf: args.asOf as number | undefined,
      });

      if (results.length === 0) return `No memory observations found for "${args.query}".`;

      return results.map((r, i) => {
        const age = formatAge(r.observation.createdAt);
        const lines = [`${i + 1}. [${r.observation.kind}] ${r.observation.content} (${age})`];
        if (r.relations && r.relations.length > 0) {
          for (const rel of r.relations) {
            const other = rel.observationA === r.observation.id ? rel.observationB : rel.observationA;
            const icon = rel.relation === 'conflicts_with' ? '⚡' : rel.relation === 'supersedes' ? '↩' : '~';
            lines.push(`  ${icon} ${rel.relation} ${other} (confidence: ${rel.confidence})${rel.judgmentStatus === 'judged' ? ' (judged)' : ''}`);
          }
        }
        return lines.join('\n');
      }).join('\n');
    }

    case 'kirograph_mem_store': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';

      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const id = await mem.store({
        content: args.content as string,
        kind: (args.kind as any) ?? 'note',
        source: 'agent',
        topicKey: args.topicKey as string | undefined,
        reviewAfter: args.reviewAfter as number | undefined,
      });

      if (!id) return 'Observation already exists (duplicate content).';
      return `Stored observation ${id} [${(args.kind as string) ?? 'note'}]`;
    }

    case 'kirograph_mem_timeline': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';

      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const { sessions, observations } = mem.timeline({
        limit: (args.limit as number) ?? 5,
        sessionId: args.sessionId as string | undefined,
      });

      if (sessions.length === 0) return 'No memory sessions found.';

      const lines: string[] = [];
      for (const session of sessions) {
        const start = new Date(session.startedAt).toISOString().slice(0, 16).replace('T', ' ');
        const status = session.endedAt ? 'ended' : 'active';
        const obs = observations.get(session.id) ?? [];
        lines.push(`## ${start} [${session.ide ?? 'unknown'}] (${status}, ${obs.length} observations)`);
        for (const o of obs.slice(0, 5)) {
          lines.push(`  - [${o.kind}] ${o.content.slice(0, 120)}`);
        }
        if (obs.length > 5) lines.push(`  …and ${obs.length - 5} more`);
      }
      return lines.join('\n');
    }

    case 'kirograph_mem_status': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';

      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();

      const stats = mem.getStats();
      const lines = [
        'KiroGraph Memory Status',
        `  Sessions: ${stats.sessions} (${stats.activeSessions} active)`,
        `  Observations: ${stats.observations}`,
        `  Symbol links: ${stats.links}`,
        `  Embeddings: ${stats.vectors} / ${stats.embeddableCount}`,
        `  Model mismatch: ${stats.modelMismatch ? '⚠ yes — run kirograph mem reembed' : 'no'}`,
        `  Relations: ${stats.relations} (${stats.pendingConflicts} pending)`,
        `  Caveman compression: ${config.cavemanMode !== 'off' ? config.cavemanMode : 'off (storing raw)'}`,
      ];
      return lines.join('\n');
    }

    case 'kirograph_mem_review': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const obs = mem.getObservationsForReview(args.limit as number ?? 20);
      if (obs.length === 0) return 'No overdue observations — all review_after dates are in the future.';
      const now = Date.now();
      return obs.map((o, i) => {
        const daysOverdue = Math.floor((now - (o.reviewAfter ?? now)) / 86400000);
        return `${i + 1}. [${o.kind}]${o.topicKey ? ` (${o.topicKey})` : ''} ${o.content.slice(0, 120)} — overdue by ${daysOverdue}d`;
      }).join('\n');
    }

    case 'kirograph_mem_mark_reviewed': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      mem.markReviewed(args.id as string);
      return `Observation ${args.id} marked as reviewed.`;
    }

    case 'kirograph_mem_compare': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const relationId = mem.compareObservations({
        observationA: args.observationA as string,
        observationB: args.observationB as string,
        relation: args.relation as any,
        confidence: args.confidence as number ?? 1.0,
        reason: args.reason as string | undefined,
        evidence: args.evidence as string | undefined,
      });
      return `Relation ${relationId} created (${args.relation}, confidence: ${args.confidence ?? 1.0}). Use kirograph_mem_judge to finalize.`;
    }

    case 'kirograph_mem_judge': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      mem.judgeRelation(
        args.relationId as string,
        args.relation as any,
        args.confidence as number,
        args.reason as string | undefined,
        args.evidence as string | undefined,
      );
      return `Relation ${args.relationId} judged as [${args.relation}] (confidence: ${args.confidence}).`;
    }

    case 'kirograph_mem_capture': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const extracted = mem.capturePassive(args.content as string);
      if (extracted.length === 0) return 'No structured sections found. Use ## Key Learnings, ## Observations, ## Decisions, or ## Key Changes headings.';
      return `Captured ${extracted.length} observation(s):\n` + extracted.map((e, i) => `${i + 1}. [${e.kind}] ${e.content.slice(0, 100)}${e.id ? '' : ' (duplicate)'}`).join('\n');
    }

    case 'kirograph_mem_save_prompt': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const id = await mem.savePrompt(args.content as string);
      return `Prompt saved as ${id}.`;
    }

    case 'kirograph_mem_suggest_topic_key': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const key = mem.suggestTopicKey(args.kind as string, args.title as string);
      return `Suggested topic_key: ${key}`;
    }

    case 'kirograph_mem_conflicts_scan': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const candidates = mem.scanConflicts(args.limit as number ?? 50);
      if (candidates.length === 0) return 'No potential conflicts found among recent observations.';
      return `Found ${candidates.length} potential conflict(s):\n` + candidates.map((c, i) =>
        `${i + 1}. [${c.observationA.kind}] "${c.observationA.content.slice(0, 80)}" ↔ [${c.observationB.kind}] "${c.observationB.content.slice(0, 80)}" (similarity: ${c.similarity.toFixed(2)})`
      ).join('\n') + '\n\nUse kirograph_mem_compare to establish relations.';
    }

    case 'kirograph_mem_prune': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const olderThan = (args.olderThan as string) ?? '90d';
      const durationMs = (() => {
        const m = olderThan.match(/^(\d+)(d|m|w|h)$/);
        if (!m) return 90 * 86400000;
        const v = parseInt(m[1]);
        switch (m[2]) {
          case 'h': return v * 3600000;
          case 'd': return v * 86400000;
          case 'w': return v * 7 * 86400000;
          case 'm': return v * 30 * 86400000;
          default: return 90 * 86400000;
        }
      })();
      const deleted = mem.prune(durationMs);
      return `Pruned ${deleted} observation(s) older than ${olderThan}.`;
    }

    case 'kirograph_mem_lint': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const result = mem.lint();
      const lines = ['Memory Lint Results:'];
      lines.push(`  Stale links:    ${result.staleLinks}`);
      lines.push(`  Model mismatch: ${result.modelMismatch ? 'yes' : 'no'}`);
      lines.push(`  Stale sessions: ${result.staleSessions} (auto-closed)`);
      if (args.fix && result.staleLinks > 0) {
        const removed = mem.removeStaleLinks();
        lines.push(`\n✓ Removed ${removed} stale link(s)`);
      } else if (result.staleLinks > 0) {
        lines.push(`\nPass fix: true to remove stale links.`);
      }
      if (result.modelMismatch) {
        lines.push(`\nRun 'kirograph mem reembed' to fix model mismatch.`);
      }
      return lines.join('\n');
    }

    case 'kirograph_mem_conflicts_list': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const limit = clampLimit(args.limit as number | undefined, 20);
      const pending = mem.getPendingRelations(limit);
      if (pending.length === 0) return 'No pending conflict relations.';
      return `Pending relations (${pending.length}):\n\n` + pending.map(r =>
        `[${r.id}] ${r.relation}\n  A: ${r.observationA}\n  B: ${r.observationB}${r.reason ? `\n  Reason: ${r.reason}` : ''}`
      ).join('\n\n') + '\n\nUse kirograph_mem_conflicts_ignore to dismiss, or kirograph_mem_judge to finalize.';
    }

    case 'kirograph_mem_conflicts_ignore': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase(); db.applyMemorySchema();
      const mem = new MemoryManager(config, db.getRawDb());
      mem.initialize();
      const relationId = args.relationId as string;
      mem.ignoreRelation(relationId);
      return `Relation "${relationId}" ignored.`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
