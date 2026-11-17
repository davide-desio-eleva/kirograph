/**
 * SQL files are parsed with their data statements blanked out.
 *
 * The extractor reads symbols only from CREATE TABLE / VIEW / FUNCTION / PROCEDURE statements.
 * Data dumps and seed files are made of INSERTs and the like, which are parsed and then ignored,
 * and the SQL grammar can take very long on them (48 s for a 540 KB file of INSERTs). A statement
 * that only moves data is replaced by spaces, keeping its line breaks, so the text has the same
 * length and the same lines: every other statement keeps its position and its text.
 *
 * Only data statements are blanked, not everything but CREATE: the grammar's error recovery can
 * lean on the statements around one it cannot parse (`CREATE TABLE b LIKE a` followed by ALTERs),
 * and taking those away would lose a table it finds today.
 *
 * Statements end at a `;` outside strings, quoted identifiers, comments and dollar-quoted bodies.
 * The first word is read past whitespace and comments.
 */

/** Statements that only read or write rows: they never hold a symbol. */
const DATA_STATEMENT = /^(insert|update|delete|replace|copy|merge|upsert|values|select|with)\b/i;

/** `COPY ... FROM stdin;`: the rows follow the statement, without semicolons. */
const COPY_FROM_STDIN = /^\s*(?:--[^\n]*\n\s*)*copy\b[\s\S]*\bfrom\s+stdin\b[^;]*;$/i;

/** The source with every data statement replaced by whitespace. */
export function maskSqlForParsing(source: string): string {
  const spans: Array<[number, number]> = []; // statements to blank, [start, end)
  let start = 0;
  let i = 0;
  const n = source.length;

  const endStatement = (end: number): void => {
    const statement = source.slice(start, end);
    if (DATA_STATEMENT.test(firstWord(source, start, end))) {
      // pg_dump's `COPY ... FROM stdin;` is followed by its rows, up to a line `\.`
      if (COPY_FROM_STDIN.test(statement)) {
        const terminator = /\n\\\.[ \t]*(?:\r?\n|$)/g;
        terminator.lastIndex = end;
        const m = terminator.exec(source);
        end = m ? m.index + m[0].length : n;
        i = end;
      }
      spans.push([start, end]);
    }
    start = end;
  };

  while (i < n) {
    const c = source[i];
    if (c === '-' && source[i + 1] === '-') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? n : nl;
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      // Quoted: a doubled quote is an escaped one
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
      endStatement(i);
    } else {
      i++;
    }
  }
  if (start < n) endStatement(n);
  if (spans.length === 0) return source;

  const out: string[] = [];
  let last = 0;
  for (const [s, e] of spans) {
    out.push(source.slice(last, s));
    out.push(source.slice(s, e).replace(/[^\r\n]/g, ' '));
    last = e;
  }
  out.push(source.slice(last));
  return out.join('');
}

/** The text of source[start, end) from its first word on (past whitespace and comments), up to 8 characters. */
function firstWord(source: string, start: number, end: number): string {
  let i = start;
  while (i < end) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '-' && source[i + 1] === '-') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 || nl > end ? end : nl;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 || close > end ? end : close + 2;
      continue;
    }
    break;
  }
  return source.slice(i, Math.min(end, i + 8));
}
