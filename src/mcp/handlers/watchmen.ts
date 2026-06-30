import KiroGraph from '../../index';

export async function handleWatchmen(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_watchmen_status': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled. Set enableMemory: true in .kirograph/config.json';
      if (!config.enableWatchmen) return 'Watchmen is not enabled. Set enableWatchmen: true in .kirograph/config.json';

      const { WatchmenChecker } = await import('../../watchmen/index');
      const { MemoryDatabase } = await import('../../memory/database');
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const memDb = new MemoryDatabase(db.getRawDb());
      memDb.initialize();

      const checker = new WatchmenChecker(config.watchmenThreshold);
      const { ready, pendingCount } = checker.shouldSynthesize(memDb);
      const { targetFiles } = checker.buildReadyResponse('', pendingCount, projectRoot);

      const statusLines = [
        `Watchmen Status:`,
        `  Pending observations: ${pendingCount} / ${config.watchmenThreshold} threshold`,
        `  Ready to synthesize:  ${ready ? 'yes' : 'no'}`,
        `  Target files:`,
      ];
      for (const f of targetFiles) statusLines.push(`    · ${f}`);
      return statusLines.join('\n');
    }

    case 'kirograph_watchmen_synthesize': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory || !config.enableWatchmen) return 'Watchmen is not enabled (enableMemory + enableWatchmen required).';
      if (config.watchmenSynthesisMode !== 'local') return 'watchmenSynthesisMode is not "local" — use the agent hook instead.';

      const { WatchmenChecker } = await import('../../watchmen/index');
      const { MemoryDatabase } = await import('../../memory/database');
      const { runLocalSynthesis } = await import('../../watchmen/synthesize');
      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const memDb = new MemoryDatabase(db.getRawDb());
      memDb.initialize();

      const checker = new WatchmenChecker(config.watchmenThreshold);
      const { ready, pendingCount } = checker.shouldSynthesize(memDb);

      if (!ready && !args.force) {
        return `Watchmen: ${pendingCount}/${config.watchmenThreshold} observations — threshold not reached. Pass force: true to run anyway.`;
      }

      const observations = memDb.getObservationsSinceLastSummary(50);
      if (observations.length === 0) return 'No observations to synthesize.';

      const readyResult = checker.buildReadyResponse('', pendingCount, projectRoot);
      const result = await runLocalSynthesis(observations, readyResult, config.watchmenLocalModel, projectRoot, true);

      const mgr = new MemoryManager(config, db.getRawDb(), projectRoot);
      mgr.initialize();
      await mgr.store({ content: result.summaryObservation, kind: 'summary', source: 'agent' });

      const synthLines = [`Watchmen synthesis complete.`];
      if (result.filesWritten.length) synthLines.push(`Brief written to: ${result.filesWritten.join(', ')}`);
      if (result.skillsWritten.length) synthLines.push(`Skills written: ${result.skillsWritten.join(', ')}`);
      if (result.skillsPruned.length) synthLines.push(`Pruned stale: ${result.skillsPruned.join(', ')}`);
      return synthLines.join('\n');
    }

    case 'kirograph_watchmen_reset': {
      const { loadConfig } = await import('../../config');
      const projectRoot = args.projectPath as string ?? cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!config.enableMemory) return 'Memory is not enabled.';
      if (!config.enableWatchmen) return 'Watchmen is not enabled.';

      const { MemoryManager } = await import('../../memory/index');
      const db = cg.getDatabase();
      db.applyMemorySchema();
      const mgr = new MemoryManager(config, db.getRawDb(), projectRoot);
      mgr.initialize();

      const id = await mgr.store({ content: `Watchmen counter reset via MCP at ${new Date().toISOString()}.`, kind: 'summary', source: 'manual' });
      return id ? 'Watchmen counter reset — pending observations set back to 0.' : 'Already at zero — nothing to reset.';
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
