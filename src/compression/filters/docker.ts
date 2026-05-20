/**
 * Docker and container output filters
 */

import type { CommandFilter, FilterResult, CompressorOptions } from '../types';

export const dockerFilter: CommandFilter = {
  name: 'docker',

  matches(command: string): boolean {
    return /\b(docker|kubectl|podman)\b/.test(command);
  },

  filter(command: string, rawOutput: string, level: CompressorOptions['level']): FilterResult {
    if (/docker\s+ps/.test(command)) return filterDockerPs(rawOutput, level);
    if (/docker\s+images/.test(command)) return filterDockerImages(rawOutput, level);
    if (/docker\s+logs/.test(command)) return filterDockerLogs(rawOutput, level);
    if (/docker\s+compose\s+ps/.test(command)) return filterComposePs(rawOutput, level);
    if (/kubectl.*pods/.test(command) || /kubectl\s+get\s+po/.test(command)) return filterKubectlPods(rawOutput, level);
    if (/kubectl.*logs/.test(command)) return filterKubectlLogs(rawOutput, level);
    if (/kubectl.*services/.test(command) || /kubectl\s+get\s+svc/.test(command)) return filterKubectlServices(rawOutput, level);

    return { output: rawOutput, strategy: 'docker:passthrough' };
  },
};

function filterDockerPs(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length <= 1) return { output: 'no containers running', strategy: 'docker-ps:empty' };

  // Parse table format
  const header = lines[0];
  const rows = lines.slice(1);

  if (level === 'ultra') {
    return { output: `${rows.length} containers running`, strategy: 'docker-ps:ultra' };
  }

  // Extract key columns: NAMES, STATUS, PORTS
  const containers = rows.map(row => {
    const parts = row.split(/\s{2,}/);
    // Typical: CONTAINER ID, IMAGE, COMMAND, CREATED, STATUS, PORTS, NAMES
    const name = parts[parts.length - 1] || '';
    const status = parts.find(p => /Up|Exited|Created/.test(p)) || '';
    const image = parts[1] || '';
    return { name: name.trim(), status: status.trim(), image: image.trim() };
  }).filter(c => c.name);

  if (level === 'aggressive') {
    const compact = containers.map(c => `${c.name}: ${c.status}`).join('\n');
    return { output: `${containers.length} containers:\n${compact}`, strategy: 'docker-ps:compact' };
  }

  const detailed = containers.map(c => `${c.name} (${c.image}) - ${c.status}`).join('\n');
  return { output: `${containers.length} containers:\n${detailed}`, strategy: 'docker-ps:detailed' };
}

function filterDockerImages(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length <= 1) return { output: 'no images', strategy: 'docker-images:empty' };

  const rows = lines.slice(1);

  if (level === 'ultra') {
    return { output: `${rows.length} images`, strategy: 'docker-images:ultra' };
  }

  // Extract REPOSITORY, TAG, SIZE
  const images = rows.map(row => {
    const parts = row.split(/\s{2,}/);
    return { repo: parts[0] || '', tag: parts[1] || '', size: parts[parts.length - 1] || '' };
  }).filter(i => i.repo && i.repo !== '<none>');

  const compact = images.slice(0, level === 'aggressive' ? 10 : 20)
    .map(i => `${i.repo}:${i.tag} (${i.size})`)
    .join('\n');
  const extra = images.length > 20 ? `\n…+${images.length - 20} more` : '';

  return { output: `${images.length} images:\n${compact}${extra}`, strategy: 'docker-images:compact' };
}

function filterDockerLogs(raw: string, level: CompressorOptions['level']): FilterResult {
  return deduplicateLogLines(raw, level, 'docker-logs');
}

function filterComposePs(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length <= 1) return { output: 'no services', strategy: 'compose-ps:empty' };

  const rows = lines.slice(1);
  if (level === 'ultra') {
    return { output: `${rows.length} services`, strategy: 'compose-ps:ultra' };
  }

  return { output: lines.join('\n'), strategy: 'compose-ps:table' };
}

function filterKubectlPods(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length <= 1) return { output: 'no pods', strategy: 'kubectl-pods:empty' };

  const rows = lines.slice(1);

  if (level === 'ultra') {
    const running = rows.filter(r => r.includes('Running')).length;
    const other = rows.length - running;
    return { output: `${rows.length} pods (${running} running${other > 0 ? `, ${other} other` : ''})`, strategy: 'kubectl-pods:ultra' };
  }

  // Keep header + rows, but truncate
  const maxRows = level === 'aggressive' ? 15 : 30;
  if (rows.length <= maxRows) return { output: raw, strategy: 'kubectl-pods:short' };

  const shown = [lines[0], ...rows.slice(0, maxRows)].join('\n');
  return { output: `${shown}\n…+${rows.length - maxRows} more pods`, strategy: 'kubectl-pods:truncated' };
}

function filterKubectlLogs(raw: string, level: CompressorOptions['level']): FilterResult {
  return deduplicateLogLines(raw, level, 'kubectl-logs');
}

function filterKubectlServices(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length <= 1) return { output: 'no services', strategy: 'kubectl-svc:empty' };

  if (level === 'ultra') {
    return { output: `${lines.length - 1} services`, strategy: 'kubectl-svc:ultra' };
  }

  return { output: raw, strategy: 'kubectl-svc:table' };
}

// ── Shared log deduplication ──────────────────────────────────────────────────

function deduplicateLogLines(raw: string, level: CompressorOptions['level'], prefix: string): FilterResult {
  const lines = raw.split('\n');

  if (lines.length <= 20) return { output: raw, strategy: `${prefix}:short` };

  // Deduplicate consecutive similar lines
  const result: string[] = [];
  let lastPattern = '';
  let repeatCount = 0;

  for (const line of lines) {
    // Normalize: strip timestamps and numbers for comparison
    const pattern = line.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<ts>')
      .replace(/\b\d+\b/g, '<n>');

    if (pattern === lastPattern) {
      repeatCount++;
    } else {
      if (repeatCount > 1) {
        result.push(`  …repeated ${repeatCount} times`);
      }
      result.push(line);
      lastPattern = pattern;
      repeatCount = 1;
    }
  }
  if (repeatCount > 1) {
    result.push(`  …repeated ${repeatCount} times`);
  }

  // Truncate
  const maxLines = level === 'ultra' ? 20 : level === 'aggressive' ? 40 : 60;
  if (result.length <= maxLines) {
    return { output: result.join('\n'), strategy: `${prefix}:deduped` };
  }

  const shown = result.slice(-maxLines).join('\n'); // Keep tail (most recent)
  return { output: `…(${result.length - maxLines} earlier lines omitted)\n${shown}`, strategy: `${prefix}:deduped+truncated` };
}
