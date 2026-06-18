import type { CavemanMode } from '../caveman';
import type { InstallTarget } from '../common';
import { installKiroEarly, installKiroLate, printKiroNextSteps } from './kiro';
import { installClaudeEarly, installClaudeLate, printClaudeNextSteps, uninitClaude } from './claude';
import { installCodexEarly, installCodexLate, printCodexNextSteps, uninitCodex } from './codex';
import { installCursorEarly, installCursorLate, printCursorNextSteps, uninitCursor } from './cursor';
import { installAntigravityEarly, installAntigravityLate, printAntigravityNextSteps, uninitAntigravity } from './antigravity';
import { installOpenCodeEarly, installOpenCodeLate, printOpenCodeNextSteps, uninitOpenCode } from './opencode';
import { installWindsurfEarly, installWindsurfLate, printWindsurfNextSteps, uninitWindsurf } from './windsurf';
import { installClineEarly, installClineLate, printClineNextSteps, uninitCline } from './cline';
import { installCopilotEarly, installCopilotLate, printCopilotNextSteps, uninitCopilot } from './copilot';
import { installCopilotCliEarly, installCopilotCliLate, printCopilotCliNextSteps, uninitCopilotCli } from './copilot-cli';
import { installJunieEarly, installJunieLate, printJunieNextSteps, uninitJunie } from './junie';
import { installGeminiCliEarly, installGeminiCliLate, printGeminiCliNextSteps, uninitGeminiCli } from './gemini-cli';
import { installContinueEarly, installContinueLate, printContinueNextSteps, uninitContinue } from './continue';
import { installRooEarly, installRooLate, printRooNextSteps, uninitRoo } from './roo';
import { installWarpEarly, installWarpLate, printWarpNextSteps, uninitWarp } from './warp';
import { installAiderEarly, installAiderLate, printAiderNextSteps, uninitAider } from './aider';
import { installTraeEarly, installTraeLate, printTraeNextSteps, uninitTrae } from './trae';
import { installAugmentEarly, installAugmentLate, printAugmentNextSteps, uninitAugment } from './augment';
import { installKiloEarly, installKiloLate, printKiloNextSteps, uninitKilo } from './kilo';
import { installAmpEarly, installAmpLate, printAmpNextSteps, uninitAmp } from './amp';
import { installDevinEarly, installDevinLate, printDevinNextSteps, uninitDevin } from './devin';
import { installReplitEarly, installReplitLate, printReplitNextSteps, uninitReplit } from './replit';
import { installGooseEarly, installGooseLate, printGooseNextSteps, uninitGoose } from './goose';
import { installOpenHandsEarly, installOpenHandsLate, printOpenHandsNextSteps, uninitOpenHands } from './openhands';
import { installTabnineEarly, installTabnineLate, printTabnineNextSteps, uninitTabnine } from './tabnine';
import { mistralVibe, ibmBob, crush, droidFactory, forgeCode, iflowCli, rovoDev } from './generic';
import { installQoderEarly, installQoderLate, printQoderNextSteps, uninitQoder } from './qoder';
import { installQwenEarly, installQwenLate, printQwenNextSteps, uninitQwen } from './qwen';

export interface TargetInstaller {
  label: string;
  installEarly(projectRoot: string, kiroHookFormat?: 'v1-legacy' | 'v2'): void;
  installLate(projectRoot: string, cavemanMode?: CavemanMode | 'off', shellCompressionLevel?: string, enableMemory?: boolean, enableDocs?: boolean, enableData?: boolean, enableSecurity?: boolean, enableArchitecture?: boolean, enablePatterns?: boolean, enableWatchmen?: boolean, watchmenSynthesisMode?: 'local' | 'agent', enableWiki?: boolean, wikiSynthesisMode?: 'local' | 'agent', wikiLocalModel?: string, enableCodeHealth?: boolean, enableAdvancedAnalysis?: boolean, enableAgentUtils?: boolean, trackCallSites?: boolean, kiroHookFormat?: 'v1-legacy' | 'v2'): void;
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

