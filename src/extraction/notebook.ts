/**
 * Notebook extractor for Jupyter (.ipynb) files.
 * Parses the JSON notebook format, extracts code cells, concatenates them,
 * runs the Python tree-sitter parser, and adjusts line numbers so they
 * reflect the position of each cell within the notebook.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { Node, Edge } from '../types';
import type { ExtractedFile, UnresolvedRef } from './extractor';
import { makeNodeId } from './extractor';
import { initGrammars, getParser } from './grammars';

interface NotebookCell {
  cell_type: string;
  source: string[];
}

interface NotebookMetadata {
  kernelspec?: { language?: string };
  language_info?: { name?: string };
}

interface NotebookJson {
  metadata?: NotebookMetadata;
  cells?: NotebookCell[];
}

/** Each code cell mapped to its starting line in the concatenated source */
interface CellOffset {
  /** 1-based starting line of this cell in the concatenated code string */
  startLine: number;
}

/**
 * Extract symbols from a Jupyter notebook file.
 * Concatenates all code cells, parses with the Python grammar,
 * and adjusts node line numbers to match cell positions.
 */
export async function extractNotebook(
  filePath: string,
  projectRoot: string,
  content?: Buffer | string
): Promise<ExtractedFile | null> {
  let raw: string;
  try {
    if (content !== undefined) {
      raw = typeof content === 'string' ? content : content.toString('utf8');
    } else {
      raw = fs.readFileSync(filePath, 'utf8');
    }
  } catch {
    return null;
  }

  const contentHash = crypto.createHash('sha256').update(raw).digest('hex');
  const fileSize = Buffer.byteLength(raw, 'utf8');
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');

  let notebook: NotebookJson;
  try {
    notebook = JSON.parse(raw);
  } catch {
    // Not valid JSON — return file tracked with no symbols
    return { filePath: relPath, language: 'jupyter', contentHash, fileSize, nodes: [], edges: [], unresolvedRefs: [] };
  }

  const cells: NotebookCell[] = notebook.cells ?? [];
  const codeCells = cells.filter((c) => c.cell_type === 'code');

  if (codeCells.length === 0) {
    return { filePath: relPath, language: 'jupyter', contentHash, fileSize, nodes: [], edges: [], unresolvedRefs: [] };
  }

  // Build concatenated source and track the starting line of each cell
  const cellOffsets: CellOffset[] = [];
  const codeChunks: string[] = [];
  let currentLine = 1; // 1-based

  for (let i = 0; i < codeCells.length; i++) {
    const cell = codeCells[i];
    const cellSource = (cell.source ?? []).join('');
    // Ensure each cell ends with a newline so cells don't bleed into each other
    const cellCode = cellSource.endsWith('\n') ? cellSource : cellSource + '\n';
    cellOffsets.push({ startLine: currentLine });
    codeChunks.push(cellCode);
    // Number of lines contributed by this cell's code
    const cellLineCount = cellCode.split('\n').length - 1; // trailing \n creates empty last entry
    // Advance by cell lines; join('\n') adds one extra separator line between cells
    currentLine += cellLineCount + (i < codeCells.length - 1 ? 1 : 0);
  }

  const concatenated = codeChunks.join('\n');

  // Load Python parser and parse concatenated source
  await initGrammars();
  const parser = await getParser('python');
  if (!parser) {
    // Python grammar unavailable — return file node with no symbols
    return { filePath: relPath, language: 'jupyter', contentHash, fileSize, nodes: [], edges: [], unresolvedRefs: [] };
  }

  const tree = parser.parse(concatenated);

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];
  const now = Date.now();

  // We reuse the same AST walking logic from extractor.ts but with 'python' language.
  // Import walkTree-equivalent logic inline to avoid circular imports by using the
  // exported makeNodeId and reimporting the walk from extractor indirectly.
  // Instead, we call extractFile on the concatenated source as a virtual Python file
  // and then remap file paths and languages back.
  //
  // To avoid code duplication we use a direct re-export path: import the internal
  // walkTree equivalent by parsing via a private helper below.

  walkPythonTree(tree.rootNode, concatenated, relPath, nodes, edges, unresolvedRefs, now, cellOffsets, codeChunks);

  return { filePath: relPath, language: 'jupyter', contentHash, fileSize, nodes, edges, unresolvedRefs };
}

// ── Transparent node types (same as extractor.ts) ────────────────────────────

const TRANSPARENT_TYPES = new Set([
  'export_statement', 'program', 'source_file', 'module', 'translation_unit',
]);

// ── Import node types relevant to Python ─────────────────────────────────────

const PYTHON_IMPORT_TYPES = new Set([
  'import_statement',
  'import_from_statement',
]);

