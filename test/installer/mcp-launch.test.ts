import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveMcpLaunch, inspectMcpLaunch, refreshMcpLaunch } from '../../src/bin/installer/mcp';

let root: string;
let mcpPath: string;
let entry: string;
const NODE = process.execPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-launch-'));
  mcpPath = path.join(root, '.kiro', 'settings', 'mcp.json');
  entry = path.join(root, 'kirograph.js');
  fs.writeFileSync(entry, '');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const writeConfig = (server: object) => {
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { kirograph: server, other: { command: 'other' } } }, null, 2));
};
const readConfig = () => JSON.parse(fs.readFileSync(mcpPath, 'utf8'));

describe('resolveMcpLaunch', () => {
  it('uses the Node binary and the real path of the entry script', () => {
    const launch = resolveMcpLaunch(entry, NODE);
    expect(launch).toEqual({ command: NODE, args: [fs.realpathSync(entry), 'serve', '--mcp'] });
  });

  it('resolves a bin link without a .js suffix to the .js file it points at', () => {
    const link = path.join(root, 'kirograph');
    fs.symlinkSync(entry, link);
    expect(resolveMcpLaunch(link, NODE)).toEqual({ command: NODE, args: [fs.realpathSync(entry), 'serve', '--mcp'] });
  });

  it('falls back to the bare command when the entry is not a located .js file', () => {
    const bare = { command: 'kirograph', args: ['serve', '--mcp'] };
    expect(resolveMcpLaunch('', NODE)).toEqual(bare);
    expect(resolveMcpLaunch(path.join(root, 'missing.js'), NODE)).toEqual(bare);
    expect(resolveMcpLaunch(path.join(root, 'main.ts'), NODE)).toEqual(bare);
  });
});

describe('inspectMcpLaunch', () => {
  it('reports none when there is no config or no KiroGraph entry', () => {
    expect(inspectMcpLaunch(mcpPath).kind).toBe('none');
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
    expect(inspectMcpLaunch(mcpPath).kind).toBe('none');
  });

  it('reports a bare command as relying on PATH', () => {
    writeConfig({ command: 'kirograph', args: ['serve', '--mcp'] });
    expect(inspectMcpLaunch(mcpPath).kind).toBe('bare');
  });

  it('reports an absolute launch whose files exist as fine', () => {
    writeConfig({ command: NODE, args: [entry, 'serve', '--mcp'] });
    expect(inspectMcpLaunch(mcpPath).kind).toBe('absolute');
  });

  it('reports an absolute launch whose Node or script is gone as missing', () => {
    writeConfig({ command: path.join(root, 'no-such-node'), args: [entry, 'serve', '--mcp'] });
    expect(inspectMcpLaunch(mcpPath).kind).toBe('missing');
    writeConfig({ command: NODE, args: [path.join(root, 'gone.js'), 'serve', '--mcp'] });
    expect(inspectMcpLaunch(mcpPath).kind).toBe('missing');
  });
});

describe('refreshMcpLaunch', () => {
  it('rewrites command and arguments, keeps other fields and the other servers', () => {
    writeConfig({ command: 'kirograph', args: ['serve', '--mcp', '--path', '/old'], disabled: false, autoApprove: ['kirograph_search'], custom: 1 });
    refreshMcpLaunch(mcpPath, '/project', { command: NODE, args: [entry, 'serve', '--mcp'] });
    const server = readConfig().mcpServers.kirograph;
    expect(server).toEqual({
      command: NODE,
      args: [entry, 'serve', '--mcp', '--path', '/project'],
      disabled: false,
      autoApprove: ['kirograph_search'],
      custom: 1,
    });
    expect(readConfig().mcpServers.other).toEqual({ command: 'other' });
    expect(inspectMcpLaunch(mcpPath).kind).toBe('absolute');
  });

  it('does nothing when there is no KiroGraph entry to repair', () => {
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
    refreshMcpLaunch(mcpPath, '/project', { command: NODE, args: [entry, 'serve', '--mcp'] });
    expect(readConfig()).toEqual({ mcpServers: { other: { command: 'other' } } });
  });
});
