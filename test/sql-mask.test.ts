import { describe, it, expect } from 'vitest';
import { maskSqlForParsing } from '../src/extraction/sql-mask';

const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');

describe('maskSqlForParsing', () => {
  it('blanks data statements, keeping length and lines', () => {
    const create = 'CREATE TABLE a (id int);';
    const insert = "\nINSERT INTO a VALUES (1, 'x;y');";
    const out = maskSqlForParsing(create + insert);
    expect(out).toBe(create + blank(insert));
    expect(out.length).toBe((create + insert).length);
  });

  it('keeps every statement that is not a data statement, with the comments before it', () => {
    const src = '-- users\nCREATE TABLE users (id int);\nALTER TABLE users ADD COLUMN n int;\nCREATE TABLE b LIKE users;\n';
    expect(maskSqlForParsing(src)).toBe(src);
  });

  it('does not split at a semicolon inside strings, comments or dollar-quoted bodies', () => {
    const fn = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN INSERT INTO t VALUES (';'); RETURN 1; END $body$ LANGUAGE plpgsql;";
    const src = `${fn}\n/* ; */ SELECT 'a;b', "c;d", \`e;f\`; -- ;\n`;
    const out = maskSqlForParsing(src);
    expect(out.startsWith(fn)).toBe(true);
    expect(out.slice(fn.length).trim()).toBe('-- ;');
  });

  it('blanks the rows of a pg_dump COPY ... FROM stdin', () => {
    const copy = '--\n-- Data\n--\n\nCOPY public.t (id, name) FROM stdin;\n1\tx;y\n2\tz\n\\.\n';
    const create = 'CREATE TABLE u (id int);\n';
    const set = 'SET a = 1;';
    const out = maskSqlForParsing(set + '\n' + copy + create);
    expect(out).toBe(set + blank('\n' + copy) + create);
  });
});
