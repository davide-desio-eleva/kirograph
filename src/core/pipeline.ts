/**
 * IndexPipeline — full-index and incremental-sync pipelines.
 *
 * Owns the two heavy workflows:
 *   - indexAll(): scan all files, extract, store, resolve, detect frameworks,
 *                 generate embeddings, analyze architecture.
 *   - sync():     detect changed files via git (or full scan fallback),
 *                 re-extract only what changed, then run the same tail pipeline.
 *
 * Everything that touches the filesystem or sub-systems is injected via the
 * constructor, keeping this class testable and free of global state.
 */

import * as path from 'path';
import * as fs from 'fs';
import { GraphDatabase } from '../db/database';
import { scanDirectory, hashContent, getChangedFiles, shouldIncludeFile, findGitRoots } from '../sync/index';
import { extractFile, type ExtractedFile } from '../extraction/extractor';
import { ExtractionPool } from '../extraction/worker-pool';
import { clearParserCache, initGrammars, hasWasmGrammar } from '../extraction/grammars';
import { detectFrameworks } from '../frameworks/index';
import { ReferenceResolver } from '../resolution/index';
import { VectorManager } from '../vectors/index';
import { ArchitectureAnalyzer } from '../architecture/index';
import { clearArchitectureState } from '../architecture/incremental';
import { readGitHeads, writeGitHeads, currentHead, headKey } from '../sync/git-head';
import { withWorkspaceFileCache } from '../sync/files';
import type { KiroGraphConfig } from '../config';
import type { IndexResult, IndexProgress, SyncResult } from '../types';
import { workspaceFingerprint, isUpToDate, writeSyncState, writeSyncErrors, hasTransientErrors } from '../sync/state';
import { LockManager } from './lock-manager';
import { rustEngineFor, rustDbPaths, type RustEngine, type RustIndexEntry, type RustIndexResult } from './rust-engine';
import { detectLanguage } from '../extraction/languages';
import { WriteBatch, MAX_FILES } from './write-batch';
import { Mutex } from '../utils';
import { statKey } from '../sync/stat-key';

const FILE_IO_BATCH_SIZE = 10;
/** Below this many files starting worker threads costs more than parsing in-process saves. */
const PARALLEL_MIN_FILES = 100;

export class IndexPipeline {
  private readonly mutex = new Mutex();

  /**
   * Removes the embeddings of a file's nodes before the file is rewritten. Only with embeddings
   * enabled: otherwise there are none, and reading every file's nodes to find out cost about a
   * tenth of an index.
   */
  private async deleteEmbeddingsOfFile(filePath: string): Promise<void> {
    if (this.config.enableEmbeddings !== true) return;
    const oldNodes = this.db.getNodesByFile(filePath);
    if (oldNodes.length === 0) return;
    await this.loadVectors();
    await this.vectors.deleteEmbeddings(oldNodes.map(n => n.id));
  }

  /**
   * Loads the embedding model and engine when they were deferred (see KiroGraph.open). Called only
   * where they are needed, so a sync that changes nothing never loads the model.
   */
  private loadVectors: () => Promise<void> = async () => {};

  setVectorLoader(load: () => Promise<void>): void {
    this.loadVectors = load;
  }

  /** What the embeddings were last completed for: a change of either makes them incomplete. */
  private embeddingsKey(): string {
    return JSON.stringify([this.config.embeddingModel ?? null, this.config.semanticEngine ?? null]);
  }

  private embeddingsStatePath(): string {
    return path.join(this.projectRoot, '.kirograph', 'embeddings-state.json');
  }

  /** True when the last embedding pass ran to the end with the current model and engine. */
  private embeddingsComplete(): boolean {
    try {
      return JSON.parse(fs.readFileSync(this.embeddingsStatePath(), 'utf8')).key === this.embeddingsKey();
    } catch {
      return false;
    }
  }

  private recordEmbeddings(complete: boolean): void {
    try {
      if (!complete) { fs.rmSync(this.embeddingsStatePath(), { force: true }); return; }
      fs.writeFileSync(this.embeddingsStatePath(), JSON.stringify({ key: this.embeddingsKey(), at: Date.now() }));
    } catch { /* an optimisation: without it the next sync checks the embeddings again */ }
  }

  /**
   * Embeds the nodes that have no embedding. Skipped when no file changed and the last pass ran to
   * the end: that pass loaded every embedded id and paged through every embeddable node to find
   * nothing, and outside the MCP server it first had to load the model.
   */
  private async embedPending(graphChanged: boolean, onProgress?: (p: IndexProgress) => void): Promise<void> {
    if (this.config.enableEmbeddings !== true) return;
    if (!graphChanged && this.embeddingsComplete()) return;
    await this.loadVectors();
    if (!this.vectors.isInitialized()) return;
    onProgress?.({ phase: 'embeddings', current: 0, total: 1 });
    // Marked incomplete first: a pass that is interrupted runs again next time
    this.recordEmbeddings(false);
    await this.vectors.embedAll((current, total) => onProgress?.({ phase: 'embeddings', current, total }));
    this.recordEmbeddings(true);
  }

  constructor(
    private readonly db: GraphDatabase,
    private readonly vectors: VectorManager,
    private readonly resolver: ReferenceResolver,
    private readonly arch: ArchitectureAnalyzer,
    private readonly lock: LockManager,
    private readonly config: KiroGraphConfig,
    private readonly projectRoot: string,
  ) {}

