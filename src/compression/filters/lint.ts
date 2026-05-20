/**
 * Lint and build tool output filters (eslint, tsc, ruff, clippy, prettier, biome)
 */

import type { CommandFilter, FilterResult, CompressorOptions } from '../types';

export const lintFilter: CommandFilter = {
  name: 'lint',

  matches(command: string): boolean {
    return /\b(eslint|tsc|typescript|ruff|clippy|cargo\s+clippy|cargo\s+build|prettier|biome|golangci-lint|rubocop|next\s+build)\b/.test(command);
  },

  filter(command: string, rawOutput: string, level: CompressorOptions['level']): FilterResult {
    if (/tsc\b|typescript/.test(command)) return filterTsc(rawOutput, level);
    if (/eslint/.test(command)) return filterEslint(rawOutput, level);
    if (/ruff/.test(command)) return filterRuff(rawOutput, level);
    if (/cargo\s+clippy/.test(command)) return filterCargoClippy(rawOutput, level);
    if (/cargo\s+build/.test(command)) return filterCargoBuild(rawOutput, level);
    if (/prettier/.test(command)) return filterPrettier(rawOutput, level);
    if (/biome/.test(command)) return filterBiome(rawOutput, level);
    if (/golangci-lint/.test(command)) return filterGolangciLint(rawOutput, level);
    if (/rubocop/.test(command)) return filterRubocop(rawOutput, level);
    if (/next\s+build/.test(command)) return filterNextBuild(rawOutput, level);

    return { output: rawOutput, strategy: 'lint:passthrough' };
  },
};

function filterTsc(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  if (lines.length === 0 || raw.includes('0 errors')) {
    return { output: 'ok (no errors)', strategy: 'tsc:clean' };
  }

  // Group errors by file
  const errorsByFile = new Map<string, string[]>();
  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)/);
    if (match) {
      const [, file, , , code, msg] = match;
      if (!errorsByFile.has(file)) errorsByFile.set(file, []);
      errorsByFile.get(file)!.push(`${code}: ${msg}`);
      continue;
    }
    // Alternative format: file:line:col - error TSxxxx: msg
    const altMatch = line.match(/^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.+)/);
    if (altMatch) {
      const [, file, , , code, msg] = altMatch;
      if (!errorsByFile.has(file)) errorsByFile.set(file, []);
      errorsByFile.get(file)!.push(`${code}: ${msg}`);
    }
  }

  if (errorsByFile.size === 0) {
    return { output: raw, strategy: 'tsc:passthrough' };
  }

  const totalErrors = [...errorsByFile.values()].reduce((s, e) => s + e.length, 0);

  if (level === 'ultra') {
    const summary = [...errorsByFile.entries()]
      .map(([f, errs]) => `${f}: ${errs.length} errors`)
      .join('\n');
    return { output: `${totalErrors} errors in ${errorsByFile.size} files\n${summary}`, strategy: 'tsc:ultra' };
  }

  const parts: string[] = [`${totalErrors} TypeScript errors in ${errorsByFile.size} files:\n`];
  const maxFiles = level === 'aggressive' ? 5 : 10;
  let shown = 0;

  for (const [file, errors] of errorsByFile) {
    if (shown >= maxFiles) break;
    parts.push(`${file} (${errors.length}):`);
    const maxErrs = level === 'aggressive' ? 3 : 5;
    for (const err of errors.slice(0, maxErrs)) {
      parts.push(`  ${err}`);
    }
    if (errors.length > maxErrs) parts.push(`  …+${errors.length - maxErrs} more`);
    shown++;
  }

  if (errorsByFile.size > maxFiles) {
    parts.push(`\n…+${errorsByFile.size - maxFiles} more files with errors`);
  }

  return { output: parts.join('\n'), strategy: 'tsc:grouped' };
}

