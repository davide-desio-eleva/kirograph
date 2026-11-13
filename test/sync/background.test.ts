import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startBackgroundSync } from '../../src/bin/commands/background';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-bg-'));
  fs.mkdirSync(path.join(root, '.kirograph'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('background sync', () => {
  it('does not start another while a sync holds the process lock', () => {
    // The parent process is alive and is not this one: a stand-in for a running sync
    fs.writeFileSync(path.join(root, '.kirograph', 'kirograph.lock'), `${process.ppid}:${Date.now()}`);
    expect(startBackgroundSync(root)).toBe(false);
  });
});