  if (target === 'cursor') {
    return {
      label: 'Cursor',
      installEarly: installCursorEarly,
      installLate: installCursorLate,
      printNextSteps: printCursorNextSteps,
      uninit: uninitCursor,
    };
  }

  if (target === 'antigravity') {
    return {
      label: 'Antigravity',
      installEarly: installAntigravityEarly,
      installLate: installAntigravityLate,
      printNextSteps: printAntigravityNextSteps,
      uninit: uninitAntigravity,
    };
  }

  if (target === 'opencode') {
    return {
      label: 'OpenCode',
      installEarly: installOpenCodeEarly,
      installLate: installOpenCodeLate,
      printNextSteps: printOpenCodeNextSteps,
      uninit: uninitOpenCode,
    };
  }

  if (target === 'windsurf') {
    return {
      label: 'Windsurf',
      installEarly: installWindsurfEarly,
      installLate: installWindsurfLate,
      printNextSteps: printWindsurfNextSteps,
      uninit: uninitWindsurf,
    };
  }

  if (target === 'cline') {
    return {
      label: 'Cline',
      installEarly: installClineEarly,
      installLate: installClineLate,
      printNextSteps: printClineNextSteps,
      uninit: uninitCline,
    };
  }

  if (target === 'copilot') {
    return {
      label: 'GitHub Copilot',
      installEarly: installCopilotEarly,
      installLate: installCopilotLate,
      printNextSteps: printCopilotNextSteps,
      uninit: uninitCopilot,
    };
  }

  if (target === 'copilot-cli') {
    return {
      label: 'GitHub Copilot CLI',
      installEarly: installCopilotCliEarly,
      installLate: installCopilotCliLate,
      printNextSteps: printCopilotCliNextSteps,
      uninit: uninitCopilotCli,
    };
  }

  if (target === 'junie') {
    return {
      label: 'JetBrains Junie',
      installEarly: installJunieEarly,
      installLate: installJunieLate,
      printNextSteps: printJunieNextSteps,
      uninit: uninitJunie,
    };
  }

  if (target === 'gemini-cli') {
    return {
      label: 'Gemini CLI',
      installEarly: installGeminiCliEarly,
      installLate: installGeminiCliLate,
      printNextSteps: printGeminiCliNextSteps,
      uninit: uninitGeminiCli,
    };
  }

  if (target === 'continue') {
    return {
      label: 'Continue',
      installEarly: installContinueEarly,
      installLate: installContinueLate,
      printNextSteps: printContinueNextSteps,
      uninit: uninitContinue,
    };
  }

  if (target === 'roo') {
    return {
      label: 'Roo Code',
      installEarly: installRooEarly,
      installLate: installRooLate,
      printNextSteps: printRooNextSteps,
      uninit: uninitRoo,
    };
  }

  if (target === 'warp') {
    return {
      label: 'Warp',
      installEarly: installWarpEarly,
      installLate: installWarpLate,
      printNextSteps: printWarpNextSteps,
      uninit: uninitWarp,
    };
  }

  if (target === 'aider') {
    return {
      label: 'Aider',
      installEarly: installAiderEarly,
      installLate: installAiderLate,
      printNextSteps: printAiderNextSteps,
      uninit: uninitAider,
    };
  }

  if (target === 'trae') {
    return {
      label: 'Trae',
      installEarly: installTraeEarly,
      installLate: installTraeLate,
      printNextSteps: printTraeNextSteps,
      uninit: uninitTrae,
    };
  }

  if (target === 'augment') {
    return {
      label: 'Augment Code',
      installEarly: installAugmentEarly,
      installLate: installAugmentLate,
      printNextSteps: printAugmentNextSteps,
      uninit: uninitAugment,
    };
  }

