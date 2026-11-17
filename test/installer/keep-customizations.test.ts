import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeToolList } from '../../src/bin/installer/install-state';
import { writeMcpConfigFinal } from '../../src/bin/installer/mcp';
import { writeCliAgent } from '../../src/bin/installer/cli-agent';
import { writeHooks } from '../../src/bin/installer/hooks';

let root: string;
let kiroDir: string;
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const write = (rel: string, data: unknown) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify(data, null, 2));
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-install-'));
  kiroDir = path.join(root, '.kiro');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mergeToolList', () => {
  const known = ['read', 'write', 'new'];
  it('writes the computed list when there is none', () => {
    expect(mergeToolList(['read', 'write'], undefined, undefined, known)).toEqual(['read', 'write']);
  });
  it('keeps a tool the user removed removed, and adds one new since the last install', () => {
    expect(mergeToolList(['read', 'write', 'new'], ['read'], ['read', 'write'], known)).toEqual(['read', 'new']);
  });
  it('without a record, takes a tool missing from the list as removed by the user', () => {
    expect(mergeToolList(['read', 'write', 'new'], ['read'], undefined, known)).toEqual(['read']);
  });
  it('keeps entries the installer does not manage', () => {
    expect(mergeToolList(['read'], ['read', 'other_server_tool'], ['read'], known)).toEqual(['read', 'other_server_tool']);
  });
});

describe('kirograph install run again (#82)', () => {
  it('keeps the user fields and autoApprove changes of the MCP entry', () => {
    writeMcpConfigFinal(kiroDir, root, {});
    const mcp = read('.kiro/settings/mcp.json');
    const all: string[] = mcp.mcpServers.kirograph.autoApprove;
    const kept = all.filter(t => t !== 'kirograph_str_replace');
    mcp.mcpServers.kirograph.autoApprove = kept;
    mcp.mcpServers.kirograph.env = { FOO: '1' };
    mcp.mcpServers.other = { command: 'other' };
    write('.kiro/settings/mcp.json', mcp);

    writeMcpConfigFinal(kiroDir, root, {});
    const after = read('.kiro/settings/mcp.json');
    expect(after.mcpServers.kirograph.autoApprove).toEqual(kept);
    expect(after.mcpServers.kirograph.env).toEqual({ FOO: '1' });
    expect(after.mcpServers.other).toEqual({ command: 'other' });
  });

  it('keeps the user resources, MCP servers, hooks and other keys of the CLI agent', () => {
    writeCliAgent(kiroDir, {});
    const agent = read('.kiro/agents/kirograph.json');
    agent.resources.push('file://docs/notes.md');
    agent.mcpServers = { aws: { command: 'aws-mcp' } };
    agent.hooks.stop.push({ command: 'echo done' });
    agent.allowedTools = agent.allowedTools.filter((t: string) => t !== '@kirograph/kirograph_str_replace');
    agent.model = 'custom';
    write('.kiro/agents/kirograph.json', agent);

    writeCliAgent(kiroDir, {});
    const after = read('.kiro/agents/kirograph.json');
    expect(after.resources).toContain('file://docs/notes.md');
    expect(after.resources).toContain('file://.kiro/steering/kirograph.md');
    expect(after.mcpServers).toEqual({ aws: { command: 'aws-mcp' } });
    expect(after.hooks.stop).toContainEqual({ command: 'echo done' });
    expect(after.hooks.stop.filter((h: { command: string }) => /kirograph/.test(h.command))).toHaveLength(1);
    expect(after.allowedTools).not.toContain('@kirograph/kirograph_str_replace');
    expect(after.model).toBe('custom');
  });

  it('does not write again a hook the user deleted, unless asked to', () => {
    writeHooks(kiroDir, { enableCompression: true });
    const hint = path.join(kiroDir, 'hooks', 'kirograph-compress-hint.json');
    expect(fs.existsSync(hint)).toBe(true);
    fs.unlinkSync(hint);

    writeHooks(kiroDir, { enableCompression: true });
    expect(fs.existsSync(hint)).toBe(false);
    writeHooks(kiroDir, { enableCompression: true });
    expect(fs.existsSync(hint)).toBe(false);

    writeHooks(kiroDir, { enableCompression: true, restore: ['kirograph-compress-hint'] });
    expect(fs.existsSync(hint)).toBe(true);
  });

  it('without a record of the last install, does not add back a deleted compression hint', () => {
    writeHooks(kiroDir, { enableCompression: true });
    fs.unlinkSync(path.join(kiroDir, 'hooks', 'kirograph-compress-hint.json'));
    fs.rmSync(path.join(root, '.kirograph', 'install-state.json'));

    writeHooks(kiroDir, { enableCompression: true });
    expect(fs.existsSync(path.join(kiroDir, 'hooks', 'kirograph-compress-hint.json'))).toBe(false);
  });

  it('writes the hook of a feature turned on later', () => {
    writeHooks(kiroDir, { enableMemory: false });
    expect(fs.existsSync(path.join(kiroDir, 'hooks', 'kirograph-mem-capture.json'))).toBe(false);
    writeHooks(kiroDir, { enableMemory: true });
    expect(fs.existsSync(path.join(kiroDir, 'hooks', 'kirograph-mem-capture.json'))).toBe(true);
  });
});
