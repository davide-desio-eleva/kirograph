import * as path from 'path';
import { Command } from 'commander';

async function runTool(target: string, toolName: string, args: Record<string, unknown>): Promise<void> {
  const KiroGraph = (await import('../../index')).default;
  const { ToolHandler } = (await import('../../mcp/handler')) as any;
  const cg = await KiroGraph.open(target);
  const handler = new ToolHandler(cg);
  const result = await handler.handle(toolName, { ...args, projectPath: target });
  cg.close();
  const text: string = result.content.map((c: any) => c.text).join('');
  console.log(text);
}

async function getBranchManager() {
  try {
    return await import('../../core/branch-manager') as any;
  } catch {
    return null;
  }
}

export function register(program: Command): void {
  const branch = program.command('branch').description('Multi-branch graph management');

  branch.command('list [projectPath]').description('List tracked branches').action(async (projectPath: string | undefined) => {
    const target = path.resolve(projectPath ?? process.cwd());
    const bm = await getBranchManager();
    if (!bm) {
      console.error('  Branch manager not available in this build.');
      process.exit(1);
    }
    const branches = bm.listTrackedBranches(target);
    const current = bm.getCurrentGitBranch(target);
    if (branches.length === 0) {
      console.log('  No tracked branches. Use: kirograph branch add [name]');
      return;
    }
    console.log('  Tracked branches (current git branch: ' + current + '):');
    for (const b of branches) {
      const size = b.sizeBytes > 1048576 ? (b.sizeBytes / 1048576).toFixed(1) + ' MB' : Math.round(b.sizeBytes / 1024) + ' KB';
      const sync = new Date(b.mtimeMs).toISOString().slice(0, 19);
      console.log('  * ' + b.name + '  ' + size + '  synced ' + sync);
    }
  });

  branch.command('add [branchName] [projectPath]').description('Start tracking a branch').action(async (branchName: string | undefined, projectPath: string | undefined) => {
    const target = path.resolve(projectPath ?? process.cwd());
    const bm = await getBranchManager();
    if (!bm) {
      console.error('  Branch manager not available in this build.');
      process.exit(1);
    }
    const name = branchName ?? bm.getCurrentGitBranch(target);
    try {
      const r = bm.addBranch(target, name);
      if (r.created) {
        console.log('  Tracking branch ' + name + ' → ' + r.dbPath);
        console.log('  Run kirograph sync to populate.');
      } else {
        console.log('  Already tracking branch: ' + name);
      }
    } catch (err: any) {
      console.error('  Error: ' + err.message);
      process.exit(1);
    }
  });

  branch.command('remove <branchName> [projectPath]').description('Stop tracking a branch').action(async (branchName: string, projectPath: string | undefined) => {
    const target = path.resolve(projectPath ?? process.cwd());
    const bm = await getBranchManager();
    if (!bm) {
      console.error('  Branch manager not available in this build.');
      process.exit(1);
    }
    const removed = bm.removeBranch(target, branchName);
    console.log(removed ? '  Removed branch: ' + branchName : '  Branch not tracked: ' + branchName);
  });

  branch.command('gc [projectPath]').description('Remove DBs for deleted git branches').action(async (projectPath: string | undefined) => {
    const target = path.resolve(projectPath ?? process.cwd());
    const bm = await getBranchManager();
    if (!bm) {
      console.error('  Branch manager not available in this build.');
      process.exit(1);
    }
    const removed = bm.gcBranches(target);
    if (removed.length === 0) { console.log('  Nothing to clean up.'); return; }
    for (const name of removed) console.log('  Removed: ' + name);
    console.log('  Cleaned ' + removed.length + ' branch(es).');
  });

  branch.command('diff <branchA> [branchB] [projectPath]').description('Diff symbols between two tracked branches').action(async (branchA: string, branchB: string | undefined, projectPath: string | undefined) => {
    const target = path.resolve(projectPath ?? process.cwd());
    await runTool(target, 'kirograph_branch_diff', { branchA, branchB: branchB ?? 'main' });
  });

  branch.command('search <query> <branchName> [projectPath]').description('Search symbols in a tracked branch').action(async (query: string, branchName: string, projectPath: string | undefined) => {
    const target = path.resolve(projectPath ?? process.cwd());
    await runTool(target, 'kirograph_branch_search', { query, branch: branchName });
  });
}
