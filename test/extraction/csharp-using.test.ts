import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../../src/extraction/extractor';

describe('C# using directives', () => {
  it('imports the namespace, not the alias', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-cs-'));
    try {
      const file = path.join(root, 'A.cs');
      fs.writeFileSync(file, 'using System.Text;\nusing static System.Math;\nusing Convert = System.Convert;\nclass A {}\n');
      const r = await extractFile(file, root);
      expect(r?.nodes.filter(n => n.kind === 'import').map(n => n.name)).toEqual(['System.Text', 'System.Math', 'System.Convert']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
