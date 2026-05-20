/**
 * KiroGraph Installer — configuration prompting
 */

import * as readline from 'readline';
import { KiroGraphConfig } from '../../config';
type CavemanMode = 'lite' | 'full' | 'ultra';
import { ask, askBool, arrowSelect, dim, reset, violet } from './prompts';
export type ConfigPatch = Pick<KiroGraphConfig, 'enableEmbeddings' | 'useVecIndex' | 'semanticEngine' | 'typesenseDashboard' | 'qdrantDashboard' | 'extractDocstrings' | 'trackCallSites' | 'enableArchitecture' | 'cavemanMode' | 'compressionLevel'> & { embeddingModel?: string; embeddingDim?: number };
export type SemanticEngine = KiroGraphConfig['semanticEngine'];

export const DEFAULT_EMBEDDING_MODEL = 'nomic-ai/nomic-embed-text-v1.5';

/** Well-known embedding models with their output dimensions. */
const PRESET_MODELS = [
  {
    value: 'nomic-ai/nomic-embed-text-v1.5',
    label: 'nomic-embed-text-v1.5',
    dim: 768,
    description: '768-dim · ~130MB · Best quality for code search  (recommended)',
  },
  {
    value: 'onnx-community/embeddinggemma-300m-ONNX',
    label: 'embeddinggemma-300m',
    dim: 768,
    description: '768-dim · ~300MB · Google Gemma-based, multilingual, 2048-token context',
  },
  {
    value: 'Xenova/all-MiniLM-L6-v2',
    label: 'all-MiniLM-L6-v2',
    dim: 384,
    description: '384-dim · ~23MB  · Fast and lightweight, lower accuracy',
  },
  {
    value: 'BAAI/bge-base-en-v1.5',
    label: 'bge-base-en-v1.5',
    dim: 768,
    description: '768-dim · ~110MB · Strong general-purpose alternative to nomic',
  },
  {
    value: '__other__',
    label: 'Other',
    dim: 768,
    description: 'Enter a custom HuggingFace model ID and embedding dimension',
  },
] as const;