  if (target === 'kilo') {
    return {
      label: 'Kilo Code',
      installEarly: installKiloEarly,
      installLate: installKiloLate,
      printNextSteps: printKiloNextSteps,
      uninit: uninitKilo,
    };
  }

  if (target === 'amp') {
    return {
      label: 'Sourcegraph Amp',
      installEarly: installAmpEarly,
      installLate: installAmpLate,
      printNextSteps: printAmpNextSteps,
      uninit: uninitAmp,
    };
  }

  if (target === 'devin') {
    return {
      label: 'Devin',
      installEarly: installDevinEarly,
      installLate: installDevinLate,
      printNextSteps: printDevinNextSteps,
      uninit: uninitDevin,
    };
  }

  if (target === 'replit') {
    return {
      label: 'Replit Agent',
      installEarly: installReplitEarly,
      installLate: installReplitLate,
      printNextSteps: printReplitNextSteps,
      uninit: uninitReplit,
    };
  }

  if (target === 'goose') {
    return {
      label: 'Block Goose',
      installEarly: installGooseEarly,
      installLate: installGooseLate,
      printNextSteps: printGooseNextSteps,
      uninit: uninitGoose,
    };
  }

  if (target === 'openhands') {
    return {
      label: 'OpenHands',
      installEarly: installOpenHandsEarly,
      installLate: installOpenHandsLate,
      printNextSteps: printOpenHandsNextSteps,
      uninit: uninitOpenHands,
    };
  }

  if (target === 'tabnine') {
    return {
      label: 'Tabnine',
      installEarly: installTabnineEarly,
      installLate: installTabnineLate,
      printNextSteps: printTabnineNextSteps,
      uninit: uninitTabnine,
    };
  }

  if (target === 'mistral-vibe') {
    return { label: 'Mistral Vibe', installEarly: mistralVibe.installEarly, installLate: mistralVibe.installLate, printNextSteps: mistralVibe.printNextSteps, uninit: mistralVibe.uninit };
  }
  if (target === 'ibm-bob') {
    return { label: 'IBM Bob', installEarly: ibmBob.installEarly, installLate: ibmBob.installLate, printNextSteps: ibmBob.printNextSteps, uninit: ibmBob.uninit };
  }
  if (target === 'crush') {
    return { label: 'Crush', installEarly: crush.installEarly, installLate: crush.installLate, printNextSteps: crush.printNextSteps, uninit: crush.uninit };
  }
  if (target === 'droid-factory') {
    return { label: 'Droid Factory', installEarly: droidFactory.installEarly, installLate: droidFactory.installLate, printNextSteps: droidFactory.printNextSteps, uninit: droidFactory.uninit };
  }
  if (target === 'forgecode') {
    return { label: 'ForgeCode', installEarly: forgeCode.installEarly, installLate: forgeCode.installLate, printNextSteps: forgeCode.printNextSteps, uninit: forgeCode.uninit };
  }
  if (target === 'iflow') {
    return { label: 'iFlow CLI', installEarly: iflowCli.installEarly, installLate: iflowCli.installLate, printNextSteps: iflowCli.printNextSteps, uninit: iflowCli.uninit };
  }
  if (target === 'qwen') {
    return { label: 'Qwen Code', installEarly: installQwenEarly, installLate: installQwenLate, printNextSteps: printQwenNextSteps, uninit: uninitQwen };
  }
  if (target === 'rovo') {
    return { label: 'Atlassian Rovo Dev', installEarly: rovoDev.installEarly, installLate: rovoDev.installLate, printNextSteps: rovoDev.printNextSteps, uninit: rovoDev.uninit };
  }
  if (target === 'qoder') {
    return { label: 'Qoder', installEarly: installQoderEarly, installLate: installQoderLate, printNextSteps: printQoderNextSteps, uninit: uninitQoder };
  }

  return {
    label: 'Kiro',
    installEarly: installKiroEarly,
    installLate: installKiroLate,
    printNextSteps: printKiroNextSteps,
  };
}
