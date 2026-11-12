import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { register } from '../../src/bin/commands/unlock';

let root: string;
let kg: string;
let output: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-unlock-'));
  kg = path.join(root, '.kirograph');
  fs.mkdirSync(path.join(kg, 'kirograph.db.lock'), { recursive: true });
  fs.mkdirSync(path.join(kg, 'db-writers'));
  output = '';
  vi.spyOn(console, 'log').mockImplementation((...a) => { output += a.join(' ') + '\n'; });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

const run = (...args: string[]) => {
  const program = new Command();
  register(program);
  return program.parseAsync(['node', 'kirograph', 'unlock', root, ...args]);
};

describe('unlock', () => {
  it('releases a stale database lock', async () => {
    await run();
    expect(fs.existsSync(path.join(kg, 'kirograph.db.lock'))).toBe(false);
  });

  it('leaves the lock alone while another process has the database open', async () => {
    // The parent process is alive and is not this one: a stand-in for an MCP server
    fs.writeFileSync(path.join(kg, 'db-writers', String(process.ppid)), String(Date.now()));
    await run();
    expect(fs.existsSync(path.join(kg, 'kirograph.db.lock'))).toBe(true);
    expect(output).toMatch(/is running/);
  });

  it('releases it with --force', async () => {
    fs.writeFileSync(path.join(kg, 'db-writers', String(process.ppid)), String(Date.now()));
    await run('--force');
    expect(fs.existsSync(path.join(kg, 'kirograph.db.lock'))).toBe(false);
  });

  it('ignores the marker of a process that is gone', async () => {
    fs.writeFileSync(path.join(kg, 'db-writers', '2147483000'), String(Date.now()));
    await run();
    expect(fs.existsSync(path.join(kg, 'kirograph.db.lock'))).toBe(false);
  });
});
