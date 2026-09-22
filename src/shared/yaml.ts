/**
 * KiroGraph — Minimal YAML parser
 *
 * js-yaml is not a declared dependency, so this handles the subset of YAML
 * used across KiroGraph (pattern rule files, wiki frontmatter):
 *   - Flat key: value (string, boolean, number)
 *   - key: [item1, item2] (inline array)
 *   - key:\n  - item (block sequence for simple values)
 *   - nested-block:\n  (nested block as raw sub-object — parsed recursively)
 *   - Quoted strings: "..." and '...'
 *   - Comments: # ...
 *
 * Originally lived inline in src/patterns/loader.ts; extracted so wiki
 * frontmatter parsing (typed-pages.ts) can reuse it without duplication.
 */

export function parseYaml(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  return parseBlock(lines, 0, 0).result;
}

interface BlockResult {
  result: Record<string, unknown>;
  nextIndex: number;
}

function parseBlock(lines: string[], startIndex: number, baseIndent: number): BlockResult {
  const result: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const rawLine = lines[i];
    // Strip trailing comments (but not inside strings — simplified approach)
    const commentIdx = rawLine.indexOf(' #');
    const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;

    // Skip blank lines
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = countIndent(rawLine);

    // If we've de-indented past our base, stop
    if (indent < baseIndent) break;

    // Skip lines that are at an indent level below our block's base
    if (indent > baseIndent && Object.keys(result).length === 0) {
      // Haven't started the block yet — shouldn't happen but skip
      i++;
      continue;
    }

    if (indent > baseIndent) {
      // This belongs to a child block already being processed — stop
      break;
    }

    const trimmed = line.trim();

    // Detect key: ... pattern
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trimStart();

    if (rest === '' || rest === '|' || rest === '>') {
      // Value is on the following lines — could be a nested block or block scalar
      // Peek ahead: if next non-empty line is indented more, recurse
      const nextContentLine = findNextContent(lines, i + 1);
      if (nextContentLine === -1) {
        result[key] = null;
        i++;
        continue;
      }
      const nextIndent = countIndent(lines[nextContentLine]);
      if (nextIndent > indent) {
        // Check if next line is a sequence item (- ...)
        if (lines[nextContentLine].trim().startsWith('- ')) {
          const { items, nextIndex } = parseSequence(lines, nextContentLine, nextIndent);
          result[key] = items;
          i = nextIndex;
        } else {
          const { result: subResult, nextIndex } = parseBlock(lines, nextContentLine, nextIndent);
          result[key] = subResult;
          i = nextIndex;
        }
      } else {
        result[key] = null;
        i++;
      }
    } else if (rest.startsWith('[')) {
      // Inline array: [a, b, c]
      result[key] = parseInlineArray(rest);
      i++;
    } else {
      // Scalar value
      result[key] = parseScalar(rest);
      i++;
    }
  }

  return { result, nextIndex: i };
}

function parseSequence(lines: string[], startIndex: number, baseIndent: number): { items: unknown[]; nextIndex: number } {
  const items: unknown[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) {
      i++;
      continue;
    }
    const indent = countIndent(rawLine);
    if (indent < baseIndent) break;

    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('- ') && trimmed !== '-') {
      break;
    }

    const itemValue = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : '';

    if (itemValue === '' || itemValue === '|' || itemValue === '>') {
      // Multi-line sequence item
      const nextContentLine = findNextContent(lines, i + 1);
      if (nextContentLine !== -1 && countIndent(lines[nextContentLine]) > indent) {
        const { result: subResult, nextIndex } = parseBlock(lines, nextContentLine, countIndent(lines[nextContentLine]));
        items.push(subResult);
        i = nextIndex;
      } else {
        items.push(null);
        i++;
      }
    } else if (itemValue.includes(':')) {
      // Inline key:value item — parse as sub-object, collecting any indented continuation lines
      const itemIndent = indent + 2;
      const continuationLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextRaw = lines[j];
        if (nextRaw.trim() === '' || nextRaw.trim().startsWith('#')) { j++; continue; }
        if (countIndent(nextRaw) >= itemIndent) {
          continuationLines.push(nextRaw);
          j++;
        } else {
          break;
        }
      }
      const blockLines = [' '.repeat(itemIndent) + itemValue, ...continuationLines];
      const { result: subResult } = parseBlock(blockLines, 0, itemIndent);
      items.push(subResult);
      i = j;
    } else {
      items.push(parseScalar(itemValue));
      i++;
    }
  }

  return { items, nextIndex: i };
}

function parseInlineArray(text: string): unknown[] {
  const inner = text.replace(/^\[/, '').replace(/\].*$/, '');
  if (inner.trim() === '') return [];
  return inner.split(',').map(s => parseScalar(s.trim()));
}

function parseScalar(text: string): unknown {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return parseFloat(text);
  // Quoted string
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function countIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function findNextContent(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t !== '' && !t.startsWith('#')) return i;
  }
  return -1;
}
