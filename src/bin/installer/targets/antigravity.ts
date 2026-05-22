/**
 * Antigravity IDE target.
 *
 * MCP: user-scoped at ~/.gemini/antigravity/mcp_config.json (print instructions)
 * Hooks: .agents/hooks.json (workspace-level)
 * Instructions: GEMINI.md (upsert block)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  readJson,
  writeJson,
  upsertGeneratedBlock,
  removeGeneratedBlock,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const ANTIGRAVITY_BLOCK_ID = 'antigravity';

function buildAntigravityHooks(): object {
  return {
    'kirograph-sync': {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'kirograph sync --quiet 2>/dev/null || true',
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
}

export function installAntigravityEarly(_projectRoot: string): void {
  // Antigravity IDE MCP is user-scoped at ~/.gemini/antigravity/mcp_config.json.
  // We print the setup instructions in printNextSteps instead of writing outside the project.
}

export function installAntigravityLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'antigravity.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Antigravity instructions written to ${instructionsPath}`);

  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  const changed = upsertGeneratedBlock(geminiPath, ANTIGRAVITY_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ GEMINI.md updated with KiroGraph instructions`
    : `  ✓ GEMINI.md already up to date`);

  // Write hooks to .agents/hooks.json
  const hooksPath = path.join(projectRoot, '.agents', 'hooks.json');
  ensureDir(path.dirname(hooksPath));
  const existing = readJson(hooksPath);
  const kgHooks = buildAntigravityHooks() as any;
  // Merge without overwriting existing hooks
  for (const [name, config] of Object.entries(kgHooks)) {
    if (!existing[name]) {
      existing[name] = config;
    }
  }
  writeJson(hooksPath, existing);
  console.log(`  ✓ Antigravity hooks written to ${hooksPath}`);
}

export function uninitAntigravity(projectRoot: string): void {
  const geminiPath = path.join(projectRoot, 'GEMINI.md');
  if (removeGeneratedBlock(geminiPath, ANTIGRAVITY_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from GEMINI.md`);
  }

  // Remove hooks
  const hooksPath = path.join(projectRoot, '.agents', 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    const config = readJson(hooksPath);
    if (config['kirograph-sync']) {
      delete config['kirograph-sync'];
      writeJson(hooksPath, config);
      console.log(`  ✓ Removed kirograph-sync from .agents/hooks.json`);
    }
  }
}

export function printAntigravityNextSteps(projectRoot: string): void {
  const escapedPath = projectRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  console.log('\n  Done! KiroGraph instructions are in GEMINI.md.');
  console.log('  Auto-sync hook installed in .agents/hooks.json');
  console.log('\n  Add the MCP server to Antigravity:');
  console.log('  Edit ~/.gemini/antigravity/mcp_config.json and add:');
  console.log('    {');
  console.log('      "mcpServers": {');
  console.log('        "kirograph": {');
  console.log(`          "command": "kirograph",`);
  console.log(`          "args": ["serve", "--mcp", "--path", "${escapedPath}"]`);
  console.log('        }');
  console.log('      }');
  console.log('    }\n');
}
