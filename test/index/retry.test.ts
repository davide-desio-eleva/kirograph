import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import KiroGraph from '../../src/index';
import type { IndexProgress } from '../../src/types';

let root: string;
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('retry pass of a full index (#97)', () => {
  it('does not parse again a file that has no symbols', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-retry-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src', 'notes.ts'), '// nothing to declare here\n');
    const kg = await KiroGraph.init(root);
    try {
      const phases = new Set<string>();
      const result = await kg.indexAll({ onProgress: (p: IndexProgress) => phases.add(p.phase) });
      expect(result.filesIndexed).toBe(2);
      expect(phases.has('retrying')).toBe(false);
    } finally {
      kg.close();
    }
  });
});