  async indexAll(opts?: {
    onProgress?: (p: IndexProgress) => void;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<IndexResult> {
    // The phases share one listing of the workspace's files (see sync/files.ts)
    return withWorkspaceFileCache(() => this.indexAllNow(opts));
  }

  private async indexAllNow(opts?: {
    onProgress?: (p: IndexProgress) => void;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<IndexResult> {
    const release = await this.mutex.acquire();
    // Acquire the file lock inside a guard: if it throws (another live PID
    // holds it), release the in-process mutex before rethrowing. Otherwise the
    // mutex leaks and every later indexAll/sync in a long-lived process (the
    // MCP server reuses this instance) deadlocks on mutex.acquire(). heldByUs
    // gates the finally so we never unlink a lock owned by another process.
    let heldByUs = false;
    try {
      await this.lock.acquireWait();
      heldByUs = true;
    } catch (e) {
      release();
      throw e;
    }
    // A full index does not wait for the disk after each commit: it is 10% faster, and an index
    // that did not finish is run again. A process that is killed loses nothing (the operating system
    // has the writes); only a power loss during the index could, and then the index is run again.
    // Syncs keep the normal setting.
    this.db.getRawDb().run('PRAGMA synchronous=OFF');
    const start = Date.now();
    // Taken before anything is read, so an edit made during the index is seen by the next sync
    const fingerprint = workspaceFingerprint(this.projectRoot);
    const heads: Record<string, string> = {};
    for (const gitRoot of findGitRoots(this.projectRoot)) {
      const head = currentHead(gitRoot);
      if (head) heads[headKey(this.projectRoot, gitRoot)] = head;
    }
    const errors: string[] = [];
    let filesIndexed = 0;
    let nodesCreated = 0;
    let edgesCreated = 0;
    // Wall-clock time per phase, in milliseconds (IndexResult.timings)
    const timings: Record<string, number> = { fingerprint: Date.now() - start };
    let phaseStart = Date.now();
    const endPhase = (name: string): void => {
      const now = Date.now();
      timings[name] = (timings[name] ?? 0) + now - phaseStart;
      phaseStart = now;
    };

    // Track languages whose WASM parser is currently poisoned (ABORT=true on the module).
    // Once a language's parser aborts, every subsequent parse call for that language
    // fails instantly. We skip those files until clearParserCache + initGrammars succeeds.
    const poisonedLanguages = new Set<string>();
    // Track consecutive WASM crashes per language. Only poison after threshold is exceeded.
    const crashCounts = new Map<string, number>();
    const POISON_THRESHOLD = 3;
    let pool: ExtractionPool | null = null;

    try {
      const files = await scanDirectory(this.projectRoot, this.config, opts?.signal);
      opts?.onProgress?.({ phase: 'scanning', current: files.length, total: files.length });
      endPhase('scan');

      // Batch-read files in parallel. Each file's stat key is taken before it is read (see
      // FileRecord.statKey), so a write made during the read shows as a change at the next sync.
      const contentMap = new Map<string, Buffer>();
      const statKeys = new Map<string, string>();
      for (let b = 0; b < files.length; b += FILE_IO_BATCH_SIZE) {
        const batch = files.slice(b, b + FILE_IO_BATCH_SIZE);
        const results = await Promise.all(batch.map(async f => {
          const st = await fs.promises.stat(f).catch(() => null);
          const content = await fs.promises.readFile(f).catch(() => null);
          return { st, content };
        }));
        for (let i = 0; i < batch.length; i++) {
          if (results[i].content) contentMap.set(batch[i], results[i].content!);
          if (results[i].st) statKeys.set(batch[i], statKey(results[i].st!));
        }
      }

      const extractOpts = { enableComplexity: !!(this.config as any).enableComplexity, maxFileSize: this.config.maxFileSize };
      endPhase('read');

      // engine "rust": the native engine parses the languages it has a grammar for and writes every
      // file. The others are extracted here, as usual, and handed to it in file order.
      const rust = rustEngineFor(this.config);
      const nativeLangs = new Set(rust?.nativeLanguages() ?? []);
      const rustEntries: RustIndexEntry[] = [];
      // Files the WASM parser crashed on in this run: the only ones the retry below re-parses
      const parseFailed = new Set<string>();

      // Parsing runs on worker threads, a few files ahead of the loop that writes them. The loop
      // takes the results in file order, so the graph is the same as when parsing in-process.
      if (files.length >= PARALLEL_MIN_FILES) pool = ExtractionPool.create();
      const parsing = new Map<number, Promise<ExtractedFile | null>>();
      // Files parsed ahead of the loop: a write batch's worth and more, so the workers keep
      // parsing while the loop flushes a batch (writing 100 files holds this thread for a while)
      const lookahead = pool ? Math.max(pool.size * 4, MAX_FILES * 2) : 0;
      const startParsing = async (from: number): Promise<void> => {
        if (!pool) return;
        for (let j = from; j < Math.min(files.length, from + lookahead); j++) {
          if (parsing.has(j)) continue;
          const f = files[j];
          const content = contentMap.get(f);
          if (!content || content.length > this.config.maxFileSize) continue;
          if (poisonedLanguages.has(detectLanguage(f))) continue;
          if (nativeLangs.has(detectLanguage(f))) continue; // parsed by the native engine
          if (!opts?.force) {
            const known = this.db.getFile(path.relative(this.projectRoot, f).replace(/\\/g, '/'));
            if (known && hashContent(content) === known.contentHash) continue;
          }
          const job = pool.run(f, this.projectRoot, content, extractOpts);
          job.catch(() => { /* taken up by the loop, which parses the file itself */ });
          parsing.set(j, job);
        }
      };

      const batch = new WriteBatch(this.db);
      // Time spent writing, within the parse-and-write loop (reported apart from parsing)
      let writeMs = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        opts?.onProgress?.({ phase: 'parsing', current: i + 1, total: files.length, currentFile: file });
        await startParsing(i);

        try {
          if (rust && nativeLangs.has(detectLanguage(file))) {
            rustEntries.push({ path: file, language: detectLanguage(file), statKey: statKeys.get(file) });
            continue;
          }
          const content = contentMap.get(file);
          if (!content) continue;
          if (content.length > this.config.maxFileSize) continue;

          const relPath = path.relative(this.projectRoot, file).replace(/\\/g, '/');

          if (!opts?.force) {
            const existing = this.db.getFile(relPath);
            if (existing && hashContent(content) === existing.contentHash) continue;
          }

          // Skip files whose language parser is currently poisoned
          const lang = detectLanguage(file);
          if (poisonedLanguages.has(lang)) continue;

          let extracted: ExtractedFile | null;
          const ahead = parsing.get(i);
          parsing.delete(i);
          try {
            extracted = ahead ? await ahead : await extractFile(file, this.projectRoot, content, extractOpts);
          } catch {
            // The worker failed: parse it here, where a failure is handled as it always was
            extracted = await extractFile(file, this.projectRoot, content, extractOpts);
          }
          if (!extracted) continue;
          if (extracted.parseFailed) parseFailed.add(extracted.filePath);

          if (rust) {
            // Written by the native engine, in file order (its replaced embeddings are removed after)
            rustEntries.push({ extracted: JSON.stringify(extracted), statKey: statKeys.get(file) });
            crashCounts.set(lang, 0);
            continue;
          }

          await this.deleteEmbeddingsOfFile(extracted.filePath);

          // Written with the other files of its batch, in one transaction (see WriteBatch)
          const writeStart = Date.now();
          batch.add(() => {
            this.db.deleteNodesByFile(extracted.filePath);
            this.db.deleteUnresolvedRefsByFile(extracted.filePath);
            this.db.upsertFile({
              path: extracted.filePath,
              contentHash: extracted.contentHash,
              language: extracted.language,
              fileSize: extracted.fileSize,
              symbolCount: extracted.nodes.length,
              indexedAt: Date.now(),
              statKey: statKeys.get(file) ?? null,
            });
            this.db.upsertNodes(extracted.nodes); nodesCreated += extracted.nodes.length;
            this.db.insertEdges(extracted.edges); edgesCreated += extracted.edges.length;
            for (const mount of extracted.routeMounts ?? []) this.db.insertRouteMount(extracted.filePath, mount);
            this.db.insertUnresolvedRefs(extracted.filePath, extracted.unresolvedRefs);
            filesIndexed++;
          }, writeErr => {
            errors.push(`${file}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
          }, extracted.nodes.length + extracted.edges.length + extracted.unresolvedRefs.length);
          writeMs += Date.now() - writeStart;
          // Reset crash count on successful parse for this language
          crashCounts.set(lang, 0);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${file}: ${msg}`);

          // Detect WASM runtime abort and attempt recovery
          const isWasmCrash = (err as any)?.constructor?.name === 'RuntimeError'
            || msg.includes('Aborted(') 
            || msg.includes('RuntimeError')
            || msg.includes('WASM grammar exists but failed to load');
          if (isWasmCrash) {
            const lang = detectLanguage(file);
            const count = (crashCounts.get(lang) ?? 0) + 1;
            crashCounts.set(lang, count);

            // Only poison the language after multiple consecutive crashes
            if (count >= POISON_THRESHOLD) {
              poisonedLanguages.add(lang);
            }

            clearParserCache();
            try {
              await initGrammars();
              // Recovery succeeded — WASM runtime is usable again.
              // Languages with count >= POISON_THRESHOLD remain permanently disabled
              // for this run. Other languages (below threshold) were never poisoned
              // and continue parsing normally.
            } catch {
              errors.push('WASM runtime unrecoverable after crash — aborting batch');
              break;
            }
          }
        }
      }

      const flushStart = Date.now();
      batch.flush();
      writeMs += Date.now() - flushStart;
      endPhase('extract');
      timings.extract -= writeMs;
      timings.write = writeMs;
      // Parsing is over: release the workers before resolution and embeddings, which need the memory
      await pool?.close();
      pool = null;

      if (rust) {
        const native = await this.runRust(rust, rustEntries, {
          force: !!opts?.force, trackOversize: false, synchronousOff: true, collectStats: false,
        }, (current, total) => opts?.onProgress?.({ phase: 'parsing', current, total }));
        filesIndexed += native.filesIndexed;
        nodesCreated += native.nodesCreated;
        edgesCreated += native.edgesCreated;
        errors.push(...native.errors);
        for (const [k, ms] of Object.entries(native.timings)) timings[`rust.${k}`] = Math.round(ms);
        endPhase('native');
      }

      // Re-parse the files the WASM parser crashed on (recorded without symbols), now that the
      // workers are gone. Every file without symbols used to be parsed again, which on a project
      // with many files that have none (SQL migrations, data YAML) doubled the parsing time.
      const emptyFiles = this.db.getAllFiles().filter(
        (f: any) => parseFailed.has(f.path) && f.symbolCount === 0 && hasWasmGrammar(f.language) && !nativeLangs.has(f.language)
      );
      if (emptyFiles.length > 0) {
        opts?.onProgress?.({ phase: 'retrying', current: 0, total: emptyFiles.length });
        for (let i = 0; i < emptyFiles.length; i++) {
          const ef = emptyFiles[i];
          const absPath = path.join(this.projectRoot, ef.path);
          opts?.onProgress?.({ phase: 'retrying', current: i + 1, total: emptyFiles.length, currentFile: absPath });
          try {
            const extracted = await extractFile(absPath, this.projectRoot, undefined, { enableComplexity: !!(this.config as any).enableComplexity });
            if (!extracted || extracted.nodes.length === 0) continue;

            await this.deleteEmbeddingsOfFile(extracted.filePath);

            this.db.transaction(() => {
              this.db.deleteNodesByFile(extracted.filePath);
              this.db.deleteUnresolvedRefsByFile(extracted.filePath);
              this.db.upsertFile({
                path: extracted.filePath,
                contentHash: extracted.contentHash,
                language: extracted.language,
                fileSize: extracted.fileSize,
                symbolCount: extracted.nodes.length,
                indexedAt: Date.now(),
              });
              this.db.upsertNodes(extracted.nodes); nodesCreated += extracted.nodes.length;
              this.db.insertEdges(extracted.edges); edgesCreated += extracted.edges.length;
              for (const mount of extracted.routeMounts ?? []) this.db.insertRouteMount(extracted.filePath, mount);
              this.db.insertUnresolvedRefs(extracted.filePath, extracted.unresolvedRefs);
            });
            filesIndexed++;
          } catch {
            // Already logged in first pass or genuinely broken — skip
          }
        }
      }

      endPhase('retry');

      // Resolve cross-file references
      opts?.onProgress?.({ phase: 'resolving', current: 0, total: 1 });
      await this.resolver.resolveAll((current, total) => {
        opts?.onProgress?.({ phase: 'resolving', current, total });
      });
      endPhase('resolve');

      // Detect frameworks
      opts?.onProgress?.({ phase: 'detecting frameworks', current: 0, total: 1 });
      const detectedFrameworks = await detectFrameworks(this.projectRoot, this.db);
      const languages = [...new Set(this.db.getAllFiles().map(f => (f as any).language).filter(Boolean))];
      opts?.onProgress?.({
        phase: 'detecting frameworks', current: 1, total: 1,
        meta: { frameworks: detectedFrameworks.map(f => f.name), languages },
      });
      endPhase('frameworks');

      // Generate embeddings (if enabled)
      await this.embedPending(true, opts?.onProgress);
      endPhase('embeddings');

      // Analyze architecture (if enabled, or auto-enabled for security)
      if (this.config.enableArchitecture || this.config.enableSecurity) {
        if (this.config.enableSecurity && !this.config.enableArchitecture) {
          const { logWarn } = await import('../errors');
          logWarn('enableSecurity requires enableArchitecture — auto-enabling architecture analysis for this run');
        }
        opts?.onProgress?.({ phase: 'architecture', current: 0, total: 1 });
        // A full index always runs it, and records its inputs for the syncs that follow
        await this.db.getRawDb().coalesce(() => this.arch.analyzeIfChanged(true, msg =>
          opts?.onProgress?.({ phase: 'architecture', current: 0, total: 1, meta: { msg } })
        ));
        opts?.onProgress?.({ phase: 'architecture', current: 1, total: 1 });
      }

      // Run security analysis (if enabled)
      if (this.config.enableSecurity) {
        try {
          const { SecurityPipeline } = await import('../security/pipeline');
          this.db.applySecuritySchema();
          const secPipeline = new SecurityPipeline(this.db, this.config, this.projectRoot);
          opts?.onProgress?.({ phase: 'security', current: 0, total: 1 });
          await this.db.getRawDb().coalesce(() => secPipeline.run((phase, current, total) =>
            opts?.onProgress?.({ phase: 'security', current, total, meta: { secPhase: phase } })
          ));
          opts?.onProgress?.({ phase: 'security', current: 1, total: 1 });
        } catch { /* security analysis is non-critical */ }
      }

      // Index documentation (if enabled)
      if (this.config.enableDocs) {
        try {
          const { DocsIndexer } = await import('../docs/indexer');
          this.db.applyDocsSchema();
          const docsIndexer = new DocsIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await this.db.getRawDb().coalesce(() => docsIndexer.indexAll({
            force: opts?.force,
            onProgress: msg => opts?.onProgress?.({ phase: 'docs', current: 0, total: 1, meta: { msg } }),
          }));
        } catch { /* docs indexing is non-critical */ }
      }

      // Index data files (if enabled)
      if ((this.config as any).enableData) {
        try {
          const { DataIndexer } = await import('../data/indexer');
          this.db.applyDataSchema();
          const dataIndexer = new DataIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await this.db.getRawDb().coalesce(() => dataIndexer.indexAll({
            onProgress: msg => opts?.onProgress?.({ phase: 'data', current: 0, total: 1, meta: { msg } }),
          }));

          // Assign data files to 'data' architecture layer if architecture is enabled
          if (this.config.enableArchitecture) {
            try {
              const rawDb = this.db.getRawDb();
              // Check if arch_file_layers table exists
              const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='arch_file_layers'");
              if (tableExists) {
                const datasets = rawDb.all('SELECT file_path FROM data_datasets') as Array<{ file_path: string }>;
                for (const ds of datasets) {
                  rawDb.run(
                    `INSERT OR REPLACE INTO arch_file_layers (file_path, layer_id, confidence) VALUES (?, ?, ?)`,
                    [ds.file_path, 'layer:data', 1.0],
                  );
                }
              }
            } catch { /* non-critical */ }
          }
        } catch { /* data indexing is non-critical */ }
      }

      // Index pattern matches (if enabled)
      if ((this.config as any).enablePatterns) {
        try {
          this.db.applyPatternsSchema();
          const { PatternIndexer } = await import('../patterns/indexer');
          const indexer = new PatternIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await indexer.indexAll((phase, current, total) => {
            opts?.onProgress?.({ phase: 'patterns' as any, current, total });
          });
        } catch (err) {
          // Patterns are non-critical — log and continue
          const { logWarn } = await import('../errors');
          const msg = err instanceof Error ? err.message : String(err);
          logWarn(`[patterns] Pattern indexing failed (non-critical): ${msg}`);
        }
      }

      this.lock.clearDirty();
      // Files that fail to parse fail the same way until they change, so they do not keep the
      // fingerprint from being recorded; an error that may pass on its own (a busy database) does
      writeSyncErrors(this.projectRoot, errors);
      if (!hasTransientErrors(errors)) {
        if (fingerprint) writeSyncState(this.projectRoot, fingerprint);
        writeGitHeads(this.projectRoot, heads);
      }
      endPhase('other');
      return { success: errors.length === 0, filesIndexed, nodesCreated, edgesCreated, errors, duration: Date.now() - start, timings };
    } finally {
      await pool?.close();
      try { this.db.getRawDb().run('PRAGMA synchronous=NORMAL'); } catch { /* the database is closed or gone */ }
      if (heldByUs) this.lock.release();
      release();
    }
  }

  /**
   * Hands the entries to the native engine, which writes them in order. The embeddings of the
   * nodes it replaced are removed afterwards (the TypeScript path removes them before each write;
   * the end state is the same: a replaced node is embedded again by embedPending).
   */
  private async runRust(
    rust: RustEngine,
    entries: RustIndexEntry[],
    mode: { force: boolean; trackOversize: boolean; synchronousOff: boolean; collectStats: boolean },
    onProgress: (current: number, total: number) => void,
  ): Promise<RustIndexResult> {
    const embeddings = this.config.enableEmbeddings === true;
    const result = await rust.indexFiles({
      projectRoot: this.projectRoot,
      ...rustDbPaths(this.projectRoot),
      force: mode.force,
      enableComplexity: !!(this.config as any).enableComplexity,
      maxFileSize: this.config.maxFileSize,
      trackOversize: mode.trackOversize,
      synchronousOff: mode.synchronousOff,
      collectStats: mode.collectStats,
      collectRemovedIds: embeddings,
    }, entries, onProgress);
    if (embeddings && result.removedNodeIds.length > 0) {
      await this.loadVectors();
      await this.vectors.deleteEmbeddings(result.removedNodeIds);
    }
    return result;
  }

  private hasIndexedFiles(): boolean {
    return this.db.getRawDb().get('SELECT 1 AS x FROM files LIMIT 1') != null;
  }

  /**
   * True when the workspace is known to have changed since the last sync: the dirty marker is set,
   * or its fingerprint differs. False when that cannot be known (no fingerprint): sync-if-dirty
   * then leaves it to the marker.
   */
  hasKnownChanges(): boolean {
    if (this.lock.isDirty()) return true;
    const fingerprint = workspaceFingerprint(this.projectRoot);
    if (!fingerprint) return false;
    return !this.hasIndexedFiles() || !isUpToDate(this.projectRoot, fingerprint);
  }

  /** True when nothing has changed since the last sync that ended without errors. */
  isUpToDate(): boolean {
    if (!this.hasIndexedFiles()) return false; // never indexed
    if (this.lock.isDirty()) return false;     // see sync()
    return isUpToDate(this.projectRoot, workspaceFingerprint(this.projectRoot));
  }

  async sync(opts?: {
    changedFiles?: string[];
    onProgress?: (p: IndexProgress) => void;
    /** Run in full even when nothing seems to have changed. */
    full?: boolean;
  }): Promise<SyncResult> {
    // The phases share one listing of the workspace's files (see sync/files.ts)
    return withWorkspaceFileCache(() => this.syncNow(opts));
  }

  private async syncNow(opts?: {
    changedFiles?: string[];
    onProgress?: (p: IndexProgress) => void;
    full?: boolean;
  }): Promise<SyncResult> {
    // Taken before anything is read, so an edit made during the sync is seen by the next one
    const fingerprint = opts?.changedFiles ? null : workspaceFingerprint(this.projectRoot);
    // The dirty marker is an explicit signal (written by the file-save hook, and the only one for
    // an ignored file the fingerprint cannot see), so a sync that finds it is never skipped
    if (!opts?.full && fingerprint && this.hasIndexedFiles() && !this.lock.isDirty()
        && isUpToDate(this.projectRoot, fingerprint)) {
      return {
        added: [], modified: [], removed: [],
        nodesCreated: 0, nodesUpdated: 0, nodesRemoved: 0,
        edgesCreated: 0, edgesRemoved: 0,
        filesScanned: 0, errors: [], duration: 0, skipped: true,
      };
    }

    const release = await this.mutex.acquire();
    // Acquire the file lock inside a guard: if it throws (another live PID
    // holds it), release the in-process mutex before rethrowing. Otherwise the
    // mutex leaks and every later indexAll/sync in a long-lived process (the
    // MCP server reuses this instance) deadlocks on mutex.acquire(). heldByUs
    // gates the finally so we never unlink a lock owned by another process.
    let heldByUs = false;
    try {
      await this.lock.acquireWait();
      heldByUs = true;
    } catch (e) {
      release();
      throw e;
    }
    const start = Date.now();
    const changedFiles = opts?.changedFiles;
    const onProgress = opts?.onProgress;
    const result: SyncResult = {
      added: [], modified: [], removed: [],
      nodesCreated: 0, nodesUpdated: 0, nodesRemoved: 0,
      edgesCreated: 0, edgesRemoved: 0,
      filesScanned: 0, errors: [], duration: 0,
    };

    try {
      const removeFile = async (rel: string) => {
        result.nodesRemoved += this.db.countNodesByFile(rel);
        result.edgesRemoved += this.db.countEdgesTouchingFile(rel);
        await this.deleteEmbeddingsOfFile(rel);
        this.db.deleteFile(rel);
        this.db.deleteUnresolvedRefsByFile(rel);
        // Clean up pattern matches for removed files (only if patterns are enabled)
        if ((this.config as any).enablePatterns) {
          this.db.getRawDb().run('DELETE FROM pattern_matches WHERE file_path = ?', [rel]);
        }
        result.removed.push(rel);
      };

      // ── Exclude-rule cleanup ──────────────────────────────────────────────
      // Remove any indexed files that now match the current exclude patterns.
      // This handles the case where a user adds a new exclude pattern (e.g.
      // "**/.vite/**") and expects those files to disappear from the index on
      // the next sync without needing a full --force re-index.
      const allIndexed = this.db.getAllFiles();
      for (const f of allIndexed) {
        if (!shouldIncludeFile(f.path, this.config)) {
          onProgress?.({ phase: 'scanning', current: 0, total: 0, meta: { excludeCleanup: true, file: f.path } });
          await removeFile(f.path);
        }
      }

      let filesToProcess: string[];

      onProgress?.({ phase: 'scanning', current: 0, total: 0 });

      // The HEAD of each repository, read before any file is: recorded after the sync, so the next
      // one adds the files of the commits made meanwhile (see sync/git-head.ts)
      let heads: Record<string, string> | null = null;

      if (changedFiles) {
        filesToProcess = changedFiles.map(f => path.resolve(this.projectRoot, f));
      } else {
        const gitChanged = await getChangedFiles(this.projectRoot, this.config, readGitHeads(this.projectRoot));
        heads = gitChanged.heads;
        const hasChanges = gitChanged.added.length > 0 || gitChanged.modified.length > 0 || gitChanged.removed.length > 0;

        // Only the changed files when the lists are known to cover everything: the uncommitted
        // changes, and the commits since the last sync. Otherwise (no recorded heads, a repository
        // git could not read, or nothing changed at all) every file is looked at, by hash
        if (hasChanges && gitChanged.complete) {
          for (const p of gitChanged.removed) {
            await removeFile(path.relative(this.projectRoot, p).replace(/\\/g, '/'));
          }
          filesToProcess = [...gitChanged.added, ...gitChanged.modified];
        } else {
          // Full scan + detect removed files
          const scanned = await scanDirectory(this.projectRoot, this.config);
          const indexed = new Set(this.db.getAllFiles().map(f => f.path));
          const current = new Set(scanned.map(f => path.relative(this.projectRoot, f).replace(/\\/g, '/')));
          result.filesScanned = current.size;
          for (const p of indexed) {
            if (!current.has(p)) await removeFile(p);
          }
          filesToProcess = scanned;
        }
      }

      result.filesScanned = result.filesScanned || filesToProcess.length;
      onProgress?.({ phase: 'scanning', current: result.filesScanned, total: result.filesScanned });

      const poisonedLanguages = new Set<string>();
      const crashCounts = new Map<string, number>();
      const POISON_THRESHOLD = 3;

      // engine "rust": as in indexAll, the native engine parses its languages and writes every file
      const rust = rustEngineFor(this.config);
      const nativeLangs = new Set(rust?.nativeLanguages() ?? []);
      const rustEntries: RustIndexEntry[] = [];

      // Unchanged files whose stat key was not recorded yet: recorded after the loop, in one go
      const unchangedKeys: Array<[string, string]> = [];
      // What the index knows of each file, read once: a query per file was most of the time a
      // sync spent going over every file (the fallback scan)
      const knownFiles = new Map(this.db.getAllFiles().map(f => [f.path, f] as const));
      // Stats taken in parallel, a few at a time, before the loop needs them
      const stats = new Map<string, fs.Stats | null>();
      for (let b = 0; b < filesToProcess.length; b += 64) {
        const slice = filesToProcess.slice(b, b + 64);
        const got = await Promise.all(slice.map(f => fs.promises.stat(f).catch(() => null)));
        slice.forEach((f, k) => stats.set(f, got[k]));
      }
      const batch = new WriteBatch(this.db);
      for (let i = 0; i < filesToProcess.length; i++) {
        const file = filesToProcess[i];
        onProgress?.({ phase: 'parsing', current: i + 1, total: filesToProcess.length, currentFile: file });

        if (!stats.get(file) && !fs.existsSync(file)) {
          const rel = path.relative(this.projectRoot, file).replace(/\\/g, '/');
          await removeFile(rel);
          continue;
        }

        try {
          // Skip files whose language parser is currently poisoned
          const lang = detectLanguage(file);
          if (poisonedLanguages.has(lang)) continue;

          // Skip an unchanged file before parsing it. Parsing is the expensive step, and when git
          // reports no changes (clean tree, after a pull or a branch switch) the fallback scan
          // reaches every indexed file. A file whose stat key (size, mtime, ctime) is the one
          // recorded is not even read; otherwise its hash decides, and the key is recorded.
          const relFile = path.relative(this.projectRoot, file).replace(/\\/g, '/');
          const st = stats.get(file) ?? null;
          const key = st ? statKey(st) : null;
          const known = knownFiles.get(relFile);
          if (known && st && st.size <= this.config.maxFileSize && key && known.statKey === key) continue;

          // engine "rust": the native engine compares the hash and writes the file (with this key)
          if (rust && nativeLangs.has(lang)) {
            rustEntries.push({ path: file, language: lang, statKey: key ?? undefined });
            continue;
          }

          if (known && st && st.size <= this.config.maxFileSize) {
            const content = await fs.promises.readFile(file).catch(() => null);
            if (content && hashContent(content) === known.contentHash) {
              if (key) unchangedKeys.push([relFile, key]);
              continue;
            }
          }

          const extracted = await extractFile(file, this.projectRoot, undefined, { enableComplexity: !!(this.config as any).enableComplexity, maxFileSize: this.config.maxFileSize });
          if (!extracted) continue;

          const existing = this.db.getFile(extracted.filePath);
          const isNew = !existing;
          if (!isNew && existing!.contentHash === extracted.contentHash) continue;

          if (rust) {
            // Written by the native engine, which also counts what it replaces
            rustEntries.push({ extracted: JSON.stringify(extracted), statKey: key ?? undefined });
            crashCounts.set(lang, 0);
            continue;
          }

          const oldNodeCount = this.db.countNodesByFile(extracted.filePath);
          const oldEdgeCount = this.db.countEdgesTouchingFile(extracted.filePath);
          await this.deleteEmbeddingsOfFile(extracted.filePath);

          // Written with the other files of its batch, in one transaction (see WriteBatch)
          batch.add(() => {
            result.nodesRemoved += oldNodeCount;
            result.edgesRemoved += oldEdgeCount;
            this.db.deleteNodesByFile(extracted.filePath);
            this.db.deleteUnresolvedRefsByFile(extracted.filePath);
            this.db.upsertFile({
              path: extracted.filePath,
              contentHash: extracted.contentHash,
              language: extracted.language,
              fileSize: extracted.fileSize,
              symbolCount: extracted.nodes.length,
              indexedAt: Date.now(),
              statKey: key,
            });
            this.db.upsertNodes(extracted.nodes); result.nodesCreated += extracted.nodes.length;
            this.db.insertEdges(extracted.edges); result.edgesCreated += extracted.edges.length;
            for (const mount of extracted.routeMounts ?? []) this.db.insertRouteMount(extracted.filePath, mount);
            this.db.insertUnresolvedRefs(extracted.filePath, extracted.unresolvedRefs);
            this.resolver.invalidateFile(extracted.filePath);
            if (isNew) result.added.push(extracted.filePath);
            else { result.modified.push(extracted.filePath); result.nodesUpdated += extracted.nodes.length; }
          }, writeErr => {
            result.errors.push(`${file}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
          }, extracted.nodes.length + extracted.edges.length + extracted.unresolvedRefs.length);
          // Reset crash count on successful parse for this language
          crashCounts.set(lang, 0);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${file}: ${msg}`);

          // Detect WASM runtime abort and attempt recovery
          const isWasmCrash = (err as any)?.constructor?.name === 'RuntimeError'
            || msg.includes('Aborted(') 
            || msg.includes('RuntimeError')
            || msg.includes('WASM grammar exists but failed to load');
          if (isWasmCrash) {
            const lang = detectLanguage(file);
            const count = (crashCounts.get(lang) ?? 0) + 1;
            crashCounts.set(lang, count);

            if (count >= POISON_THRESHOLD) {
              poisonedLanguages.add(lang);
            }

            clearParserCache();
            try {
              await initGrammars();
              // Recovery succeeded — WASM runtime is usable again.
              // Languages at POISON_THRESHOLD stay disabled for this run.
            } catch {
              result.errors.push('WASM runtime unrecoverable after crash — aborting sync');
              break;
            }
          }
        }
      }

      batch.flush();
      if (rust && rustEntries.length > 0) {
        const native = await this.runRust(rust, rustEntries, {
          force: false, trackOversize: true, synchronousOff: false, collectStats: true,
        }, (current, total) => onProgress?.({ phase: 'parsing', current, total }));
        // Files the native engine found unchanged by their hash: their stat key is recorded too
        const keyOf = new Map(rustEntries.filter(e => e.path && e.statKey)
          .map(e => [path.relative(this.projectRoot, e.path!).replace(/\\/g, '/'), e.statKey!] as const));
        for (const p of native.unchangedPaths) {
          const k = keyOf.get(p);
          if (k) unchangedKeys.push([p, k]);
        }
        for (const f of native.files) {
          result.nodesRemoved += f.oldNodes;
          result.edgesRemoved += f.oldEdges;
          result.nodesCreated += f.nodes;
          result.edgesCreated += f.edges;
          if (f.isNew) result.added.push(f.path);
          else { result.modified.push(f.path); result.nodesUpdated += f.nodes; }
        }
        result.errors.push(...native.errors);
      }
      this.db.setFileStatKeys(unchangedKeys);

      // Resolve cross-file references. When no file was added, changed or removed, no node or
      // reference is new, so resolution has nothing to find: every unresolved reference was
      // already tried against the same nodes.
      if (result.added.length + result.modified.length + result.removed.length > 0) {
        onProgress?.({ phase: 'resolving', current: 0, total: 1 });
        await this.resolver.resolveAll((current, total) => {
          onProgress?.({ phase: 'resolving', current, total });
        }, [...result.added, ...result.modified, ...result.removed]);
      }

      await detectFrameworks(this.projectRoot);

      // Whether any file was added, changed or removed: the phases below that read only the graph
      // (and files of their own, which they check themselves) have nothing new to see without it
      const graphChanged = result.added.length + result.modified.length + result.removed.length > 0;

      // Generate embeddings (if enabled)
      await this.embedPending(graphChanged, onProgress);

      // Analyze architecture (if enabled, or auto-enabled for security)
      if (this.config.enableArchitecture || this.config.enableSecurity) {
        if (this.config.enableSecurity && !this.config.enableArchitecture) {
          const { logWarn } = await import('../errors');
          logWarn('enableSecurity requires enableArchitecture — auto-enabling architecture analysis for this run');
        }
        onProgress?.({ phase: 'architecture', current: 0, total: 1 });
        // Skipped when the graph, the manifests and the configuration are as at the last run
        await this.db.getRawDb().coalesce(() => this.arch.analyzeIfChanged(graphChanged, msg =>
          onProgress?.({ phase: 'architecture', current: 0, total: 1, meta: { msg } })
        ));
        onProgress?.({ phase: 'architecture', current: 1, total: 1 });
      } else if (graphChanged) {
        // The analysis did not see this change: if it is turned on later, it must run
        clearArchitectureState(this.projectRoot);
      }

      // Run security analysis (if enabled)
      if (this.config.enableSecurity) {
        try {
          const { SecurityPipeline } = await import('../security/pipeline');
          this.db.applySecuritySchema();
          const secPipeline = new SecurityPipeline(this.db, this.config, this.projectRoot);
          onProgress?.({ phase: 'security', current: 0, total: 1 });
          // Only what the changes since the last complete run require: see security/incremental.ts
          await this.db.getRawDb().coalesce(() => secPipeline.run(
            (phase, current, total) =>
              onProgress?.({ phase: 'security', current, total, meta: { secPhase: phase } }),
            { incremental: { graphChanged } },
          ));
          onProgress?.({ phase: 'security', current: 1, total: 1 });
        } catch { /* security analysis is non-critical */ }
      }

      // Re-index documentation (if enabled)
      if (this.config.enableDocs) {
        try {
          const { DocsIndexer } = await import('../docs/indexer');
          this.db.applyDocsSchema();
          const docsIndexer = new DocsIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await this.db.getRawDb().coalesce(() => docsIndexer.indexAll({
            onProgress: msg => onProgress?.({ phase: 'docs', current: 0, total: 1, meta: { msg } }),
          }));
        } catch { /* docs indexing is non-critical */ }
      }

      // Re-index data files (if enabled)
      if ((this.config as any).enableData) {
        try {
          const { DataIndexer } = await import('../data/indexer');
          this.db.applyDataSchema();
          const dataIndexer = new DataIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await this.db.getRawDb().coalesce(() => dataIndexer.indexAll({
            onProgress: msg => onProgress?.({ phase: 'data', current: 0, total: 1, meta: { msg } }),
          }));

          // Assign data files to 'data' architecture layer if architecture is enabled
          if (this.config.enableArchitecture) {
            try {
              const rawDb = this.db.getRawDb();
              const tableExists = rawDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='arch_file_layers'");
              if (tableExists) {
                const datasets = rawDb.all('SELECT file_path FROM data_datasets') as Array<{ file_path: string }>;
                for (const ds of datasets) {
                  rawDb.run(
                    `INSERT OR REPLACE INTO arch_file_layers (file_path, layer_id, confidence) VALUES (?, ?, ?)`,
                    [ds.file_path, 'layer:data', 1.0],
                  );
                }
              }
            } catch { /* non-critical */ }
          }
        } catch { /* data indexing is non-critical */ }
      }

      // Re-index pattern matches for changed files (if enabled)
      if ((this.config as any).enablePatterns) {
        try {
          const tableExists = this.db.getRawDb().get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='pattern_matches'"
          );
          if (tableExists) {
            const { PatternIndexer } = await import('../patterns/indexer');
            const { PatternLibraryLoader } = await import('../patterns/loader');
            const { PatternRunner } = await import('../patterns/runner');
            const runner = new PatternRunner();
            if (runner.isAvailable()) {
              const loader = new PatternLibraryLoader();
              const builtinPath = require('path').join(__dirname, '../patterns/library');
              const rules = loader.load(builtinPath, (this.config as any).patternLibraryPath);
              const threshold = (this.config as any).patternSeverityThreshold ?? 'low';
              const indexer = new PatternIndexer(this.db.getRawDb(), this.config, this.projectRoot);
              const changedPaths = [...result.added, ...result.modified];
              for (const filePath of changedPaths) {
                const fileRecord = this.db.getFile(filePath);
                const language = fileRecord?.language ?? 'unknown';
                await indexer.indexFile(filePath, language, rules, runner, threshold, Date.now());
              }
            }
          }
        } catch { /* non-critical */ }
      }

      this.lock.clearDirty();
      // A sync with errors is not recorded: the files that failed are tried again next time
      writeSyncErrors(this.projectRoot, result.errors);
      if (!hasTransientErrors(result.errors)) {
        if (fingerprint) writeSyncState(this.projectRoot, fingerprint);
        if (heads) writeGitHeads(this.projectRoot, heads);
      }
      result.duration = Date.now() - start;
      return result;
    } finally {
      if (heldByUs) this.lock.release();
      release();
    }
  }
}
