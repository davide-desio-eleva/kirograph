/**
 * Markdown Section Parser
 *
 * Handles: .md, .mdx, .cheatmd
 * Parsing strategy: ATX headings (# Heading) + setext headings (underline with = or -)
 *
 * Correctly ignores headings inside fenced code blocks (``` or ~~~).
 */

import type { DocFormatParser, ParseResult, ParsedSection } from '../types';

// ── ATX heading regex: # to ###### at start of line ──────────────────────────
const ATX_HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/;

// ── Setext heading: line followed by === or --- ──────────────────────────────
const SETEXT_H1 = /^=+\s*$/;
const SETEXT_H2 = /^-+\s*$/;

// ── Fenced code block markers ────────────────────────────────────────────────
const FENCE_OPEN = /^(`{3,}|~{3,})/;

interface RawHeading {
  title: string;
  level: number;
  lineIndex: number;
  byteOffset: number;
}

/**
 * Extract all headings from Markdown content, respecting code fences.
 */
function extractHeadings(content: string): RawHeading[] {
  const lines = content.split('\n');
  const headings: RawHeading[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let byteOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n

    // Track fenced code blocks
    if (!inFence) {
      const fenceMatch = line.match(FENCE_OPEN);
      if (fenceMatch) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        byteOffset += lineBytes;
        continue;
      }
    } else {
      // Check for closing fence
      const closingPattern = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`);
      if (closingPattern.test(line)) {
        inFence = false;
      }
      byteOffset += lineBytes;
      continue;
    }

    // ATX heading
    const atxMatch = line.match(ATX_HEADING);
    if (atxMatch) {
      headings.push({
        title: atxMatch[2].trim(),
        level: atxMatch[1].length,
        lineIndex: i,
        byteOffset,
      });
      byteOffset += lineBytes;
      continue;
    }

    // Setext heading (check next line)
    if (i + 1 < lines.length && line.trim().length > 0) {
      const nextLine = lines[i + 1];
      if (SETEXT_H1.test(nextLine)) {
        headings.push({
          title: line.trim(),
          level: 1,
          lineIndex: i,
          byteOffset,
        });
      } else if (SETEXT_H2.test(nextLine)) {
        headings.push({
          title: line.trim(),
          level: 2,
          lineIndex: i,
          byteOffset,
        });
      }
    }

    byteOffset += lineBytes;
  }

  return headings;
}

/**
 * Build a section hierarchy from flat headings list.
 * Each section's content spans from its heading to the next heading of same or higher level.
 */
function buildHierarchy(headings: RawHeading[], content: string): ParsedSection[] {
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (headings.length === 0) {
    // No headings — treat entire file as a single root section
    return [{
      title: '(document)',
      level: 0,
      byteStart: 0,
      byteEnd: contentBytes,
      content,
      children: [],
    }];
  }

  // Calculate byte ranges for each heading
  const sections: Array<RawHeading & { byteEnd: number; content: string }> = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].byteOffset;
    const end = i + 1 < headings.length ? headings[i + 1].byteOffset : contentBytes;
    const sectionContent = Buffer.from(content, 'utf8').slice(start, end).toString('utf8');
    sections.push({ ...headings[i], byteEnd: end, content: sectionContent });
  }

  // Build tree using a stack-based approach
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

    // Pop stack until we find a parent with lower level
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

// ── Parser Export ─────────────────────────────────────────────────────────────

export const markdownParser: DocFormatParser = {
  name: 'markdown',
  extensions: ['.md', '.mdx', '.cheatmd'],

  parse(content: string, _filePath: string): ParseResult {
    const headings = extractHeadings(content);
    const sections = buildHierarchy(headings, content);

    return {
      sections,
      format: 'markdown',
    };
  },
};
