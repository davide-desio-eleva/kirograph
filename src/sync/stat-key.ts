import type * as fs from 'fs';

/**
 * A file's size, mtime and ctime, as recorded when it was read. When all three are unchanged the
 * content is taken as unchanged, as git does: the ctime changes with every write to the file and
 * cannot be set back, so tools that restore the mtime do not hide a change. Taken before the
 * file is read, so a write made during the read shows as a change next time.
 */
export function statKey(st: fs.Stats): string {
  return `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}
