import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  readJson,
  writeJson,
  KIROGRAPH_COMMAND,
  KIROGRAPH_MCP_ARGS,
  KIROGRAPH_SERVER_NAME,
  removeMcpServersConfig,
  upsertGeneratedBlock,
  removeGeneratedBlock,
  writeMcpServersConfig,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const COPILOT_BLOCK_ID = 'copilot';

function buildCopilotHooks(): object {
  return {
    hooks: {
      'session-end': [
        { command: 'kirograph sync --quiet 2>/dev/null || true' },
      ],
    },
  };
}

export function installCopilotEarly(projectRoot: string): void {
  // VS Code Copilot Chat format: .vscode/mcp.json with "servers" key
  const vscodeMcpPath = path.join(projectRoot, '.vscode', 'mcp.json');
  ensureDir(path.dirname(vscodeMcpPath));
  const vscodeConfig = readJson(vscodeMcpPath);
  vscodeConfig.servers = vscodeConfig.servers ?? {};
  if (!vscodeConfig.servers[KIROGRAPH_SERVER_NAME]) {
    vscodeConfig.servers[KIROGRAPH_SERVER_NAME] = {
      type: 'stdio',
      command: KIROGRAPH_COMMAND,
      args: KIROGRAPH_MCP_ARGS,
    };
    writeJson(vscodeMcpPath, vscodeConfig);
    console.log(`  ✓ Copilot MCP registered in ${vscodeMcpPath}`);
  } else {
    console.log(`  ✓ Copilot MCP already configured in ${vscodeMcpPath}`);
  }

  // GitHub Copilot agent mode format: .github/copilot-mcp.json with "mcpServers" key
  const ghMcpPath = path.join(projectRoot, '.github', 'copilot-mcp.json');
  const ghWritten = writeMcpServersConfig(ghMcpPath, {
    command: KIROGRAPH_COMMAND,
    args: KIROGRAPH_MCP_ARGS,
  });
  console.log(ghWritten
    ? `  ✓ Copilot MCP registered in ${ghMcpPath}`
    : `  ✓ Copilot MCP already configured in ${ghMcpPath}`);
}

export function installCopilotLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'copilot.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Copilot instructions written to ${instructionsPath}`);

  const rulesPath = path.join(projectRoot, '.github', 'copilot-instructions.md');
  ensureDir(path.dirname(rulesPath));
  const changed = upsertGeneratedBlock(rulesPath, COPILOT_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ .github/copilot-instructions.md updated with KiroGraph instructions`
    : `  ✓ .github/copilot-instructions.md already up to date`);

  // Write hooks
  const hooksPath = path.join(projectRoot, '.github', 'hooks.json');
  const existing = readJson(hooksPath);
  const kgHooks = buildCopilotHooks() as any;
  existing.hooks = existing.hooks ?? {};
  for (const [event, commands] of Object.entries(kgHooks.hooks)) {
    existing.hooks[event] = existing.hooks[event] ?? [];
    for (const cmd of commands as Array<{ command: string }>) {
      if (!existing.hooks[event].some((h: any) => h.command === cmd.command)) {
        existing.hooks[event].push(cmd);
      }
    }
  }
  writeJson(hooksPath, existing);
  console.log(`  ✓ Copilot hooks written to ${hooksPath}`);
}

export function uninitCopilot(projectRoot: string): void {
  // Remove from .vscode/mcp.json (servers key)
  const vscodeMcpPath = path.join(projectRoot, '.vscode', 'mcp.json');
  if (fs.existsSync(vscodeMcpPath)) {
    const config = readJson(vscodeMcpPath);
    if (config.servers?.[KIROGRAPH_SERVER_NAME]) {
      delete config.servers[KIROGRAPH_SERVER_NAME];
      if (Object.keys(config.servers).length === 0) delete config.servers;
      writeJson(vscodeMcpPath, config);
      console.log(`  ✓ Removed kirograph from .vscode/mcp.json`);
    }
  }

  // Remove from .github/copilot-mcp.json
  const mcpPath = path.join(projectRoot, '.github', 'copilot-mcp.json');
  if (removeMcpServersConfig(mcpPath)) {
    console.log(`  ✓ Removed kirograph from .github/copilot-mcp.json`);
  }

  const rulesPath = path.join(projectRoot, '.github', 'copilot-instructions.md');
  if (removeGeneratedBlock(rulesPath, COPILOT_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from .github/copilot-instructions.md`);
  }

  const hooksPath = path.join(projectRoot, '.github', 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    const config = readJson(hooksPath);
    if (config.hooks) {
      let changed = false;
      for (const event of Object.keys(config.hooks)) {
        const before = config.hooks[event].length;
        config.hooks[event] = config.hooks[event].filter((h: any) => !h.command?.includes('kirograph'));
        if (config.hooks[event].length === 0) delete config.hooks[event];
        if (config.hooks[event]?.length !== before) changed = true;
      }
      if (Object.keys(config.hooks).length === 0) delete config.hooks;
      if (changed) {
        writeJson(hooksPath, config);
        console.log(`  ✓ Removed kirograph hooks from .github/hooks.json`);
      }
    }
  }
}

export function printCopilotNextSteps(): void {
  console.log('\n  Done! Restart your editor for the Copilot MCP server and hooks to load.');
  console.log('  MCP registered in .vscode/mcp.json and .github/copilot-mcp.json');
  console.log('  Auto-sync hook runs on session end.\n');
}
