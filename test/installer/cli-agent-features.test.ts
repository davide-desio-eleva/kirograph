import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeCliAgent } from '../../src/bin/installer/cli-agent';
import { writeMcpConfigFinal } from '../../src/bin/installer/mcp';
import { readInstallState, updateInstallState } from '../../src/bin/installer/install-state';

let root: string;
let kiroDir: string;
const agentPath = () => path.join(kiroDir, 'agents', 'kirograph.json');
const agent = () => JSON.parse(fs.readFileSync(agentPath(), 'utf8'));

// Every flag that hides a tool set, switched off: the server then exposes only the core tools.
const off = { enableCodeHealth: false, enableComplexity: false, enableArchitecture: false, enableSecurity: false, enablePatterns: false };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-agent-'));
  kiroDir = path.join(root, '.kiro');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('writeCliAgent follows the enabled features', () => {
  it('lists only the tools the enabled features expose', () => {
    writeCliAgent(kiroDir, off);
    const allowed: string[] = agent().allowedTools;
    expect(allowed).toContain('@kirograph/kirograph_search');
    expect(allowed).toContain('@kirograph/kirograph_context');
    expect(allowed).toContain('@kirograph/kirograph_node');
    expect(allowed).not.toContain('@kirograph/kirograph_health');
    expect(allowed).not.toContain('@kirograph/kirograph_complexity');
  });

  it('adds the code health and complexity tools and mentions them when those features are on', () => {
    writeCliAgent(kiroDir, { ...off, enableCodeHealth: true, enableComplexity: true });
    expect(agent().allowedTools).toContain('@kirograph/kirograph_health');
    expect(agent().description).toContain('code health and complexity');
  });

  it('without flags and without a record, lists every tool as before', () => {
    writeCliAgent(kiroDir);
    expect(agent().allowedTools).toContain('@kirograph/kirograph_health');
  });
});

describe('a rewrite without flags keeps the features of the last install', () => {
  it('reads the saved features (the caveman path)', () => {
    writeMcpConfigFinal(kiroDir, root, { ...off, enableSecurity: true });
    writeCliAgent(kiroDir, { ...off, enableSecurity: true });
    expect(readInstallState(kiroDir)?.features).toMatchObject({ enableSecurity: true, enableCodeHealth: false });

    writeCliAgent(kiroDir); // what `caveman` does
    expect(agent().description).toContain('security auditing');
    expect(agent().allowedTools).not.toContain('@kirograph/kirograph_health');
  });

  it('records the features at MCP install time', () => {
    writeMcpConfigFinal(kiroDir, root, off);
    expect(readInstallState(kiroDir)?.features).toEqual(expect.objectContaining({ enableCodeHealth: false }));
  });

  it('keeps a tool the user removed from the agent list', () => {
    writeCliAgent(kiroDir, { ...off, enableCodeHealth: true });
    const edited = agent();
    edited.allowedTools = edited.allowedTools.filter((t: string) => t !== '@kirograph/kirograph_health');
    fs.writeFileSync(agentPath(), JSON.stringify(edited, null, 2));
    updateInstallState(kiroDir, {});

    writeCliAgent(kiroDir, { ...off, enableCodeHealth: true });
    expect(agent().allowedTools).not.toContain('@kirograph/kirograph_health');
    expect(agent().allowedTools).toContain('@kirograph/kirograph_search');
  });
});
