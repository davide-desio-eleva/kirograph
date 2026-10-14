/**
 * Symbol extractor using web-tree-sitter
 * Parses source files and extracts nodes + edges into the graph.
 * Handles functions, classes, methods, variables, constants, and imports.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { Node, Edge, NodeKind, Language } from '../types';
import { detectLanguage, isSupportedLanguage } from './languages';
import { initGrammars, getParser, hasWasmGrammar } from './grammars';
import { extractNotebook } from './notebook';
import { extractRoutes, JS_TS_LANGUAGES, type RouteMount } from './routes';

export interface UnresolvedRef {
  sourceId: string;
  refName: string;
  refKind: 'function' | 'import' | 'extends' | 'implements';
  line: number;
  column: number;
  /** Call-site facts the detectors need later, e.g. how the first argument was built. */
  metadata?: Record<string, unknown>;
}

/**
 * A `register(target, { prefix })` call. `specifier` is the module the plugin comes from (null
 * when it is declared in the same file); `importedName` is its export name, which differs from
 * `pluginName` under an alias. An inline plugin carries its function's line span instead.
 */
export interface RouteMountFact {
  pluginName: string;
  importedName: string | null;
  specifier: string | null;
  prefix: string;
  line: number;
  inlineStart?: number;
  inlineEnd?: number;
}

export interface ExtractedFile {
  filePath: string;
  language: Language;
  contentHash: string;
  fileSize: number;
  nodes: Node[];
  edges: Edge[];
  unresolvedRefs: UnresolvedRef[];
  routeMounts?: RouteMountFact[];
}

export function makeNodeId(filePath: string, kind: string, name: string, line: number): string {
  const hash = crypto.createHash('sha256').update(`${filePath}:${kind}:${name}:${line}`).digest('hex').slice(0, 32);
  return `${kind}:${hash}`;
}

/** Validate that filePath stays within projectRoot to prevent path traversal. */
function validatePath(filePath: string, projectRoot: string): boolean {
  try {
    const real = fs.realpathSync(filePath);
    const realRoot = fs.realpathSync(projectRoot);
    return real.startsWith(realRoot + path.sep) || real === realRoot;
  } catch {
    // If we can't resolve, check with normalize
    const normalized = path.resolve(filePath);
    return normalized.startsWith(path.resolve(projectRoot));
  }
}

/**
 * Extract symbols from a single file.
 * Optionally accepts pre-read content for batch I/O efficiency.
 */
export async function extractFile(filePath: string, projectRoot: string, content?: Buffer | string, opts?: { enableComplexity?: boolean; maxFileSize?: number }): Promise<ExtractedFile | null> {
  const language = detectLanguage(filePath);
  if (!isSupportedLanguage(language)) return null;

  // Path traversal protection
  if (!validatePath(filePath, projectRoot)) return null;

  let source: string;
  try {
    if (content !== undefined) {
      source = typeof content === 'string' ? content : content.toString('utf8');
    } else {
      source = fs.readFileSync(filePath, 'utf8');
    }
  } catch {
    return null;
  }

  // Defensive size guard (issue #33): even though the scanner enforces
  // maxFileSize via fs.stat, some callers (e.g. git-changed-file sync) bypass
  // the scanner and hand paths straight here. A multi-MB file handed to the
  // tree-sitter WASM parser can abort the entire process, so skip oversized
  // files before parsing. We return the file as tracked-but-unparsed (empty
  // symbols) rather than null so it's still recorded, not silently dropped.
  if (opts?.maxFileSize !== undefined && Buffer.byteLength(source, 'utf8') > opts.maxFileSize) {
    const relPathSkip = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    return {
      filePath: relPathSkip,
      language,
      contentHash: crypto.createHash('sha256').update(source).digest('hex'),
      fileSize: Buffer.byteLength(source, 'utf8'),
      nodes: [],
      edges: [],
      unresolvedRefs: [],
    };
  }

  // Delegate Jupyter notebooks to the dedicated notebook extractor
  if (language === 'jupyter') {
    return extractNotebook(filePath, projectRoot, source);
  }

  const contentHash = crypto.createHash('sha256').update(source).digest('hex');
  const fileSize = Buffer.byteLength(source, 'utf8');
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');

  await initGrammars();
  const parser = await getParser(language);
  if (!parser) {
    if (!hasWasmGrammar(language)) {
      // Language genuinely has no grammar (e.g. Liquid, unknown) — track file but no AST extraction
      return {
        filePath: relPath,
        language,
        contentHash,
        fileSize,
        nodes: [],
        edges: [],
        unresolvedRefs: [],
      };
    }
    // Grammar should exist but parser failed (likely WASM crash) — signal extraction failure
    throw new Error(`Parser unavailable for ${language} (WASM grammar exists but failed to load)`);
  }

  // web-tree-sitter allocates Parser/Tree state in WASM linear memory, which JS GC
  // does not reclaim — both must be explicitly .delete()'d once we're done with them
  // (issue #49), otherwise long `sync` runs across many files leak memory and hang.
  let tree: any;
  try {
    // Skip Go template files disguised as YAML (e.g. Helm templates).
    // tree-sitter-yaml crashes with "memory access out of bounds" on {{ }} syntax.
    // These files produce valid YAML only after Helm renders them — raw they're not parseable.
    if (language === 'yaml' && source.includes('{{')) {
      return {
        filePath: relPath,
        language,
        contentHash,
        fileSize,
        nodes: [],
        edges: [],
        unresolvedRefs: [],
      };
    }

    // Wrap parser.parse() to catch WASM runtime crashes (e.g. memory access out of bounds
    // on malformed files like Helm Go templates in .yaml). Skip the file gracefully instead
    // of letting the crash propagate and poison the entire language.
    try {
      tree = parser.parse(source);
    } catch (parseErr: any) {
      const parseMsg = parseErr?.message ?? String(parseErr);
      const isWasmCrash = parseErr?.constructor?.name === 'RuntimeError'
        || parseMsg.includes('memory access out of bounds')
        || parseMsg.includes('Aborted(');
      if (isWasmCrash) {
        // Individual file crashed the WASM parser — skip this file, return empty nodes.
        // The next file in this language may parse fine.
        return {
          filePath: relPath,
          language,
          contentHash,
          fileSize,
          nodes: [],
          edges: [],
          unresolvedRefs: [],
        };
      }
      throw parseErr; // Re-throw non-WASM errors
    }

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const unresolvedRefs: UnresolvedRef[] = [];
    const now = Date.now();

    walkTree(tree.rootNode, source, relPath, language, nodes, edges, unresolvedRefs, now);

    let routeMounts: RouteMountFact[] | undefined;
    if (JS_TS_LANGUAGES.has(language)) {
      const imports = collectImportBindings(tree.rootNode, source, relPath, language);

      // HTTP routes (Express/Fastify/...): route nodes plus route → handler references
      const routes = extractRoutes(tree.rootNode, source, relPath, now,
        (handler, routeId, refs) => walkForCalls(handler, source, routeId, refs, language));
      nodes.push(...routes.nodes);
      unresolvedRefs.push(...routes.refs);
      routeMounts = routes.mounts.map(m => toMountFact(m, imports));

      // Code that uses a package binding points at that import, so the security pass can
      // turn the usage into a dependency reference
      linkImportBindings(imports, edges, unresolvedRefs);
    }

    // Complexity post-processing: compute metrics for function/method nodes when enabled.
    if (opts?.enableComplexity) {
      const sourceLines = source.split('\n');
      for (const n of nodes) {
        if (n.kind !== 'function' && n.kind !== 'method') continue;
        const fnSource = sourceLines.slice(n.startLine - 1, n.endLine).join('\n');
        const cc = computeTextCyclomaticComplexity(fnSource);
        const depth = computeTextNestingDepth(fnSource);
        const loc = n.endLine - n.startLine + 1;
        const tokens = fnSource.match(/\b\w+\b|[+\-*/=<>!&|^~%]+|[(){}[\],;.]/g) ?? [];
        const volume = tokens.length > 0 && tokens.length > 1
          ? tokens.length * Math.log2(new Set(tokens).size || 1)
          : 0;
        const mi = Math.max(0, Math.min(100,
          171 - 5.2 * Math.log(Math.max(1, volume)) - 0.23 * cc - 16.2 * Math.log(Math.max(1, loc))
        ));
        n.complexityCyclomatic = cc;
        n.nestingDepth = depth;
        n.maintainabilityIndex = Math.round(mi * 10) / 10;
      }
    }

    return { filePath: relPath, language, contentHash, fileSize, nodes, edges, unresolvedRefs, routeMounts };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

// ── Elixir helpers ────────────────────────────────────────────────────────────

const ELIXIR_DEF_KINDS: Record<string, NodeKind> = {
  defmodule: 'module',
  def: 'function',
  defp: 'function',
  defmacro: 'function',
  defmacrop: 'function',
  defprotocol: 'interface',
  defimpl: 'class',
  defstruct: 'struct',
};

const ELIXIR_IMPORT_TARGETS = new Set(['alias', 'import', 'require', 'use']);

function elixirCallTarget(node: any, source: string): string | null {
  const target = node.childForFieldName?.('target') ?? node.child(0);
  if (!target) return null;
  return source.slice(target.startIndex, target.endIndex).trim() || null;
}

function elixirFirstArg(node: any): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'arguments') {
      return child.namedChild(0) ?? child.child(0) ?? null;
    }
  }
  return null;
}

