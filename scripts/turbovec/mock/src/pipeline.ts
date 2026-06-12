import type { GraphNode } from './graph';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Stage<TIn, TOut> {
  name: string;
  run(input: TIn): Promise<TOut>;
}

export interface PipelineResult<T> {
  value: T;
  durationMs: number;
  stagesRun: string[];
  errors: string[];
}

export interface PipelineOptions {
  timeout?: number;
  retries?: number;
  onProgress?: (stage: string, status: StageStatus) => void;
}

export class Pipeline<T> {
  private stages: Array<Stage<unknown, unknown>> = [];
  private options: PipelineOptions;

  constructor(options: PipelineOptions = {}) {
    this.options = { timeout: 30_000, retries: 0, ...options };
  }

  pipe<TOut>(stage: Stage<T, TOut>): Pipeline<TOut> {
    (this.stages as Stage<unknown, unknown>[]).push(stage as Stage<unknown, unknown>);
    return this as unknown as Pipeline<TOut>;
  }

  async run(input: T): Promise<PipelineResult<T>> {
    const stagesRun: string[] = [];
    const errors: string[] = [];
    const start = performance.now();
    let current: unknown = input;

    for (const stage of this.stages) {
      this.options.onProgress?.(stage.name, 'running');
      try {
        current = await this.withTimeout(stage.run(current), this.options.timeout ?? 30_000);
        stagesRun.push(stage.name);
        this.options.onProgress?.(stage.name, 'done');
      } catch (err) {
        errors.push(`${stage.name}: ${String(err)}`);
        this.options.onProgress?.(stage.name, 'failed');
        break;
      }
    }

    return {
      value: current as T,
      durationMs: performance.now() - start,
      stagesRun,
      errors,
    };
  }

  private withTimeout<R>(promise: Promise<R>, ms: number): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Stage timed out after ${ms}ms`)), ms);
      promise.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); },
      );
    });
  }
}

export class BatchStage<TItem, TOut> implements Stage<TItem[], TOut[]> {
  name: string;
  private batchSize: number;
  private processor: (item: TItem) => Promise<TOut>;

  constructor(name: string, processor: (item: TItem) => Promise<TOut>, batchSize = 32) {
    this.name = name;
    this.batchSize = batchSize;
    this.processor = processor;
  }

  async run(input: TItem[]): Promise<TOut[]> {
    const results: TOut[] = [];
    for (let i = 0; i < input.length; i += this.batchSize) {
      const batch = input.slice(i, i + this.batchSize);
      const out = await Promise.all(batch.map(item => this.processor(item)));
      results.push(...out);
    }
    return results;
  }
}

export class FilterStage<T> implements Stage<T[], T[]> {
  name: string;
  private predicate: (item: T) => boolean;

  constructor(name: string, predicate: (item: T) => boolean) {
    this.name = name;
    this.predicate = predicate;
  }

  async run(input: T[]): Promise<T[]> {
    return input.filter(this.predicate);
  }
}

export class MapStage<TIn, TOut> implements Stage<TIn[], TOut[]> {
  name: string;
  private transform: (item: TIn) => TOut;

  constructor(name: string, transform: (item: TIn) => TOut) {
    this.name = name;
    this.transform = transform;
  }

  async run(input: TIn[]): Promise<TOut[]> {
    return input.map(this.transform);
  }
}

export class DeduplicateStage<T> implements Stage<T[], T[]> {
  name = 'deduplicate';
  private keyFn: (item: T) => string;

  constructor(keyFn: (item: T) => string) {
    this.keyFn = keyFn;
  }

  async run(input: T[]): Promise<T[]> {
    const seen = new Set<string>();
    return input.filter(item => {
      const key = this.keyFn(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

export class AggregateStage<TIn, TOut> implements Stage<TIn[], TOut> {
  name: string;
  private reducer: (acc: TOut, item: TIn, index: number) => TOut;
  private initial: TOut;

  constructor(name: string, reducer: (acc: TOut, item: TIn, index: number) => TOut, initial: TOut) {
    this.name = name;
    this.reducer = reducer;
    this.initial = initial;
  }

  async run(input: TIn[]): Promise<TOut> {
    return input.reduce(this.reducer, this.initial);
  }
}

export function buildNodeIndexingPipeline(onProgress?: (stage: string, status: StageStatus) => void) {
  return new Pipeline<GraphNode[]>({ onProgress })
    .pipe(new FilterStage<GraphNode>('filter-valid', n => Boolean(n.id && n.label)))
    .pipe(new DeduplicateStage<GraphNode>(n => n.id))
    .pipe(new MapStage<GraphNode, GraphNode>('normalize', n => ({
      ...n,
      label: n.label.trim(),
      weight: Math.max(0, n.weight),
    })));
}

export function createEmbeddingPipeline<T extends { text: string }>(
  embed: (text: string) => Promise<Float32Array>,
  batchSize = 16,
) {
  return new BatchStage<T, T & { embedding: Float32Array }>(
    'embed',
    async item => ({ ...item, embedding: await embed(item.text) }),
    batchSize,
  );
}
