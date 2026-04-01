/**
 * KiroGraph Installer — configuration prompting
 */

import * as readline from 'readline';
import { KiroGraphConfig } from '../../config';
import { ask, askBool, arrowSelect, dim, reset, violet } from './prompts';

export type ConfigPatch = Pick<KiroGraphConfig, 'enableEmbeddings' | 'useVecIndex' | 'semanticEngine' | 'extractDocstrings' | 'trackCallSites'> & { embeddingModel?: string };
export type SemanticEngine = KiroGraphConfig['semanticEngine'];

export const DEFAULT_EMBEDDING_MODEL = 'nomic-ai/nomic-embed-text-v1.5';

export async function promptConfigOptions(rl: readline.Interface): Promise<ConfigPatch> {
  const enableEmbeddings = await askBool(
    rl,
    'Enable semantic embeddings for similarity search? (requires a local embedding model)',
    'Enables semantic/similarity-based code search. Increases indexing time and requires a compatible local embedding model (e.g. via Ollama).',
  );

  const patch: ConfigPatch = { enableEmbeddings, useVecIndex: false, semanticEngine: 'cosine', extractDocstrings: true, trackCallSites: true };

  if (enableEmbeddings) {
    console.log(`\n  ${dim}HuggingFace model identifier for generating embeddings (e.g. org/model-name).${reset}`);
    console.log(`  ${dim}Press Enter to use the default: ${DEFAULT_EMBEDDING_MODEL}${reset}`);
    let embeddingModel = DEFAULT_EMBEDDING_MODEL;
    while (true) {
      const raw = (await ask(rl, `  ${violet}Embedding model identifier:${reset} `)).trim();
      if (raw === '') { embeddingModel = DEFAULT_EMBEDDING_MODEL; break; }
      if (raw.includes('/')) { embeddingModel = raw; break; }
      console.log(`  Expected a HuggingFace model ID in the format org/model-name (e.g. nomic-ai/nomic-embed-text-v1.5).`);
    }
    patch.embeddingModel = embeddingModel;
    if (embeddingModel !== DEFAULT_EMBEDDING_MODEL) {
      console.log(`\n  ℹ  To use this model locally, run: ollama pull ${embeddingModel}`);
    }

    const semanticEngine = await arrowSelect<SemanticEngine>(rl, 'Choose the semantic search engine:', [
      { value: 'cosine',     label: 'cosine',     description: 'In-process cosine similarity. No extra deps. Best for small/medium projects.' },
      { value: 'sqlite-vec', label: 'sqlite-vec', description: 'ANN index. Sub-linear search. Best for large codebases. Needs: better-sqlite3, sqlite-vec (native).' },
      { value: 'orama',      label: 'orama',      description: 'Hybrid search (full-text + vector). Pure JS. Needs: @orama/orama, @orama/plugin-data-persistence.' },
      { value: 'pglite',     label: 'pglite',     description: 'Hybrid search via PostgreSQL + pgvector. Exact results. Pure WASM. Needs: @electric-sql/pglite.' },
    ]);
    patch.semanticEngine = semanticEngine;
    patch.useVecIndex = semanticEngine === 'sqlite-vec';
  }

  patch.extractDocstrings = await askBool(
    rl,
    'Extract docstrings from source files?',
    'Enriches symbol metadata and improves context quality. Slightly increases indexing time.',
  );

  patch.trackCallSites = await askBool(
    rl,
    'Track call sites to enable caller/callee graph traversal?',
    'Enables the kirograph_callers and kirograph_callees MCP tools for graph traversal. Increases index size.',
  );

  return patch;
}
