import { describe, it, expect } from 'vitest';
import { extractSql, sqlStatements } from '../src/extraction/sql';

const names = (src: string) => extractSql(src, 'db/schema.sql', 0).nodes.map(n => `${n.kind} ${n.name}`);

describe('SQL symbols (#84)', () => {
  it('reads the name after IF NOT EXISTS, OR REPLACE and modifiers', () => {
    expect(names([
      'CREATE TABLE IF NOT EXISTS users (id int);',
      'CREATE OR REPLACE VIEW active AS SELECT 1;',
      'CREATE TEMPORARY TABLE scratch (id int);',
      'CREATE MATERIALIZED VIEW totals AS SELECT 1;',
      'CREATE FUNCTION IF NOT EXISTS f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;',
      'CREATE PROCEDURE refresh() LANGUAGE sql AS $$ SELECT 1 $$;',
    ].join('\n'))).toEqual(['class users', 'function active', 'class scratch', 'function totals', 'function f', 'function refresh']);
  });

  it('takes quoted, backticked, bracketed and schema-qualified names', () => {
    expect(names('CREATE TABLE "Order Items" (id int);\nCREATE TABLE `bt` (id int);\nCREATE TABLE [dbo].[Orders] (id int);\nCREATE TABLE public.orders (id int);'))
      .toEqual(['class Order Items', 'class bt', 'class dbo.Orders', 'class public.orders']);
  });

  it('ignores statements that declare nothing, and semicolons in strings and bodies', () => {
    const src = "INSERT INTO t VALUES ('a;b');\nCREATE INDEX i ON t (id);\nCREATE FUNCTION g() RETURNS int AS $body$ BEGIN RETURN 1; END $body$ LANGUAGE plpgsql;\n";
    expect(names(src)).toEqual(['function g']);
    expect(sqlStatements(src)).toHaveLength(3);
  });

  it('keeps the rows of a pg_dump COPY in their statement', () => {
    const src = 'COPY t (id) FROM stdin;\n1;\n2;\n\\.\nCREATE TABLE u (id int);\n';
    expect(sqlStatements(src)).toHaveLength(2);
    expect(names(src)).toEqual(['class u']);
  });

  it('gives lines, the signature and the comment before the statement', () => {
    const [node] = extractSql('\n/* People who sign in */\nCREATE TABLE users (\n  id int\n);\n', 'db/schema.sql', 0).nodes;
    expect(node).toMatchObject({
      startLine: 3, endLine: 5, startColumn: 0, endColumn: 1,
      signature: 'CREATE TABLE users (', docstring: 'People who sign in',
      qualifiedName: 'db/schema.sql::users', language: 'sql',
    });
  });
});
