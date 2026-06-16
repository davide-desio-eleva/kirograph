import { Command } from 'commander';
import * as path from 'path';
import {
  getGlobalHooksDir,
  getWorkspaceHooksDir,
  listHooks,
  copyHooks,
  ensureDir,
} from '../../hooks/manager';
import { singleChoice, multiSelect, isInteractive } from '../../hooks/prompt';
import { dim, reset, green } from '../ui';

function hookChoiceOption(h: { displayName: string; filename: string; description?: string }) {
  return {
    label: h.displayName,
    value: h.filename,
    description: h.description,
  };
}

function hookSummaryLabel(
  hooks: Array<{ filename: string; displayName: string; description?: string }>,
  filename: string
): string {
  const hook = hooks.find((h) => h.filename === filename);
  if (!hook) return filename;
  return hook.displayName;
}

/**
 * Register the `hook` command group with save, import, and list subcommands.
 * Returns the hook Command so it can be extended.
 */
export function register(program: Command): Command {
  const hookCmd = program
    .command('hook')
    .description('Manage global hooks: save, import, and list');

  // ── hook save ───────────────────────────────────────────────────────────────
  hookCmd
    .command('save')
    .description('Save workspace hooks to the global store')
    .argument('[projectPath]', 'Project root path (optional)')
    .option('--all', 'Save all hooks without prompting')
    .action(async (projectPath: string | undefined, opts: { all?: boolean }) => {
      const target = path.resolve(projectPath ?? process.cwd());

      let globalDir: string;
      try {
        globalDir = getGlobalHooksDir();
      } catch (err: unknown) {
        console.error(`  ✖ ${(err as Error).message}`);
        process.exit(1);
      }

      const workspaceDir = getWorkspaceHooksDir(target);
      const hooks = listHooks(workspaceDir);

      if (hooks.length === 0) {
        console.log(`  ${dim}No hooks found in workspace${reset}`);
        return;
      }

      let filesToSave: string[];

      if (opts.all || !isInteractive()) {
        filesToSave = hooks.map((h) => h.filename);
      } else {
        const choice = await singleChoice('Save workspace hooks globally:', [
          { label: 'All', value: 'all' },
          { label: 'Select specific hooks', value: 'select' },
          { label: 'Cancel', value: 'cancel' },
        ]);

        if (choice === 'cancel') {
          console.log(`  ${dim}No hooks saved${reset}`);
          return;
        }

        if (choice === 'all') {
          filesToSave = hooks.map((h) => h.filename);
        } else {
          const hookOptions = hooks.map(hookChoiceOption);
          const selected = await multiSelect(
            'Select hooks to save globally:',
            hookOptions,
            { emptySelection: 'focused' }
          );
          if (selected.length === 0) {
            console.log(`  ${dim}No hooks saved${reset}`);
            return;
          }
          filesToSave = selected;
        }
      }

      try {
        ensureDir(globalDir);
        const copied = copyHooks(workspaceDir, globalDir, filesToSave);
        console.log(`  ${green}✓${reset} Saved ${copied.length} hook${copied.length === 1 ? '' : 's'} to global store:`);
        for (const f of copied) {
          console.log(`    ${hookSummaryLabel(hooks, f)}`);
        }
      } catch (err: unknown) {
        console.error(`  ✖ ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ── hook import ─────────────────────────────────────────────────────────────
  hookCmd
    .command('import')
    .description('Import hooks from the global store into the workspace')
    .argument('[projectPath]', 'Project root path (optional)')
    .option('--all', 'Import all hooks without prompting')
    .action(async (projectPath: string | undefined, opts: { all?: boolean }) => {
      const target = path.resolve(projectPath ?? process.cwd());

      let globalDir: string;
      try {
        globalDir = getGlobalHooksDir();
      } catch (err: unknown) {
        console.error(`  ✖ ${(err as Error).message}`);
        process.exit(1);
      }

      const hooks = listHooks(globalDir);

      if (hooks.length === 0) {
        console.log(`  ${dim}No global hooks found${reset}`);
        return;
      }

      let filesToImport: string[];

      if (opts.all || !isInteractive()) {
        filesToImport = hooks.map((h) => h.filename);
      } else {
        const choice = await singleChoice('Import global hooks:', [
          { label: 'All', value: 'all' },
          { label: 'Select specific hooks', value: 'select' },
          { label: 'Cancel', value: 'cancel' },
        ]);

        if (choice === 'cancel') {
          console.log(`  ${dim}No hooks imported${reset}`);
          return;
        }

        if (choice === 'all') {
          filesToImport = hooks.map((h) => h.filename);
        } else {
          const options = hooks.map(hookChoiceOption);
          const selected = await multiSelect('Select hooks to import:', options);
          if (selected.length === 0) {
            console.log(`  ${dim}No hooks imported${reset}`);
            return;
          }
          filesToImport = selected;
        }
      }

      const workspaceDir = getWorkspaceHooksDir(target);

      try {
        ensureDir(workspaceDir);
        const copied = copyHooks(globalDir, workspaceDir, filesToImport);
        console.log(`  ${green}✓${reset} Imported ${copied.length} hook${copied.length === 1 ? '' : 's'}:`);
        for (const f of copied) {
          console.log(`    ${hookSummaryLabel(hooks, f)}`);
        }
      } catch (err: unknown) {
        console.error(`  ✖ ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ── hook list ───────────────────────────────────────────────────────────────
  hookCmd
    .command('list')
    .description('List all saved global hooks')
    .action(() => {
      let globalDir: string;
      try {
        globalDir = getGlobalHooksDir();
      } catch (err: unknown) {
        console.error(`  ✖ ${(err as Error).message}`);
        process.exit(1);
        return;
      }

      const hooks = listHooks(globalDir);

      if (hooks.length === 0) {
        console.log(`  ${dim}No global hooks saved${reset}`);
        return;
      }

      console.log(`  ${dim}Global hooks:${reset}`);
      for (const hook of hooks) {
        if (hook.description) {
          console.log(`    ${hook.displayName} ${dim}(${hook.description})${reset}`);
        } else {
          console.log(`    ${hook.displayName}`);
        }
      }
    });

  return hookCmd;
}
