/**
 * Sync through a running MCP server.
 *
 * A hook that runs `kirograph sync` starts a second process that opens the same database as the
 * MCP server, and the two contend for its lock (the collisions reported in #70). When a server is
 * running for the project it can do the sync itself: it already has the database open, and the
 * sync goes through the same in-process mutex as its own work.
 *
 * The server listens on a local socket (a named pipe on Windows) whose name is derived from the
 * project's real path, in the temporary directory because a Unix socket path is limited to about
 * 100 characters and a project path can be longer. The socket file is private to the user (0600).
 * Nothing but a sync can be asked of it. Every failure is silent: a client that cannot reach a
 * server returns null and the caller syncs in-process, as it always did.
 *
 * This file imports only built-in modules so a hook command reaches it without loading the index.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export interface RemoteSyncRequest {
  /** Sync only when the dirty marker is set or the workspace changed (sync-if-dirty). */
  ifDirty?: boolean;
  /** Check every file even when nothing seems to have changed. */
  full?: boolean;
}

/** The part of a sync result the commands print. Null (ifDirty) means there was nothing to do. */
export type RemoteSyncResponse =
  | { ok: true; result: Record<string, any> | null }
  | { ok: false; error: string };

export function socketPath(projectRoot: string): string {
  let real = projectRoot;
  try { real = fs.realpathSync(projectRoot); } catch { /* not there: hash the path as given */ }
  const id = crypto.createHash('sha1').update(real).digest('hex').slice(0, 16);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\kirograph-${id}`
    : path.join(os.tmpdir(), `kirograph-${id}.sock`);
}

/**
 * Asks the server of the project to sync. Returns null when there is none, or when it fails to
 * answer, in which case the caller syncs itself.
 */
export function requestSync(
  projectRoot: string,
  req: RemoteSyncRequest,
  connectTimeoutMs = 1000,
): Promise<RemoteSyncResponse | null> {
  return new Promise(resolve => {
    let settled = false;
    let buffer = '';
    const done = (value: RemoteSyncResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect(socketPath(projectRoot));
    // Only the connection is timed: a sync that is running is waited for
    const timer = setTimeout(() => done(null), connectTimeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.write(JSON.stringify({ op: 'sync', ...req }) + '\n');
    });
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { done(JSON.parse(buffer.slice(0, end)) as RemoteSyncResponse); } catch { done(null); }
    });
    socket.on('error', () => done(null));
    socket.on('close', () => done(null));
  });
}

/** True when something is listening on the project's socket. */
function isServed(projectRoot: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath(projectRoot));
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * Starts answering sync requests for the project. Returns a function that stops it, or null when
 * the socket could not be taken (another server has it, or the platform refuses): the server
 * then simply does not offer the shortcut.
 */
export async function serveSync(
  projectRoot: string,
  handle: (req: RemoteSyncRequest) => Promise<Record<string, any> | null>,
): Promise<(() => void) | null> {
  const target = socketPath(projectRoot);
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', async chunk => {
      buffer += chunk;
      if (buffer.length > 4096) { socket.destroy(); return; } // a request is a few dozen bytes
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let response: RemoteSyncResponse;
      try {
        const req = JSON.parse(buffer.slice(0, end));
        if (req?.op !== 'sync') throw new Error('unknown request');
        response = { ok: true, result: await handle({ ifDirty: req.ifDirty === true, full: req.full === true }) };
      } catch (err) {
        response = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      buffer = '';
      socket.end(JSON.stringify(response) + '\n');
    });
  });

  const listen = () => new Promise<boolean>(resolve => {
    server.once('error', () => resolve(false));
    server.listen(target, () => resolve(true));
  });

  if (!(await listen())) {
    // A socket file left by a killed server refuses connections. Take it over; leave a live one.
    if (process.platform === 'win32' || await isServed(projectRoot)) return null;
    try { fs.unlinkSync(target); } catch { return null; }
    if (!(await listen())) return null;
  }
  server.unref(); // never keeps the process alive
  if (process.platform !== 'win32') { try { fs.chmodSync(target, 0o600); } catch { /* best effort */ } }

  return () => {
    server.close();
    if (process.platform !== 'win32') { try { fs.unlinkSync(target); } catch { /* gone already */ } }
  };
}
