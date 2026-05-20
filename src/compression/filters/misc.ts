/**
 * Miscellaneous command filters: grep/rg, diff, curl/wget, playwright, prisma
 */

import type { CommandFilter, FilterResult, CompressorOptions } from '../types';

export const miscFilter: CommandFilter = {
  name: 'misc',

  matches(command: string): boolean {
    return /\b(grep|rg|ripgrep|diff|curl|wget|playwright|prisma)\b/.test(command);
  },

  filter(command: string, rawOutput: string, level: CompressorOptions['level']): FilterResult {
    if (/\b(grep|rg|ripgrep)\b/.test(command)) return filterGrep(rawOutput, level);
    if (/\bdiff\b/.test(command) && !/git\s+diff/.test(command)) return filterDiff(rawOutput, level);
    if (/\bcurl\b/.test(command)) return filterCurl(rawOutput, level);
    if (/\bwget\b/.test(command)) return filterWget(rawOutput, level);
    if (/\bplaywright\b/.test(command)) return filterPlaywright(rawOutput, level);
    if (/\bprisma\s+generate\b/.test(command)) return filterPrismaGenerate(rawOutput, level);
    return { output: rawOutput, strategy: 'misc:passthrough' };
  },
};

// ── Grep / Ripgrep ────────────────────────────────────────────────────────────

function filterGrep(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  if (lines.length === 0) return { output: 'no matches', strategy: 'grep:empty' };
  if (lines.length <= 15) return { output: raw, strategy: 'grep:short' };

  // Group by file
  const byFile = new Map<string, string[]>();
  for (const line of lines) {
    // Format: file:line:content or file:content
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const file = line.slice(0, colonIdx);
      const rest = line.slice(colonIdx + 1);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(rest.trim());
    } else {
      const key = '__ungrouped__';
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(line);
    }
  }

  if (level === 'ultra') {
    const summary = [...byFile.entries()]
      .filter(([k]) => k !== '__ungrouped__')
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10)
      .map(([f, matches]) => `${f} (${matches.length})`)
      .join(', ');
    return { output: `${lines.length} matches: ${summary}`, strategy: 'grep:ultra' };
  }

  if (level === 'aggressive') {
    const grouped = [...byFile.entries()]
      .filter(([k]) => k !== '__ungrouped__')
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 15)
      .map(([file, matches]) => `${file} (${matches.length} matches)`)
      .join('\n');
    const extra = byFile.size > 15 ? `\n…+${byFile.size - 15} more files` : '';
    return { output: `${lines.length} matches in ${byFile.size} files:\n${grouped}${extra}`, strategy: 'grep:grouped' };
  }

  // Normal: show grouped with sample lines
  const parts: string[] = [`${lines.length} matches in ${byFile.size} files:\n`];
  let shown = 0;
  for (const [file, matches] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (shown >= 10 || file === '__ungrouped__') break;
    parts.push(`${file} (${matches.length}):`);
    for (const m of matches.slice(0, 3)) parts.push(`  ${m.slice(0, 100)}`);
    if (matches.length > 3) parts.push(`  …+${matches.length - 3} more`);
    shown++;
  }
  if (byFile.size > 10) parts.push(`\n…+${byFile.size - 10} more files`);

  return { output: parts.join('\n'), strategy: 'grep:structured' };
}

// ── Diff (non-git) ────────────────────────────────────────────────────────────

function filterDiff(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  if (lines.length <= 20) return { output: raw, strategy: 'diff:short' };

  // Keep headers and changed lines, reduce context
  const result: string[] = [];
  const contextLines = level === 'ultra' ? 1 : level === 'aggressive' ? 2 : 3;
  let afterChange = 0;
  let contextBuffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@') || line.startsWith('diff ')) {
      result.push(line);
      contextBuffer = [];
      afterChange = 0;
      continue;
    }

    if (line.startsWith('+') || line.startsWith('-') || line.startsWith('!') || line.startsWith('>') || line.startsWith('<')) {
      if (contextBuffer.length > 0) {
        result.push(...contextBuffer.slice(-contextLines));
        contextBuffer = [];
      }
      result.push(line);
      afterChange = 0;
      continue;
    }

    afterChange++;
    if (afterChange <= contextLines) {
      result.push(line);
    } else {
      contextBuffer.push(line);
    }
  }

  return { output: result.join('\n'), strategy: 'diff:condensed' };
}

// ── Curl ──────────────────────────────────────────────────────────────────────

