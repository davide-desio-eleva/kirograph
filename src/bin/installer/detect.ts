/**
 * Platform auto-detection for KiroGraph installer.
 *
 * Detects which AI coding tools are installed on the system by checking
 * for known config directories and CLI binaries. Used by `kirograph install`
 * (with no --target flag) to auto-configure all detected platforms.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { InstallTarget } from './common';

export interface PlatformDetector {
  target: InstallTarget;
  label: string;
  /** How the platform was detected (shown to user) */
  reason: string;
  detect: (projectRoot: string) => DetectionResult | false;
}

export interface DetectionResult {
  target: InstallTarget;
  label: string;
  reason: string;
}

function whichExists(binary: string): boolean {
  try {
    execSync(`which ${binary}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function fileExists(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

const home = process.env.HOME || process.env.USERPROFILE || '';

const DETECTORS: PlatformDetector[] = [
  {
    target: 'kiro',
    label: 'Kiro',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.kiro'))) return { target: 'kiro', label: 'Kiro', reason: '.kiro/ found in project' };
      if (dirExists(path.join(home, '.kiro'))) return { target: 'kiro', label: 'Kiro', reason: '~/.kiro/ found' };
      return false;
    },
  },
  {
    target: 'claude',
    label: 'Claude Code',
    reason: '',
    detect: (root) => {
      if (fileExists(path.join(root, '.mcp.json'))) return { target: 'claude', label: 'Claude Code', reason: '.mcp.json found in project' };
      if (whichExists('claude')) return { target: 'claude', label: 'Claude Code', reason: 'claude binary on PATH' };
      return false;
    },
  },
  {
    target: 'cursor',
    label: 'Cursor',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.cursor'))) return { target: 'cursor', label: 'Cursor', reason: '.cursor/ found in project' };
      if (dirExists(path.join(home, '.cursor'))) return { target: 'cursor', label: 'Cursor', reason: '~/.cursor/ found' };
      return false;
    },
  },
  {
    target: 'windsurf',
    label: 'Windsurf',
    reason: '',
    detect: () => {
      if (dirExists(path.join(home, '.codeium', 'windsurf'))) return { target: 'windsurf', label: 'Windsurf', reason: '~/.codeium/windsurf/ found' };
      return false;
    },
  },
  {
    target: 'codex',
    label: 'Codex',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.codex'))) return { target: 'codex', label: 'Codex', reason: '.codex/ found in project' };
      if (dirExists(path.join(home, '.codex'))) return { target: 'codex', label: 'Codex', reason: '~/.codex/ found' };
      if (whichExists('codex')) return { target: 'codex', label: 'Codex', reason: 'codex binary on PATH' };
      return false;
    },
  },
  {
    target: 'copilot',
    label: 'GitHub Copilot',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.vscode'))) return { target: 'copilot', label: 'GitHub Copilot', reason: '.vscode/ found in project' };
      if (dirExists(path.join(home, '.vscode'))) return { target: 'copilot', label: 'GitHub Copilot', reason: '~/.vscode/ found' };
      return false;
    },
  },
  {
    target: 'gemini-cli',
    label: 'Gemini CLI',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.gemini'))) return { target: 'gemini-cli', label: 'Gemini CLI', reason: '.gemini/ found in project' };
      if (whichExists('gemini')) return { target: 'gemini-cli', label: 'Gemini CLI', reason: 'gemini binary on PATH' };
      if (dirExists(path.join(home, '.gemini'))) return { target: 'gemini-cli', label: 'Gemini CLI', reason: '~/.gemini/ found' };
      return false;
    },
  },
  {
    target: 'cline',
    label: 'Cline',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.cline'))) return { target: 'cline', label: 'Cline', reason: '.cline/ found in project' };
      if (dirExists(path.join(root, '.clinerules'))) return { target: 'cline', label: 'Cline', reason: '.clinerules/ found in project' };
      return false;
    },
  },
  {
    target: 'roo',
    label: 'Roo Code',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.roo'))) return { target: 'roo', label: 'Roo Code', reason: '.roo/ found in project' };
      return false;
    },
  },
  {
    target: 'warp',
    label: 'Warp',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.warp'))) return { target: 'warp', label: 'Warp', reason: '.warp/ found in project' };
      if (whichExists('warp')) return { target: 'warp', label: 'Warp', reason: 'warp binary on PATH' };
      return false;
    },
  },
  {
    target: 'continue',
    label: 'Continue',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.continue'))) return { target: 'continue', label: 'Continue', reason: '.continue/ found in project' };
      if (dirExists(path.join(home, '.continue'))) return { target: 'continue', label: 'Continue', reason: '~/.continue/ found' };
      return false;
    },
  },
  {
    target: 'opencode',
    label: 'OpenCode',
    reason: '',
    detect: (root) => {
      if (fileExists(path.join(root, '.opencode.json'))) return { target: 'opencode', label: 'OpenCode', reason: '.opencode.json found in project' };
      return false;
    },
  },
  {
    target: 'antigravity',
    label: 'Antigravity',
    reason: '',
    detect: () => {
      if (dirExists(path.join(home, '.gemini', 'antigravity'))) return { target: 'antigravity', label: 'Antigravity', reason: '~/.gemini/antigravity/ found' };
      return false;
    },
  },
  {
    target: 'trae',
    label: 'Trae',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.trae'))) return { target: 'trae', label: 'Trae', reason: '.trae/ found in project' };
      return false;
    },
  },
  {
    target: 'amp',
    label: 'Sourcegraph Amp',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.amp'))) return { target: 'amp', label: 'Sourcegraph Amp', reason: '.amp/ found in project' };
      return false;
    },
  },
  {
    target: 'aider',
    label: 'Aider',
    reason: '',
    detect: () => {
      if (whichExists('aider')) return { target: 'aider', label: 'Aider', reason: 'aider binary on PATH' };
      return false;
    },
  },
  {
    target: 'goose',
    label: 'Block Goose',
    reason: '',
    detect: () => {
      if (whichExists('goose')) return { target: 'goose', label: 'Block Goose', reason: 'goose binary on PATH' };
      return false;
    },
  },
  {
    target: 'junie',
    label: 'JetBrains Junie',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.junie'))) return { target: 'junie', label: 'JetBrains Junie', reason: '.junie/ found in project' };
      return false;
    },
  },
  {
    target: 'augment',
    label: 'Augment Code',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.augment'))) return { target: 'augment', label: 'Augment Code', reason: '.augment/ found in project' };
      return false;
    },
  },
  {
    target: 'kilo',
    label: 'Kilo Code',
    reason: '',
    detect: (root) => {
      if (fileExists(path.join(root, 'kilo.json'))) return { target: 'kilo', label: 'Kilo Code', reason: 'kilo.json found in project' };
      return false;
    },
  },
  {
    target: 'devin',
    label: 'Devin',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.devin'))) return { target: 'devin', label: 'Devin', reason: '.devin/ found in project' };
      return false;
    },
  },
  {
    target: 'openhands',
    label: 'OpenHands',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.openhands'))) return { target: 'openhands', label: 'OpenHands', reason: '.openhands/ found in project' };
      return false;
    },
  },
  {
    target: 'tabnine',
    label: 'Tabnine',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.tabnine'))) return { target: 'tabnine', label: 'Tabnine', reason: '.tabnine/ found in project' };
      return false;
    },
  },
  {
    target: 'replit',
    label: 'Replit Agent',
    reason: '',
    detect: (root) => {
      if (fileExists(path.join(root, '.replit'))) return { target: 'replit', label: 'Replit Agent', reason: '.replit found in project' };
      return false;
    },
  },
  {
    target: 'qoder',
    label: 'Qoder',
    reason: '',
    detect: (root) => {
      if (dirExists(path.join(root, '.qoder'))) return { target: 'qoder', label: 'Qoder', reason: '.qoder/ found in project' };
      return false;
    },
  },
  {
    target: 'commandcode',
    label: 'Command Code',
    reason: '',
    detect: () => {
      // Command Code stores user/global state in ~/.commandcode/ and ships the
      // `command-code` binary (run as `cmd`). Avoid keying off .mcp.json — it's
      // shared with other agents (e.g. Claude) and would misfire.
      if (dirExists(path.join(home, '.commandcode'))) return { target: 'commandcode', label: 'Command Code', reason: '~/.commandcode/ found' };
      if (whichExists('command-code')) return { target: 'commandcode', label: 'Command Code', reason: 'command-code binary found in PATH' };
      return false;
    },
  },
];

/**
 * Detect all AI coding platforms installed on this system / in this project.
 * Returns detection results for all platforms that were found.
 */
export function detectPlatforms(projectRoot: string): DetectionResult[] {
  const results: DetectionResult[] = [];
  for (const detector of DETECTORS) {
    const result = detector.detect(projectRoot);
    if (result) {
      results.push(result);
    }
  }
  return results;
}

/**
 * Get just the target names of detected platforms.
 */
export function detectTargets(projectRoot: string): InstallTarget[] {
  return detectPlatforms(projectRoot).map(r => r.target);
}
