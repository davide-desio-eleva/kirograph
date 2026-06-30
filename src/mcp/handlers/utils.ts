import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const MAX_OUTPUT = 15_000;

export function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…[truncated]' : s;
}

/** Estimate how many tokens reading the full files would cost (chars / 4 heuristic). */
export function estimateFileTokens(projectRoot: string, filePaths: string[]): number {
  let total = 0;
  for (const fp of filePaths) {
    try {
      const fullPath = path.isAbsolute(fp) ? fp : path.join(projectRoot, fp);
      const stat = fs.statSync(fullPath);
      total += Math.round(stat.size / 4);
    } catch {
      // File may not exist or be unreadable — skip
    }
  }
  return total;
}

export function clampLimit(value: number | undefined, defaultValue: number): number {
  const n = typeof value === 'number' ? value : defaultValue;
  return Math.max(1, Math.min(100, Math.round(n)));
}

/** Map internal kind values to human-readable MCP response kinds. */
export function mapKind(kind: string): string {
  if (kind === 'type_alias') return 'type';
  return kind;
}

/** Write a session marker so hooks can detect MCP was consulted. */
export function writeSessionMarker(projectRoot: string): void {
  try {
    const hash = crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
    fs.writeFileSync(`/tmp/kirograph-consulted-${hash}`, String(Date.now()));
  } catch { /* best-effort */ }
}

/** Format a timestamp as a human-readable relative age. */
export function formatAge(timestamp: number): string {
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
