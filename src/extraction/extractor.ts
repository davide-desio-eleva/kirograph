/**
 * Symbol extractor using web-tree-sitter
 * Parses source files and extracts nodes + edges into the graph.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { Node, Edge, NodeKind, Language } from '../types';
import { detectLanguage, GRAMMAR_MAP, isSupportedLanguage } from './languages';

// Lazy-loaded tree-sitter
let Parser: any = null;
const loadedGrammars = new Map<string, any>();

async function getParser(): Promise<any> {
  if (Parser) return Parser;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TreeSitter = require('web-tree-sitter');
  await TreeSitter.Parser.init();
  Parser = TreeSitter;
  return Parser;
}

async function getGrammar(language: Language): Promise<any | null> {
  if (loadedGrammars.has(language)) return loadedGrammars.get(language)!;
  const grammarName = GRAMMAR_MAP[language];
  if (!grammarName) return null;

  try {
    const TS = await getParser();
    // tree-sitter-wasms stores wasm files in out/
    const wasmDir = path.join(require.resolve('tree-sitter-wasms/package.json'), '..', 'out');
    const wasmPath = path.join(wasmDir, `${grammarName}.wasm`);
    if (!fs.existsSync(wasmPath)) return null;
    const lang = await TS.Language.load(wasmPath);
    loadedGrammars.set(language, lang);
    return lang;
  } catch {
    return null;
  }
}

export interface ExtractedFile {
  filePath: string;
  language: Language;
  contentHash: string;
  fileSize: number;
  nodes: Node[];
  edges: Edge[];
}

function makeNodeId(filePath: string, kind: string, name: string, line: number): string {
  return crypto.createHash('sha1').update(`${filePath}:${kind}:${name}:${line}`).digest('hex').slice(0, 16);
}

/**
 * Extract symbols from a single file.
 */
export async function extractFile(filePath: string, projectRoot: string): Promise<ExtractedFile | null> {
  const language = detectLanguage(filePath);
  if (!isSupportedLanguage(language)) return null;

  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const contentHash = crypto.createHash('sha1').update(source).digest('hex');
  const fileSize = Buffer.byteLength(source, 'utf8');
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');

  const grammar = await getGrammar(language);
  if (!grammar) {
    // Return minimal file node even without grammar
    return {
      filePath: relPath,
      language,
      contentHash,
      fileSize,
      nodes: [],
      edges: [],
    };
  }

  const TS = await getParser();
  const parser = new TS.Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(source);

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const now = Date.now();

  // Walk the AST and extract symbols
  walkTree(tree.rootNode, source, relPath, language, nodes, edges, now);

  return { filePath: relPath, language, contentHash, fileSize, nodes, edges };
}

function walkTree(
  node: any,
  source: string,
  filePath: string,
  language: Language,
  nodes: Node[],
  edges: Edge[],
  now: number,
  parentId?: string
): void {
  // Transparent wrapper nodes — descend without creating a symbol
  const transparent = new Set(['export_statement', 'program', 'source_file', 'module', 'translation_unit']);
  if (transparent.has(node.type)) {
    for (let i = 0; i < node.childCount; i++) {
      walkTree(node.child(i), source, filePath, language, nodes, edges, now, parentId);
    }
    return;
  }

  const kind = mapNodeKind(node.type, language);
  if (kind) {
    const name = extractName(node, source, language);
    if (name) {
      const id = makeNodeId(filePath, kind, name, node.startPosition.row + 1);
      const graphNode: Node = {
        id,
        kind,
        name,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        language,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        signature: extractSignature(node, source),
        isExported: isExported(node, source),
        isAsync: isAsync(node),
        isStatic: isStatic(node),
        updatedAt: now,
      };
      nodes.push(graphNode);

      if (parentId) {
        edges.push({ source: parentId, target: id, kind: 'contains' });
      }

      // Extract call edges within this node
      extractCalls(node, source, filePath, id, edges, now);

      // Recurse into children with this node as parent
      for (let i = 0; i < node.childCount; i++) {
        walkTree(node.child(i), source, filePath, language, nodes, edges, now, id);
      }
      return;
    }
  }

  // No symbol at this node — recurse without changing parent
  for (let i = 0; i < node.childCount; i++) {
    walkTree(node.child(i), source, filePath, language, nodes, edges, now, parentId);
  }
}

function mapNodeKind(type: string, _lang: Language): NodeKind | null {
  const map: Record<string, NodeKind> = {
    // TypeScript / JavaScript
    function_declaration: 'function',
    function_expression: 'function',
    arrow_function: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    class_expression: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type_alias',
    enum_declaration: 'enum',
    // Python
    function_definition: 'function',
    class_definition: 'class',
    // Go
    function_declaration_go: 'function',
    method_declaration: 'method',
    type_declaration: 'type_alias',
    // Rust
    function_item: 'function',
    impl_item: 'class',
    struct_item: 'struct',
    trait_item: 'trait',
    enum_item: 'enum',
    // Java / C#
    constructor_declaration: 'method',
    // Generic
    module: 'module',
    namespace_declaration: 'namespace',
  };
  return map[type] ?? null;
}

function extractName(node: any, source: string, _lang: Language): string | null {
  // Look for a 'name' or 'identifier' child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'type_identifier') {
      return source.slice(child.startIndex, child.endIndex);
    }
  }
  return null;
}
function extractSignature(node: any, source: string): string | undefined {
  // Grab first line as signature approximation
  const text = source.slice(node.startIndex, node.endIndex);
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
}

function isExported(node: any, source: string): boolean {
  const text = source.slice(node.startIndex, Math.min(node.startIndex + 20, node.endIndex));
  return text.startsWith('export');
}

function isAsync(node: any): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === 'async') return true;
  }
  return false;
}

function isStatic(node: any): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === 'static') return true;
  }
  return false;
}

function extractCalls(node: any, source: string, filePath: string, sourceId: string, edges: Edge[], _now: number): void {
  // Find call_expression nodes within this node
  findCallExpressions(node, source, filePath, sourceId, edges);
}

function findCallExpressions(node: any, source: string, filePath: string, sourceId: string, edges: Edge[]): void {
  if (node.type === 'call_expression') {
    const funcNode = node.child(0);
    if (funcNode) {
      const calleeName = source.slice(funcNode.startIndex, funcNode.endIndex).split('(')[0].trim();
      if (calleeName && calleeName.length < 100) {
        // We store as unresolved — will be resolved in a later pass
        const targetId = makeNodeId(filePath, 'function', calleeName, 0);
        edges.push({
          source: sourceId,
          target: targetId,
          kind: 'calls',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    findCallExpressions(node.child(i), source, filePath, sourceId, edges);
  }
}
