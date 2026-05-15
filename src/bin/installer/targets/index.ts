import type { CavemanMode } from '../caveman';
import type { InstallTarget } from '../common';
import { installKiroEarly, installKiroLate, printKiroNextSteps } from './kiro';
import { installClaudeEarly, installClaudeLate, printClaudeNextSteps, uninitClaude } from './claude';
import { installCodexEarly, installCodexLate, printCodexNextSteps, uninitCodex } from './codex';

export interface TargetInstaller {
  label: string;
  installEarly(projectRoot: string): void;
  installLate(projectRoot: string, cavemanMode?: CavemanMode | 'off'): void;
  printNextSteps(projectRoot: string): void;
  uninit?(projectRoot: string): void;
}

export function getTargetInstaller(target: InstallTarget): TargetInstaller {
  if (target === 'claude') {
    return {
      label: 'Claude Code',
      installEarly: installClaudeEarly,
      installLate: installClaudeLate,
      printNextSteps: printClaudeNextSteps,
      uninit: uninitClaude,
    };
  }

  if (target === 'codex') {
    return {
      label: 'Codex',
      installEarly: installCodexEarly,
      installLate: installCodexLate,
      printNextSteps: printCodexNextSteps,
      uninit: uninitCodex,
    };
  }

  return {
    label: 'Kiro',
    installEarly: installKiroEarly,
    installLate: installKiroLate,
    printNextSteps: printKiroNextSteps,
  };
}

