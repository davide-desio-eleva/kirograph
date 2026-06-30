import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export function sanitizeBranchName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function branchDbPath(projectRoot: string, branchName: string): string {
  return path.join(projectRoot, '.kirograph', `branch-${sanitizeBranchName(branchName)}.db`);
}

export interface BranchInfo {
  name: string;       // sanitized name
  rawName: string;    // from git (if resolvable)
  dbPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export function listTrackedBranches(projectRoot: string): BranchInfo[] {
  const dir = path.join(projectRoot, '.kirograph');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('branch-') && f.endsWith('.db'))
    .map(f => {
      const sanitized = f.slice('branch-'.length, -'.db'.length);
      const dbPath = path.join(dir, f);
      const stat = fs.statSync(dbPath);
      return { name: sanitized, rawName: sanitized, dbPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
    });
}

export function getCurrentGitBranch(projectRoot: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export function getGitBranches(projectRoot: string): string[] {
  try {
    return execSync('git branch', { cwd: projectRoot, stdio: 'pipe' })
      .toString().split('\n')
      .map(l => l.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function addBranch(projectRoot: string, branchName: string): { created: boolean; dbPath: string } {
  const mainDb = path.join(projectRoot, '.kirograph', 'kirograph.db');
  const targetDb = branchDbPath(projectRoot, branchName);
  if (fs.existsSync(targetDb)) return { created: false, dbPath: targetDb };
  if (!fs.existsSync(mainDb)) throw new Error('No main KiroGraph database found. Run kirograph index first.');
  fs.copyFileSync(mainDb, targetDb);
  return { created: true, dbPath: targetDb };
}

export function removeBranch(projectRoot: string, branchName: string): boolean {
  const dbPath = branchDbPath(projectRoot, branchName);
  if (!fs.existsSync(dbPath)) return false;
  fs.unlinkSync(dbPath);
  return true;
}

export function gcBranches(projectRoot: string): string[] {
  const gitBranches = new Set(getGitBranches(projectRoot).map(sanitizeBranchName));
  const tracked = listTrackedBranches(projectRoot);
  const removed: string[] = [];
  for (const b of tracked) {
    if (!gitBranches.has(b.name)) {
      fs.unlinkSync(b.dbPath);
      removed.push(b.name);
    }
  }
  return removed;
}
