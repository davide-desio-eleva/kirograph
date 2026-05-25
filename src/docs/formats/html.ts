/**
 * HTML Section Parser
 *
 * Handles: .html, .htm
 * Parsing strategy: <h1>–<h6> heading tags.
 * Strips HTML tags from content for summary extraction.
 */

import type { DocFormatParser, ParseResult, ParsedSection } from '../types';

const HEADING_RE = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;

interface RawHeading {
  title: string;
  level: number;
  byteOffset: number;
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

function extractHeadings(content: string): RawHeading[] {
  const headings: RawHeading[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  HEADING_RE.lastIndex = 0;

  while ((match = HEADING_RE.exec(content)) !== null) {
    const title = stripHtmlTags(match[2]);
    if (title.length === 0) continue;

    headings.push({
      title,
      level: parseInt(match[1], 10),
      byteOffset: Buffer.byteLength(content.slice(0, match.index), 'utf8'),
    });
  }

  return headings;
}

function buildHierarchy(headings: RawHeading[], content: string): ParsedSection[] {
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (headings.length === 0) {
    // Try to extract title from <title> tag
    const titleMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtmlTags(titleMatch[1]) : '(document)';
    return [{
      title,
      level: 0,
      byteStart: 0,
      byteEnd: contentBytes,
      content: stripHtmlTags(content),
      children: [],
    }];
  }

  const sections: Array<RawHeading & { byteEnd: number; content: string }> = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].byteOffset;
    const end = i + 1 < headings.length ? headings[i + 1].byteOffset : contentBytes;
    const rawContent = Buffer.from(content, 'utf8').slice(start, end).toString('utf8');
    sections.push({ ...headings[i], byteEnd: end, content: rawContent });
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

export const htmlParser: DocFormatParser = {
  name: 'html',
  extensions: ['.html', '.htm'],

  parse(content: string, _filePath: string): ParseResult {
    const headings = extractHeadings(content);
    const sections = buildHierarchy(headings, content);
    return { sections, format: 'html' };
  },
};