function filterEslint(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  // Check for clean output
  if (lines.every(l => !l.trim() || l.includes('0 problems'))) {
    return { output: 'ok (no problems)', strategy: 'eslint:clean' };
  }

  // Group by rule
  const ruleCount = new Map<string, number>();
  const errorsByFile = new Map<string, string[]>();
  let currentFile = '';

  for (const line of lines) {
    // File path line (starts with / or ./)
    if (line.match(/^[/.]/)) {
      currentFile = line.trim();
      continue;
    }

    // Error line: "  line:col  error/warning  message  rule-name"
    const match = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/);
    if (match) {
      const [, , , , msg, rule] = match;
      ruleCount.set(rule, (ruleCount.get(rule) || 0) + 1);
      if (currentFile) {
        if (!errorsByFile.has(currentFile)) errorsByFile.set(currentFile, []);
        errorsByFile.get(currentFile)!.push(`${rule}: ${msg}`);
      }
    }
  }

  const totalProblems = [...ruleCount.values()].reduce((s, c) => s + c, 0);

  if (level === 'ultra') {
    const topRules = [...ruleCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([rule, count]) => `${rule}: ${count}`)
      .join(', ');
    return { output: `${totalProblems} problems: ${topRules}`, strategy: 'eslint:ultra' };
  }

  if (level === 'aggressive') {
    const byRule = [...ruleCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => `  ${rule}: ${count}`)
      .join('\n');
    return { output: `${totalProblems} problems in ${errorsByFile.size} files:\n${byRule}`, strategy: 'eslint:byrule' };
  }

  // Normal: show by file, limited
  const parts: string[] = [`${totalProblems} problems in ${errorsByFile.size} files:\n`];
  let shown = 0;
  for (const [file, errors] of errorsByFile) {
    if (shown >= 10) break;
    parts.push(`${file} (${errors.length}):`);
    for (const err of errors.slice(0, 3)) parts.push(`  ${err}`);
    if (errors.length > 3) parts.push(`  …+${errors.length - 3} more`);
    shown++;
  }
  if (errorsByFile.size > 10) parts.push(`\n…+${errorsByFile.size - 10} more files`);

  return { output: parts.join('\n'), strategy: 'eslint:grouped' };
}

function filterRuff(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  if (lines.length === 0 || raw.includes('All checks passed')) {
    return { output: 'ok (no issues)', strategy: 'ruff:clean' };
  }

  // Group by rule code
  const ruleCount = new Map<string, number>();
  for (const line of lines) {
    const match = line.match(/\b([A-Z]\d{3,4})\b/);
    if (match) ruleCount.set(match[1], (ruleCount.get(match[1]) || 0) + 1);
  }

  const total = [...ruleCount.values()].reduce((s, c) => s + c, 0);

  if (level === 'ultra') {
    const top = [...ruleCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([r, c]) => `${r}:${c}`).join(' ');
    return { output: `${total} issues: ${top}`, strategy: 'ruff:ultra' };
  }

  const byRule = [...ruleCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rule, count]) => `  ${rule}: ${count}`)
    .join('\n');

  return { output: `${total} issues:\n${byRule}`, strategy: 'ruff:grouped' };
}

function filterCargoClippy(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  if (raw.includes('0 warnings') && !raw.includes('error')) {
    return { output: 'ok (no warnings)', strategy: 'clippy:clean' };
  }

  // Extract warnings and errors
  const issues: string[] = [];
  for (const line of lines) {
    if (line.startsWith('warning:') || line.startsWith('error')) {
      issues.push(line);
    }
  }

  const errors = issues.filter(l => l.startsWith('error'));
  const warnings = issues.filter(l => l.startsWith('warning:'));

  if (level === 'ultra') {
    return { output: `${errors.length} errors, ${warnings.length} warnings`, strategy: 'clippy:ultra' };
  }

  const maxIssues = level === 'aggressive' ? 10 : 20;
  const shown = issues.slice(0, maxIssues).join('\n');
  const extra = issues.length > maxIssues ? `\n…+${issues.length - maxIssues} more` : '';

  return { output: `${errors.length} errors, ${warnings.length} warnings:\n\n${shown}${extra}`, strategy: 'clippy:filtered' };
}

function filterCargoBuild(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  // Success
  if (raw.includes('Finished') && !raw.includes('error')) {
    const finishLine = lines.find(l => l.includes('Finished'));
    return { output: finishLine || 'ok', strategy: 'cargo-build:success' };
  }

  // Errors only
  const errors = lines.filter(l => l.startsWith('error'));
  if (errors.length === 0) {
    return { output: raw, strategy: 'cargo-build:passthrough' };
  }

  const maxErrors = level === 'ultra' ? 5 : level === 'aggressive' ? 10 : 20;
  const shown = errors.slice(0, maxErrors).join('\n');
  const extra = errors.length > maxErrors ? `\n…+${errors.length - maxErrors} more errors` : '';

  return { output: `${errors.length} errors:\n\n${shown}${extra}`, strategy: 'cargo-build:errors' };
}