function extractElixirName(node: any, source: string, kind: NodeKind): string | null {
  const firstArg = elixirFirstArg(node);
  if (!firstArg) return null;
  if (kind === 'module' || kind === 'interface' || kind === 'class') {
    return source.slice(firstArg.startIndex, firstArg.endIndex).trim();
  }
  if (kind === 'function') {
    if (firstArg.type === 'call') {
      const nameNode = firstArg.childForFieldName?.('target') ?? firstArg.child(0);
      if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex).trim();
    }
    return source.slice(firstArg.startIndex, firstArg.endIndex).trim();
  }
  return null;
}

function extractElixirImportSource(node: any, source: string): string | null {
  const firstArg = elixirFirstArg(node);
  if (!firstArg) return null;
  return source.slice(firstArg.startIndex, firstArg.endIndex).trim() || null;
}

function walkElixirCall(
  node: any,
  source: string,
  filePath: string,
  language: Language,
  nodes: Node[],
  edges: Edge[],
  unresolvedRefs: UnresolvedRef[],
  now: number,
  parentId?: string
): void {
  const targetText = elixirCallTarget(node, source);
  if (!targetText) {
    for (let i = 0; i < node.childCount; i++) {
      walkTree(node.child(i), source, filePath, language, nodes, edges, unresolvedRefs, now, parentId);
    }
    return;
  }

  if (ELIXIR_IMPORT_TARGETS.has(targetText)) {
    const modPath = extractElixirImportSource(node, source);
    if (modPath) {
      const id = makeNodeId(filePath, 'import', modPath, node.startPosition.row + 1);
      nodes.push({
        id, kind: 'import', name: modPath,
        qualifiedName: `${filePath}::import:${modPath}`,
        filePath, language,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        updatedAt: now,
      });
      unresolvedRefs.push({ sourceId: id, refName: modPath, refKind: 'import', line: node.startPosition.row + 1, column: node.startPosition.column });
    }
    return;
  }

  const defKind = ELIXIR_DEF_KINDS[targetText];
  if (defKind) {
    const name = extractElixirName(node, source, defKind);
    if (name) {
      const id = makeNodeId(filePath, defKind, name, node.startPosition.row + 1);
      const isPrivate = targetText === 'defp' || targetText === 'defmacrop';
      nodes.push({
        id, kind: defKind, name,
        qualifiedName: `${filePath}::${name}`,
        filePath, language,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
        docstring: extractDocstring(node, source),
        signature: extractSignature(node, source, defKind),
        visibility: isPrivate ? 'private' : 'public',
        isExported: !isPrivate,
        updatedAt: now,
      });
      if (parentId) edges.push({ source: parentId, target: id, kind: 'contains' });
      collectCallRefs(node, source, id, unresolvedRefs, language);
      for (let i = 0; i < node.childCount; i++) {
        walkTree(node.child(i), source, filePath, language, nodes, edges, unresolvedRefs, now, id);
      }
      return;
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    walkTree(node.child(i), source, filePath, language, nodes, edges, unresolvedRefs, now, parentId);
  }
}

// ── Node type mappings ────────────────────────────────────────────────────────

/** AST node types that should be descended without creating a symbol node */
const TRANSPARENT_TYPES = new Set([
  'export_statement', 'program', 'source_file', 'module', 'translation_unit',
  'chunk', // Lua root node type
]);

/** Mapping from tree-sitter node types to graph NodeKind */
const KIND_MAP: Record<string, NodeKind> = {
  // Functions
  function_declaration: 'function',
  function_expression: 'function',
  arrow_function: 'function',
  function_definition: 'function',    // Python, Scala
  function_item: 'function',          // Rust
  function_declaration_go: 'function',
  // Methods
  method_definition: 'method',
  method_declaration: 'method',       // Go, Java, C#
  constructor_declaration: 'method',  // Java, C#
  // Classes / structs
  class_declaration: 'class',
  abstract_class_declaration: 'class', // TypeScript `abstract class` (distinct AST node from class_declaration)
  class_expression: 'class',
  class_definition: 'class',          // Python, Scala
  impl_item: 'class',                 // Rust (impl blocks)
  struct_item: 'struct',              // Rust
  struct_definition: 'struct',        // Zig
  // Interfaces / traits
  interface_declaration: 'interface',
  trait_item: 'trait',                // Rust
  trait_definition: 'trait',          // Scala
  protocol_declaration: 'interface',  // Swift
  // Enums
  enum_declaration: 'enum',
  enum_item: 'enum',                  // Rust
  // Type aliases
  type_alias_declaration: 'type_alias',
  type_declaration: 'type_alias',     // Go
  typealias_declaration: 'type_alias',// Swift
  type_item: 'type_alias',            // Rust
  type_alias: 'type_alias',           // Kotlin
  // Namespaces / modules
  namespace_declaration: 'namespace',
  module_definition: 'namespace',     // OCaml
  // Variables / constants (language-specific, see extractVariableKind)
  lexical_declaration: 'variable',    // TS/JS (const/let/var) — refined below
  variable_declaration: 'variable',   // TS/JS (var)
  // Ruby
  method: 'method',            // Ruby def (top-level and in class body)
  class: 'class',              // Ruby class
  // Lua
  local_function_definition_statement: 'function',
  function_definition_statement: 'function',
  // Import statements (all handled via extractImport)
};

/** Refine variable declarations into 'variable' or 'constant' based on modifier */
function extractVariableKind(node: any): NodeKind {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'const') return 'constant';
  }
  return 'variable';
}

