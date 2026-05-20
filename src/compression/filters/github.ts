/**
 * GitHub CLI (gh) output filters
 */

import type { CommandFilter, FilterResult, CompressorOptions } from '../types';

export const githubFilter: CommandFilter = {
  name: 'gh',

  matches(command: string): boolean {
    return /\bgh\s/.test(command);
  },

  filter(command: string, rawOutput: string, level: CompressorOptions['level']): FilterResult {
    if (/gh\s+pr\s+list/.test(command)) return filterPrList(rawOutput, level);
    if (/gh\s+pr\s+view/.test(command)) return filterPrView(rawOutput, level);
    if (/gh\s+pr\s+checks/.test(command)) return filterPrChecks(rawOutput, level);
    if (/gh\s+issue\s+list/.test(command)) return filterIssueList(rawOutput, level);
    if (/gh\s+run\s+list/.test(command)) return filterRunList(rawOutput, level);
    if (/gh\s+run\s+view/.test(command)) return filterRunView(rawOutput, level);
    return { output: rawOutput, strategy: 'gh:passthrough' };
  },
};

function filterPrList(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { output: 'no open PRs', strategy: 'gh:pr-list:empty' };

  if (level === 'ultra') {
    return { output: `${lines.length} PRs`, strategy: 'gh:pr-list:ultra' };
  }

  // gh pr list outputs tab-separated: number, title, branch, status
  const compact = lines.map(l => {
    const parts = l.split('\t');
    if (parts.length >= 3) {
      const [num, title, branch] = parts;
      return `#${num} ${title} (${branch})`;
    }
    return l;
  });

  const maxLines = level === 'aggressive' ? 10 : 20;
  const shown = compact.slice(0, maxLines).join('\n');
  const extra = compact.length > maxLines ? `\n…+${compact.length - maxLines} more` : '';

  return { output: `${compact.length} PRs:\n${shown}${extra}`, strategy: 'gh:pr-list' };
}

function filterPrView(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  if (level === 'ultra') {
    // Extract title and state
    const titleLine = lines.find(l => l.startsWith('title:') || /^#\d+/.test(l.trim()));
    const stateLine = lines.find(l => l.includes('OPEN') || l.includes('MERGED') || l.includes('CLOSED'));
    return { output: (titleLine || lines[0] || '').trim() + (stateLine ? ` [${stateLine.trim()}]` : ''), strategy: 'gh:pr-view:ultra' };
  }

  // Strip verbose metadata, keep: title, state, author, body summary, checks
  const important = lines.filter(l => {
    const trimmed = l.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('--')) return false;
    return true;
  });

  const maxLines = level === 'aggressive' ? 20 : 40;
  if (important.length <= maxLines) return { output: important.join('\n'), strategy: 'gh:pr-view' };

  return { output: important.slice(0, maxLines).join('\n') + `\n…+${important.length - maxLines} more lines`, strategy: 'gh:pr-view' };
}

function filterPrChecks(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { output: 'no checks', strategy: 'gh:pr-checks:empty' };

  const passed = lines.filter(l => l.includes('pass') || l.includes('✓')).length;
  const failed = lines.filter(l => l.includes('fail') || l.includes('✗') || l.includes('X')).length;

  if (level === 'ultra') {
    return { output: failed > 0 ? `✗ ${failed} failed, ${passed} passed` : `✓ ${passed} passed`, strategy: 'gh:pr-checks:ultra' };
  }

  return { output: raw, strategy: 'gh:pr-checks' };
}

function filterIssueList(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { output: 'no open issues', strategy: 'gh:issue-list:empty' };

  if (level === 'ultra') {
    return { output: `${lines.length} issues`, strategy: 'gh:issue-list:ultra' };
  }

  const compact = lines.map(l => {
    const parts = l.split('\t');
    if (parts.length >= 3) {
      const [num, title] = parts;
      return `#${num} ${title}`;
    }
    return l;
  });

  const maxLines = level === 'aggressive' ? 10 : 20;
  const shown = compact.slice(0, maxLines).join('\n');
  const extra = compact.length > maxLines ? `\n…+${compact.length - maxLines} more` : '';

  return { output: `${compact.length} issues:\n${shown}${extra}`, strategy: 'gh:issue-list' };
}

function filterRunList(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { output: 'no runs', strategy: 'gh:run-list:empty' };

  if (level === 'ultra') {
    const failed = lines.filter(l => l.includes('failure') || l.includes('X')).length;
    return { output: failed > 0 ? `${lines.length} runs (${failed} failed)` : `${lines.length} runs`, strategy: 'gh:run-list:ultra' };
  }

  const maxLines = level === 'aggressive' ? 10 : 20;
  const shown = lines.slice(0, maxLines).join('\n');
  const extra = lines.length > maxLines ? `\n…+${lines.length - maxLines} more` : '';

  return { output: `${shown}${extra}`, strategy: 'gh:run-list' };
}

function filterRunView(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  if (level === 'ultra') {
    const statusLine = lines.find(l => l.includes('completed') || l.includes('in_progress') || l.includes('failure'));
    return { output: statusLine || lines[0] || '', strategy: 'gh:run-view:ultra' };
  }

  const maxLines = level === 'aggressive' ? 20 : 40;
  if (lines.length <= maxLines) return { output: raw, strategy: 'gh:run-view' };
  return { output: lines.slice(0, maxLines).join('\n') + `\n…+${lines.length - maxLines} more`, strategy: 'gh:run-view' };
}
