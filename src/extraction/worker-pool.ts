/**
 * Parses files on worker threads.
 *
 * Parsing is about half the time of a full index and it is CPU-bound, so it can run on several
 * cores while the main thread writes the database. The pool exists only when the compiled worker
 * script is next to this file (a build, not the TypeScript sources a test runs); anywhere else
 * `create` returns null and the caller parses in-process.
 *
 * A worker that fails rejects its jobs. The caller then parses those files itself, so a crash in
 * a worker costs speed, never a file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { ExtractedFile } from './extractor';

type Opts = { enableComplexity?: boolean; maxFileSize?: number };

interface Pending { resolve: (r: ExtractedFile | null) => void; reject: (e: Error) => void }
interface Slot { worker: Worker; pending: Map<number, Pending>; alive: boolean }

export class ExtractionPool {
  private readonly slots: Slot[] = [];
  private nextId = 1;

  private constructor(script: string, size: number) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn(script));
  }

  /**
   * The number of workers worth starting on this machine: one core is left for the main thread.
   * KIROGRAPH_WORKERS overrides it; 0 (or 1) parses in-process.
   */
  static defaultSize(): number {
    const forced = process.env.KIROGRAPH_WORKERS;
    if (forced !== undefined && /^\d+$/.test(forced)) return Math.min(16, Number(forced));
    return Math.max(0, Math.min(6, os.cpus().length - 1));
  }

  static create(size = ExtractionPool.defaultSize(), script = path.join(__dirname, 'worker.js')): ExtractionPool | null {
    if (size < 2) return null; // one worker gains nothing over parsing in-process
    if (!fs.existsSync(script)) return null;
    try {
      return new ExtractionPool(script, size);
    } catch {
      return null;
    }
  }

  private spawn(script: string): Slot {
    const worker = new Worker(script);
    const slot: Slot = { worker, pending: new Map(), alive: true };
    const fail = (err: Error) => {
      slot.alive = false;
      for (const p of slot.pending.values()) p.reject(err);
      slot.pending.clear();
    };
    worker.on('message', (m: { id: number; result?: ExtractedFile | null; error?: { name: string; message: string } }) => {
      const p = slot.pending.get(m.id);
      if (!p) return;
      slot.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
      else p.resolve(m.result ?? null);
    });
    worker.on('error', err => fail(err));
    worker.on('exit', () => fail(new Error('extraction worker exited')));
    return slot;
  }

  /** Parses a file on the least busy live worker. Rejects when no worker is alive or it fails. */
  run(file: string, root: string, content: Buffer, opts: Opts): Promise<ExtractedFile | null> {
    let best: Slot | null = null;
    for (const s of this.slots) {
      if (s.alive && (!best || s.pending.size < best.pending.size)) best = s;
    }
    if (!best) return Promise.reject(new Error('no live extraction worker'));
    const id = this.nextId++;
    const slot = best;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage({ id, file, root, content: new Uint8Array(content), opts });
    });
  }

  get size(): number { return this.slots.length; }

  async close(): Promise<void> {
    await Promise.all(this.slots.map(s => s.worker.terminate().catch(() => 0)));
  }
}
