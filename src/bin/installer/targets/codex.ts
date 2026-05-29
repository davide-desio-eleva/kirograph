import * as fs from 'fs';
import * as path from 'path';
import { CavemanMode } from '../caveman';
import {
  ensureDir,
  buildInstructionOpts,
  readJson,
  writeJson,
  printMcpCommand,
  removeGeneratedBlock,
  upsertGeneratedBlock,
} from '../common';
import { buildAgentInstructions } from '../instructions';

const CODEX_BLOCK_ID = 'codex';

function buildCodexHooks(): object {
  return {
    hooks: {
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

export function installCodexEarly(projectRoot: string): void {
  // Codex now supports project-level .codex/ config.
  // Write hooks.json there for auto-sync.
  const codexDir = path.join(projectRoot, '.codex');
  ensureDir(codexDir);
  const hooksPath = path.join(codexDir, 'hooks.json');
  const existing = readJson(hooksPath);
  const kgHooks = buildCodexHooks() as any;

  existing.hooks = existing.hooks ?? {};
  for (const [event, matchers] of Object.entries(kgHooks.hooks)) {
    existing.hooks[event] = existing.hooks[event] ?? [];
    for (const matcher of matchers as any[]) {
      // Avoid duplicates by checking if a kirograph command already exists
      const hasKirograph = existing.hooks[event].some((m: any) =>
        m.hooks?.some((h: any) => h.command?.includes('kirograph'))
      );
      if (!hasKirograph) {
        existing.hooks[event].push(matcher);
      }
    }
  }
  writeJson(hooksPath, existing);
  console.log(`  ✓ Codex hooks written to ${hooksPath}`);
}

export function installCodexLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean): void {
  const opts = buildInstructionOpts(cavemanMode, shellCompressionLevel, enableMemory, true, enableDocs, enableData, enableSecurity, enableArchitecture);

  const instructionsPath = path.join(projectRoot, '.kirograph', 'codex.md');
  ensureDir(path.dirname(instructionsPath));
  fs.writeFileSync(instructionsPath, buildAgentInstructions(opts));
  console.log(`  ✓ Codex instructions written to ${instructionsPath}`);

  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const changed = upsertGeneratedBlock(agentsPath, CODEX_BLOCK_ID, '## KiroGraph', buildAgentInstructions(opts));
  console.log(changed
    ? `  ✓ Codex project instructions updated in ${agentsPath}`
    : `  ✓ Codex project instructions already up to date`);
}

export function uninitCodex(projectRoot: string): void {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (removeGeneratedBlock(agentsPath, CODEX_BLOCK_ID)) {
    console.log(`  ✓ Removed KiroGraph block from AGENTS.md`);
  }

  // Remove hooks
  const hooksPath = path.join(projectRoot, '.codex', 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    const config = readJson(hooksPath);
    if (config.hooks) {
      let changed = false;
      for (const event of Object.keys(config.hooks)) {
        const before = config.hooks[event].length;
        config.hooks[event] = config.hooks[event].filter((m: any) =>
          !m.hooks?.some((h: any) => h.command?.includes('kirograph'))
        );
        if (config.hooks[event].length === 0) delete config.hooks[event];
        if (config.hooks[event]?.length !== before) changed = true;
      }
      if (Object.keys(config.hooks).length === 0) delete config.hooks;
      if (changed) {
        writeJson(hooksPath, config);
        console.log(`  ✓ Removed kirograph hooks from .codex/hooks.json`);
      }
    }
  }
}

export function printCodexNextSteps(projectRoot: string): void {
  const escapedPath = projectRoot.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  console.log('\n  Done! Codex project instructions and hooks are installed.');
  console.log('  Auto-sync hook runs on Stop event.');
  printMcpCommand(`codex mcp add kirograph -- kirograph serve --mcp --path "${escapedPath}"`);
}