/**
 * Widget superclass names that mark a Dart class as a UI component.
 * `State<Foo>` subclasses are kept as 'class' — they are state holders, not widgets.
 */
const DART_WIDGET_SUPERCLASSES = new Set([
  'StatelessWidget',
  'StatefulWidget',
  'HookWidget',
  'ConsumerWidget',
  'ConsumerStatefulWidget',
]);

/**
 * Inspect a Dart class_definition node's superclass clause to decide if the
 * class is a widget component or a plain class.
 *
 * Dart tree-sitter grammar: class_definition → superclass → type_identifier
 * We look for any child/grandchild whose text is one of the known widget base classes.
 */
function refineDartClassKind(node: any, source: string): NodeKind {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'superclass') {
      // Walk all descendants of the superclass clause looking for a type_identifier
      const superText = source.slice(child.startIndex, child.endIndex);
      // Quick string check first for performance
      if (DART_WIDGET_SUPERCLASSES.has(superText.replace(/^extends\s+/, '').trim())) {
        return 'component';
      }
      // Drill into children to find the exact type_identifier
      for (let j = 0; j < child.childCount; j++) {
        const typeNode = child.child(j);
        if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier') {
          const name = source.slice(typeNode.startIndex, typeNode.endIndex).trim();
          if (DART_WIDGET_SUPERCLASSES.has(name)) return 'component';
          // Also match any name that ends with "Widget" (catches custom base widgets)
          if (name.endsWith('Widget') && name !== 'State') return 'component';
        }
      }
    }
  }
  return 'class';
}

/** Languages/node-types that represent import statements */
const IMPORT_NODE_TYPES = new Set([
  'import_statement',         // TS/JS
  'import_from_statement',    // Python
  'import_declaration',       // Go, Java
  'use_declaration',          // Rust
  'using_directive',          // C#
  'namespace_use_declaration',// PHP
  'import_header',            // Kotlin
  'import_or_export',         // Dart
  'include_statement',        // Pascal
  'preproc_include',          // C/C++
]);

// ── Main tree walker ──────────────────────────────────────────────────────────

function walkTree(
  node: any,
  source: string,
  filePath: string,
  language: Language,
  nodes: Node[],
  edges: Edge[],
  unresolvedRefs: UnresolvedRef[],
  now: number,
  parentId?: string
): void {
  if (TRANSPARENT_TYPES.has(node.type)) {
    for (let i = 0; i < node.childCount; i++) {
      walkTree(node.child(i), source, filePath, language, nodes, edges, unresolvedRefs, now, parentId);
    }
    return;
  }

  // Elixir: all definitions and imports are `call` nodes
  if (language === 'elixir' && node.type === 'call') {
    walkElixirCall(node, source, filePath, language, nodes, edges, unresolvedRefs, now, parentId);
    return;
  }

  // Handle import statements
  if (IMPORT_NODE_TYPES.has(node.type)) {
    const importNode = extractImport(node, source, filePath, language, unresolvedRefs, now, parentId);
    if (importNode) nodes.push(importNode);
    return; // Don't recurse into import nodes
  }

  let kind: NodeKind | null = KIND_MAP[node.type] ?? null;

  // Refine lexical_declaration into variable/constant
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    kind = extractVariableKind(node);
  }

  // Python/Go/Rust/Java/C# variable and constant types
  if (!kind) kind = getLanguageSpecificKind(node.type, language);

  // Dart: refine class_definition kind based on superclass (Widget → component)
  if (language === 'dart' && node.type === 'class_definition' && kind === 'class') {
    kind = refineDartClassKind(node, source);
  }

  if (kind) {
    const name = extractName(node, source, language, kind);
    if (name) {
      const id = makeNodeId(filePath, kind, name, node.startPosition.row + 1);
      const visibility = extractVisibility(node, source, language);
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
        docstring: extractDocstring(node, source),
        signature: extractSignature(node, source, kind),
        visibility,
        isExported: isExported(node),
        isAsync: isAsync(node),
        isStatic: isStatic(node),
        isAbstract: isAbstract(node),
        updatedAt: now,
      };
      nodes.push(graphNode);

      if (parentId) {
        edges.push({ source: parentId, target: id, kind: 'contains' });
      }

      // Collect call references within this symbol
      collectCallRefs(node, source, id, unresolvedRefs, language);

      // Extract inheritance edges for C# and Java class/interface nodes
      if ((kind === 'class' || kind === 'interface') && (language === 'csharp' || language === 'java')) {
        extractInheritance(node, source, language, id, unresolvedRefs);
      }

      // Recurse with this node as parent
      for (let i = 0; i < node.childCount; i++) {
        walkTree(node.child(i), source, filePath, language, nodes, edges, unresolvedRefs, now, id);
      }
      return;
    }
  }

  // No symbol — recurse without changing parent
  for (let i = 0; i < node.childCount; i++) {
    walkTree(node.child(i), source, filePath, language, nodes, edges, unresolvedRefs, now, parentId);
  }
}

