import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import KiroGraph from '../../src/index';

let root: string;
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });

const JS = `import { NativeEventEmitter } from 'react-native';
export function listenForPing(emitter) {
  return emitter.addListener('onPing', () => {});
}
`;
const JAVA = `package app;
public class Pinger {
  public void firePing(Object module) {
    module.emit("onPing", null);
  }
}
`;

/** Edges the native-events bridge made, as "source name -> target name" */
function bridgeEdges(kg: KiroGraph): string[] {
  const db = (kg as any).db.getRawDb();
  const rows = db.all(`
    SELECT s.name AS s, t.name AS t FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.metadata LIKE '%native-events-bridge%' ORDER BY 1, 2`);
  return rows.map((r: any) => `${r.s} -> ${r.t}`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-bridge-'));
  git('init', '-q');
  write('package.json', JSON.stringify({ name: 'app', dependencies: { 'react-native': '0.74.0' } }));
  write('src/listener.js', JS);
  write('android/Pinger.java', JAVA);
  write('notes.py', 'x = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('cross-language bridges', () => {
  it('links a native emitter to the JS listener of the same event', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      expect(bridgeEdges(kg)).toEqual(['firePing -> listenForPing']);
    } finally { kg.close(); }
  });

  it('keeps the edges through a sync that changes a file the bridges do not read', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      write('notes.py', 'x = 2\ny = 3\n');
      const r = await kg.sync({ full: true });
      expect(r.modified).toEqual(['notes.py']);
      expect(bridgeEdges(kg)).toEqual(['firePing -> listenForPing']);
    } finally { kg.close(); }
  });

  it('rebuilds the edges when a file the bridges read changes, as an index would', async () => {
    const kg = await KiroGraph.init(root);
    try {
      await kg.indexAll();
      write('src/listener.js', JS + '\nexport const other = 1;\n');
      await kg.sync({ full: true });
      expect(bridgeEdges(kg)).toEqual(['firePing -> listenForPing']);

      // The listener now listens for another event: the edge goes
      write('src/listener.js', JS.replace('onPing', 'onOther'));
      await kg.sync({ full: true });
      expect(bridgeEdges(kg)).toEqual([]);
    } finally { kg.close(); }
  });
});
