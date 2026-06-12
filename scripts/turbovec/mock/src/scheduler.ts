export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  name: string;
  priority: TaskPriority;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  retries: number;
  maxRetries: number;
  payload: unknown;
}

export interface SchedulerOptions {
  concurrency?: number;
  maxQueueSize?: number;
  defaultMaxRetries?: number;
}

export interface SchedulerStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  totalProcessed: number;
  avgDurationMs: number;
}

export type TaskHandler<T = unknown, R = void> = (task: Task & { payload: T }) => Promise<R>;

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0, high: 1, normal: 2, low: 3,
};

export class TaskScheduler {
  private queue: Task[] = [];
  private running = new Map<string, Task>();
  private done: Task[] = [];
  private handlers = new Map<string, TaskHandler>();
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly defaultMaxRetries: number;
  private _active = false;

  constructor(options: SchedulerOptions = {}) {
    this.concurrency = options.concurrency ?? 4;
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.defaultMaxRetries = options.defaultMaxRetries ?? 2;
  }

  register<T>(name: string, handler: TaskHandler<T>): void {
    this.handlers.set(name, handler as TaskHandler);
  }

  enqueue(name: string, payload: unknown, priority: TaskPriority = 'normal'): Task {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`Queue full (max ${this.maxQueueSize})`);
    }
    const task: Task = {
      id: Math.random().toString(36).slice(2),
      name,
      priority,
      state: 'queued',
      createdAt: Date.now(),
      retries: 0,
      maxRetries: this.defaultMaxRetries,
      payload,
    };
    this.queue.push(task);
    this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    if (this._active) this.drain();
    return task;
  }

  cancel(id: string): boolean {
    const idx = this.queue.findIndex(t => t.id === id);
    if (idx < 0) return false;
    this.queue[idx].state = 'cancelled';
    this.queue.splice(idx, 1);
    return true;
  }

  start(): void {
    this._active = true;
    this.drain();
  }

  stop(): void {
    this._active = false;
  }

  stats(): SchedulerStats {
    const durations = this.done
      .filter(t => t.startedAt && t.finishedAt)
      .map(t => t.finishedAt! - t.startedAt!);
    return {
      queued: this.queue.length,
      running: this.running.size,
      done: this.done.filter(t => t.state === 'done').length,
      failed: this.done.filter(t => t.state === 'failed').length,
      totalProcessed: this.done.length,
      avgDurationMs: durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0,
    };
  }

  private drain(): void {
    while (this._active && this.running.size < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.runTask(task);
    }
  }

  private async runTask(task: Task): Promise<void> {
    task.state = 'running';
    task.startedAt = Date.now();
    this.running.set(task.id, task);

    const handler = this.handlers.get(task.name);
    if (!handler) {
      task.state = 'failed';
      task.error = `No handler for task "${task.name}"`;
      task.finishedAt = Date.now();
      this.running.delete(task.id);
      this.done.push(task);
      this.drain();
      return;
    }

    try {
      await handler(task);
      task.state = 'done';
    } catch (err) {
      if (task.retries < task.maxRetries) {
        task.retries++;
        task.state = 'queued';
        this.running.delete(task.id);
        this.queue.unshift(task);
        this.drain();
        return;
      }
      task.state = 'failed';
      task.error = String(err);
    }

    task.finishedAt = Date.now();
    this.running.delete(task.id);
    this.done.push(task);
    this.drain();
  }
}

export class WorkerPool<TWork, TResult> {
  private workers: Array<(work: TWork) => Promise<TResult>>;
  private queue: Array<{ work: TWork; resolve: (r: TResult) => void; reject: (e: Error) => void }> = [];
  private busy = new Set<number>();

  constructor(workers: Array<(work: TWork) => Promise<TResult>>) {
    this.workers = workers;
  }

  submit(work: TWork): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const freeIdx = this.workers.findIndex((_, i) => !this.busy.has(i));
      if (freeIdx >= 0) {
        this.runWorker(freeIdx, work, resolve, reject);
      } else {
        this.queue.push({ work, resolve, reject });
      }
    });
  }

  private async runWorker(
    idx: number,
    work: TWork,
    resolve: (r: TResult) => void,
    reject: (e: Error) => void,
  ): Promise<void> {
    this.busy.add(idx);
    try {
      const result = await this.workers[idx](work);
      resolve(result);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.busy.delete(idx);
      const next = this.queue.shift();
      if (next) this.runWorker(idx, next.work, next.resolve, next.reject);
    }
  }

  get pending(): number { return this.queue.length; }
  get activeworkers(): number { return this.busy.size; }
}

export function createIndexingScheduler(concurrency = 2): TaskScheduler {
  return new TaskScheduler({ concurrency, maxQueueSize: 500, defaultMaxRetries: 1 });
}

export function priorityFromFileSize(bytes: number): TaskPriority {
  if (bytes < 1_000) return 'low';
  if (bytes < 10_000) return 'normal';
  if (bytes < 100_000) return 'high';
  return 'critical';
}