// ── Language-specific node kinds ──────────────────────────────────────────────

function getLanguageSpecificKind(type: string, lang: Language): NodeKind | null {
  switch (lang) {
    case 'python':
      if (type === 'assignment') return 'variable';
      break;
    case 'go':
      if (type === 'var_declaration' || type === 'short_var_declaration') return 'variable';
      if (type === 'const_declaration') return 'constant';
      if (type === 'type_spec') return 'type_alias';
      break;
    case 'rust':
      if (type === 'let_declaration') return 'variable';
      if (type === 'const_item') return 'constant';
      if (type === 'static_item') return 'variable';
      break;
    case 'java':
      if (type === 'field_declaration') return 'property';
      if (type === 'local_variable_declaration') return 'variable';
      break;
    case 'csharp':
      if (type === 'field_declaration') return 'property';
      break;
    case 'php':
      if (type === 'property_declaration') return 'property';
      if (type === 'const_declaration') return 'constant';
      break;
    case 'kotlin':
      if (type === 'property_declaration') return 'variable';
      break;
    case 'swift':
      if (type === 'property_declaration') return 'property';
      if (type === 'constant_declaration') return 'constant';
      break;
    case 'dart':
      if (type === 'function_signature') return 'function';
      if (type === 'method_signature') return 'method';
      break;
    case 'ruby':
      if (type === 'singleton_method') return 'method';
      break;
    case 'scala':
      if (type === 'object_definition') return 'class';
      if (type === 'val_definition') return 'variable';
      if (type === 'var_definition') return 'variable';
      if (type === 'type_definition') return 'type_alias';
      break;
    case 'lua':
      if (type === 'local_function') return 'function';
      if (type === 'local_variable_declaration') return 'variable';
      if (type === 'variable_assignment') return 'variable';
      break;
    case 'zig':
      if (type === 'VarDecl') return 'variable';
      if (type === 'ContainerDecl') return 'struct';
      break;
    case 'bash':
      if (type === 'variable_assignment') return 'variable';
      break;
    case 'ocaml':
      if (type === 'let_binding') return 'variable';
      if (type === 'type_binding') return 'type_alias';
      if (type === 'module_binding') return 'namespace';
      break;
    case 'elm':
      if (type === 'function_declaration_left') return 'function';
      if (type === 'type_alias_declaration') return 'type_alias';
      break;
    case 'solidity':
      if (type === 'contract_declaration') return 'class';
      if (type === 'event_definition') return 'function';
      if (type === 'modifier_definition') return 'function';
      if (type === 'state_variable_declaration') return 'variable';
      break;
    case 'objc':
      if (type === 'class_interface') return 'class';
      if (type === 'class_implementation') return 'class';
      if (type === 'protocol_declaration') return 'interface';
      if (type === 'method_declaration') return 'method';
      if (type === 'property_declaration') return 'property';
      break;
    case 'hcl':
      if (type === 'block') return 'namespace';
      if (type === 'attribute') return 'variable';
      break;
    case 'scss':
      if (type === 'mixin_statement') return 'function';
      if (type === 'function_statement') return 'function';
      if (type === 'variable_declaration') return 'variable';
      if (type === 'include_statement') return 'import';
      if (type === 'use_statement') return 'import';
      if (type === 'forward_statement') return 'import';
      if (type === 'placeholder') return 'class';
      break;
    case 'css':
      if (type === 'rule_set') return 'class';
      if (type === 'declaration') return 'variable';
      break;
    case 'rescript':
      if (type === 'let_binding') return 'function';
      if (type === 'type_definition') return 'type_alias';
      if (type === 'module_declaration') return 'module';
      break;
    case 'sql':
      if (type === 'create_function_statement') return 'function';
      if (type === 'create_table_statement') return 'class';
      if (type === 'create_view_statement') return 'function';
      if (type === 'create_procedure_statement') return 'function';
      break;
    case 'r':
      if (type === 'function_definition') return 'function';
      if (type === 'left_assignment') return 'variable';
      break;
    case 'julia':
      if (type === 'function_definition') return 'function';
      if (type === 'struct_definition') return 'struct';
      if (type === 'module_definition') return 'module';
      if (type === 'macro_definition') return 'function';
      break;
    case 'powershell':
      if (type === 'function_statement') return 'function';
      if (type === 'class_statement') return 'class';
      break;
    case 'perl':
      if (type === 'subroutine_declaration_statement') return 'function';
      if (type === 'package_statement') return 'module';
      break;
    case 'gdscript':
      if (type === 'function_definition') return 'function';
      if (type === 'class_definition') return 'class';
      if (type === 'variable_statement') return 'variable';
      break;
    case 'astro':
      if (type === 'function_declaration') return 'function';
      if (type === 'function_definition') return 'function';
      break;
    case 'nix':
      if (type === 'function') return 'function';
      if (type === 'binding') return 'variable';
      break;
    case 'verilog':
      if (type === 'module_declaration') return 'class';
      if (type === 'task_declaration') return 'function';
      if (type === 'function_declaration') return 'function';
      break;
  }
  return null;
}

