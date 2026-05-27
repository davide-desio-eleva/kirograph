/**
 * KiroGraph Read Modes
 *
 * Implements multiple read modes for the kirograph_read tool:
 * - full: entire file content (default)
 * - map: structure overview (symbols with line numbers)
 * - signatures: function/class signatures only
 * - diff: changes since last read
 * - lines: specific line range
 * - imports: import statements
 * - exports: exported symbols
 */

import * as fs from 'fs';
import * as path from 'path';
import type KiroGraph from '../index';
import { getFileReadCache } from './cache';

export type ReadMode = 'full' | 'map' | 'signatures' | 'diff' | 'lines' | 'imports' | 'exports';

export interface ReadModeOptions {
  mode: ReadMode;
  filePath: string;
  start?: number;
  end?: number;
  cg?: KiroGraph | null;
}

export interface ReadModeResult {
  content: string;
  mode: ReadMode;
  tokenEstimate: number;
}

/**
 * Execute a read mode against a file.
 */
export function executeReadMode(opts: ReadModeOptions): ReadModeResult {
  const { mode, filePath, start, end, cg } = opts;

  switch (mode) {
    case 'full':
      return readFull(filePath);
    case 'map':
      return readMap(filePath, cg);
    case 'signatures':
      return readSignatures(filePath, cg);
    case 'diff':
      return readDiff(filePath);
    case 'lines':
      return readLines(filePath, start, end);
    case 'imports':
      return readImports(filePath, cg);
    case 'exports':
      return readExports(filePath, cg);
    default:
      return readFull(filePath);
  }
}

function readFull(filePath: string): ReadModeResult {
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    content,
    mode: 'full',
    tokenEstimate: Math.round(content.length / 4),
  };
}

function readMap(filePath: string, cg?: KiroGraph | null): ReadModeResult {
  if (cg) {
    // Use graph data — no file read needed
    const projectRoot = cg.getProjectRoot();
    const relPath = path.isAbsolute(filePath)
      ? path.relative(projectRoot, filePath)
      : filePath;

    try {
      const db = cg.getDatabase();
      const nodes = db.getNodesByFile(relPath);
      if (nodes.length > 0) {
        const lines = [`# ${relPath} — Structure Map (${nodes.length} symbols)\n`];
        // Sort by line number
        const sorted = [...nodes].sort((a, b) => a.startLine - b.startLine);
        for (const n of sorted) {
          const exported = n.isExported ? ' [exported]' : '';
          lines.push(`  L${n.startLine}-${n.endLine}  ${n.kind} ${n.name}${exported}`);
        }
        const content = lines.join('\n');
        return { content, mode: 'map', tokenEstimate: Math.round(content.length / 4) };
      }
    } catch {
      // Fall through to file-based approach
    }
  }

  // Fallback: parse file for structure indicators
  const raw = fs.readFileSync(filePath, 'utf8');
  const fileLines = raw.split('\n');
  const structureLines: string[] = [`# ${path.basename(filePath)} — Structure Map\n`];

  const patterns = [
    /^\s*(export\s+)?(async\s+)?function\s+(\w+)/,
    /^\s*(export\s+)?(default\s+)?class\s+(\w+)/,
    /^\s*(export\s+)?interface\s+(\w+)/,
    /^\s*(export\s+)?type\s+(\w+)/,
    /^\s*(export\s+)?enum\s+(\w+)/,
    /^\s*(export\s+)?const\s+(\w+)\s*=/,
  ];

  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i]!;
    for (const pat of patterns) {
      if (pat.test(line)) {
        structureLines.push(`  L${i + 1}  ${line.trim()}`);
        break;
      }
    }
  }

  const content = structureLines.length > 1
    ? structureLines.join('\n')
    : `# ${path.basename(filePath)} — No structure detected`;
  return { content, mode: 'map', tokenEstimate: Math.round(content.length / 4) };
}

