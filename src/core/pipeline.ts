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
import { scanDirectory, hashContent, getChangedFiles, shouldIncludeFile } from '../sync/index';
import { extractFile } from '../extraction/extractor';
import { clearParserCache, initGrammars, hasWasmGrammar } from '../extraction/grammars';
import { detectFrameworks } from '../frameworks/index';
import { ReferenceResolver } from '../resolution/index';
import { VectorManager } from '../vectors/index';
import { ArchitectureAnalyzer } from '../architecture/index';
import type { KiroGraphConfig } from '../config';
import type { IndexResult, IndexProgress, SyncResult } from '../types';
import { LockManager } from './lock-manager';
import { Mutex } from '../utils';

const FILE_IO_BATCH_SIZE = 10;

export class IndexPipeline {
  private readonly mutex = new Mutex();

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
    const release = await this.mutex.acquire();
    this.lock.acquire();
    const start = Date.now();
    const errors: string[] = [];
    let filesIndexed = 0;
    let nodesCreated = 0;
    let edgesCreated = 0;

    // Track languages whose WASM parser is currently poisoned (ABORT=true on the module).
    // Once a language's parser aborts, every subsequent parse call for that language
    // fails instantly. We skip those files until clearParserCache + initGrammars succeeds.
    const poisonedLanguages = new Set<string>();

