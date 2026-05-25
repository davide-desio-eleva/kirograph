/**
 * reStructuredText Section Parser
 *
 * Handles: .rst
 * Parsing strategy: Adornment-based heading detection.
 * RST headings are defined by underline (and optional overline) characters.
 * The first adornment character encountered defines level 1, the second level 2, etc.
 */

import type { DocFormatParser, ParseResult, ParsedSection } from '../types';

// Characters that can be used as RST adornments
const ADORNMENT_CHARS = new Set('= - ` : . \' " ~ ^ _ * + #'.split(' '));

interface RawHeading {
  title: string;
  level: number;
  lineIndex: number;
  byteOffset: number;
}

function isAdornmentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  const char = trimmed[0];
  if (!ADORNMENT_CHARS.has(char)) return false;
  return trimmed.split('').every(c => c === char);
}

function extractHeadings(content: string): RawHeading[] {
  const lines = content.split('\n');
  const headings: RawHeading[] = [];
  const adornmentOrder: string[] = []; // tracks which chars map to which levels
  let byteOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;

    // Check for heading pattern: title line followed by adornment line
    if (i + 1 < lines.length && line.trim().length > 0 && !isAdornmentLine(line)) {
      const nextLine = lines[i + 1];
      if (isAdornmentLine(nextLine) && nextLine.trim().length >= line.trim().length) {
        const adornChar = nextLine.trim()[0];

        // Also check for overline pattern (adornment above and below)
        let hasOverline = false;
        if (i > 0 && isAdornmentLine(lines[i - 1]) && lines[i - 1].trim()[0] === adornChar) {
          hasOverline = true;
        }

        // Determine level based on order of appearance
        const key = hasOverline ? `over_${adornChar}` : adornChar;
        let levelIdx = adornmentOrder.indexOf(key);
        if (levelIdx === -1) {
          adornmentOrder.push(key);
          levelIdx = adornmentOrder.length - 1;
        }

        headings.push({
          title: line.trim(),
          level: levelIdx + 1,
          lineIndex: i,
          byteOffset: hasOverline ? byteOffset - (Buffer.byteLength(lines[i - 1], 'utf8') + 1) : byteOffset,
        });
      }
    }

    byteOffset += lineBytes;
  }

  return headings;
}

function buildHierarchy(headings: RawHeading[], content: string): ParsedSection[] {
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (headings.length === 0) {
    return [{
      title: '(document)',
      level: 0,
      byteStart: 0,
      byteEnd: contentBytes,
      content,
      children: [],
    }];
  }

  const sections: Array<RawHeading & { byteEnd: number; content: string }> = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].byteOffset;
    const end = i + 1 < headings.length ? headings[i + 1].byteOffset : contentBytes;
    const sectionContent = Buffer.from(content, 'utf8').slice(start, end).toString('utf8');
    sections.push({ ...headings[i], byteEnd: end, content: sectionContent });
  }

  const root: ParsedSection[] = [];
  const stack: Array<{ section: ParsedSection; level: number }> = [];

  for (const s of sections) {
    const parsed: ParsedSection = {
      title: s.title,
      level: s.level,
      byteStart: s.byteOffset,
      byteEnd: s.byteEnd,
      content: s.content,
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= s.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(parsed);
    } else {
      stack[stack.length - 1].section.children.push(parsed);
    }

    stack.push({ section: parsed, level: s.level });
  }

  return root;
}

export const rstParser: DocFormatParser = {
  name: 'rst',
  extensions: ['.rst'],

  parse(content: string, _filePath: string): ParseResult {
    const headings = extractHeadings(content);
    const sections = buildHierarchy(headings, content);
    return { sections, format: 'rst' };
  },
};
