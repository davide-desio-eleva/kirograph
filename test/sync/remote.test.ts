import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { socketPath, serveSync, requestSync } from '../../src/sync/remote';

const posix = process.platform !== 'win32';
let root: string;
let stop: (() => void) | null = null;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-remote-')); });
afterEach(() => {
  stop?.(); stop = null;
  if (posix) { try { fs.unlinkSync(socketPath(root)); } catch { /* none */ } }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sync through a running server', () => {
  it('derives a distinct, short name per project', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-remote-'));
    try {
      expect(socketPath(root)).not.toBe(socketPath(other));
      expect(socketPath(root)).toBe(socketPath(root));
      if (posix) expect(socketPath(root).length).toBeLessThan(100);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('returns null when no server is listening', async () => {
    expect(await requestSync(root, {})).toBeNull();
  });

  it('answers a sync with what the handler returns, passing the request through', async () => {
    const seen: unknown[] = [];
    stop = await serveSync(root, async req => { seen.push(req); return { added: ['a.ts'], errors: [] }; });
    expect(stop).not.toBeNull();
    expect(await requestSync(root, { full: true })).toEqual({ ok: true, result: { added: ['a.ts'], errors: [] } });
    expect(await requestSync(root, { ifDirty: true })).toEqual({ ok: true, result: { added: ['a.ts'], errors: [] } });
    expect(seen).toEqual([{ ifDirty: false, full: true }, { ifDirty: true, full: false }]);
  });

  it('passes a null result (nothing to do) through', async () => {
    stop = await serveSync(root, async () => null);
    expect(await requestSync(root, { ifDirty: true })).toEqual({ ok: true, result: null });
  });

  it('reports a handler error instead of hanging, and keeps serving', async () => {
    let calls = 0;
    stop = await serveSync(root, async () => { if (calls++ === 0) throw new Error('boom'); return {}; });
    expect(await requestSync(root, {})).toEqual({ ok: false, error: 'boom' });
    expect(await requestSync(root, {})).toEqual({ ok: true, result: {} });
  });

  it('waits for a slow sync', async () => {
    stop = await serveSync(root, () => new Promise(r => setTimeout(() => r({ done: true }), 1500)));
    expect(await requestSync(root, {}, 200)).toEqual({ ok: true, result: { done: true } });
  });

  it.skipIf(!posix)('refuses anything but a sync request', async () => {
    stop = await serveSync(root, async () => ({}));
    const reply = await new Promise<string>(resolve => {
      const s = net.connect(socketPath(root), () => s.write(JSON.stringify({ op: 'exec', cmd: 'x' }) + '\n'));
      let out = ''; s.setEncoding('utf8'); s.on('data', d => out += d); s.on('close', () => resolve(out));
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, error: 'unknown request' });
  });

  it.skipIf(!posix)('makes the socket private to the user', async () => {
    stop = await serveSync(root, async () => ({}));
    expect(fs.statSync(socketPath(root)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)('leaves a live server alone, and takes over a dead one\'s socket file', async () => {
    stop = await serveSync(root, async () => ({ who: 'first' }));
    expect(await serveSync(root, async () => ({ who: 'second' }))).toBeNull();
    expect(await requestSync(root, {})).toEqual({ ok: true, result: { who: 'first' } });

    // Leave the file behind as a killed server would: close the listener without unlinking
    const file = socketPath(root);
    stop(); stop = null;
    fs.closeSync(fs.openSync(file, 'w')); // a stale entry at the path
    stop = await serveSync(root, async () => ({ who: 'third' }));
    expect(stop).not.toBeNull();
    expect(await requestSync(root, {})).toEqual({ ok: true, result: { who: 'third' } });
  });

  it('stopping removes the socket', async () => {
    stop = await serveSync(root, async () => ({}));
    stop(); stop = null;
    expect(await requestSync(root, {})).toBeNull();
  });
});