export async function promptConfigOptions(rl: readline.Interface): Promise<ConfigPatch> {
  const enableEmbeddings = await askBool(
    rl,
    'Enable semantic embeddings for similarity search? (requires a local embedding model)',
    'Enables semantic/similarity-based code search. Increases indexing time; the chosen embedding model is downloaded automatically on first use.',
  );

  const patch: ConfigPatch = { enableEmbeddings, useVecIndex: false, semanticEngine: 'cosine', typesenseDashboard: false, qdrantDashboard: false, extractDocstrings: true, trackCallSites: true, enableArchitecture: false, cavemanMode: 'off', compressionLevel: 'normal' };

  if (enableEmbeddings) {
    // ── Model selection ────────────────────────────────────────────────────────
    const modelChoice = await arrowSelect<string>(
      rl,
      'Choose an embedding model:',
      PRESET_MODELS.map(m => ({ value: m.value, label: m.label, description: m.description })),
    );

    let embeddingModel: string;
    let embeddingDim: number;

    if (modelChoice === '__other__') {
      console.log(`\n  ${dim}Enter a HuggingFace model ID in the format org/model-name.${reset}`);
      while (true) {
        const raw = (await ask(rl, `  ${violet}Model identifier:${reset} `)).trim();
        if (raw.includes('/')) { embeddingModel = raw; break; }
        console.log(`  Expected a HuggingFace model ID in the format org/model-name (e.g. nomic-ai/nomic-embed-text-v1.5).`);
      }
      console.log(`\n  ${dim}Enter the embedding output dimension for this model (check the model card on HuggingFace).${reset}`);
      while (true) {
        const raw = (await ask(rl, `  ${violet}Embedding dimension (e.g. 768, 384):${reset} `)).trim();
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n > 0) { embeddingDim = n; break; }
        console.log(`  Expected a positive integer (e.g. 768, 384, 1536).`);
      }
    } else {
      const preset = PRESET_MODELS.find(m => m.value === modelChoice)!;
      embeddingModel = preset.value;
      embeddingDim = preset.dim;
    }

    patch.embeddingModel = embeddingModel;
    patch.embeddingDim = embeddingDim;

    // ── Engine selection ───────────────────────────────────────────────────────
    const semanticEngine = await arrowSelect<SemanticEngine>(rl, 'Choose the semantic search engine:', [
      { value: 'cosine',     label: 'cosine',     description: 'In-process cosine similarity. No extra deps. Best for small/medium projects.' },
      { value: 'sqlite-vec', label: 'sqlite-vec', description: 'ANN index. Sub-linear search. Best for large codebases. Needs: better-sqlite3, sqlite-vec (native).' },
      { value: 'orama',      label: 'orama',      description: 'Hybrid search (full-text + vector). Pure JS. Needs: @orama/orama, @orama/plugin-data-persistence.' },
      { value: 'pglite',     label: 'pglite',     description: 'Hybrid search via PostgreSQL + pgvector. Exact results. Pure WASM. Needs: @electric-sql/pglite.' },
      { value: 'lancedb',    label: 'lancedb',    description: 'ANN search via LanceDB (Apache Lance columnar format). Pure JS. Needs: @lancedb/lancedb.' },
      { value: 'qdrant',     label: 'qdrant',     description: 'ANN search via Qdrant embedded binary (HNSW index, Cosine). Needs: qdrant-local.' },
      { value: 'typesense',  label: 'typesense',  description: 'ANN search via Typesense (auto-downloaded binary, HNSW, Cosine). Needs: typesense.' },
    ]);
    patch.semanticEngine = semanticEngine;
    patch.useVecIndex = semanticEngine === 'sqlite-vec';

    if (semanticEngine === 'typesense') {
      patch.typesenseDashboard = await askBool(
        rl,
        'Open Typesense dashboard after indexing?',
        'Serves the Typesense Dashboard locally and opens it in your browser after indexing completes.',
      );
    }

    if (semanticEngine === 'qdrant') {
      patch.qdrantDashboard = await askBool(
        rl,
        'Open Qdrant dashboard after indexing?',
        'Downloads the Qdrant Web UI (first time only) and opens it in your browser after indexing completes.',
      );
    }
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

  patch.enableArchitecture = await askBool(
    rl,
    'Enable architecture analysis (package graph + layer detection)?',
    'Detects packages from manifests (package.json, go.mod, Cargo.toml, etc.) and architectural layers (api, service, data, ui, shared) from file structure. Enables kirograph_architecture, kirograph_coupling, and kirograph_package MCP tools.',
  );

  const cavemanChoice = await arrowSelect(rl, 'Caveman mode: agent communication style:', [
    { value: 'off',   label: 'off',   description: 'Normal responses' },
    { value: 'lite',  label: 'lite',  description: 'Compact, no filler, full sentences' },
    { value: 'full',  label: 'full',  description: 'Fragments, no articles, short synonyms' },
    { value: 'ultra', label: 'ultra', description: 'Max compression, abbreviations, → for causality' },
  ]);
  patch.cavemanMode = cavemanChoice as CavemanMode | 'off';

  const compressionChoice = await arrowSelect(rl, 'Output compression: default level for kirograph_exec:', [
    { value: 'off',        label: 'off',        description: 'No compression hook or steering (tool still available)' },
    { value: 'normal',     label: 'normal',     description: 'Balanced: removes noise, keeps structure (recommended)' },
    { value: 'aggressive', label: 'aggressive', description: 'More compact: groups by category, limits output' },
    { value: 'ultra',      label: 'ultra',      description: 'Maximum compression: counts and summaries only' },
  ]);
  patch.compressionLevel = compressionChoice as KiroGraphConfig['compressionLevel'];

  return patch;
}
