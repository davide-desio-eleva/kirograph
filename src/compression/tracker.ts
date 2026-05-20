/**
 * KiroGraph Token Savings Tracker
 *
 * Records compression results to a local JSON file for analytics.
 * Uses a simple append-only JSON lines file to avoid SQLite dependency
 * in the compression module (keeps it lightweight and independent).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { TokenSavingsRecord } from './types';

const TRACKER_DIR = '.kirograph';
const TRACKER_FILE = 'token-savings.jsonl';
const MAX_RECORDS = 5000; // Rotate after this many records

export interface GainStats {
  totalCommands: number;
  totalOriginal: number;
  totalCompressed: number;
  totalSaved: number;
  savingsPercent: number;
  byFamily: Record<string, { count: number; savings: number }>;
  recentCommands: Array<{ command: string; savings: number; timestamp: number; source?: string }>;
  /** Breakdown by source type */
  bySource: {
    exec: { count: number; saved: number };
    graph: { count: number; saved: number };
  };
}

export class TokenTracker {
  private filePath: string;
  private sessionId: string;

  constructor(projectRoot: string) {
    const dir = path.join(projectRoot, TRACKER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, TRACKER_FILE);
    this.sessionId = this.getOrCreateSessionId(dir);
  }

  private getOrCreateSessionId(dir: string): string {
    const sessionFile = path.join(dir, '.session-id');
    try {
      const existing = fs.readFileSync(sessionFile, 'utf8').trim();
      if (existing) return existing;
    } catch { /* file doesn't exist */ }

    const id = crypto.randomBytes(8).toString('hex');
    try {
      fs.writeFileSync(sessionFile, id, 'utf8');
    } catch { /* ignore write errors */ }
    return id;
  }

  /**
   * Record a compression result.
   */
  record(command: string, originalTokens: number, compressedTokens: number, strategy: string, source: 'exec' | 'graph' = 'exec'): void {
    const record: TokenSavingsRecord = {
      timestamp: Date.now(),
      command: command.slice(0, 200), // Truncate long commands
      originalTokens,
      compressedTokens,
      strategy,
      sessionId: this.sessionId,
      source,
    };

    try {
      fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
      this.maybeRotate();
    } catch {
      // Non-critical — don't crash on tracking failure
    }
  }

  /**
   * Record a graph tool saving.
   * @param toolName - The MCP tool that was called
   * @param outputTokens - Actual tokens returned by the tool
   * @param naiveCost - Estimated tokens the agent would have used without the tool
   */
  recordGraphSaving(toolName: string, outputTokens: number, naiveCost: number): void {
    this.record(toolName, naiveCost, outputTokens, `graph:${toolName}`, 'graph');
  }

  /**
   * Get aggregated statistics for a time period.
   */
  getStats(period: 'session' | 'today' | 'week' | 'all'): GainStats {
    const records = this.loadRecords(period);

    if (records.length === 0) {
      return {
        totalCommands: 0,
        totalOriginal: 0,
        totalCompressed: 0,
        totalSaved: 0,
        savingsPercent: 0,
        byFamily: {},
        recentCommands: [],
        bySource: { exec: { count: 0, saved: 0 }, graph: { count: 0, saved: 0 } },
      };
    }

    let totalOriginal = 0;
    let totalCompressed = 0;
    const byFamily = new Map<string, { count: number; totalOriginal: number; totalCompressed: number }>();
    const bySource = { exec: { count: 0, saved: 0 }, graph: { count: 0, saved: 0 } };

    for (const r of records) {
      totalOriginal += r.originalTokens;
      totalCompressed += r.compressedTokens;

      const family = this.extractFamily(r.strategy);
      const existing = byFamily.get(family) || { count: 0, totalOriginal: 0, totalCompressed: 0 };
      existing.count++;
      existing.totalOriginal += r.originalTokens;
      existing.totalCompressed += r.compressedTokens;
      byFamily.set(family, existing);

      const source = r.source || 'exec';
      bySource[source].count++;
      bySource[source].saved += r.originalTokens - r.compressedTokens;
    }

    const totalSaved = totalOriginal - totalCompressed;
    const savingsPercent = totalOriginal > 0 ? Math.round((totalSaved / totalOriginal) * 100) : 0;

    // Convert byFamily map to sorted object
    const byFamilyObj: Record<string, { count: number; savings: number }> = {};
    const sortedFamilies = [...byFamily.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [family, data] of sortedFamilies) {
      const familySaved = data.totalOriginal - data.totalCompressed;
      const familyPercent = data.totalOriginal > 0 ? Math.round((familySaved / data.totalOriginal) * 100) : 0;
      byFamilyObj[family] = { count: data.count, savings: familyPercent };
    }

    // Recent commands (last 10)
    const recentCommands = records.slice(-10).reverse().map(r => ({
      command: r.command,
      savings: r.originalTokens > 0
        ? Math.round(((r.originalTokens - r.compressedTokens) / r.originalTokens) * 100)
        : 0,
      timestamp: r.timestamp,
      source: r.source,
    }));

    return {
      totalCommands: records.length,
      totalOriginal,
      totalCompressed,
      totalSaved,
      savingsPercent,
      byFamily: byFamilyObj,
      recentCommands,
      bySource,
    };
  }

  /**
   * Get raw history for CLI display.
   */
  getHistory(limit: number = 20): TokenSavingsRecord[] {
    const records = this.loadRecords('all');
    return records.slice(-limit).reverse();
  }

  /**
   * Get daily breakdown for graph display.
   */
  getDailyBreakdown(days: number = 30): Array<{ date: string; commands: number; saved: number }> {
    const records = this.loadRecords('all');
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;

    const byDay = new Map<string, { commands: number; saved: number }>();

    for (const r of records) {
      if (r.timestamp < cutoff) continue;
      const date = new Date(r.timestamp).toISOString().slice(0, 10);
      const existing = byDay.get(date) || { commands: 0, saved: 0 };
      existing.commands++;
      existing.saved += r.originalTokens - r.compressedTokens;
      byDay.set(date, existing);
    }

    return [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, data]) => ({ date, ...data }));
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private loadRecords(period: 'session' | 'today' | 'week' | 'all'): TokenSavingsRecord[] {
    if (!fs.existsSync(this.filePath)) return [];

    let lines: string[];
    try {
      lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(l => l.trim());
    } catch {
      return [];
    }

    const records: TokenSavingsRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    // Filter by period
    const now = Date.now();
    switch (period) {
      case 'session':
        return records.filter(r => r.sessionId === this.sessionId);
      case 'today': {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        return records.filter(r => r.timestamp >= startOfDay.getTime());
      }
      case 'week':
        return records.filter(r => r.timestamp >= now - 7 * 24 * 60 * 60 * 1000);
      case 'all':
        return records;
    }
  }

  private extractFamily(strategy: string): string {
    // "git:status:ultra" → "git"
    // "jest:failures" → "jest"
    const colon = strategy.indexOf(':');
    return colon > 0 ? strategy.slice(0, colon) : strategy;
  }

  private maybeRotate(): void {
    try {
      const stat = fs.statSync(this.filePath);
      // Rotate if file exceeds ~500KB
      if (stat.size > 500 * 1024) {
        const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(l => l.trim());
        if (lines.length > MAX_RECORDS) {
          // Keep last half
          const keep = lines.slice(-Math.floor(MAX_RECORDS / 2));
          fs.writeFileSync(this.filePath, keep.join('\n') + '\n', 'utf8');
        }
      }
    } catch {
      // Non-critical
    }
  }
}
