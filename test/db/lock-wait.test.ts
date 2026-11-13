import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { LockManager } from '../../src/core/lock-manager';

let root: string;
const lockFile = () => path.join(root, '.kirograph', 'kirograph.lock');

/** A child process that holds the index lock, the way a running sync does, for `holdMs`. */
function holder(holdMs: number): Promise<{ held: Promise<void>; exited: Promise<void> }> {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const fd = fs.openSync(process.argv[1], 'wx');
    fs.writeSync(fd, process.pid + ':' + Date.now());
    fs.closeSync(fd);
    console.log('locked');
    setTimeout(() => { fs.unlinkSync(process.argv[1]); process.exit(0); }, ${holdMs});
  `, lockFile()]);
  // Listen from the start: a fast child can exit before the test gets to wait for it
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
  const held = new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('locked')) resolve(); });
    child.on('error', reject);
  });
  return { held, exited };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-lockwait-'));
  fs.mkdirSync(path.join(root, '.kirograph'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('LockManager.acquireWait', () => {
  it('waits for a live holder to release the lock, then acquires it', async () => {
    const { held, exited } = await holder(800);
    await held;

    const started = Date.now();
    await new LockManager(root).acquireWait(5_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(fs.existsSync(lockFile())).toBe(true);
    new LockManager(root).release();

    await exited;
  });

  it('gives up after the timeout and reports the live holder', async () => {
    const { held, exited } = await holder(3_000);
    await held;

    await expect(new LockManager(root).acquireWait(300)).rejects.toThrow(/KiroGraph is locked by PID/);

    await exited;
  });

  it('acquires at once when the lock is free', async () => {
    const started = Date.now();
    await new LockManager(root).acquireWait(5_000);
    expect(Date.now() - started).toBeLessThan(200);
    new LockManager(root).release();
  });
});