    try {
      const files = await scanDirectory(this.projectRoot, this.config, opts?.signal);
      opts?.onProgress?.({ phase: 'scanning', current: files.length, total: files.length });

      // Batch-read files in parallel
      const contentMap = new Map<string, Buffer>();
      for (let b = 0; b < files.length; b += FILE_IO_BATCH_SIZE) {
        const batch = files.slice(b, b + FILE_IO_BATCH_SIZE);
        const results = await Promise.all(batch.map(f => fs.promises.readFile(f).catch(() => null)));
        for (let i = 0; i < batch.length; i++) {
          if (results[i]) contentMap.set(batch[i], results[i]!);
        }
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        opts?.onProgress?.({ phase: 'parsing', current: i + 1, total: files.length, currentFile: file });

        try {
          const content = contentMap.get(file);
          if (!content) continue;
          if (content.length > this.config.maxFileSize) continue;

          const relPath = path.relative(this.projectRoot, file).replace(/\\/g, '/');

          if (!opts?.force) {
            const existing = this.db.getFile(relPath);
            if (existing && hashContent(content) === existing.contentHash) continue;
          }

          // Skip files whose language parser is currently poisoned
          const { detectLanguage } = await import('../extraction/languages');
          const lang = detectLanguage(file);
          if (poisonedLanguages.has(lang)) continue;

          const extracted = await extractFile(file, this.projectRoot, content, { enableComplexity: !!(this.config as any).enableComplexity });
          if (!extracted) continue;

          const oldNodes = this.db.getNodesByFile(extracted.filePath);
          if (oldNodes.length > 0) await this.vectors.deleteEmbeddings(oldNodes.map(n => n.id));

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
            for (const node of extracted.nodes) { this.db.upsertNode(node); nodesCreated++; }
            for (const edge of extracted.edges) { this.db.insertEdge(edge); edgesCreated++; }
            for (const ref of extracted.unresolvedRefs) {
              this.db.insertUnresolvedRef(ref.sourceId, ref.refName, ref.refKind, extracted.filePath, ref.line, ref.column);
            }
          });

          filesIndexed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${file}: ${msg}`);

          // Detect WASM runtime abort and attempt recovery
          const isWasmCrash = (err as any)?.constructor?.name === 'RuntimeError'
            || msg.includes('Aborted(') 
            || msg.includes('RuntimeError')
            || msg.includes('WASM grammar exists but failed to load');
          if (isWasmCrash) {
            // Mark the language as poisoned so we skip remaining files of this language
            const { detectLanguage } = await import('../extraction/languages');
            const lang = detectLanguage(file);
            poisonedLanguages.add(lang);

            clearParserCache();
            try {
              await initGrammars();
              // Recovery succeeded — un-poison all languages
              poisonedLanguages.clear();
            } catch {
              errors.push('WASM runtime unrecoverable after crash — aborting batch');
              break;
            }
          }
        }
      }

      // Re-process files that have symbolCount=0 but should have symbols (WASM recovery)
      const emptyFiles = this.db.getAllFiles().filter(
        (f: any) => f.symbolCount === 0 && hasWasmGrammar(f.language)
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

            const oldNodes = this.db.getNodesByFile(extracted.filePath);
            if (oldNodes.length > 0) await this.vectors.deleteEmbeddings(oldNodes.map(n => n.id));

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
              for (const node of extracted.nodes) { this.db.upsertNode(node); nodesCreated++; }
              for (const edge of extracted.edges) { this.db.insertEdge(edge); edgesCreated++; }
              for (const ref of extracted.unresolvedRefs) {
                this.db.insertUnresolvedRef(ref.sourceId, ref.refName, ref.refKind, extracted.filePath, ref.line, ref.column);
              }
            });
            filesIndexed++;
          } catch {
            // Already logged in first pass or genuinely broken — skip
          }
        }
      }

      // Resolve cross-file references
      opts?.onProgress?.({ phase: 'resolving', current: 0, total: 1 });
      await this.resolver.resolveAll((current, total) => {
        opts?.onProgress?.({ phase: 'resolving', current, total });
      });

      // Detect frameworks
      opts?.onProgress?.({ phase: 'detecting frameworks', current: 0, total: 1 });
      const detectedFrameworks = await detectFrameworks(this.projectRoot, this.db);
      const languages = [...new Set(this.db.getAllFiles().map(f => (f as any).language).filter(Boolean))];
      opts?.onProgress?.({
        phase: 'detecting frameworks', current: 1, total: 1,
        meta: { frameworks: detectedFrameworks.map(f => f.name), languages },
      });

      // Generate embeddings (if enabled)
      if (this.vectors.isInitialized()) {
        opts?.onProgress?.({ phase: 'embeddings', current: 0, total: 1 });
        await this.vectors.embedAll((current, total) =>
          opts?.onProgress?.({ phase: 'embeddings', current, total })
        );
      }

      // Analyze architecture (if enabled, or auto-enabled for security)
      if (this.config.enableArchitecture || this.config.enableSecurity) {
        if (this.config.enableSecurity && !this.config.enableArchitecture) {
          const { logWarn } = await import('../errors');
          logWarn('enableSecurity requires enableArchitecture — auto-enabling architecture analysis for this run');
        }
        opts?.onProgress?.({ phase: 'architecture', current: 0, total: 1 });
        await this.arch.analyze(msg =>
          opts?.onProgress?.({ phase: 'architecture', current: 0, total: 1, meta: { msg } })
        );
        opts?.onProgress?.({ phase: 'architecture', current: 1, total: 1 });
      }

      // Run security analysis (if enabled)
      if (this.config.enableSecurity) {
        try {
          const { SecurityPipeline } = await import('../security/pipeline');
          this.db.applySecuritySchema();
          const secPipeline = new SecurityPipeline(this.db, this.config, this.projectRoot);
          opts?.onProgress?.({ phase: 'security', current: 0, total: 1 });
          await secPipeline.run((phase, current, total) =>
            opts?.onProgress?.({ phase: 'security', current, total, meta: { secPhase: phase } })
          );
          opts?.onProgress?.({ phase: 'security', current: 1, total: 1 });
        } catch { /* security analysis is non-critical */ }
      }

      // Index documentation (if enabled)
      if (this.config.enableDocs) {
        try {
          const { DocsIndexer } = await import('../docs/indexer');
          this.db.applyDocsSchema();
          const docsIndexer = new DocsIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await docsIndexer.indexAll({
            force: opts?.force,
            onProgress: msg => opts?.onProgress?.({ phase: 'docs', current: 0, total: 1, meta: { msg } }),
          });
        } catch { /* docs indexing is non-critical */ }
      }

      // Index data files (if enabled)
      if ((this.config as any).enableData) {
        try {
          const { DataIndexer } = await import('../data/indexer');
          this.db.applyDataSchema();
          const dataIndexer = new DataIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await dataIndexer.indexAll({
            onProgress: msg => opts?.onProgress?.({ phase: 'data', current: 0, total: 1, meta: { msg } }),
          });

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
      return { success: errors.length === 0, filesIndexed, nodesCreated, edgesCreated, errors, duration: Date.now() - start };
    } finally {
      this.lock.release();
      release();
    }
  }

  async sync(opts?: {
    changedFiles?: string[];
    onProgress?: (p: IndexProgress) => void;
  }): Promise<SyncResult> {
    const release = await this.mutex.acquire();
    this.lock.acquire();
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
        const oldNodes = this.db.getNodesByFile(rel);
        const oldEdgeCount = this.db.getEdgesForNodes(oldNodes.map(n => n.id)).length;
        result.nodesRemoved += oldNodes.length;
        result.edgesRemoved += oldEdgeCount;
        await this.vectors.deleteEmbeddings(oldNodes.map(n => n.id));
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

      if (changedFiles) {
        filesToProcess = changedFiles.map(f => path.resolve(this.projectRoot, f));
      } else {
        const gitChanged = await getChangedFiles(this.projectRoot, this.config);
        const hasChanges = gitChanged.added.length > 0 || gitChanged.modified.length > 0 || gitChanged.removed.length > 0;

        if (hasChanges) {
          for (const p of gitChanged.removed) {
            await removeFile(path.relative(this.projectRoot, p).replace(/\\/g, '/'));
          }
          filesToProcess = [...gitChanged.added, ...gitChanged.modified];
        } else {
          // Fallback: full scan + detect removed files
          const indexed = new Set(this.db.getAllFiles().map(f => f.path));
          const current = new Set(
            (await scanDirectory(this.projectRoot, this.config))
              .map(f => path.relative(this.projectRoot, f).replace(/\\/g, '/'))
          );
          result.filesScanned = current.size;
          for (const p of indexed) {
            if (!current.has(p)) await removeFile(p);
          }
          filesToProcess = await scanDirectory(this.projectRoot, this.config);
        }
      }

      result.filesScanned = result.filesScanned || filesToProcess.length;
      onProgress?.({ phase: 'scanning', current: result.filesScanned, total: result.filesScanned });

      const poisonedLanguages = new Set<string>();

      for (let i = 0; i < filesToProcess.length; i++) {
        const file = filesToProcess[i];
        onProgress?.({ phase: 'parsing', current: i + 1, total: filesToProcess.length, currentFile: file });

        if (!fs.existsSync(file)) {
          const rel = path.relative(this.projectRoot, file).replace(/\\/g, '/');
          await removeFile(rel);
          continue;
        }

        try {
          // Skip files whose language parser is currently poisoned
          const { detectLanguage } = await import('../extraction/languages');
          const lang = detectLanguage(file);
          if (poisonedLanguages.has(lang)) continue;

          const extracted = await extractFile(file, this.projectRoot, undefined, { enableComplexity: !!(this.config as any).enableComplexity });
          if (!extracted) continue;

          const existing = this.db.getFile(extracted.filePath);
          const isNew = !existing;
          if (!isNew && existing!.contentHash === extracted.contentHash) continue;

          const oldNodes = this.db.getNodesByFile(extracted.filePath);
          const oldEdgeCount = this.db.getEdgesForNodes(oldNodes.map(n => n.id)).length;
          await this.vectors.deleteEmbeddings(oldNodes.map(n => n.id));

          this.db.transaction(() => {
            result.nodesRemoved += oldNodes.length;
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
            });
            for (const node of extracted.nodes) { this.db.upsertNode(node); result.nodesCreated++; }
            for (const edge of extracted.edges) { this.db.insertEdge(edge); result.edgesCreated++; }
            for (const ref of extracted.unresolvedRefs) {
              this.db.insertUnresolvedRef(ref.sourceId, ref.refName, ref.refKind, extracted.filePath, ref.line, ref.column);
            }
          });

          this.resolver.invalidateFile(extracted.filePath);
          if (isNew) result.added.push(extracted.filePath);
          else { result.modified.push(extracted.filePath); result.nodesUpdated += extracted.nodes.length; }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${file}: ${msg}`);