// ── KIND_MAP subset for Python ────────────────────────────────────────────────

type NodeKindLocal = Node['kind'];

const PYTHON_KIND_MAP: Record<string, NodeKindLocal> = {
  function_definition: 'function',
  class_definition: 'class',
  assignment: 'variable',
};

// ── CALL_NODE_TYPES for Python ────────────────────────────────────────────────

const CALL_NODE_TYPES = new Set(['call']);

// ── Line offset helper ────────────────────────────────────────────────────────

/**
 * Given a 1-based line number within the concatenated source, return the
 * corrected 1-based line number relative to the notebook.
 *
 * The concatenated source is built as:
 *   cell[0]\n cell[1]\n cell[2]\n ...
 * where cell[i] starts at cellOffsets[i].startLine (1-based) within the concatenation.
 *
 * Each cell chunk in codeChunks already ends with \n; cells are separated by an
 * extra \n (the join('\n') adds one extra newline between chunks).
 *
 * We build a lookup of the absolute start lines in the concatenated string by
 * re-counting: cell 0 starts at line 1; cell 1 starts at line (lines-in-cell-0 + 1 + 1),
 * etc. (The +1 accounts for the join separator).
 *
 * For simplicity we use the pre-computed cellOffsets directly — they track the
 * cumulative line position in the concatenated string at each cell boundary.
 */
function remapLine(lineInConcat: number, cellOffsets: CellOffset[], codeChunks: string[]): number {
  // cellOffsets[i].startLine is the 1-based line of cell i in the concatenated string
  // (built with join('\n') which adds +1 separator line between cells).
  // We need to find which cell this line belongs to.
  //
  // Rebuild absolute offsets accounting for the '\n' separator added by join:
  // cell 0: lines [offset0, offset0 + cellLines0 - 1]
  // separator line: offset0 + cellLines0
  // cell 1: offset0 + cellLines0 + 1
  // etc.
  //
  // cellOffsets already accounts for this (built with currentLine += cellLines + 1
  // because codeChunks.join('\n') adds a newline between chunks).

  let cellIdx = 0;
  for (let i = cellOffsets.length - 1; i >= 0; i--) {
    if (lineInConcat >= cellOffsets[i].startLine) {
      cellIdx = i;
      break;
    }
  }
  // Position within the cell (0-based)
  const posInCell = lineInConcat - cellOffsets[cellIdx].startLine;
  // Return 1-based position within notebook (cell starts at cellOffsets[cellIdx].startLine
  // which IS the 1-based line in the notebook for cell 0 = line 1)
  return cellOffsets[cellIdx].startLine + posInCell;
}

// ── Python-specific AST walker ────────────────────────────────────────────────

function walkPythonTree(
  node: any,
  source: string,
  filePath: string,
  nodes: Node[],
  edges: Edge[],
  unresolvedRefs: UnresolvedRef[],
  now: number,
  cellOffsets: CellOffset[],
  codeChunks: string[],
  parentId?: string
): void {
  if (TRANSPARENT_TYPES.has(node.type)) {
    for (let i = 0; i < node.childCount; i++) {
      walkPythonTree(node.child(i), source, filePath, nodes, edges, unresolvedRefs, now, cellOffsets, codeChunks, parentId);
    }
    return;
  }

  if (PYTHON_IMPORT_TYPES.has(node.type)) {
    const modulePath = extractPythonImportSource(node, source);
    if (modulePath) {
      const rawLine = node.startPosition.row + 1;
      const line = remapLine(rawLine, cellOffsets, codeChunks);
      const id = makeNodeId(filePath, 'import', modulePath, line);
      nodes.push({
        id,
        kind: 'import',
        name: modulePath,
        qualifiedName: `${filePath}::import:${modulePath}`,
        filePath,
        language: 'jupyter',
        startLine: line,
        endLine: remapLine(node.endPosition.row + 1, cellOffsets, codeChunks),
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        updatedAt: now,
      });
      unresolvedRefs.push({ sourceId: id, refName: modulePath, refKind: 'import', line, column: node.startPosition.column });
    }
    return;
  }

  let kind: NodeKindLocal | null = PYTHON_KIND_MAP[node.type] ?? null;

  if (kind) {
    const name = extractPythonName(node, source, kind);
    if (name) {
      const rawStartLine = node.startPosition.row + 1;
      const rawEndLine = node.endPosition.row + 1;
      const startLine = remapLine(rawStartLine, cellOffsets, codeChunks);
      const endLine = remapLine(rawEndLine, cellOffsets, codeChunks);
      const id = makeNodeId(filePath, kind, name, startLine);
      const visibility = extractPythonVisibility(name);

      const graphNode: Node = {
        id,
        kind,
        name,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        language: 'jupyter',
        startLine,
        endLine,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        docstring: extractPythonDocstring(node, source),
        signature: extractPythonSignature(node, source, kind),
        visibility,
        isExported: false,
        updatedAt: now,
      };
      nodes.push(graphNode);

      if (parentId) {
        edges.push({ source: parentId, target: id, kind: 'contains' });
      }

      collectPythonCallRefs(node, source, id, unresolvedRefs, cellOffsets, codeChunks);

      for (let i = 0; i < node.childCount; i++) {
        walkPythonTree(node.child(i), source, filePath, nodes, edges, unresolvedRefs, now, cellOffsets, codeChunks, id);
      }
      return;
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkPythonTree(node.child(i), source, filePath, nodes, edges, unresolvedRefs, now, cellOffsets, codeChunks, parentId);
  }
}

// ── Python helpers ────────────────────────────────────────────────────────────

function extractPythonImportSource(node: any, source: string): string | null {
  if (node.type === 'import_from_statement') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'dotted_name' || child.type === 'relative_import') {
        return source.slice(child.startIndex, child.endIndex);
      }
    }
  }
  if (node.type === 'import_statement') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'dotted_name') {
        return source.slice(child.startIndex, child.endIndex);
      }
    }
  }
  return null;
}