function filterPrettier(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  if (lines.length === 0 || raw.includes('All matched files use Prettier')) {
    return { output: 'ok (all formatted)', strategy: 'prettier:clean' };
  }

  // Files needing formatting
  const files = lines.filter(l => !l.startsWith('[') && l.includes('.'));
  if (level === 'ultra') {
    return { output: `${files.length} files need formatting`, strategy: 'prettier:ultra' };
  }

  const maxFiles = level === 'aggressive' ? 10 : 20;
  const shown = files.slice(0, maxFiles).join('\n');
  const extra = files.length > maxFiles ? `\n…+${files.length - maxFiles} more` : '';

  return { output: `${files.length} files need formatting:\n${shown}${extra}`, strategy: 'prettier:files' };
}

function filterBiome(raw: string, level: CompressorOptions['level']): FilterResult {
  // Similar to eslint
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { output: 'ok', strategy: 'biome:clean' };

  const errorLines = lines.filter(l => /error|warning/i.test(l));
  if (errorLines.length === 0) return { output: 'ok', strategy: 'biome:clean' };

  const maxLines = level === 'ultra' ? 5 : level === 'aggressive' ? 10 : 20;
  return { output: errorLines.slice(0, maxLines).join('\n'), strategy: 'biome:filtered' };
}

function filterGolangciLint(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { output: 'ok (no issues)', strategy: 'golangci:clean' };

  // Group by linter name
  const byLinter = new Map<string, number>();
  for (const line of lines) {
    const match = line.match(/\((\w+)\)\s*$/);
    if (match) byLinter.set(match[1], (byLinter.get(match[1]) || 0) + 1);
  }

  const total = [...byLinter.values()].reduce((s, c) => s + c, 0) || lines.length;

  if (level === 'ultra') {
    const top = [...byLinter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([l, c]) => `${l}:${c}`).join(' ');
    return { output: `${total} issues: ${top}`, strategy: 'golangci:ultra' };
  }

  const grouped = [...byLinter.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([linter, count]) => `  ${linter}: ${count}`)
    .join('\n');

  return { output: `${total} issues:\n${grouped}`, strategy: 'golangci:grouped' };
}

function filterRubocop(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  const summaryMatch = raw.match(/(\d+)\s+offenses?\s+detected/);

  if (!summaryMatch || summaryMatch[1] === '0') {
    return { output: 'ok (no offenses)', strategy: 'rubocop:clean' };
  }

  const total = parseInt(summaryMatch[1]);
  if (level === 'ultra') {
    return { output: `${total} offenses`, strategy: 'rubocop:ultra' };
  }

  const offenses = lines.filter(l => l.includes(':') && /[CWE]:/.test(l));
  const maxLines = level === 'aggressive' ? 10 : 20;
  const shown = offenses.slice(0, maxLines).join('\n');
  const extra = offenses.length > maxLines ? `\n…+${offenses.length - maxLines} more` : '';

  return { output: `${total} offenses:\n${shown}${extra}`, strategy: 'rubocop:filtered' };
}

function filterNextBuild(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n');

  // Success
  if (raw.includes('Compiled successfully') || raw.includes('✓ Compiled')) {
    const routeLines = lines.filter(l => l.includes('○') || l.includes('●') || l.includes('λ'));
    if (level === 'ultra') {
      return { output: `ok (${routeLines.length} routes)`, strategy: 'next-build:ultra' };
    }
    const maxRoutes = level === 'aggressive' ? 10 : 20;
    const shown = routeLines.slice(0, maxRoutes).join('\n');
    return { output: `Build successful (${routeLines.length} routes):\n${shown}`, strategy: 'next-build:success' };
  }

  // Errors
  const errorLines = lines.filter(l => /error/i.test(l) || l.includes('Failed'));
  const maxLines = level === 'ultra' ? 5 : level === 'aggressive' ? 10 : 20;
  return { output: errorLines.slice(0, maxLines).join('\n') || raw, strategy: 'next-build:errors' };
}