// ── Import extraction ─────────────────────────────────────────────────────────

function extractImport(
  node: any,
  source: string,
  filePath: string,
  language: Language,
  unresolvedRefs: UnresolvedRef[],
  now: number,
  parentId?: string
): Node | null {
  const modulePath = extractImportSource(node, source, language);
  if (!modulePath) return null;

  const id = makeNodeId(filePath, 'import', modulePath, node.startPosition.row + 1);
  const importNode: Node = {
    id,
    kind: 'import',
    name: modulePath,
    qualifiedName: `${filePath}::import:${modulePath}`,
    filePath,
    language,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
    updatedAt: now,
  };

  // Register as unresolved import for later file-level resolution
  unresolvedRefs.push({
    sourceId: id,
    refName: modulePath,
    refKind: 'import',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });

  return importNode;
}

/** Extract the module path string from an import statement node */
function extractImportSource(node: any, source: string, language: Language): string | null {
  // TS/JS/Svelte: import X from "module" → look for trailing string literal
  if (
    node.type === 'import_statement' ||
    (language === 'svelte' && node.type === 'import_statement')
  ) {
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child.type === 'string') {
        return stripQuotes(source.slice(child.startIndex, child.endIndex));
      }
    }
  }

  // Python: from .module import X  or  import module
  if (node.type === 'import_from_statement') {
    // Look for dotted_name or relative_import after 'from'
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'dotted_name' || child.type === 'relative_import') {
        return source.slice(child.startIndex, child.endIndex);
      }
    }
  }
  if (node.type === 'import_statement' && language === 'python') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'dotted_name') {
        return source.slice(child.startIndex, child.endIndex);
      }
    }
  }

  // Go: import "path" or import ( "path" )
  if (node.type === 'import_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'string') {
        return stripQuotes(source.slice(child.startIndex, child.endIndex));
      }
      if (child.type === 'import_spec_list') {
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (spec.type === 'import_spec') {
            for (let k = 0; k < spec.childCount; k++) {
              const s = spec.child(k);
              if (s.type === 'string') return stripQuotes(source.slice(s.startIndex, s.endIndex));
            }
          }
        }
      }
    }
  }

  // Rust: use path::to::module;
  if (node.type === 'use_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type !== 'use' && child.type !== ';') {
        return source.slice(child.startIndex, child.endIndex);
      }
    }
  }

  // C#: using Namespace.Name;
  if (node.type === 'using_directive') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'qualified_name' || child.type === 'identifier') {
        return source.slice(child.startIndex, child.endIndex);
      }
    }
  }

  // Java/Kotlin: import a.b.c
  if (node.type === 'import_declaration' || node.type === 'import_header') {
    const text = source.slice(node.startIndex, node.endIndex).trim();
    const m = text.match(/^import\s+(.+?)[;\s*]*$/);
    if (m) return m[1].trim();
  }

  // PHP: use Foo\Bar
  if (node.type === 'namespace_use_declaration') {
    const text = source.slice(node.startIndex, node.endIndex).trim();
    const m = text.match(/^use\s+(.+?)[;\s]*$/);
    if (m) return m[1].trim();
  }

  // Swift/Dart: import SomeModule
  if (node.type === 'import_declaration' || node.type === 'import_or_export') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'identifier' || child.type === 'string') {
        return source.slice(child.startIndex, child.endIndex);
      }
    }
  }

  // C/C++: #include "file.h" or #include <lib.h>
  if (node.type === 'preproc_include') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'string_literal' || child.type === 'system_lib_string') {
        return source.slice(child.startIndex, child.endIndex).replace(/[<>"]/g, '');
      }
    }
  }

  return null;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

// ── Name extraction ───────────────────────────────────────────────────────────

function extractName(node: any, source: string, _lang: Language, kind: NodeKind): string | null {
  // For variable/constant declarations (lexical_declaration, variable_declaration),
  // the identifier is inside a variable_declarator child
  if (kind === 'variable' || kind === 'constant') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'variable_declarator') {
        for (let j = 0; j < child.childCount; j++) {
          const gc = child.child(j);
          if (gc.type === 'identifier') return source.slice(gc.startIndex, gc.endIndex);
        }
      }
    }
  }

  // For Go const_declaration / var_declaration → look inside var_spec / const_spec
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'var_spec' || child.type === 'const_spec') {
      for (let j = 0; j < child.childCount; j++) {
        const gc = child.child(j);
        if (gc.type === 'identifier') return source.slice(gc.startIndex, gc.endIndex);
      }
    }
  }

  // Lua function_definition_statement: name lives inside a `variable` child (e.g. M.greet)
  // Extract the last identifier to get the function name (not the module prefix)
  if (node.type === 'function_definition_statement') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'variable') {
        let lastId: string | null = null;
        for (let j = 0; j < child.childCount; j++) {
          const gc = child.child(j);
          if (gc.type === 'identifier') lastId = source.slice(gc.startIndex, gc.endIndex);
        }
        if (lastId) return lastId;
      }
    }
  }

  // Standard: look for first named-identifier child
  // Covers: identifier, property_identifier, type_identifier (most languages),
  //         simple_identifier (Kotlin, Swift), word (Bash), name (PHP), constant (Ruby class)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (
      child.type === 'identifier' ||
      child.type === 'property_identifier' ||
      child.type === 'type_identifier' ||
      child.type === 'simple_identifier' ||
      child.type === 'word' ||
      child.type === 'name' ||
      child.type === 'constant'
    ) {
      return source.slice(child.startIndex, child.endIndex);
    }
  }

  // Python assignment: the left side is the name
  if (node.type === 'assignment') {
    const left = node.child(0);
    if (left && left.type === 'identifier') {
      return source.slice(left.startIndex, left.endIndex);
    }
  }

  return null;
}

// ── Signature extraction ──────────────────────────────────────────────────────

