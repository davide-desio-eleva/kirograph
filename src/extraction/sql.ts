/**
 * SQL symbols, read from the text of each statement instead of a syntax tree.
 *
 * The SQL grammar bundled as WASM knows little of the CREATE statements real projects use:
 * `IF NOT EXISTS` (read as a table named "IF"), `OR REPLACE`, `TEMPORARY`, views, procedures,
 * and quoted or backticked names all came out wrong or not at all, and it could take tens of
 * seconds on a large data dump. The symbols come only from CREATE statements, whose head is
 * regular in every dialect, so each statement is read directly:
 *
 *   CREATE [OR REPLACE] [modifiers] TABLE | VIEW | MATERIALIZED VIEW | FUNCTION | PROCEDURE
 *     [IF NOT EXISTS] name
 *
 * The node is the statement from CREATE to before its semicolon, so lines, columns, signature
 * and docstring are what the tree-based extraction gave for the statements it understood. A
 * table is a `class`; a view, a function and a procedure are `function`s, as before.
 */

import type { Node, Edge, NodeKind } from '../types';
import type { UnresolvedRef } from './extractor';
import { makeNodeId } from './extractor';

/** One identifier: bare, "double quoted", `backticked` or [bracketed]. */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[A-Za-z_\u0080-￿][\w$\u0080-￿]*)`;
/** Words that may sit between CREATE and the object type (PostgreSQL, MySQL, SQLite, SQL Server, Oracle). */
const MODIFIER = String.raw`(?:OR\s+REPLACE|OR\s+ALTER|GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|VOLATILE|TRANSIENT|EXTERNAL|VIRTUAL|RECURSIVE|SECURE|ALGORITHM\s*=\s*\w+|DEFINER\s*=\s*\S+|SQL\s+SECURITY\s+\w+|EDITIONABLE|NONEDITIONABLE|FORCE|NOFORCE)`;
const CREATE_HEAD = new RegExp(
  String.raw`^CREATE\s+(?:${MODIFIER}\s+)*(TABLE|MATERIALIZED\s+VIEW|VIEW|FUNCTION|PROCEDURE|PROC)\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT}(?:\s*\.\s*${IDENT})*)`,
  'i',
);

const KIND: Record<string, NodeKind> = { table: 'class', view: 'function', function: 'function', procedure: 'function', proc: 'function' };

export interface SqlStatement {
  /** Offset of the statement's first character (after the previous semicolon). */
  start: number;
  /** Offset just past its semicolon (or the end of the text). */
  end: number;
}

/**
 * The statements of a SQL text: they end at a `;` outside strings, quoted identifiers, comments
 * and dollar-quoted bodies. The rows of a pg_dump `COPY ... FROM stdin;` belong to it, up to `\.`.
 */
export function sqlStatements(source: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  const n = source.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '-' && source[i + 1] === '-') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? n : nl;
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n) {
        if (source[i] === c) {
          if (source[i + 1] === c) { i += 2; continue; }
          break;
        }
        if (c === "'" && source[i] === '\\') i++; // MySQL backslash escapes
        i++;
      }
      i++;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i, i + 64));
      if (m) {
        const close = source.indexOf(m[0], i + m[0].length);
        i = close === -1 ? n : close + m[0].length;
      } else {
        i++;
      }
    } else if (c === ';') {
      i++;
      let end = i;
      if (/^\s*(?:--[^\n]*\n\s*)*copy\b[\s\S]*\bfrom\s+stdin\b[^;]*;$/i.test(source.slice(start, end))) {
        const terminator = /\n\\\.[ \t]*(?:\r?\n|$)/g;
        terminator.lastIndex = end;
        const m = terminator.exec(source);
        end = m ? m.index + m[0].length : n;
        i = end;
      }
      out.push({ start, end });
      start = end;
    } else {
      i++;
    }
  }
  if (start < n && source.slice(start).trim()) out.push({ start, end: n });
  return out;
}

/** The comments before a statement's first word, one entry per comment, and where that word is. */
function leadingComments(source: string, start: number, end: number): { comments: string[]; at: number } {
  const comments: string[] = [];
  let i = start;
  while (i < end) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && source[i + 1] === '-') {
      const nl = source.indexOf('\n', i);
      const stop = nl === -1 || nl > end ? end : nl;
      comments.push(source.slice(i, stop).replace(/\r$/, ''));
      i = stop;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close === -1 || close > end ? end : close + 2;
      comments.push(source.slice(i, stop));
      i = stop;
      continue;
    }
    break;
  }
  return { comments, at: i };
}

/** The docstring the tree-based extraction made of the comments right before a declaration. */
function docstringOf(comments: string[]): string | undefined {
  if (comments.length === 0) return undefined;
  const cleaned = comments.join('\n')
    .replace(/^\/\*+\s*/gm, '')
    .replace(/\s*\*+\/\s*$/gm, '')
    .replace(/^\s*\*\s?/gm, '')
    .replace(/^\/\/\s?/gm, '')
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function signatureOf(text: string, kind: NodeKind): string | undefined {
  if (kind === 'function') {
    const bodyStart = text.search(/\s*[\{:]\s*\n|=>|{/);
    const header = bodyStart > 0 ? text.slice(0, bodyStart).trim() : text.split('\n')[0].trim();
    return header.length > 150 ? header.slice(0, 150) + '…' : header || undefined;
  }
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine || undefined;
}

/** `"public"."Orders"` → `public.Orders`: quotes off each part, the parts joined by dots. */
function nameOf(raw: string): string {
  return raw.split(/\s*\.\s*(?=(?:[^"`\]]|"[^"]*"|`[^`]*`|\[[^\]]*\])*$)/)
    .map(part => {
      const p = part.trim();
      if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith('`') && p.endsWith('`'))) {
        const q = p[0];
        return p.slice(1, -1).split(q + q).join(q);
      }
      if (p.startsWith('[') && p.endsWith(']')) return p.slice(1, -1);
      return p;
    })
    .join('.');
}

export function extractSql(source: string, filePath: string, now: number): { nodes: Node[]; edges: Edge[]; unresolvedRefs: UnresolvedRef[] } {
  const nodes: Node[] = [];
  // Line starts, to turn offsets into lines and columns (columns in UTF-16 units, as elsewhere)
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const position = (offset: number): { line: number; column: number } => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] };
  };

  for (const st of sqlStatements(source)) {
    const { comments, at } = leadingComments(source, st.start, st.end);
    const head = CREATE_HEAD.exec(source.slice(at, Math.min(st.end, at + 2000)));
    if (!head) continue;
    const kind = KIND[head[1].toLowerCase().replace(/\s+/g, ' ').split(' ').pop()!];
    const name = nameOf(head[2]);
    if (!kind || !name) continue;

    // The statement without its semicolon, and without the whitespace around it
    let text = source.slice(at, st.end).trimEnd();
    if (text.endsWith(';')) text = text.slice(0, -1).trimEnd();
    const stop = at + text.length;
    const from = position(at);
    const to = position(stop);
    nodes.push({
      id: makeNodeId(filePath, kind, name, from.line),
      kind,
      name,
      qualifiedName: `${filePath}::${name}`,
      filePath,
      language: 'sql',
      startLine: from.line,
      endLine: to.line,
      startColumn: from.column,
      endColumn: to.column,
      docstring: docstringOf(comments),
      signature: signatureOf(text, kind),
      isExported: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      updatedAt: now,
    });
  }
  return { nodes, edges: [], unresolvedRefs: [] };
}