function filterCurl(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  // Strip progress bars and stats
  const meaningful = lines.filter(l => {
    const trimmed = l.trim();
    if (!trimmed) return false;
    if (/^\s*%\s+Total/.test(trimmed)) return false;
    if (/^\s*\d+\s+\d+/.test(trimmed) && trimmed.includes('--:--:--')) return false;
    if (trimmed.startsWith('*') && (trimmed.includes('Trying') || trimmed.includes('Connected') || trimmed.includes('TLS'))) return false;
    if (trimmed.startsWith('>') || trimmed.startsWith('< ')) return false; // verbose headers
    return true;
  });

  if (meaningful.length === 0) return { output: 'ok', strategy: 'curl:empty' };

  const maxChars = level === 'ultra' ? 2000 : level === 'aggressive' ? 5000 : 10000;
  const output = meaningful.join('\n');

  if (output.length <= maxChars) return { output, strategy: 'curl:filtered' };

  return { output: output.slice(0, maxChars) + '\n…(truncated)', strategy: 'curl:truncated' };
}

// ── Wget ──────────────────────────────────────────────────────────────────────

function filterWget(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  // Strip progress bars and connection info
  const meaningful = lines.filter(l => {
    const trimmed = l.trim();
    if (!trimmed) return false;
    if (/^\d+K\s/.test(trimmed)) return false; // progress lines
    if (/^--\d{4}/.test(trimmed)) return false; // timestamp lines
    if (trimmed.includes('Resolving') || trimmed.includes('Connecting')) return false;
    if (/\d+%\[/.test(trimmed)) return false; // progress bar
    return true;
  });

  if (meaningful.length === 0) return { output: 'ok', strategy: 'wget:empty' };

  // Look for the saved file line
  const savedLine = lines.find(l => l.includes('saved') || l.includes('written'));
  if (savedLine && level === 'ultra') {
    return { output: savedLine.trim(), strategy: 'wget:ultra' };
  }

  return { output: meaningful.join('\n'), strategy: 'wget:filtered' };
}

// ── Playwright ────────────────────────────────────────────────────────────────

function filterPlaywright(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  // Check for all-pass
  const passedMatch = raw.match(/(\d+)\s+passed/);
  const failedMatch = raw.match(/(\d+)\s+failed/);

  const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
  const total = passed + failed;

  if (failed === 0 && passed > 0) {
    if (level === 'ultra') return { output: `✓ ${passed}/${total}`, strategy: 'playwright:allpass:ultra' };
    return { output: `PASSED: ${passed}/${total} tests`, strategy: 'playwright:allpass' };
  }

  if (failed > 0) {
    // Extract failure details
    const failures: string[] = [];
    let inFailure = false;
    let block: string[] = [];

    for (const line of lines) {
      if (line.includes('✘') || line.includes('FAILED') || line.includes('Error:') || line.includes('expect(')) {
        if (block.length > 0) failures.push(block.join('\n'));
        block = [line];
        inFailure = true;
      } else if (inFailure) {
        block.push(line);
        if (block.length > 15) {
          failures.push(block.join('\n'));
          block = [];
          inFailure = false;
        }
      }
    }
    if (block.length > 0) failures.push(block.join('\n'));

    const header = `FAILED: ${failed}/${total} tests`;
    const maxFailures = level === 'ultra' ? 2 : level === 'aggressive' ? 3 : 5;
    const shown = failures.slice(0, maxFailures).join('\n\n');
    const extra = failures.length > maxFailures ? `\n…+${failures.length - maxFailures} more` : '';

    return { output: `${header}\n\n${shown}${extra}`, strategy: 'playwright:failures' };
  }

  return { output: raw, strategy: 'playwright:passthrough' };
}

// ── Prisma ────────────────────────────────────────────────────────────────────

function filterPrismaGenerate(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  // Strip ASCII art and decorative lines
  const meaningful = lines.filter(l => {
    const trimmed = l.trim();
    if (!trimmed) return false;
    if (/^[╔╗╚╝║═│┌┐└┘├┤┬┴┼─]+$/.test(trimmed)) return false;
    if (/^[█▓░▒■□]+/.test(trimmed)) return false;
    if (trimmed.startsWith('✔') || trimmed.startsWith('✓') || trimmed.includes('Generated')) return true;
    if (trimmed.includes('Prisma') && trimmed.includes('Client')) return true;
    return !(/^[│║]/.test(trimmed));
  });

  if (meaningful.length === 0) return { output: 'ok', strategy: 'prisma:empty' };

  if (level === 'ultra') {
    const genLine = meaningful.find(l => l.includes('Generated') || l.includes('✔'));
    return { output: genLine?.trim() || 'ok', strategy: 'prisma:ultra' };
  }

  return { output: meaningful.join('\n'), strategy: 'prisma:filtered' };
}
