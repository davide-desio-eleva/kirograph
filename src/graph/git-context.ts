/**
 * Git Context — shared module for all enableGitContext tools.
 *
 * Runs git diff / git log, maps changed line ranges to graph nodes,
 * and enriches with callers/callees. All tools in handlers/git-context.ts
 * import from here.
 */

import { execSync } from 'child_process';
import type { GraphDatabase } from '../db/database';

export interface ChangedSymbol {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  qualifiedName: string;
  changeType: 'added' | 'modified' | 'deleted' | 'unknown';
  callers: Array<{ name: string; kind: string; filePath: string; startLine: number }>;
  callees: Array<{ name: string; kind: string; filePath: string; startLine: number }>;
}

export interface DiffHunk {
  filePath: string;
  addedLines: Array<[number, number]>;   // [start, end] inclusive
  deletedLines: Array<[number, number]>;
  isNewFile: boolean;
  isDeletedFile: boolean;
}

/** Run a git command in projectRoot. Throws if git not found or not a git repo. */
function git(projectRoot: string, args: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: any) {
    throw new Error(`git ${args.split(' ')[0]} failed: ${err.message ?? String(err)}`);
  }
}

/** Parse unified diff output into a list of DiffHunk objects. */
export function parseDiff(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('diff --git')) {
      current = null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const filePath = line.slice(4).replace(/^[ab]\//, '').replace(/^\t/, '');
      if (line.startsWith('+++ ') && filePath !== '/dev/null') {
        if (!current) {
          current = { filePath, addedLines: [], deletedLines: [], isNewFile: false, isDeletedFile: false };
          hunks.push(current);
        } else {
          current.filePath = filePath;
        }
      } else if (line.startsWith('--- ') && filePath === '/dev/null') {
        if (current) current.isNewFile = true;
      } else if (line.startsWith('+++ ') && filePath === '/dev/null') {
        if (current) current.isDeletedFile = true;
      }
      continue;
    }
    if (line.startsWith('@@') && current) {
      // @@ -oldStart,oldLen +newStart,newLen @@
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        const newStart = parseInt(m[3], 10);
        const newLen = parseInt(m[4] ?? '1', 10);
        if (newLen > 0) current.addedLines.push([newStart, newStart + newLen - 1]);
        const oldStart = parseInt(m[1], 10);
        const oldLen = parseInt(m[2] ?? '1', 10);
        if (oldLen > 0) current.deletedLines.push([oldStart, oldStart + oldLen - 1]);
      }
      continue;
    }
    if (line.startsWith('new file') && current) { current.isNewFile = true; continue; }
    if (line.startsWith('deleted file') && current) { current.isDeletedFile = true; continue; }
  }

  return hunks;
}

/** Map a DiffHunk to graph nodes that overlap the changed line ranges. */
function hunkToNodes(db: GraphDatabase, hunk: DiffHunk): Array<{ id: string; name: string; kind: string; filePath: string; startLine: number; endLine: number; qualifiedName: string; changeType: 'added' | 'modified' | 'deleted' | 'unknown' }> {
  const rawDb = db.getRawDb();
  const found = new Map<string, any>();

  const queryRange = (lines: Array<[number, number]>, changeType: 'added' | 'modified' | 'deleted') => {
    for (const [s, e] of lines) {
      const rows = rawDb.all(
        `SELECT id, name, kind, file_path, start_line, end_line, qualified_name
         FROM nodes WHERE file_path = ? AND start_line <= ? AND end_line >= ?
         AND kind NOT IN ('contains','declared_in')`,
        [hunk.filePath, e, s]
      );
      for (const r of rows) {
        if (!found.has(r.id)) found.set(r.id, { ...r, changeType });
      }
    }
  };

  if (hunk.isNewFile) {
    queryRange(hunk.addedLines, 'added');
  } else if (hunk.isDeletedFile) {
    // Can't look up nodes by line — they're gone. Return what we have.
  } else {
    queryRange(hunk.addedLines, 'modified');
  }

  return [...found.values()].map(r => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    qualifiedName: r.qualified_name,
    changeType: r.changeType,
  }));
}

/** Enrich a list of nodes with their immediate callers and callees (max 5 each). */
function enrichWithEdges(db: GraphDatabase, nodes: Array<{ id: string; name: string; kind: string; filePath: string; startLine: number; endLine: number; qualifiedName: string; changeType: 'added' | 'modified' | 'deleted' | 'unknown' }>): ChangedSymbol[] {
  const rawDb = db.getRawDb();
  return nodes.map(n => {
    const callers = rawDb.all(
      `SELECT s.name, s.kind, s.file_path, s.start_line FROM edges e
       JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind IN ('calls','imports') LIMIT 5`,
      [n.id]
    ).map((r: any) => ({ name: r.name, kind: r.kind, filePath: r.file_path, startLine: r.start_line }));
    const callees = rawDb.all(
      `SELECT t.name, t.kind, t.file_path, t.start_line FROM edges e
       JOIN nodes t ON t.id = e.target WHERE e.source = ? AND e.kind IN ('calls','imports') LIMIT 5`,
      [n.id]
    ).map((r: any) => ({ name: r.name, kind: r.kind, filePath: r.file_path, startLine: r.start_line }));
    return { ...n, callers, callees };
  });
}

