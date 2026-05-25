/**
 * OpenAPI/Swagger Section Parser
 *
 * Handles: .yaml, .yml, .json (when detected as OpenAPI spec)
 * Parsing strategy: Operations grouped by tag.
 * Each tag becomes a level-1 section, each operation becomes a level-2 section.
 *
 * Detection: file must contain "openapi:" or "swagger:" (YAML) or
 * "openapi" / "swagger" keys at root level (JSON).
 */

import type { DocFormatParser, ParseResult, ParsedSection } from '../types';

interface OpenAPIOperation {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  byteStart: number;
  byteEnd: number;
}

function isOpenAPIContent(content: string, filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content);
      return 'openapi' in parsed || 'swagger' in parsed;
    } catch { return false; }
  }
  // YAML detection
  return /^(openapi|swagger)\s*:/m.test(content);
}

function parseYAMLOperations(content: string): OpenAPIOperation[] {
  const operations: OpenAPIOperation[] = [];
  const lines = content.split('\n');
  let inPaths = false;
  let currentPath = '';
  let currentMethod = '';
  let currentTags: string[] = [];
  let currentSummary = '';
  let currentDescription = '';
  let opStart = 0;
  let byteOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;

    // Detect paths: section
    if (/^paths\s*:/.test(line)) {
      inPaths = true;
      byteOffset += lineBytes;
      continue;
    }

    // Exit paths section on next top-level key
    if (inPaths && /^\S/.test(line) && !/^paths/.test(line)) {
      // Flush last operation
      if (currentPath && currentMethod) {
        operations.push({
          method: currentMethod.toUpperCase(),
          path: currentPath,
          summary: currentSummary,
          description: currentDescription,
          tags: currentTags.length > 0 ? currentTags : ['default'],
          byteStart: opStart,
          byteEnd: byteOffset,
        });
      }
      inPaths = false;
      byteOffset += lineBytes;
      continue;
    }

    if (inPaths) {
      // Path pattern: "  /users:" or "  '/users/{id}':"
      const pathMatch = line.match(/^\s{2}(['"]?)(\/[^'":\s]*)\1\s*:/);
      if (pathMatch) {
        // Flush previous operation
        if (currentPath && currentMethod) {
          operations.push({
            method: currentMethod.toUpperCase(),
            path: currentPath,
            summary: currentSummary,
            description: currentDescription,
            tags: currentTags.length > 0 ? currentTags : ['default'],
            byteStart: opStart,
            byteEnd: byteOffset,
          });
          currentMethod = '';
          currentSummary = '';
          currentDescription = '';
          currentTags = [];
        }
        currentPath = pathMatch[2];
      }

      // Method pattern: "    get:", "    post:", etc.
      const methodMatch = line.match(/^\s{4}(get|post|put|delete|patch|head|options)\s*:/);
      if (methodMatch) {
        // Flush previous operation if same path different method
        if (currentMethod) {
          operations.push({
            method: currentMethod.toUpperCase(),
            path: currentPath,
            summary: currentSummary,
            description: currentDescription,
            tags: currentTags.length > 0 ? currentTags : ['default'],
            byteStart: opStart,
            byteEnd: byteOffset,
          });
        }
        currentMethod = methodMatch[1];
        currentSummary = '';
        currentDescription = '';
        currentTags = [];
        opStart = byteOffset;
      }

      // Summary
      const summaryMatch = line.match(/^\s{6}summary\s*:\s*['"]?(.+?)['"]?\s*$/);
      if (summaryMatch) currentSummary = summaryMatch[1];

      // Description
      const descMatch = line.match(/^\s{6}description\s*:\s*['"]?(.+?)['"]?\s*$/);
      if (descMatch) currentDescription = descMatch[1];

      // Tags
      const tagMatch = line.match(/^\s{8}-\s*['"]?(.+?)['"]?\s*$/);
      if (tagMatch && i > 0 && /^\s{6}tags\s*:/.test(lines[i - 1] || '')) {
        currentTags.push(tagMatch[1]);
      }
      // Also handle inline tag after "tags:" line
      if (/^\s{6}tags\s*:/.test(line)) {
        // Look ahead for tag items
        for (let j = i + 1; j < lines.length && /^\s{8}-/.test(lines[j]); j++) {
          const t = lines[j].match(/^\s{8}-\s*['"]?(.+?)['"]?\s*$/);
          if (t) currentTags.push(t[1]);
        }
      }
    }

    byteOffset += lineBytes;
  }

  // Flush last operation
  if (currentPath && currentMethod) {
    operations.push({
      method: currentMethod.toUpperCase(),
      path: currentPath,
      summary: currentSummary,
      description: currentDescription,
      tags: currentTags.length > 0 ? currentTags : ['default'],
      byteStart: opStart,
      byteEnd: byteOffset,
    });
  }

  return operations;
}

function parseJSONOperations(content: string): OpenAPIOperation[] {
  const operations: OpenAPIOperation[] = [];
  try {
    const spec = JSON.parse(content);
    const paths = spec.paths || {};
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

    for (const [pathStr, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of methods) {
        const op = (pathItem as any)[method];
        if (!op) continue;
        operations.push({
          method: method.toUpperCase(),
          path: pathStr,
          summary: op.summary || '',
          description: op.description || '',
          tags: Array.isArray(op.tags) ? op.tags : ['default'],
          byteStart: 0,
          byteEnd: contentBytes,
        });
      }
    }
  } catch { /* invalid JSON */ }
  return operations;
}

function buildSections(operations: OpenAPIOperation[], content: string): ParsedSection[] {
  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (operations.length === 0) {
    return [{
      title: '(API spec)',
      level: 0,
      byteStart: 0,
      byteEnd: contentBytes,
      content,
      children: [],
    }];
  }

  // Group by tag
  const byTag = new Map<string, OpenAPIOperation[]>();
  for (const op of operations) {
    for (const tag of op.tags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(op);
    }
  }

  const root: ParsedSection[] = [];
  for (const [tag, ops] of byTag) {
    const children: ParsedSection[] = ops.map(op => ({
      title: `${op.method} ${op.path}`,
      level: 2,
      byteStart: op.byteStart,
      byteEnd: op.byteEnd,
      content: [op.summary, op.description].filter(Boolean).join('\n') || `${op.method} ${op.path}`,
      children: [],
    }));

    root.push({
      title: tag,
      level: 1,
      byteStart: ops[0]?.byteStart ?? 0,
      byteEnd: ops[ops.length - 1]?.byteEnd ?? contentBytes,
      content: `Tag: ${tag}\n${ops.map(o => `${o.method} ${o.path}`).join('\n')}`,
      children,
    });
  }

  return root;
}

export const openapiParser: DocFormatParser = {
  name: 'openapi',
  extensions: [], // Not registered by extension — detected by content

  parse(content: string, filePath: string): ParseResult {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const operations = ext === '.json'
      ? parseJSONOperations(content)
      : parseYAMLOperations(content);

    const sections = buildSections(operations, content);
    return { sections, format: 'openapi' };
  },
};

/**
 * Check if a file is an OpenAPI spec (used by the format registry for content-based detection).
 */
export function isOpenAPI(content: string, filePath: string): boolean {
  return isOpenAPIContent(content, filePath);
}
