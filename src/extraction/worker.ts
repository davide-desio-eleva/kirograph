/**
 * Worker thread of the extraction pool (see worker-pool.ts). It loads the grammars once, then
 * parses the files it is sent and posts back what extractFile returns.
 */
import { parentPort } from 'worker_threads';
import { extractFile } from './extractor';

interface Job {
  id: number;
  file: string;
  root: string;
  content: Uint8Array;
  opts: { enableComplexity?: boolean; maxFileSize?: number };
}

parentPort!.on('message', async (job: Job) => {
  try {
    const result = await extractFile(job.file, job.root, Buffer.from(job.content), job.opts);
    parentPort!.postMessage({ id: job.id, result });
  } catch (err) {
    parentPort!.postMessage({
      id: job.id,
      error: { name: (err as Error)?.constructor?.name ?? 'Error', message: err instanceof Error ? err.message : String(err) },
    });
  }
});
