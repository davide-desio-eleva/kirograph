/**
 * SQLite through `node:sqlite`, the SQLite built into Node.js (22.16 and later, with FTS5).
 *
 * It replaces node-sqlite3-wasm, a SQLite compiled to WebAssembly that had no real file locking
 * (it locked by creating a directory, for reads too), could not use WAL, and wrote slowly. Real
 * SQLite locks the file the usual way, so with WAL readers never wait for a writer.
 *
 * The adapter keeps the small interface the rest of KiroGraph uses: `prepare(sql)` with `run`,
 * `get` and `all` taking an array of values (or a named-values object), `exec` and `close`.
 */

import type { StatementSync, DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/** Node.js version from which `node:sqlite` has FTS5 (the full-text index of symbols). */
export const MIN_NODE_VERSION = '22.16.0';

let DatabaseSync: typeof DatabaseSyncType | null = null;

function loadDriver(): typeof DatabaseSyncType {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite prints "SQLite is an experimental feature" on Node 22; nothing for the user to do
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String((warning as Error)?.message ?? warning).includes('SQLite')) return;
    return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    DatabaseSync = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
  return DatabaseSync;
}

/** Why this Node.js cannot run KiroGraph's database, or null when it can. */
export function sqliteUnsupportedReason(): string | null {
  try {
    const Db = loadDriver();
    const db = new Db(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    } finally {
      db.close();
    }
    return null;
  } catch {
    return `KiroGraph needs Node.js ${MIN_NODE_VERSION} or later (its built-in SQLite with full-text search). `
      + `This is Node.js ${process.versions.node}: upgrade it, for example with \`nvm install 22\`.`;
  }
}

type Value = null | number | bigint | string | Uint8Array;
type Params = unknown[] | Record<string, unknown> | undefined;

/** A value as SQLite takes it: booleans as 0/1, undefined as NULL, typed arrays as bytes. */
function bindable(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  // node:sqlite binds every JS number as REAL: 1 would be stored as '1.0' in a TEXT column (and
  // compare unequal to '1'). Whole numbers are bound as INTEGER, as the previous driver did.
  if (typeof v === 'number') return Number.isSafeInteger(v) && !Object.is(v, -0) ? BigInt(v) : v;
  if (typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return String(v);
}

function args(values: Params): unknown[] {
  if (values === undefined) return [];
  if (Array.isArray(values)) return values.map(bindable);
  // Named parameters ($name, :name, @name): passed as one object
  const named: Record<string, Value> = {};
  for (const [k, v] of Object.entries(values)) named[k] = bindable(v);
  return [named];
}

/** A prepared statement with the call shapes the rest of the code uses. */
export class Statement {
  constructor(private readonly stmt: StatementSync) {}

  run(values?: Params): { changes: number; lastInsertRowid: number } {
    const r = (this.stmt.run as (...a: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint })(...args(values));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get(values?: Params): any {
    const row = (this.stmt.get as (...a: unknown[]) => unknown)(...args(values));
    return row === undefined ? undefined : { ...(row as object) };
  }

  all(values?: Params): any[] {
    return ((this.stmt.all as (...a: unknown[]) => unknown[])(...args(values))).map(r => ({ ...(r as object) }));
  }

  /** node:sqlite resets a statement after each call: nothing to do. */
  _reset(): void { /* nothing */ }

  /** node:sqlite finalizes statements when the database closes. */
  finalize(): void { /* nothing */ }
}

export class Database {
  private readonly db: DatabaseSyncType;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    const Db = loadDriver();
    this.db = new Db(path, { readOnly: opts.readOnly === true });
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, values?: Params): { changes: number; lastInsertRowid: number } {
    return this.prepare(sql).run(values);
  }

  get(sql: string, values?: Params): any {
    return this.prepare(sql).get(values);
  }

  all(sql: string, values?: Params): any[] {
    return this.prepare(sql).all(values);
  }

  close(): void {
    this.db.close();
  }
}