function extractSignature(node: any, source: string, kind: NodeKind): string | undefined {
  // For functions/methods, try to get the meaningful header without the body
  if (kind === 'function' || kind === 'method') {
    // Try to find parameter list — stop before the body block
    const text = source.slice(node.startIndex, node.endIndex);
    // Find opening brace or colon (Python), take everything before it
    const bodyStart = text.search(/\s*[\{:]\s*\n|=>|{/);
    const header = bodyStart > 0 ? text.slice(0, bodyStart).trim() : text.split('\n')[0].trim();
    return header.length > 150 ? header.slice(0, 150) + '…' : header || undefined;
  }

  // Default: first line truncated
  const text = source.slice(node.startIndex, node.endIndex);
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine || undefined;
}

// ── Visibility extraction ─────────────────────────────────────────────────────

function extractVisibility(node: any, source: string, language: Language): Node['visibility'] {
  // TypeScript / JavaScript: accessibility_modifier child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'accessibility_modifier') {
      const mod = source.slice(child.startIndex, child.endIndex);
      if (mod === 'public') return 'public';
      if (mod === 'private') return 'private';
      if (mod === 'protected') return 'protected';
    }
    // Direct modifier keywords (Java, C#, PHP, Swift, Kotlin)
    if (child.type === 'public') return 'public';
    if (child.type === 'private') return 'private';
    if (child.type === 'protected') return 'protected';
    if (child.type === 'internal') return 'internal';
  }

  // Rust: no `pub` keyword = private, `pub` = public
  if (language === 'rust') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'visibility_modifier') {
        const v = source.slice(child.startIndex, child.endIndex);
        return v.startsWith('pub') ? 'public' : 'private';
      }
    }
    return 'private'; // Rust default
  }

  // C# default: private
  if (language === 'csharp') return 'private';

  // PHP default: public
  if (language === 'php') return 'public';

  // Swift: check for access modifiers
  if (language === 'swift') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      const t = child.type;
      if (t === 'fileprivate') return 'private';
    }
    return 'internal'; // Swift default
  }

  // Python: underscore prefix convention
  if (language === 'python') {
    const name = extractName(node, source, language, 'function');
    if (name?.startsWith('_') && !name.startsWith('__')) return 'protected';
    if (name?.startsWith('__')) return 'private';
    return 'public';
  }

  return undefined;
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function extractDocstring(node: any, source: string): string | undefined {
  const commentTypes = new Set(['comment', 'block_comment', 'line_comment', 'documentation_comment']);
  const commentLines: string[] = [];

  let sibling = node.previousNamedSibling;
  while (sibling && commentTypes.has(sibling.type)) {
    commentLines.unshift(source.slice(sibling.startIndex, sibling.endIndex));
    sibling = sibling.previousNamedSibling;
  }

  if (commentLines.length === 0) return undefined;

  const cleaned = commentLines.join('\n')
    .replace(/^\/\*+\s*/gm, '')
    .replace(/\s*\*+\/\s*$/gm, '')
    .replace(/^\s*\*\s?/gm, '')
    .replace(/^\/\/\s?/gm, '')
    .trim();

  return cleaned.length > 0 ? cleaned : undefined;
}

function isExported(node: any): boolean {
  // Walk up the parent chain to find an export_statement ancestor
  let current = node.parent;
  while (current) {
    if (current.type === 'export_statement') return true;
    // Stop at scope boundaries
    if (current.type === 'function_body' || current.type === 'class_body' || current.type === 'statement_block') break;
    current = current.parent;
  }
  return false;
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

/**
 * Detect abstract declarations. Handles both grammars that use a dedicated
 * abstract node type (TypeScript: `abstract_class_declaration`) and those that
 * fold `abstract` into a modifier/keyword child (Java, C#, Kotlin, PHP).
 */
function isAbstract(node: any): boolean {
  if (node.type === 'abstract_class_declaration') return true;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'abstract') return true;
    // Java/C#/Kotlin wrap keywords in a `modifiers` child
    if (child.type === 'modifiers') {
      for (let j = 0; j < child.childCount; j++) {
        if (child.child(j).type === 'abstract') return true;
      }
    }
  }
  return false;
}

// ── Call reference collection ─────────────────────────────────────────────────

/**
 * Node types that represent a function/method call across all supported languages.
 * Using a combined set avoids threading a language parameter through the recursive walker.
 */
const CALL_NODE_TYPES = new Set([
  'call_expression',          // JS/TS/Go/Rust/Swift/Kotlin/Dart/C/C++
  'invocation_expression',    // C#
  'method_invocation',        // Java
  'call',                     // Python/Ruby/Elixir (function calls in bodies)
  'function_call_expression', // PHP
]);

/**
 * Extract the callee name from a call node.
 * Uses named field lookup first (more precise), then falls back to first-child heuristic.
 */
