/**
 * Keeps the graph in step with the files without IDE hooks (config `watch`, KIROGRAPH_WATCH=1).
 *
 * The MCP server watches the project; the files that change are collected, and synced together a
 * moment after the last change (a burst of saves is one sync). Only files the index would take:
 * not under .git/ or .kirograph/, of a known language, and not left out by include/exclude.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { KiroGraphConfig } from '../config';
import { shouldIncludeFile } from '../sync/index';
import { detectLanguage } from '../extraction/languages';

/** Wait after the last change before syncing. KIROGRAPH_WATCH_DEBOUNCE_MS overrides it (100 ms – 60 s). */
export function watchDebounceMs(): number {
  const v = Number(process.env.KIROGRAPH_WATCH_DEBOUNCE_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(60_000, Math.max(100, v)) : 2_000;
}

export function watchEnabled(config: KiroGraphConfig | null): boolean {
  const env = process.env.KIROGRAPH_WATCH;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return config?.watch === true;
}

/**
 * Starts watching `root`. `sync` receives the changed paths (relative to root); a change that
 * arrives while it runs is synced after it. Returns a function that stops the watch, or null
 * when the platform cannot watch a tree (Node < 20 on Linux).
 */
export function watchProject(
  root: string,
  config: KiroGraphConfig,
  sync: (files: string[]) => Promise<unknown>,
  debounceMs = watchDebounceMs(),
): (() => void) | null {
  let watcher: fs.FSWatcher;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const flush = async (): Promise<void> => {
    timer = null;
    if (running || pending.size === 0) return;
    running = true;
    const files = [...pending];
    pending.clear();
    try {
      await sync(files);
    } catch { /* the next change, or the next sync, tries again */ }
    running = false;
    if (pending.size > 0) schedule();
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, debounceMs);
  };

  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString().replace(/\\/g, '/');
      if (rel.startsWith('.git/') || rel === '.git' || rel.startsWith('.kirograph/') || rel.includes('/node_modules/') || rel.startsWith('node_modules/')) return;
      if (detectLanguage(path.join(root, rel)) === 'unknown' || !shouldIncludeFile(rel, config)) return;
      pending.add(rel);
      schedule();
    });
  } catch {
    return null;
  }
  watcher.on('error', () => { /* a watch that breaks (folder removed) stops; the hooks and the next start catch up */ });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
