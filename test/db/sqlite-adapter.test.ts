import { describe, it, expect } from 'vitest';
import { Database } from '../../src/db/sqlite';

describe('node:sqlite adapter', () => {
  it('binds whole numbers as INTEGER, so they read back the same from an untyped or TEXT column', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a TEXT, b, c REAL)');
    db.run('INSERT INTO t VALUES (?, ?, ?)', [1, 2, 3]);
    db.run('INSERT INTO t VALUES (?, ?, ?)', [1.5, -0, 2 ** 60]);
    const rows = db.all('SELECT a, b, c, typeof(b) tb FROM t');
    expect(rows[0]).toEqual({ a: '1', b: 2, c: 3, tb: 'integer' });
    expect(rows[1].a).toBe('1.5');
    expect(rows[1].tb).toBe('real');
    // A TEXT value '1' and a bound 1 match, as they did with the previous driver
    expect(db.get('SELECT COUNT(*) n FROM t WHERE a = ?', ['1']).n).toBe(1);
    db.close();
  });

  it('binds booleans as 0/1 and undefined as NULL', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (a, b)');
    db.run('INSERT INTO t VALUES (?, ?)', [true, undefined]);
    expect(db.get('SELECT a, b FROM t')).toEqual({ a: 1, b: null });
    db.close();
  });
});
