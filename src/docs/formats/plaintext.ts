/**
 * Plain Text Section Parser
 *
 * Handles: .txt
 * Parsing strategy: Paragraph-block splitting.
 * Treats blank-line-separated blocks as sections.
 * Lines that are ALL CAPS or followed by a line of dashes are treated as headings.
 */

import type { DocFormatParser, ParseResult, ParsedSection } from '../types';

interface RawHeading {
  title: string;
  level: number;
  byteOffset: number;
}

function isAllCaps(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  // Must have at least some letters and be all uppercase
  return /[A-Z]/.test(trimmed) && trimmed === trimmed.toUpperCase() && /^[A-Z\s\d\-_:]+$/.test(trimmed);
}

function isDashUnderline(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 3 && /^[-=~]+$/.test(trimmed);
}

function extractHeadings(content: string): RawHeading[] {
  const lines = content.split('\n');
  const headings: RawHeading[] = [];
  let byteOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    const trimmed = line.trim();

    // Pattern 1: ALL CAPS line preceded by blank line (or first line)
    if (isAllCaps(trimmed) && (i === 0 || lines[i - 1].trim() === '')) {
      headings.push({
        title: trimmed,
        level: 1,
        byteOffset,
      });
      byteOffset += lineBytes;
      continue;
    }

    // Pattern 2: Line followed by dash/equals underline
    if (trimmed.length > 0 && i + 1 < lines.length && isDashUnderline(lines[i + 1])) {
      const underlineChar = lines[i + 1].trim()[0];
      headings.push({
        title: trimmed,
        level: underlineChar === '=' ? 1 : 2,
        byteOffset,
      });
      byteOffset += lineBytes;
      continue;
    }

    byteOffset += lineBytes;
  }

  return headings;
}

function buildHierarchy(headings: RawHeading[], content: string): ParsedSection[] {
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (headings.length === 0) {
    // No headings detected — treat as single section
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

export const plaintextParser: DocFormatParser = {
  name: 'plaintext',
  extensions: ['.txt'],

  parse(content: string, _filePath: string): ParseResult {
    const headings = extractHeadings(content);
    const sections = buildHierarchy(headings, content);
    return { sections, format: 'plaintext' };
  },
};
