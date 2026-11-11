import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDatabase } from '../../src/db/database';
import { WriteBatch } from '../../src/core/write-batch';

let root: string;
let db: GraphDatabase;

const file = (name: string) => ({
  path: name, contentHash: 'h', language: 'typescript', fileSize: 1, symbolCount: 0, indexedAt: 1,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-batch-'));
  db = new GraphDatabase(root);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('WriteBatch', () => {
  it('writes many files in one transaction', () => {
    const transaction = vi.spyOn(db, 'transaction');
    const batch = new WriteBatch(db, 20, 1_000_000);
    for (let i = 0; i < 10; i++) batch.add(() => db.upsertFile(file(`f${i}.ts`)), () => {}, 1);
    expect(transaction).not.toHaveBeenCalled(); // nothing is written until the batch is flushed
    batch.flush();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(db.getAllFiles()).toHaveLength(10);
  });

  it('flushes by itself when the file limit is reached', () => {
    const transaction = vi.spyOn(db, 'transaction');
    const batch = new WriteBatch(db, 5, 1_000_000);
    for (let i = 0; i < 12; i++) batch.add(() => db.upsertFile(file(`f${i}.ts`)), () => {}, 1);
    expect(transaction).toHaveBeenCalledTimes(2); // 5 + 5, two files still queued
    batch.flush();
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(db.getAllFiles()).toHaveLength(12);
  });

  it('flushes by itself when the row limit is reached', () => {
    const transaction = vi.spyOn(db, 'transaction');
    const batch = new WriteBatch(db, 100, 1_000);
    batch.add(() => db.upsertFile(file('big.ts')), () => {}, 1_500);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('undoes only the failing file and keeps the others', () => {
    const errors: unknown[] = [];
    const batch = new WriteBatch(db, 20, 1_000_000);
    batch.add(() => db.upsertFile(file('ok-before.ts')), e => errors.push(e), 1);
    batch.add(() => {
      db.upsertFile(file('broken.ts')); // written, then undone with the rest of its savepoint
      throw new Error('write failed');
    }, e => errors.push(e), 1);
    batch.add(() => db.upsertFile(file('ok-after.ts')), e => errors.push(e), 1);
    batch.flush();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('write failed');
    expect(db.getFile('broken.ts')).toBeNull();
    expect(db.getFile('ok-before.ts')).not.toBeNull();
    expect(db.getFile('ok-after.ts')).not.toBeNull();
  });

  it('does nothing when flushed with nothing queued', () => {
    const transaction = vi.spyOn(db, 'transaction');
    new WriteBatch(db).flush();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('GraphDatabase.savepoint', () => {
  it('releases on success and undoes on failure, inside one transaction', () => {
    db.transaction(() => {
      db.savepoint(() => db.upsertFile(file('kept.ts')));
      expect(() => db.savepoint(() => {
        db.upsertFile(file('undone.ts'));
        throw new Error('boom');
      })).toThrow('boom');
    });
    expect(db.getFile('kept.ts')).not.toBeNull();
    expect(db.getFile('undone.ts')).toBeNull();
  });
});