export interface GitDiffResult {
  changedSymbols: ChangedSymbol[];
  hunks: DiffHunk[];
  ref?: string;
}

/**
 * Get changed symbols for unstaged, staged, or a ref diff.
 * - staged=false → git diff (working tree vs index)
 * - staged=true  → git diff --cached (index vs HEAD)
 * - ref          → git diff <ref>..HEAD
 */
export function getChangedSymbols(projectRoot: string, db: GraphDatabase, opts: { staged?: boolean; ref?: string } = {}): GitDiffResult {
  let diffArgs = 'diff --unified=0';
  if (opts.ref) diffArgs = `diff --unified=0 ${opts.ref}..HEAD`;
  else if (opts.staged) diffArgs = 'diff --cached --unified=0';

  const diffOutput = git(projectRoot, diffArgs);
  if (!diffOutput) return { changedSymbols: [], hunks: [] };

  const hunks = parseDiff(diffOutput);
  const allNodes: Array<{ id: string; name: string; kind: string; filePath: string; startLine: number; endLine: number; qualifiedName: string; changeType: 'added' | 'modified' | 'deleted' | 'unknown' }> = [];
  for (const h of hunks) {
    allNodes.push(...hunkToNodes(db, h));
  }

  // Deduplicate by id
  const seen = new Set<string>();
  const unique = allNodes.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; });

  return { changedSymbols: enrichWithEdges(db, unique), hunks };
}

/** Get structured commit info for staged changes (for commit message generation). */
export interface CommitContext {
  stagedFiles: string[];
  changedSymbols: ChangedSymbol[];
  diffStat: string;
}

export function getCommitContext(projectRoot: string, db: GraphDatabase): CommitContext {
  const stagedFiles = git(projectRoot, 'diff --cached --name-only').split('\n').filter(Boolean);
  const diffStat = git(projectRoot, 'diff --cached --stat');
  const { changedSymbols } = getChangedSymbols(projectRoot, db, { staged: true });
  return { stagedFiles, changedSymbols, diffStat };
}

/** Get semantic diff between two git refs. */
export function getPRContext(projectRoot: string, db: GraphDatabase, base: string, head = 'HEAD'): GitDiffResult {
  const ref = `${base}..${head}`;
  let diffOutput: string;
  try {
    diffOutput = git(projectRoot, `diff --unified=0 ${ref}`);
  } catch {
    throw new Error(`Could not diff ${ref}. Ensure both refs exist in this repository.`);
  }
  if (!diffOutput) return { changedSymbols: [], hunks: [], ref };

  const hunks = parseDiff(diffOutput);
  const allNodes: Array<{ id: string; name: string; kind: string; filePath: string; startLine: number; endLine: number; qualifiedName: string; changeType: 'added' | 'modified' | 'deleted' | 'unknown' }> = [];
  for (const h of hunks) allNodes.push(...hunkToNodes(db, h));

  const seen = new Set<string>();
  const unique = allNodes.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; });

  return { changedSymbols: enrichWithEdges(db, unique), hunks, ref };
}

/** Get commit log between two refs as structured entries. */
export interface CommitEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export function getCommitLog(projectRoot: string, ref1: string, ref2: string): CommitEntry[] {
  const log = git(projectRoot, `log --pretty=format:%H|||%h|||%an|||%ad|||%s --date=short ${ref1}..${ref2}`);
  if (!log) return [];
  return log.split('\n').filter(Boolean).map(line => {
    const [hash, shortHash, author, date, ...subjectParts] = line.split('|||');
    return { hash, shortHash, author, date, subject: subjectParts.join('|||') };
  });
}

/** Find test files that reference a given symbol. */
export function findTestFiles(db: GraphDatabase, symbolId: string): string[] {
  const rawDb = db.getRawDb();
  const testFiles = rawDb.all(
    `SELECT DISTINCT n.file_path FROM edges e
     JOIN nodes n ON n.id = e.source
     WHERE e.target = ? AND (
       n.file_path LIKE '%test%' OR n.file_path LIKE '%spec%' OR
       n.file_path LIKE '%.test.%' OR n.file_path LIKE '%.spec.%'
     )`,
    [symbolId]
  );
  return testFiles.map((r: any) => r.file_path);
}

/** Find symbols that have no test coverage (exported, no caller from a test file). */
export function findUncoveredSymbols(db: GraphDatabase, limit = 30): Array<{ name: string; kind: string; filePath: string; startLine: number }> {
  const rawDb = db.getRawDb();
  return rawDb.all(
    `SELECT n.name, n.kind, n.file_path, n.start_line FROM nodes n
     WHERE n.is_exported = 1 AND n.kind IN ('function','method','class')
     AND NOT EXISTS (
       SELECT 1 FROM edges e JOIN nodes caller ON caller.id = e.source
       WHERE e.target = n.id AND (
         caller.file_path LIKE '%test%' OR caller.file_path LIKE '%spec%'
       )
     )
     ORDER BY n.file_path, n.start_line LIMIT ?`,
    [limit]
  ).map((r: any) => ({ name: r.name, kind: r.kind, filePath: r.file_path, startLine: r.start_line }));
}
