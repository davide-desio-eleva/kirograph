import fs from 'fs';
import path from 'path';
import KiroGraph from '../../index';
import { truncate } from './utils';

export async function handlePatterns(toolName: string, args: Record<string, unknown>, cg: KiroGraph): Promise<string> {
  switch (toolName) {
    case 'kirograph_live_search': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);

      if (!config.enablePatterns) {
        return 'kirograph_live_search requires enablePatterns: true in .kirograph/config.json';
      }

      const { PatternRunner } = await import('../../patterns/runner');
      const runner = new PatternRunner();

      if (!runner.isAvailable()) {
        return 'kirograph_live_search requires @ast-grep/napi. Run: npm install @ast-grep/napi';
      }

      const pattern = args.pattern as string;
      const language = args.language as string;
      const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
      const limit = Math.max(1, Math.min(100, Math.round(rawLimit)));

      const db = cg.getDatabase();
      const rawDb = db.getRawDb();

      const files: Array<{ path: string }> = rawDb.all(
        'SELECT path FROM files WHERE language = ? LIMIT 5000',
        [language],
      );

      const results: Array<{ filePath: string; line: number; matchText: string }> = [];
      let truncated = false;

      for (const file of files) {
        if (results.length >= limit) { truncated = true; break; }

        let content: string;
        try {
          const fullPath = path.isAbsolute(file.path) ? file.path : path.join(projectRoot, file.path);
          content = fs.readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }

        const matches = await runner.runInline(pattern, language, content);
        for (const m of matches) {
          if (results.length >= limit) { truncated = true; break; }
          results.push({ filePath: file.path, line: m.line, matchText: m.matchText });
        }
      }

      if (results.length === 0) {
        return `0 matches for '${pattern}' in ${language} files`;
      }

      const lines: string[] = [
        `${results.length} match${results.length !== 1 ? 'es' : ''} for '${pattern}' in ${language} files`,
        '',
      ];

      for (const r of results) {
        lines.push(` ${r.filePath}:${r.line}`);
        lines.push(`   ${r.matchText}`);
        lines.push('');
      }

      if (truncated) {
        lines.push(`[truncated — showing first ${limit} results; refine your pattern or use --lang to narrow scope]`);
      }

      return truncate(lines.join('\n'));
    }

    case 'kirograph_pattern_coverage': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!(config as any).enablePatterns) {
        return 'Pattern analysis is not enabled. Set enablePatterns: true in .kirograph/config.json and run kirograph index.';
      }

      // Load all pattern rules to enumerate coverage
      const { PatternLibraryLoader } = await import('../../patterns/loader');
      const loader = new PatternLibraryLoader();
      const builtinPath = path.join(__dirname, '../../patterns/library');
      const customPath = (config as any).patternLibraryPath as string | undefined;
      let rules: import('../../patterns/types').PatternRule[] = [];
      try {
        rules = loader.load(builtinPath, customPath);
      } catch { /* no rules — continue */ }

      // Group rules by owaspCategory prefix (A01–A10)
      const rulesByCategory = new Map<string, import('../../patterns/types').PatternRule[]>();
      for (const rule of rules) {
        const prefix = rule.owaspCategory.match(/^(A\d{2})/)?.[1] ?? rule.owaspCategory;
        if (!rulesByCategory.has(prefix)) rulesByCategory.set(prefix, []);
        rulesByCategory.get(prefix)!.push(rule);
      }

      // Query match counts from DB if table exists
      const db = cg.getDatabase();
      db.applyPatternsSchema();
      const rawDb = db.getRawDb();
      const matchCountsByCategory = new Map<string, number>();
      try {
        const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
        if (tableExists) {
          const rows: Array<{ owasp_category: string; cnt: number }> = rawDb.all(
            'SELECT owasp_category, COUNT(*) as cnt FROM pattern_matches GROUP BY owasp_category'
          );
          for (const row of rows) {
            const prefix = row.owasp_category.match(/^(A\d{2})/)?.[1] ?? row.owasp_category;
            matchCountsByCategory.set(prefix, (matchCountsByCategory.get(prefix) ?? 0) + row.cnt);
          }
        }
      } catch { /* non-critical */ }

      // All OWASP Top 10 categories
      const owaspTop10 = [
        'A01', 'A02', 'A03', 'A04', 'A05',
        'A06', 'A07', 'A08', 'A09', 'A10',
      ];
      const owaspNames: Record<string, string> = {
        A01: 'Broken Access Control',
        A02: 'Cryptographic Failures',
        A03: 'Injection',
        A04: 'Insecure Design',
        A05: 'Security Misconfiguration',
        A06: 'Vulnerable and Outdated Components',
        A07: 'Identification and Authentication Failures',
        A08: 'Software and Data Integrity Failures',
        A09: 'Security Logging and Monitoring Failures',
        A10: 'Server-Side Request Forgery',
      };

      const covered: string[] = [];
      const uncovered: string[] = [];

      const lines: string[] = [
        '# OWASP Top 10 Pattern Coverage',
        '',
        `Total rules loaded: ${rules.length}`,
        '',
        'Category | Rules | Matches',
        '-------- | ----- | -------',
      ];

      for (const cat of owaspTop10) {
        const catRules = rulesByCategory.get(cat) ?? [];
        const matchCount = matchCountsByCategory.get(cat) ?? 0;
        const label = `${cat}: ${owaspNames[cat] ?? cat}`;
        if (catRules.length > 0) {
          covered.push(label);
          lines.push(`${label} | ${catRules.length} | ${matchCount}`);
        } else {
          uncovered.push(label);
        }
      }

      // Extra categories not in top 10
      for (const [cat, catRules] of rulesByCategory.entries()) {
        if (!owaspTop10.includes(cat)) {
          const matchCount = matchCountsByCategory.get(cat) ?? 0;
          lines.push(`${cat} | ${catRules.length} | ${matchCount}`);
        }
      }

      if (uncovered.length > 0) {
        lines.push('', `Uncovered categories (${uncovered.length}):`, ...uncovered.map(c => `  - ${c}`));
      }

      lines.push('', `Coverage: ${covered.length} / ${owaspTop10.length} OWASP Top 10 categories`);

      return lines.join('\n');
    }

    case 'kirograph_pattern_save_baseline': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!(config as any).enablePatterns) {
        return 'Pattern analysis is not enabled. Set enablePatterns: true in .kirograph/config.json and run kirograph index.';
      }

      const label = (args.label as string) ?? 'default';

      const db = cg.getDatabase();
      db.applyPatternsSchema();
      const rawDb = db.getRawDb();

      const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
      if (!tableExists) {
        return 'No pattern_matches table found. Run kirograph index first to populate pattern data.';
      }

      const rows: Array<{ pattern_id: string; cnt: number }> = rawDb.all(
        'SELECT pattern_id, COUNT(*) as cnt FROM pattern_matches GROUP BY pattern_id'
      );

      const baseline: Record<string, number> = {};
      for (const row of rows) {
        baseline[row.pattern_id] = row.cnt;
      }

      const kirographDir = path.join(projectRoot, '.kirograph');
      if (!fs.existsSync(kirographDir)) fs.mkdirSync(kirographDir, { recursive: true });

      const baselinePath = path.join(kirographDir, `pattern-baseline-${label}.json`);
      fs.writeFileSync(baselinePath, JSON.stringify({ label, savedAt: Date.now(), counts: baseline }, null, 2));

      const totalMatches = Object.values(baseline).reduce((s, c) => s + c, 0);
      return `Baseline "${label}" saved: ${Object.keys(baseline).length} patterns, ${totalMatches} total matches → ${baselinePath}`;
    }

    case 'kirograph_pattern_diff': {
      const { loadConfig } = await import('../../config');
      const projectRoot = cg.getProjectRoot();
      const config = await loadConfig(projectRoot);
      if (!(config as any).enablePatterns) {
        return 'Pattern analysis is not enabled. Set enablePatterns: true in .kirograph/config.json and run kirograph index.';
      }

      const label = (args.label as string) ?? 'default';
      const baselinePath = path.join(projectRoot, '.kirograph', `pattern-baseline-${label}.json`);

      if (!fs.existsSync(baselinePath)) {
        return `Baseline "${label}" not found. Run kirograph_pattern_save_baseline first.`;
      }

      let baseline: { label: string; savedAt: number; counts: Record<string, number> };
      try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      } catch {
        return `Failed to read baseline file: ${baselinePath}`;
      }

      const db = cg.getDatabase();
      db.applyPatternsSchema();
      const rawDb = db.getRawDb();

      const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'");
      const currentCounts: Record<string, number> = {};
      if (tableExists) {
        const rows: Array<{ pattern_id: string; cnt: number }> = rawDb.all(
          'SELECT pattern_id, COUNT(*) as cnt FROM pattern_matches GROUP BY pattern_id'
        );
        for (const row of rows) {
          currentCounts[row.pattern_id] = row.cnt;
        }
      }

      const allPatternIds = new Set([...Object.keys(baseline.counts), ...Object.keys(currentCounts)]);

      const newFindings: Array<{ id: string; count: number }> = [];
      const resolvedFindings: Array<{ id: string; count: number }> = [];
      const unchanged: Array<{ id: string; count: number }> = [];
      const changed: Array<{ id: string; before: number; after: number; delta: number }> = [];

      for (const id of allPatternIds) {
        const before = baseline.counts[id] ?? 0;
        const after = currentCounts[id] ?? 0;
        if (before === 0 && after > 0) {
          newFindings.push({ id, count: after });
        } else if (before > 0 && after === 0) {
          resolvedFindings.push({ id, count: before });
        } else if (before === after) {
          unchanged.push({ id, count: after });
        } else {
          changed.push({ id, before, after, delta: after - before });
        }
      }

      const savedDate = new Date(baseline.savedAt).toISOString().slice(0, 16).replace('T', ' ');
      const lines: string[] = [
        `# Pattern Diff: "${label}" (saved ${savedDate}) → current`,
        '',
        `NEW: ${newFindings.length}  RESOLVED: ${resolvedFindings.length}  CHANGED: ${changed.length}  UNCHANGED: ${unchanged.length}`,
      ];

      if (newFindings.length > 0) {
        lines.push('', '## New Findings (not in baseline)');
        for (const f of newFindings.sort((a, b) => b.count - a.count)) {
          lines.push(`  + ${f.id}: ${f.count} matches`);
        }
      }

      if (resolvedFindings.length > 0) {
        lines.push('', '## Resolved (in baseline, not in current)');
        for (const f of resolvedFindings.sort((a, b) => b.count - a.count)) {
          lines.push(`  - ${f.id}: was ${f.count} matches`);
        }
      }

      if (changed.length > 0) {
        lines.push('', '## Changed');
        for (const f of changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
          const sign = f.delta > 0 ? '+' : '';
          lines.push(`  ~ ${f.id}: ${f.before} → ${f.after} (${sign}${f.delta})`);
        }
      }

      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
