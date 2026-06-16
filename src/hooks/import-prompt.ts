import {
  getGlobalHooksDir,
  listHooks,
  copyHooks,
  getWorkspaceHooksDir,
  ensureDir,
} from './manager';
import { singleChoice, multiSelect } from './prompt';

const green = '\x1b[32m';
const reset = '\x1b[0m';

/**
 * Ask which global hooks to import. Returns filenames to copy, or null to skip.
 */
export async function promptImportGlobalHookSelection(): Promise<string[] | null> {
  let globalDir: string;
  try {
    globalDir = getGlobalHooksDir();
  } catch {
    return null;
  }

  const globalHooks = listHooks(globalDir);
  if (globalHooks.length === 0) return null;

  const choice = await singleChoice('Import global hooks?', [
    { label: 'None', value: 'none' },
    { label: 'All', value: 'all' },
    { label: 'Select specific hooks', value: 'select' },
  ]);

  if (choice === 'all') {
    return globalHooks.map((h) => h.filename);
  }

  if (choice === 'select') {
    const options = globalHooks.map((h) => ({
      label: h.displayName,
      value: h.filename,
      description: h.description,
    }));
    const selected = await multiSelect('Select hooks to import:', options);
    return selected.length > 0 ? selected : null;
  }

  return null;
}

/** Copy selected global hooks into the workspace and print a summary. */
export function applyImportedGlobalHooks(
  projectRoot: string,
  filenames: string[]
): void {
  if (filenames.length === 0) return;

  const globalDir = getGlobalHooksDir();
  const globalHooks = listHooks(globalDir);
  const workspaceHooksDir = getWorkspaceHooksDir(projectRoot);
  ensureDir(workspaceHooksDir);
  const copied = copyHooks(globalDir, workspaceHooksDir, filenames);
  console.log(`  ${green}✓${reset} Imported ${copied.length} hook${copied.length === 1 ? '' : 's'}:`);
  for (const f of copied) {
    const hook = globalHooks.find((h) => h.filename === f);
    console.log(`    ${hook?.displayName ?? f}`);
  }
}
