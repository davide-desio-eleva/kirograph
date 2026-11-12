/**
 * Rolls back a transaction that a killed process left half written.
 *
 * SQLite writes the original content of every page it is about to change into a rollback journal
 * (`kirograph.db-journal`) and deletes the journal when the transaction commits. A journal that is
 * still there when nobody holds the database is "hot": the process died mid-write, the database
 * file may hold some of the new pages, and the next process to open it must put the old ones back.
 *
 * It never happens with the WASM driver. The driver takes its lock by creating the directory
 * `kirograph.db.lock`, and answers "is a reserved lock held?" by checking that the directory
 * exists. SQLite asks that question to decide whether a journal is hot, after taking its own
 * shared lock, so it always hears yes (from itself), concludes that a writer is active and waits
 * for it. The open then spins until the busy timeout (120 s) and fails with "Database is locked",
 * and the database stays unusable until someone rolls it back by hand with another SQLite.
 *
 * This replays the journal before the driver opens the file. The format is the one in the SQLite
 * file format documentation ("Rollback Journal"): a header per segment (magic, record count,
 * checksum nonce, original size in pages, sector size, page size), then records of page number,
 * page content and checksum. Replay stops at the first record whose checksum fails, which is how
 * a record cut short by the kill looks, and the file is cut back to its original size.
 *
 * A backup of the database and the journal is made first, so a failed recovery loses nothing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logWarn } from '../errors';

const MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const HEADER_FIELDS = 28; // magic 8, nRec 4, nonce 4, size in pages 4, sector size 4, page size 4

/** Keeps the newest `keep` backups: each is a copy of the database. */
function pruneBackups(dir: string, keep: number): void {
  try {
    const names = fs.readdirSync(dir).sort(); // ISO timestamps sort by time
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  } catch { /* the backups are a courtesy */ }
}

export interface RecoveryResult {
  /** Pages put back. */
  pagesRestored: number;
  /** Where the database and journal were saved before the change. */
  backupDir: string;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Checksum of a page record, as SQLite computes it: the nonce plus every 200th byte from the end. */
function pageChecksum(nonce: number, page: Buffer): number {
  let sum = nonce >>> 0;
  for (let i = page.length - 200; i > 0; i -= 200) sum = (sum + page[i]) >>> 0;
  return sum;
}

/**
 * Replays `journal` onto the database file `dbPath`. Exported for tests; use `recoverHotJournal`.
 * Throws when the journal is not one it understands, before changing anything.
 */
export function replayJournal(dbPath: string, journal: Buffer): number {
  if (journal.length < HEADER_FIELDS || !journal.subarray(0, 8).equals(MAGIC)) {
    // A journal whose header was never written, or was zeroed: no page was changed
    if (journal.length === 0 || journal.subarray(0, 8).every(b => b === 0)) return 0;
    throw new Error('the journal does not start with the SQLite journal header');
  }

  const fd = fs.openSync(dbPath, 'r+');
  try {
    let restored = 0;
    let originalPages = 0;
    let offset = 0;
    let first = true;

    while (offset + HEADER_FIELDS <= journal.length) {
      if (!journal.subarray(offset, offset + 8).equals(MAGIC)) break; // padding or a master journal name
      let records = journal.readUInt32BE(offset + 8);
      const nonce = journal.readUInt32BE(offset + 12);
      const pages = journal.readUInt32BE(offset + 16);
      const sector = journal.readUInt32BE(offset + 20);
      const pageSize = journal.readUInt32BE(offset + 24);
      if (!isPowerOfTwo(sector) || sector < 32 || !isPowerOfTwo(pageSize) || pageSize < 512 || pageSize > 65536) {
        if (first) throw new Error('the journal header has an impossible sector or page size');
        break;
      }
      if (first) { originalPages = pages; first = false; }

      const recordSize = 4 + pageSize + 4;
      const start = offset + sector; // the header takes a whole sector
      // 0xFFFFFFFF, or 0 in a journal that was never synced: the records run to the end of the file
      if (records === 0xffffffff || records === 0) records = Math.floor((journal.length - start) / recordSize);

      let done = 0;
      for (; done < records; done++) {
        const at = start + done * recordSize;
        if (at + recordSize > journal.length) break; // cut short
        const pgno = journal.readUInt32BE(at);
        const page = journal.subarray(at + 4, at + 4 + pageSize);
        const stored = journal.readUInt32BE(at + 4 + pageSize);
        if (pgno === 0 || stored !== pageChecksum(nonce, page)) { done = -1; break; }
        fs.writeSync(fd, page, 0, pageSize, (pgno - 1) * pageSize);
        restored++;
      }
      if (done < 0 || done < records) break; // a bad or missing record ends the replay

      // The next segment starts at the next sector boundary after this one's records
      const end = start + records * recordSize;
      offset = Math.ceil(end / sector) * sector;
    }

    if (originalPages > 0) {
      const pageSize = journal.readUInt32BE(24);
      fs.ftruncateSync(fd, originalPages * pageSize);
    }
    fs.fsyncSync(fd);
    return restored;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * If a hot journal is next to the database and no process holds the database, rolls it back.
 * Returns null when there was nothing to do. Throws, with the files untouched, when it cannot.
 *
 * `lockPath` is the driver's lock directory. It is taken here for the duration, so a process that
 * starts a write meanwhile waits, and a live writer (which holds it) makes this a no-op.
 */
export function recoverHotJournal(dbPath: string, lockPath: string): RecoveryResult | null {
  const journalPath = `${dbPath}-journal`;
  let journalSize: number;
  try { journalSize = fs.statSync(journalPath).size; } catch { return null; }
  if (!fs.existsSync(dbPath)) return null;

  try {
    fs.mkdirSync(lockPath);
  } catch (err: any) {
    if (err?.code === 'EEXIST') return null; // a live process holds it: its journal is in use
    throw err;
  }

  try {
    const journal = fs.readFileSync(journalPath);
    const dbDir = path.dirname(dbPath);
    const backupDir = path.join(dbDir, 'recovery', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(dbPath, path.join(backupDir, path.basename(dbPath)));
    fs.copyFileSync(journalPath, path.join(backupDir, path.basename(journalPath)));

    let restored: number;
    try {
      restored = replayJournal(dbPath, journal);
    } catch (err) {
      // Put the database back as it was before the replay started, then say what to do
      fs.copyFileSync(path.join(backupDir, path.basename(dbPath)), dbPath);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The database was left half written by a process that was killed (a rollback journal ` +
        `of ${journalSize} bytes is next to it) and KiroGraph could not roll it back: ${msg}. ` +
        `Nothing was changed. A copy is in ${backupDir}. To recover it by hand, run: ` +
        `sqlite3 "${dbPath}" "PRAGMA quick_check;" (the sqlite3 command-line tool rolls the journal back), ` +
        `then \`kirograph index --force\` if the check is not "ok".`,
      );
    }

    fs.unlinkSync(journalPath);
    pruneBackups(path.join(dbDir, 'recovery'), 3);
    logWarn(
      `Rolled back a transaction left half written by a process that was killed ` +
      `(${restored} pages restored). A copy of the database as it was is in ${backupDir}.`,
    );
    return { pagesRestored: restored, backupDir };
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
