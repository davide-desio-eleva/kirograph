import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ExtractionPool } from '../../src/extraction/worker-pool';
import { extractFile } from '../../src/extraction/extractor';

// The pool runs the compiled worker script, so these tests need a build (npm run build)
const script = path.resolve(__dirname, '../../dist/extraction/worker.js');
const root = path.resolve(__dirname, '../..');
const sample = path.join(root, 'src/extraction/libc-shims.ts');

describe('ExtractionPool', () => {
  it('is not created from the TypeScript sources', () => {
    expect(ExtractionPool.create(4)).toBeNull();
  });

  it('is not created for fewer than two workers', () => {
    expect(ExtractionPool.create(1, script)).toBeNull();
    expect(ExtractionPool.create(0, script)).toBeNull();
  });

  it.skipIf(!fs.existsSync(script))('returns what extractFile returns in-process', async () => {
    const pool = ExtractionPool.create(2, script)!;
    try {
      const content = fs.readFileSync(sample);
      const [fromPool, inProcess] = await Promise.all([
        pool.run(sample, root, content, {}),
        extractFile(sample, root, content, {}),
      ]);
      const strip = (r: any) => ({ ...r, nodes: r.nodes.map((n: any) => ({ ...n, updatedAt: 0 })), edges: r.edges });
      expect(fromPool).not.toBeNull();
      expect(fromPool!.nodes.length).toBeGreaterThan(0);
      expect(strip(fromPool).nodes.map((n: any) => n.id)).toEqual(strip(inProcess).nodes.map((n: any) => n.id));
      expect(fromPool!.contentHash).toBe(inProcess!.contentHash);
    } finally {
      await pool.close();
    }
  });

  it.skipIf(!fs.existsSync(script))('answers many files in flight, and null for an unsupported one', async () => {
    const pool = ExtractionPool.create(2, script)!;
    try {
      const content = fs.readFileSync(sample);
      const results = await Promise.all([
        ...Array.from({ length: 12 }, () => pool.run(sample, root, content, {})),
        pool.run(path.join(root, 'package.json'), root, Buffer.from('{}'), {}),
      ]);
      expect(results.slice(0, 12).every(r => r && r.nodes.length > 0)).toBe(true);
      expect(results[12]).toBeNull();
    } finally {
      await pool.close();
    }
  });

  it.skipIf(!fs.existsSync(script))('rejects when its workers are gone', async () => {
    const pool = ExtractionPool.create(2, script)!;
    await pool.close();
    await expect(pool.run(sample, root, Buffer.from(''), {})).rejects.toThrow();
  });
});