function extractCallName(node: any, source: string): string | null {
  // Named fields — Java uses 'name', Python/Ruby use 'function'/'method', Elixir uses 'target'
  for (const field of ['name', 'method', 'function', 'target']) {
    const f = node.childForFieldName?.(field);
    if (f) {
      const t = f.type;
      if (t === 'identifier' || t === 'name' || t === 'property_identifier' || t === 'type_identifier') {
        const text = source.slice(f.startIndex, f.endIndex).trim();
        if (text && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(text)) return text;
      }
    }
  }
  // Fallback: first child, take final segment of dotted access (covers JS/TS, C#, Go, Rust…)
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

function collectCallRefs(node: any, source: string, sourceId: string, unresolvedRefs: UnresolvedRef[], language: Language): void {
  walkForCalls(node, source, sourceId, unresolvedRefs, language);
}

function walkForCalls(node: any, source: string, sourceId: string, unresolvedRefs: UnresolvedRef[], language: Language): void {
  if (CALL_NODE_TYPES.has(node.type)) {
    const calleeName = extractCallName(node, source);
    if (calleeName) {
      const metadata: Record<string, unknown> = {};
      if (JS_TS_LANGUAGES.has(language)) {
        const argKind = classifyFirstArgument(node, source);
        if (argKind) metadata.argKind = argKind;
        const rootName = calleeRootName(node, source);
        if (rootName) metadata.rootName = rootName;
      } else {
        const argKind = classifyGenericArgument(node, source, language);
        if (argKind) metadata.argKind = argKind;
      }
      unresolvedRefs.push({
        sourceId,
        refName: calleeName,
        refKind: 'function',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    walkForCalls(node.child(i), source, sourceId, unresolvedRefs, language);
  }
}

/** The identifier a call chain starts from: `db` in `db.execute(...)`, `sql` in `sql\`...\``. */
function calleeRootName(callNode: any, source: string): string | undefined {
  let fn = callNode.childForFieldName?.('function');
  while (fn && fn.type === 'member_expression') fn = fn.childForFieldName?.('object');
  return fn?.type === 'identifier' ? source.slice(fn.startIndex, fn.endIndex) : undefined;
}

/**
 * Per-language node types for the first argument of a call. `static` lists literal strings,
 * `interpolating` lists string forms that always splice values in, `binary` lists
 * concatenation and formatting operators. Anything else is classified as dynamic.
 * Grammars differ, so each entry was checked against its tree-sitter node names.
 */
const GENERIC_ARG_SHAPES: Partial<Record<Language, { static: string[]; interpolating?: string[]; binary: string[]; wrapper?: string }>> = {
  python: { static: ['string'], binary: ['binary_operator'] },
  java: { static: ['string_literal'], binary: ['binary_expression'] },
  go: { static: ['interpreted_string_literal', 'raw_string_literal'], binary: ['binary_expression'] },
  csharp: { static: ['string_literal', 'verbatim_string_literal', 'raw_string_literal'], interpolating: ['interpolated_string_expression'], binary: ['binary_expression'], wrapper: 'argument' },
  php: { static: ['string'], interpolating: ['encapsed_string', 'heredoc'], binary: ['binary_expression'], wrapper: 'argument' },
  ruby: { static: ['string'], binary: ['binary'] },
  rust: { static: ['string_literal', 'raw_string_literal'], binary: ['binary_expression'] },
  kotlin: { static: ['string_literal'], binary: ['additive_expression'] },
};

/** Text markers of a string that splices values in: f-strings, `$`-variables and `#{}` interpolation. */
const INTERPOLATION_MARKER = /#\{|\$\{|\{\$|\$[A-Za-z_@]|^\$@?"|^[A-Za-z]*[fF][A-Za-z]*["']/;

/**
 * First-argument shape for non-JS languages (the same three classes as the JS classifier).
 * Languages without a table entry get no classification, so their sinks are reported as before.
 */
function classifyGenericArgument(callNode: any, source: string, language: Language): 'static' | 'dynamic' | undefined {
  const shape = GENERIC_ARG_SHAPES[language];
  if (!shape) return undefined;
  let first = callNode.childForFieldName?.('arguments')?.namedChild?.(0);
  while (first && first.type === 'comment') first = first.nextNamedSibling;
  if (!first) return undefined;
  if (shape.wrapper && first.type === shape.wrapper) first = first.namedChild?.(0);
  if (!first) return undefined;
  if (shape.binary.includes(first.type)) return 'dynamic';
  if (shape.interpolating?.includes(first.type)) return 'dynamic';
  if (shape.static.includes(first.type)) {
    const text = source.slice(first.startIndex, first.endIndex);
    return INTERPOLATION_MARKER.test(text) ? 'dynamic' : 'static';
  }
  return 'dynamic';
}

/**
 * How the first argument of a JS/TS call was built:
 * - 'parameterized': a tagged template with the `sql` tag (Drizzle), bound by the driver
 * - 'static': a string or template literal with no substitutions
 * - 'dynamic': anything else (concatenation, interpolation, a variable)
 * Calls without arguments get no classification.
 */
function classifyFirstArgument(callNode: any, source: string): 'parameterized' | 'static' | 'dynamic' | undefined {
  const argsNode = callNode.childForFieldName?.('arguments');
  const first = argsNode?.namedChild?.(0);
  if (!first) return undefined;
  // Tagged templates: tree-sitter-typescript parses sql`...` as a call whose argument is a
  // template_string; other grammars use a dedicated tagged_template_expression node.
  if (first.type === 'tagged_template_expression' || first.type === 'call_expression') {
    const tag = first.childForFieldName?.('function');
    const tagArgs = first.childForFieldName?.('arguments');
    const isSqlTag = tag?.type === 'identifier' && source.slice(tag.startIndex, tag.endIndex) === 'sql';
    if (first.type === 'tagged_template_expression' || tagArgs?.type === 'template_string') {
      return isSqlTag ? 'parameterized' : 'dynamic';
    }
  }
  if (first.type === 'string') return 'static';
  if (first.type === 'template_string') {
    const hasSubstitution = (first.namedChildren as any[]).some(c => c.type === 'template_substitution');
    return hasSubstitution ? 'dynamic' : 'static';
  }
  return 'dynamic';
}

interface ImportBinding {
  specifier: string;
  importId: string;
  /** Name exported by the module; null for default and namespace imports. */
  importedName: string | null;
}

/**
 * Local names bound by each top-level JS/TS import (default, namespace and named imports),
 * mapped to the module they come from and the import node that records it.
 */
function collectImportBindings(
  root: any,
  source: string,
  filePath: string,
  language: Language,
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const node of root.namedChildren as any[]) {
    if (node.type !== 'import_statement') continue;
    const specifier = extractImportSource(node, source, language);
    if (!specifier) continue;
    const importId = makeNodeId(filePath, 'import', specifier, node.startPosition.row + 1);
    for (const { local, imported } of importBindingNames(node, source)) {
      bindings.set(local, { specifier, importId, importedName: imported });
    }
  }
  return bindings;
}

/**
 * Link calls made through an imported package binding to that file's import node with a
 * `references` edge. The security integrator then maps the import node to its dependency.
 * Relative imports are skipped: they point at project files, not dependencies.
 */
function linkImportBindings(
  imports: Map<string, ImportBinding>,
  edges: Edge[],
  unresolvedRefs: UnresolvedRef[],
): void {
  if (imports.size === 0) return;
  const linked = new Set<string>();
  for (const ref of unresolvedRefs) {
    const root = ref.metadata?.rootName;
    if (ref.refKind !== 'function' || typeof root !== 'string') continue;
    const binding = imports.get(root);
    if (!binding || binding.specifier.startsWith('.') || binding.specifier.startsWith('/')) continue;
    const key = `${ref.sourceId}→${binding.importId}`;
    if (linked.has(key)) continue;
    linked.add(key);
    edges.push({
      source: ref.sourceId,
      target: binding.importId,
      kind: 'references',
      line: ref.line,
      column: ref.column,
      confidence: 'inferred',
      confidenceScore: 0.8,
    });
  }
}

/** Local names bound by a JS/TS import, with the exported name they refer to. */
function importBindingNames(node: any, source: string): Array<{ local: string; imported: string | null }> {
  const text = (n: any): string => source.slice(n.startIndex, n.endIndex);
  const names: Array<{ local: string; imported: string | null }> = [];
  const clause = (node.namedChildren as any[]).find(c => c.type === 'import_clause');
  if (!clause) return names;
  for (const child of clause.namedChildren as any[]) {
    if (child.type === 'identifier') {
      names.push({ local: text(child), imported: null });
    } else if (child.type === 'namespace_import') {
      const id = (child.namedChildren as any[]).find(c => c.type === 'identifier');
      if (id) names.push({ local: text(id), imported: null });
    } else if (child.type === 'named_imports') {
      for (const spec of child.namedChildren as any[]) {
        if (spec.type !== 'import_specifier') continue;
        const name = spec.childForFieldName?.('name');
        const alias = spec.childForFieldName?.('alias');
        const local = alias ?? name;
        if (local && name) names.push({ local: text(local), imported: text(name) });
      }
    }
  }
  return names;
}

/** Turn a route-extraction mount into a fact, resolving the target's module through the file's imports. */
function toMountFact(m: RouteMount, imports: Map<string, ImportBinding>): RouteMountFact {
  const t = m.target;
  if (t.kind === 'inline') {
    return { pluginName: '<inline>', importedName: null, specifier: null, prefix: m.prefix, line: m.line,
      inlineStart: t.startLine, inlineEnd: t.endLine };
  }
  if (t.kind === 'require') {
    return { pluginName: t.specifier, importedName: null, specifier: t.specifier, prefix: m.prefix, line: m.line };
  }
  if (t.kind === 'namespace') {
    const ns = imports.get(t.object);
    return { pluginName: t.name, importedName: t.name, specifier: ns?.specifier ?? null, prefix: m.prefix, line: m.line };
  }
  const binding = imports.get(t.name);
  return {
    pluginName: t.name,
    importedName: binding?.importedName ?? null,
    specifier: binding?.specifier ?? null,
    prefix: m.prefix,
    line: m.line,
  };
}

// ── Inheritance extraction ────────────────────────────────────────────────────

/**
 * Extract the simple type name from an AST node representing a type reference.
 * Strips generic parameters (e.g. "List<T>" → "List").
 */
function extractTypeName(node: any, source: string): string | null {
  const t = node.type;
  if (t === 'identifier' || t === 'type_identifier' || t === 'name') {
    return source.slice(node.startIndex, node.endIndex).trim() || null;
  }
  // qualified_name / generic_name: take the rightmost identifier
  if (t === 'qualified_name' || t === 'generic_name' || t === 'scoped_type_identifier') {
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'name') {
        return source.slice(child.startIndex, child.endIndex).trim() || null;
      }
    }
  }
  return null;
}

/**
 * Scan a class/interface AST node for its base types and add them as unresolved
 * extends/implements refs, which the resolver later turns into graph edges.
 *
 * C#:  base_list  children → all are either base class or interface (can't distinguish without types)
 * Java: superclass → extends; super_interfaces / extends_interfaces → implements / extends
 */
function extractInheritance(
  node: any,
  source: string,
  language: Language,
  classNodeId: string,
  unresolvedRefs: UnresolvedRef[],
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (language === 'csharp' && child.type === 'base_list') {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j);
        const name = extractTypeName(item, source);
        if (name) {
          unresolvedRefs.push({
            sourceId: classNodeId,
            refName: name,
            // In C# both classes and interfaces appear in the same base_list;
            // we emit 'extends' for all — the resolver maps it to the extends edge
            // which covers both parent classes and parent interfaces structurally.
            refKind: 'extends',
            line: item.startPosition.row + 1,
            column: item.startPosition.column,
          });
        }
      }
    }

    if (language === 'java') {
      if (child.type === 'superclass') {
        // superclass has a single type_identifier or scoped_type_identifier child
        const typeNode = child.namedChild?.(0);
        if (typeNode) {
          const name = extractTypeName(typeNode, source);
          if (name) unresolvedRefs.push({ sourceId: classNodeId, refName: name, refKind: 'extends', line: child.startPosition.row + 1, column: child.startPosition.column });
        }
      }
      if (child.type === 'super_interfaces' || child.type === 'extends_interfaces') {
        // contains a type_list with one or more types
        const typeList = child.namedChild?.(0);
        if (typeList) {
          const count = typeList.namedChildCount ?? 0;
          for (let j = 0; j < count; j++) {
            const typeNode = typeList.namedChild(j);
            if (typeNode) {
              const name = extractTypeName(typeNode, source);
              if (name) {
                unresolvedRefs.push({
                  sourceId: classNodeId,
                  refName: name,
                  refKind: child.type === 'extends_interfaces' ? 'extends' : 'implements',
                  line: typeNode.startPosition.row + 1,
                  column: typeNode.startPosition.column,
                });
              }
            }
          }
        }
      }
    }
  }
}

// ── Text-based complexity helpers ─────────────────────────────────────────────
// Used when enableComplexity=true in extractFile(). Text heuristics are less
// accurate than full AST walking but require no per-language grammar handling.

const CC_PATTERNS = [
  /\bif\b/g, /\belse\s+if\b/g, /\belif\b/g,
  /\bfor\b/g, /\bwhile\b/g, /\bdo\b/g,
  /\bcase\b/g, /\bcatch\b/g, /\bexcept\b/g,
  /&&/g, /\|\|/g, /\?\?/g,
  // ternary ? that is not ?. or ?: or optional chaining
  /(?<![?!])\?(?![.?:])/g,
];

function computeTextCyclomaticComplexity(src: string): number {
  // Strip string literals and comments to avoid counting keywords inside them
  const stripped = src
    .replace(/`[^`]*`/g, '``')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  let count = 0;
  for (const pat of CC_PATTERNS) count += (stripped.match(pat) ?? []).length;
  return 1 + count;
}

function computeTextNestingDepth(src: string): number {
  let depth = 0, max = 0;
  for (const ch of src) {
    if (ch === '{') { depth++; if (depth > max) max = depth; }
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }
  return max;
}
