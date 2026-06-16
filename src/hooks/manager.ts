import * as fs from 'fs';
import * as path from 'path';

/**
 * Information about a hook file found in a directory.
 */
export interface HookFileInfo {
  /** Filename (e.g. "my-lint-hook.kiro.hook") */
  filename: string;
  /** Display name parsed from hook JSON `name` field, or filename if unparseable */
  displayName: string;
  /** Description parsed from hook JSON `description` field, if present */
  description?: string;
  /** Full absolute path to the file */
  fullPath: string;
}

/**
 * Resolve the global KiroGraph directory path (~/.kirograph/).
 * Throws if home directory cannot be determined.
 */
export function getGlobalKirographDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('Cannot determine home directory');
  }
  return path.join(home, '.kirograph');
}

/**
 * Resolve the global hooks directory path (~/.kirograph/hooks/).
 * Throws if home directory cannot be determined.
 */
export function getGlobalHooksDir(): string {
  return path.join(getGlobalKirographDir(), 'hooks');
}

/**
 * Resolve the workspace hooks directory path (.kiro/hooks/ relative to project root).
 */
export function getWorkspaceHooksDir(projectRoot: string): string {
  return path.join(projectRoot, '.kiro', 'hooks');
}

/**
 * Ensure the target directory exists, creating it recursively.
 * Throws on permission or filesystem errors.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * List all .kiro.hook files in a directory.
 * Returns empty array if directory does not exist.
 */
export function listHooks(dirPath: string): HookFileInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  return entries
    .filter((name) => name.endsWith('.kiro.hook'))
    .map((filename) => {
      const fullPath = path.join(dirPath, filename);
      const { displayName, description } = parseHookMetadata(fullPath);
      return { filename, displayName, description, fullPath };
    });
}

/**
 * Copy hook files from source dir to destination dir.
 * Always overwrites existing files with the same filename.
 * Uses fail-fast semantics: throws immediately on first copy error.
 * Returns the list of copied filenames.
 */
export function copyHooks(
  sourceDir: string,
  destDir: string,
  filenames: string[]
): string[] {
  const copied: string[] = [];
  for (const filename of filenames) {
    const src = path.join(sourceDir, filename);
    const dest = path.join(destDir, filename);
    const content = fs.readFileSync(src);
    fs.writeFileSync(dest, content);
    copied.push(filename);
  }
  return copied;
}

/**
 * Parse a hook file's JSON metadata (`name`, `description`).
 * Falls back to the filename when `name` is absent or unparseable.
 */
export function parseHookMetadata(filePath: string): {
  displayName: string;
  description?: string;
} {
  const fallback = path.basename(filePath);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(content);
    const displayName =
      typeof json.name === 'string' && json.name.length > 0 ? json.name : fallback;
    const description =
      typeof json.description === 'string' && json.description.length > 0
        ? json.description
        : undefined;
    return { displayName, description };
  } catch {
    return { displayName: fallback };
  }
}

/**
 * Parse a hook file's JSON to extract the `name` field.
 * Returns the basename of the file path if parsing fails or `name` is absent/empty.
 */
export function parseHookName(filePath: string): string {
  return parseHookMetadata(filePath).displayName;
}