          // Detect WASM runtime abort and attempt recovery
          const isWasmCrash = (err as any)?.constructor?.name === 'RuntimeError'
            || msg.includes('Aborted(') 
            || msg.includes('RuntimeError')
            || msg.includes('WASM grammar exists but failed to load');
          if (isWasmCrash) {
            const { detectLanguage } = await import('../extraction/languages');
            const lang = detectLanguage(file);
            poisonedLanguages.add(lang);

            clearParserCache();
            try {
              await initGrammars();
              poisonedLanguages.clear();
            } catch {
              result.errors.push('WASM runtime unrecoverable after crash — aborting sync');
              break;
            }
          }
        }
      }

      // Resolve cross-file references
      onProgress?.({ phase: 'resolving', current: 0, total: 1 });
      await this.resolver.resolveAll((current, total) => {
        onProgress?.({ phase: 'resolving', current, total });
      });

      await detectFrameworks(this.projectRoot);

      // Generate embeddings (if enabled)
      if (this.vectors.isInitialized()) {
        onProgress?.({ phase: 'embeddings', current: 0, total: 1 });
        await this.vectors.embedAll((current, total) =>
          onProgress?.({ phase: 'embeddings', current, total })
        );
      }

      // Analyze architecture (if enabled, or auto-enabled for security)
      if (this.config.enableArchitecture || this.config.enableSecurity) {
        if (this.config.enableSecurity && !this.config.enableArchitecture) {
          const { logWarn } = await import('../errors');
          logWarn('enableSecurity requires enableArchitecture — auto-enabling architecture analysis for this run');
        }
        onProgress?.({ phase: 'architecture', current: 0, total: 1 });
        await this.arch.analyze(msg =>
          onProgress?.({ phase: 'architecture', current: 0, total: 1, meta: { msg } })
        );
        onProgress?.({ phase: 'architecture', current: 1, total: 1 });
      }

      // Run security analysis (if enabled)
      if (this.config.enableSecurity) {
        try {
          const { SecurityPipeline } = await import('../security/pipeline');
          this.db.applySecuritySchema();
          const secPipeline = new SecurityPipeline(this.db, this.config, this.projectRoot);
          onProgress?.({ phase: 'security', current: 0, total: 1 });
          await secPipeline.run((phase, current, total) =>
            onProgress?.({ phase: 'security', current, total, meta: { secPhase: phase } })
          );
          onProgress?.({ phase: 'security', current: 1, total: 1 });
        } catch { /* security analysis is non-critical */ }
      }

      // Re-index documentation (if enabled)
      if (this.config.enableDocs) {
        try {
          const { DocsIndexer } = await import('../docs/indexer');
          this.db.applyDocsSchema();
          const docsIndexer = new DocsIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await docsIndexer.indexAll({
            onProgress: msg => onProgress?.({ phase: 'docs', current: 0, total: 1, meta: { msg } }),
          });
        } catch { /* docs indexing is non-critical */ }
      }

      // Re-index data files (if enabled)
      if ((this.config as any).enableData) {
        try {
          const { DataIndexer } = await import('../data/indexer');
          this.db.applyDataSchema();
          const dataIndexer = new DataIndexer(this.db.getRawDb(), this.config, this.projectRoot);
          await dataIndexer.indexAll({
            onProgress: msg => onProgress?.({ phase: 'data', current: 0, total: 1, meta: { msg } }),
          });

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
      result.duration = Date.now() - start;
      return result;
    } finally {
      this.lock.release();
      release();
    }
  }
}