function extractPythonName(node: any, source: string, kind: NodeKindLocal): string | null {
  if (kind === 'variable' && node.type === 'assignment') {
    const left = node.child(0);
    if (left && left.type === 'identifier') {
      return source.slice(left.startIndex, left.endIndex);
    }
    return null;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier') {
      return source.slice(child.startIndex, child.endIndex);
    }
  }
  return null;
}

function extractPythonVisibility(name: string): Node['visibility'] {
  if (name.startsWith('__')) return 'private';
  if (name.startsWith('_')) return 'protected';
  return 'public';
}

function extractPythonDocstring(node: any, source: string): string | undefined {
  const commentTypes = new Set(['comment']);
  const commentLines: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling && commentTypes.has(sibling.type)) {
    commentLines.unshift(source.slice(sibling.startIndex, sibling.endIndex));
    sibling = sibling.previousNamedSibling;
  }
  if (commentLines.length === 0) return undefined;
  const cleaned = commentLines.join('\n').replace(/^#\s?/gm, '').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function extractPythonSignature(node: any, source: string, kind: NodeKindLocal): string | undefined {
  if (kind === 'function' || kind === 'method') {
    const text = source.slice(node.startIndex, node.endIndex);
    const bodyStart = text.search(/\s*:\s*\n/);
    const header = bodyStart > 0 ? text.slice(0, bodyStart).trim() : text.split('\n')[0].trim();
    return header.length > 150 ? header.slice(0, 150) + '…' : header || undefined;
  }
  const text = source.slice(node.startIndex, node.endIndex);
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine || undefined;
}

function collectPythonCallRefs(
  node: any,
  source: string,
  sourceId: string,
  unresolvedRefs: UnresolvedRef[],
  cellOffsets: CellOffset[],
  codeChunks: string[]
): void {
  walkForPythonCalls(node, source, sourceId, unresolvedRefs, cellOffsets, codeChunks);
}

function walkForPythonCalls(
  node: any,
  source: string,
  sourceId: string,
  unresolvedRefs: UnresolvedRef[],
  cellOffsets: CellOffset[],
  codeChunks: string[]
): void {
  if (CALL_NODE_TYPES.has(node.type)) {
    const calleeName = extractPythonCallName(node, source);
    if (calleeName) {
      const rawLine = node.startPosition.row + 1;
      const line = remapLine(rawLine, cellOffsets, codeChunks);
      unresolvedRefs.push({
        sourceId,
        refName: calleeName,
        refKind: 'function',
        line,
        column: node.startPosition.column,
      });
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    walkForPythonCalls(node.child(i), source, sourceId, unresolvedRefs, cellOffsets, codeChunks);
  }
}

function extractPythonCallName(node: any, source: string): string | null {
  for (const field of ['function', 'method']) {
    const f = node.childForFieldName?.(field);
    if (f) {
      const t = f.type;
      if (t === 'identifier' || t === 'name') {
        const text = source.slice(f.startIndex, f.endIndex).trim();
        if (text && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(text)) return text;
      }
    }
  }
  const funcNode = node.child(0);
  if (funcNode) {
    const rawName = source.slice(funcNode.startIndex, funcNode.endIndex).split('(')[0].trim();
    if (rawName && rawName.length < 100) {
      const calleeName = rawName.split('.').pop()!.trim();
      if (calleeName && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(calleeName)) return calleeName;
    }
  }
  return null;
}