function readSignatures(filePath: string, cg?: KiroGraph | null): ReadModeResult {
  if (cg) {
    const projectRoot = cg.getProjectRoot();
    const relPath = path.isAbsolute(filePath)
      ? path.relative(projectRoot, filePath)
      : filePath;

    try {
      const db = cg.getDatabase();
      const nodes = db.getNodesByFile(relPath);
      if (nodes.length > 0) {
        const lines = [`# ${relPath} — Signatures\n`];
        const sorted = [...nodes].sort((a, b) => a.startLine - b.startLine);
        for (const n of sorted) {
          if (n.signature) {
            lines.push(`${n.signature}`);
          } else {
            lines.push(`${n.kind} ${n.name} (L${n.startLine})`);
          }
        }
        const content = lines.join('\n');
        return { content, mode: 'signatures', tokenEstimate: Math.round(content.length / 4) };
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: extract first line of each function/class
  const raw = fs.readFileSync(filePath, 'utf8');
  const fileLines = raw.split('\n');
  const sigs: string[] = [`# ${path.basename(filePath)} — Signatures\n`];

  const patterns = [
    /^\s*(export\s+)?(async\s+)?function\s+/,
    /^\s*(export\s+)?(default\s+)?class\s+/,
    /^\s*(export\s+)?interface\s+/,
    /^\s*(export\s+)?type\s+\w+/,
  ];

  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i]!;
    for (const pat of patterns) {
      if (pat.test(line)) {
        // Take the line up to the opening brace or end
        const sig = line.replace(/\{.*$/, '').trim();
        sigs.push(sig);
        break;
      }
    }
  }

  const content = sigs.length > 1
    ? sigs.join('\n')
    : `# ${path.basename(filePath)} — No signatures found`;
  return { content, mode: 'signatures', tokenEstimate: Math.round(content.length / 4) };
}

function readDiff(filePath: string): ReadModeResult {
  const cache = getFileReadCache();
  const previousContent = cache.getPreviousContent(filePath);

  if (!previousContent) {
    // No previous version — return full content
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      content: `[no previous version cached — showing full content]\n\n${content}`,
      mode: 'diff',
      tokenEstimate: Math.round(content.length / 4),
    };
  }

  const currentContent = fs.readFileSync(filePath, 'utf8');
  if (currentContent === previousContent) {
    const msg = '[no changes since last read]';
    return { content: msg, mode: 'diff', tokenEstimate: 5 };
  }

  // Simple line-based diff
  const oldLines = previousContent.split('\n');
  const newLines = currentContent.split('\n');
  const diffLines: string[] = [`# Diff: ${path.basename(filePath)}\n`];

  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i >= oldLines.length) {
      diffLines.push(`+ ${newLines[j]}`);
      j++;
    } else if (j >= newLines.length) {
      diffLines.push(`- ${oldLines[i]}`);
      i++;
    } else if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else {
      // Simple heuristic: look ahead for matching lines
      let foundInNew = -1;
      for (let k = j + 1; k < Math.min(j + 5, newLines.length); k++) {
        if (newLines[k] === oldLines[i]) { foundInNew = k; break; }
      }
      if (foundInNew >= 0) {
        // Lines were added
        while (j < foundInNew) {
          diffLines.push(`+ ${newLines[j]}`);
          j++;
        }
      } else {
        diffLines.push(`- ${oldLines[i]}`);
        i++;
        diffLines.push(`+ ${newLines[j]}`);
        j++;
      }
    }
  }

  const content = diffLines.join('\n');
  return { content, mode: 'diff', tokenEstimate: Math.round(content.length / 4) };
}

function readLines(filePath: string, start?: number, end?: number): ReadModeResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  const allLines = raw.split('\n');
  const startLine = Math.max(1, start ?? 1);
  const endLine = Math.min(allLines.length, end ?? allLines.length);

  const selected = allLines.slice(startLine - 1, endLine);
  const numbered = selected.map((line, idx) => `${startLine + idx}: ${line}`);
  const content = `# ${path.basename(filePath)} — Lines ${startLine}-${endLine} of ${allLines.length}\n\n${numbered.join('\n')}`;
  return { content, mode: 'lines', tokenEstimate: Math.round(content.length / 4) };
}

function readImports(filePath: string, cg?: KiroGraph | null): ReadModeResult {
  if (cg) {
    const projectRoot = cg.getProjectRoot();
    const relPath = path.isAbsolute(filePath)
      ? path.relative(projectRoot, filePath)
      : filePath;

    try {
      const db = cg.getDatabase();
      const nodes = db.getNodesByFile(relPath);
      const importNodes = nodes.filter(n => n.kind === 'import');
      if (importNodes.length > 0) {
        const lines = [`# ${relPath} — Imports (${importNodes.length})\n`];
        for (const n of importNodes) {
          lines.push(`  ${n.name} (L${n.startLine})`);
        }
        const content = lines.join('\n');
        return { content, mode: 'imports', tokenEstimate: Math.round(content.length / 4) };
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: regex-based import extraction
  const raw = fs.readFileSync(filePath, 'utf8');
  const fileLines = raw.split('\n');
  const importLines: string[] = [`# ${path.basename(filePath)} — Imports\n`];

  for (const line of fileLines) {
    if (/^\s*(import|from|require\()/.test(line)) {
      importLines.push(`  ${line.trim()}`);
    }
  }

  const content = importLines.length > 1
    ? importLines.join('\n')
    : `# ${path.basename(filePath)} — No imports found`;
  return { content, mode: 'imports', tokenEstimate: Math.round(content.length / 4) };
}

function readExports(filePath: string, cg?: KiroGraph | null): ReadModeResult {
  if (cg) {
    const projectRoot = cg.getProjectRoot();
    const relPath = path.isAbsolute(filePath)
      ? path.relative(projectRoot, filePath)
      : filePath;

    try {
      const db = cg.getDatabase();
      const nodes = db.getNodesByFile(relPath);
      const exportedNodes = nodes.filter(n => n.isExported);
      if (exportedNodes.length > 0) {
        const lines = [`# ${relPath} — Exports (${exportedNodes.length})\n`];
        for (const n of exportedNodes) {
          lines.push(`  ${n.kind} ${n.name} (L${n.startLine})`);
        }
        const content = lines.join('\n');
        return { content, mode: 'exports', tokenEstimate: Math.round(content.length / 4) };
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: regex-based export extraction
  const raw = fs.readFileSync(filePath, 'utf8');
  const fileLines = raw.split('\n');
  const exportLines: string[] = [`# ${path.basename(filePath)} — Exports\n`];

  for (const line of fileLines) {
    if (/^\s*export\s+/.test(line)) {
      exportLines.push(`  ${line.trim()}`);
    }
  }

  const content = exportLines.length > 1
    ? exportLines.join('\n')
    : `# ${path.basename(filePath)} — No exports found`;
  return { content, mode: 'exports', tokenEstimate: Math.round(content.length / 4) };
}
