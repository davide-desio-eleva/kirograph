/**
 * RDoc Section Parser
 *
 * Handles: .rdoc (Ruby documentation format)
 * Parsing strategy: = heading hierarchy (= Title, == Section, === Subsection)
 * Similar to AsciiDoc but with Ruby-specific conventions.
 */

import type { DocFormatParser, ParseResult, ParsedSection } from '../types';

const HEADING_RE = /^(={1,6})\s+(.+)$/;

interface RawHeading {
  title: string;
  level: number;
  lineIndex: number;
  byteOffset: number;
}

function extractHeadings(content: string): RawHeading[] {
  const lines = content.split('\n');
  const headings: RawHeading[] = [];
  let byteOffset = 0;
  let inVerbatim = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;

    // Track verbatim blocks (indented by 2+ spaces in RDoc)
    // Skip lines starting with spaces (code blocks in RDoc)
    if (line.startsWith('  ') && line.trim().length > 0) {
      byteOffset += lineBytes;
      continue;
    }

    const match = line.match(HEADING_RE);
    if (match) {
      headings.push({
        title: match[2].trim(),
        level: match[1].length,
        lineIndex: i,
        byteOffset,
      });
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

export const rdocParser: DocFormatParser = {
  name: 'rdoc',
  extensions: ['.rdoc'],

  parse(content: string, _filePath: string): ParseResult {
    const headings = extractHeadings(content);
    const sections = buildHierarchy(headings, content);
    return { sections, format: 'rdoc' };
  },
};
