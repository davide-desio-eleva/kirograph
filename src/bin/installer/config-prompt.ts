/**
 * KiroGraph Installer — configuration prompting
 */

import * as readline from 'readline';
import { KiroGraphConfig } from '../../config';
type CavemanMode = 'lite' | 'full' | 'ultra';
import { ask, askToggle, arrowSelect, printSection, printSeparator, dim, reset, violet } from './prompts';
import { promptImportGlobalHookSelection } from '../../hooks/import-prompt';

export interface PromptConfigOptions {
  projectRoot?: string;
  offerHookImport?: boolean;
}
export type ConfigPatch = Pick<KiroGraphConfig,
  'enableEmbeddings' | 'useVecIndex' | 'semanticEngine' |
  'turboquantMemDocs' | 'turboquantBits' | 'turbovecMemDocs' | 'turbovecBits' |
  'typesenseDashboard' | 'qdrantDashboard' |
  'extractDocstrings' | 'trackCallSites' | 'enableArchitecture' |
  'cavemanMode' | 'shellCompressionLevel' |
  'enableMemory' | 'enableWatchmen' | 'watchmenThreshold' | 'watchmenSynthesisMode' | 'watchmenLocalModel' |
  'enableDocs' | 'docsContextLimit' |
  'enableData' | 'dataContextLimit' |
  'enableSecurity' | 'enablePatterns' |
  'enableWiki' | 'wikiSynthesisMode' | 'wikiLocalModel' |
  'enableCodeHealth' | 'enableNavigation' | 'enableComplexity' |
  'enableGitContext' | 'enableEditPrimitives' | 'enableBranch' |
  'enableAgentUtils' | 'enableGeneralCompression'
> & { embeddingModel?: string; embeddingDim?: number };
export type SemanticEngine = KiroGraphConfig['semanticEngine'];

type InstallMode = 'core' | 'full' | 'custom' | 'profiles';

const PROFILES: Record<string, { label: string; description: string; patch: Partial<ConfigPatch> }> = {
  developer: {
    label: 'Developer',
    description: 'Code health, navigation, complexity, call-site tracking',
    patch: { enableCodeHealth: true, enableNavigation: true, enableComplexity: true, trackCallSites: true },
  },
  team: {
    label: 'Team',
    description: 'Developer + architecture, git context, wiki',
    patch: { enableCodeHealth: true, enableNavigation: true, enableComplexity: true, trackCallSites: true, enableArchitecture: true, enableGitContext: true, enableWiki: true, wikiSynthesisMode: 'agent' },
  },
  security: {
    label: 'Security',
    description: 'Security analysis, patterns, architecture, code health',
    patch: { enableSecurity: true, enableArchitecture: true, enablePatterns: true, enableCodeHealth: true },
  },
  data: {
    label: 'Data & Docs',
    description: 'Tabular data indexing and documentation navigation',
    patch: { enableData: true, enableDocs: true },
  },
  ai: {
    label: 'AI / LLM Agent',
    description: 'Memory, watchmen, agent utils, wiki, general compression',
    patch: { enableMemory: true, enableWatchmen: true, enableAgentUtils: true, enableWiki: true, wikiSynthesisMode: 'agent', enableGeneralCompression: true },
  },
};

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

export async function promptConfigOptions(
  rl: readline.Interface,
  opts: PromptConfigOptions = {},
): Promise<{ patch: ConfigPatch; hooksToImport: string[] | null }> {
  // ── Install mode ─────────────────────────────────────────────────────────────
  const installMode = await arrowSelect<InstallMode>(rl, 'Installation mode:', [
    { value: 'core',     label: 'Core only',  description: '3 always-on tools (search, context, node) — ~170 tok. Zero config.' },
    { value: 'full',     label: 'Full',        description: 'Enable every feature with sensible defaults. Best for a fresh project.' },
    { value: 'profiles', label: 'Profiles',   description: 'Choose a preset bundle (Developer, Team, Security, Data & Docs, AI/LLM).' },
    { value: 'custom',   label: 'Custom',     description: 'Answer each question individually. Maximum control.' },
  ]);

  const basePatch: ConfigPatch = {
    enableEmbeddings: false, useVecIndex: false, semanticEngine: 'cosine',
    turboquantMemDocs: false, turboquantBits: 3, turbovecMemDocs: false, turbovecBits: 4,
    typesenseDashboard: false, qdrantDashboard: false,
    extractDocstrings: false, trackCallSites: false,
    enableArchitecture: false, cavemanMode: 'off', shellCompressionLevel: 'off',
    enableMemory: false, enableWatchmen: false, watchmenThreshold: 5,
    watchmenSynthesisMode: 'local', watchmenLocalModel: 'onnx-community/gemma-4-E4B-it-ONNX',
    enableDocs: false, docsContextLimit: 0,
    enableData: false, dataContextLimit: 0,
    enableSecurity: false, enablePatterns: false,
    enableWiki: false, wikiSynthesisMode: 'agent', wikiLocalModel: 'onnx-community/gemma-4-E4B-it-ONNX',
    enableCodeHealth: false, enableNavigation: false, enableComplexity: false,
    enableGitContext: false, enableEditPrimitives: false, enableBranch: false,
    enableAgentUtils: false, enableGeneralCompression: false,
  };

  if (installMode === 'core') {
    return { patch: basePatch, hooksToImport: null };
  }

  if (installMode === 'full') {
    const fullPatch: ConfigPatch = {
      ...basePatch,
      enableEmbeddings: true, embeddingModel: DEFAULT_EMBEDDING_MODEL, embeddingDim: 768,
      extractDocstrings: true, trackCallSites: true,
      enableArchitecture: true, shellCompressionLevel: 'normal',
      enableCodeHealth: true, enableNavigation: true, enableComplexity: true,
      enableGitContext: true, enableEditPrimitives: true, enableBranch: true,
      enableAgentUtils: true, enableGeneralCompression: true,
      enableSecurity: true, enablePatterns: true,
      enableDocs: true, enableData: true,
      enableMemory: true, enableWatchmen: true,
      enableWiki: true, wikiSynthesisMode: 'agent',
    };
    return { patch: fullPatch, hooksToImport: null };
  }

  if (installMode === 'profiles') {
    const profileKey = await arrowSelect<string>(rl, 'Select a profile:', Object.entries(PROFILES).map(([key, p]) => ({
      value: key,
      label: p.label,
      description: p.description,
    })));
    const profile = PROFILES[profileKey];
    const patch: ConfigPatch = { ...basePatch, ...profile.patch };
    return { patch, hooksToImport: null };
  }

  // ── Custom: ask all questions individually ─────────────────────────────────
  // ── Semantic Search ─────────────────────────────────────────────────────────
  printSection('🔍', 'Semantic Search');

  const enableEmbeddings = await askToggle(
    rl,
    'Semantic embeddings (similarity search):',
    'Enables natural-language code search via vector embeddings. A local model (~130MB) is downloaded on first use.',
  );

  const patch: ConfigPatch = { ...basePatch, enableEmbeddings };

  if (enableEmbeddings) {
    // ── Model selection ────────────────────────────────────────────────────────
    const modelChoice = await arrowSelect<string>(
      rl,
      'Embedding model:',
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
    const semanticEngine = await arrowSelect<SemanticEngine>(rl, 'Vector search engine:', [
      { value: 'cosine',      label: 'cosine',      description: 'In-process cosine similarity. No extra deps. Best for small/medium projects.' },
      { value: 'turboquant',  label: 'turboquant',  description: 'ANN index, zero native deps. Compresses embeddings 20–30× (Google TurboQuant). ANN without native binaries — ideal for CI, ARM, restricted envs. Optional: npm install turboquant-js.' },
      { value: 'turbovec',   label: 'turbovec',   description: 'ANN search via Rust/SIMD (napi-rs). Same TurboQuant algorithm but NEON on ARM and AVX-512BW on x86 — faster than turboquant-js at the cost of a one-time Rust build. Requires Rust toolchain. Build: cd native/turbovec-node && npm install && npm run build.' },
      { value: 'sqlite-vec', label: 'sqlite-vec', description: 'ANN index. Sub-linear search. Best for large codebases. Needs: better-sqlite3, sqlite-vec (native).' },
      { value: 'orama',      label: 'orama',      description: 'Hybrid search (full-text + vector). Pure JS. Needs: @orama/orama, @orama/plugin-data-persistence.' },
      { value: 'pglite',     label: 'pglite',     description: 'Hybrid search via PostgreSQL + pgvector. Exact results. Pure WASM. Needs: @electric-sql/pglite.' },
      { value: 'lancedb',    label: 'lancedb',    description: 'ANN search via LanceDB (Apache Lance columnar format). Pure JS. Needs: @lancedb/lancedb.' },
      { value: 'qdrant',     label: 'qdrant',     description: 'ANN search via Qdrant embedded binary (HNSW index, Cosine). Needs: qdrant-local.' },
      { value: 'typesense',  label: 'typesense',  description: 'ANN search via Typesense (auto-downloaded binary, HNSW, Cosine). Needs: typesense.' },
    ]);
    patch.semanticEngine = semanticEngine;
    patch.useVecIndex = semanticEngine === 'sqlite-vec';

    // TurboQuant for memory & docs: offer only when turboquant is the code-node engine
    if (semanticEngine === 'turboquant') {
      patch.turboquantMemDocs = await askToggle(rl,
        'TurboQuant for memory & docs search (optional):',
        'Replaces the default linear cosine scan in memory observations and doc sections with a compressed ANN index — no native deps required. Most useful when you accumulate many observations or large doc sets (1 000+ entries).',
        false,
      );
    }

    // TurboVec bit width
    if (semanticEngine === 'turbovec') {
      patch.turbovecBits = await arrowSelect<number>(rl, 'TurboVec bits per coordinate:', [
        { value: 4, label: '4 bits (recommended)', description: 'Best quality, ~19× compression vs raw Float32. Default.' },
        { value: 3, label: '3 bits',               description: 'Balanced — ~25× compression, slight quality drop.' },
        { value: 2, label: '2 bits',               description: 'Highest compression (~38×), lowest accuracy.' },
      ]);
      patch.turbovecMemDocs = await askToggle(rl,
        'TurboVec for memory & docs search (optional):',
        'Replaces the default linear cosine scan in memory observations and doc sections with the TurboVec ANN index. Requires the addon to be built.',
        false,
      );
    }

    if (semanticEngine === 'typesense') {
      patch.typesenseDashboard = await askToggle(rl,
        'Typesense dashboard:',
        'Serves the Typesense Dashboard locally and opens it in your browser after indexing completes.',
        false,
      );
    }

    if (semanticEngine === 'qdrant') {
      patch.qdrantDashboard = await askToggle(rl,
        'Qdrant dashboard:',
        'Downloads the Qdrant Web UI (first time only) and opens it in your browser after indexing completes.',
        false,
      );
    }
  }

  // ── Graph Features ──────────────────────────────────────────────────────────
  printSection('📊', 'Graph Features');

  patch.extractDocstrings = await askToggle(rl,
    'Docstring extraction:',
    'Enriches symbol metadata and improves context quality. Slightly increases indexing time.',
    false,
  );

  patch.trackCallSites = await askToggle(rl,
    'Call site tracking (caller/callee graph):',
    'Enables kirograph_callers and kirograph_callees MCP tools. Increases index size.',
    false,
  );

  patch.enableArchitecture = await askToggle(rl,
    'Architecture analysis (packages + layers):',
    'Detects packages from manifests and architectural layers. Enables kirograph_architecture, kirograph_coupling, kirograph_package.',
    false,
  );

  // ── Graph Tools ─────────────────────────────────────────────────────────────
  printSection('📊', 'Graph Tools');

  patch.enableNavigation = await askToggle(rl,
    'Navigation tools (status, files, impact):',
    'Enables kirograph_status, kirograph_files, kirograph_impact.',
    false,
  );

  patch.enableCodeHealth = await askToggle(rl,
    'Code health tools (hotspots, dead code, path analysis, type hierarchy):',
    'Enables kirograph_hotspots, kirograph_surprising, kirograph_diff, kirograph_dead_code, kirograph_circular_deps, kirograph_path, kirograph_affected, kirograph_type_hierarchy.',
    false,
  );

  patch.enableComplexity = await askToggle(rl,
    'Complexity metrics tools:',
    'Enables complexity analysis, simplify scan, health score, DSM, test risk.',
    false,
  );

  patch.enableGitContext = await askToggle(rl,
    'Git context tools (diff context, commit context, flows):',
    'Enables kirograph_flows, kirograph_diff_context, kirograph_commit_context, kirograph_pr_context, kirograph_changelog, kirograph_test_map, kirograph_test_coverage.',
    false,
  );

  patch.enableEditPrimitives = await askToggle(rl,
    'Edit primitive tools (str_replace, insert_at, refactor):',
    'Enables kirograph_refactor, kirograph_str_replace, kirograph_multi_str_replace, kirograph_insert_at, kirograph_ast_grep_rewrite.',
    false,
  );

  patch.enableAgentUtils = await askToggle(rl,
    'Agent utilities (file caching, budget tracking):',
    'Enables kirograph_read, kirograph_gain, kirograph_budget.',
    false,
  );

  // ── Security ────────────────────────────────────────────────────────────────
  printSection('🔒', 'Security');

  patch.enableSecurity = await askToggle(rl,
    'Security analysis (vulnerability scanning + reachability):',
    'Scans dependency manifests for known vulnerabilities and performs reachability analysis. Requires Architecture analysis (will be auto-enabled). Enables kirograph_security, kirograph_vulns, kirograph_sbom, kirograph_vex, kirograph_reachability MCP tools.',
    false,
  );

  if (patch.enableSecurity && !patch.enableArchitecture) {
    patch.enableArchitecture = true;
    console.log('  ℹ  Architecture analysis auto-enabled (required by Security module)');
  }

  // ── Pattern Matching ─────────────────────────────────────────────────────────
  printSection('🔍', 'Pattern Matching');

  patch.enablePatterns = await askToggle(rl,
    'Precise SAST with ast-grep?',
    'Runs AST structural pattern matching during indexing using @ast-grep/napi (~15MB native binding). Unlike heuristic symbol-name analysis, matches real code structure — precise SQL injection, path traversal, eval detection. Requires @ast-grep/napi (will be installed automatically if you answer yes).',
    false,
  );

  // ── Documentation ───────────────────────────────────────────────────────────
  printSection('📖', 'Documentation');

  (patch as any).enableDocs = await askToggle(rl,
    'Documentation indexing (section-level retrieval):',
    'Indexes docs by heading structure. Enables kirograph_docs_toc, kirograph_docs_search, kirograph_docs_section, kirograph_docs_outline, kirograph_docs_refs.',
    false,
  );

  if ((patch as any).enableDocs) {
    const contextChoice = await arrowSelect<number>(rl, 'Include doc sections in kirograph_context results?', [
      { value: 0,  label: '0 (disabled)', description: 'Docs stay separate — use kirograph_docs_* tools explicitly (recommended)' },
      { value: 3,  label: '3 sections',   description: 'Include up to 3 relevant doc sections in context results' },
      { value: 5,  label: '5 sections',   description: 'Include up to 5 relevant doc sections in context results' },
      { value: 10, label: '10 sections',  description: 'Include up to 10 relevant doc sections in context results' },
    ]);
    (patch as any).docsContextLimit = contextChoice;
  }

  // ── Data ─────────────────────────────────────────────────────────────────────
  printSection('📊', 'Data');

  (patch as any).enableData = await askToggle(rl,
    'Tabular data indexing (CSV/TSV/JSONL/JSON/Excel/Parquet):',
    'Indexes data files for structured querying. Enables kirograph_data_list, kirograph_data_describe, kirograph_data_query, kirograph_data_aggregate, kirograph_data_search.',
    false,
  );

  if ((patch as any).enableData) {
    (patch as any).dataInstallExcel = await askToggle(rl,
      'Install Excel support (xlsx package)?',
      'Required for .xlsx/.xls files. CSV/TSV/JSONL/JSON are always supported without extra deps.',
      false,
    );

    (patch as any).dataInstallParquet = await askToggle(rl,
      'Install Parquet support (parquetjs-lite package)?',
      'Required for .parquet files. CSV/TSV/JSONL/JSON are always supported without extra deps.',
      false,
    );

    (patch as any).dataInstallPdf = await askToggle(rl,
      'Install PDF support (@firecrawl/pdf-inspector package)?',
      'Required for .pdf files. Rust/NAPI binary — prebuilts for linux-x64 and macOS ARM64.',
      false,
    );

    const contextChoice = await arrowSelect<number>(rl, 'Include dataset schemas in kirograph_context results?', [
      { value: 0,  label: '0 (disabled)', description: 'Data stays separate — use kirograph_data_* tools explicitly (recommended)' },
      { value: 2,  label: '2 datasets',   description: 'Include up to 2 relevant dataset schemas in context results' },
      { value: 5,  label: '5 datasets',   description: 'Include up to 5 relevant dataset schemas in context results' },
    ]);
    (patch as any).dataContextLimit = contextChoice;
  }

  // ── Agent Behavior ──────────────────────────────────────────────────────────
  printSection('🤖', 'Agent Behavior');

  const cavemanChoice = await arrowSelect(rl, 'Communication style (caveman mode):', [
    { value: 'off',   label: 'off',   description: 'Normal responses — no compression' },
    { value: 'lite',  label: 'lite',  description: 'Compact, no filler, full sentences' },
    { value: 'full',  label: 'full',  description: 'Fragments, no articles, short synonyms' },
    { value: 'ultra', label: 'ultra', description: 'Max compression, abbreviations, → for causality' },
  ]);
  patch.cavemanMode = cavemanChoice as CavemanMode | 'off';

  const compressionChoice = await arrowSelect(rl, 'Shell compression (kirograph_exec):', [
    { value: 'off',        label: 'off',        description: 'Disables kirograph_exec entirely' },
    { value: 'normal',     label: 'normal',     description: 'Balanced: removes noise, keeps structure (recommended)' },
    { value: 'aggressive', label: 'aggressive', description: 'More compact: groups by category, limits output' },
    { value: 'ultra',      label: 'ultra',      description: 'Maximum compression: counts and summaries only' },
  ]);
  patch.shellCompressionLevel = compressionChoice as KiroGraphConfig['shellCompressionLevel'];
  if (compressionChoice === 'off') {
    console.log('  ℹ  kirograph_exec disabled (shell compression is off)');
  }

  patch.enableGeneralCompression = await askToggle(rl,
    'General-purpose compression tool (kirograph_compress):',
    'Enables kirograph_compress — an on-demand MCP tool that compresses arbitrary text before it reaches the model. ' +
    'Two engines: rtk-style structural filters for shell output (git, npm, test logs) when a command hint is provided, ' +
    'or caveman grammar rules for prose and observations otherwise. ' +
    'Useful when the agent pastes large content, receives a fat RAG chunk, or wants to explicitly compress before storing. ' +
    'Independent from automatic shell compression (kirograph_exec) and caveman mode — those apply in the background; ' +
    'this gives the model an explicit, on-demand compression action.',
    false,
  );

  let hooksToImport: string[] | null = null;
  if (opts.offerHookImport && opts.projectRoot) {
    printSection('🪝', 'Hooks');
    hooksToImport = await promptImportGlobalHookSelection();
  }

  // ── Memory ──────────────────────────────────────────────────────────────────
  printSection('🧠', 'Memory');

  patch.enableMemory = await askToggle(rl,
    'Persistent memory (cross-session observations):',
    'Stores decisions, errors, and patterns across sessions. Compressed (if caveman is on), linked to code symbols, searchable via kirograph_mem_* tools. Zero LLM tokens on write.',
    false,
  );

  if (patch.enableMemory) {
    patch.enableWatchmen = await askToggle(rl,
      'Watchmen (auto-synthesize workspace briefs from memory):',
      'When enough observations accumulate (default: 5), synthesizes them into .kiro/steering/kirograph-watchmen.md, CLAUDE.md, AGENTS.md, or the equivalent for your tool.',
      false,
    );

    if (patch.enableWatchmen) {
      // ── Synthesis mode ───────────────────────────────────────────────────
      const synthesisMode = await arrowSelect<KiroGraphConfig['watchmenSynthesisMode']>(
        rl,
        'Watchmen synthesis mode:',
        [
          {
            value: 'local',
            label: 'Local model',
            description: 'Runs a local HuggingFace model via @huggingface/transformers. Zero API cost, no data leaves your machine. Model downloaded once to ~/.kirograph/models/. Works for all tools via runCommand hook.',
          },
          {
            value: 'agent',
            label: 'Active agent',
            description: '⚠ Kiro only. Uses the active Kiro agent to synthesize. Consumes API tokens/credits on every synthesis. Not supported for other tools.',
          },
        ],
      );
      patch.watchmenSynthesisMode = synthesisMode;

      if (synthesisMode === 'local') {
        // ── Local model selection ──────────────────────────────────────────
        const LOCAL_MODELS = [
          {
            value: 'onnx-community/gemma-4-E4B-it-ONNX',
            label: 'Gemma 4 E4B (recommended)',
            description: '~3–4 GB · Google DeepMind Gemma 4 · 4.5B params · 128K context · Best quality · Apache 2.0',
          },
          {
            value: 'onnx-community/Qwen2.5-1.5B-Instruct',
            label: 'Qwen2.5-1.5B',
            description: '~1.5 GB · Lighter option if RAM is limited · Acceptable quality',
          },
          {
            value: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
            label: 'SmolLM2-1.7B',
            description: '~1.7 GB · HuggingFace compact model · Good at following structured formats',
          },
          {
            value: '__other__',
            label: 'Other',
            description: 'Enter a custom HuggingFace model ID (must have ONNX weights on onnx-community)',
          },
        ] as const;

        const modelChoice = await arrowSelect<string>(rl, 'Local synthesis model:', LOCAL_MODELS.map(m => ({ value: m.value, label: m.label, description: m.description })));

        if (modelChoice === '__other__') {
          console.log(`\n  ${dim}Enter a HuggingFace model ID (e.g. onnx-community/gemma-4-E4B-it-ONNX).${reset}`);
          while (true) {
            const raw = (await ask(rl, `  ${violet}Model identifier:${reset} `)).trim();
            if (raw.includes('/')) { patch.watchmenLocalModel = raw; break; }
            console.log(`  Expected a HuggingFace model ID in the format org/model-name.`);
          }
        } else {
          patch.watchmenLocalModel = modelChoice;
        }
      }
    }
  }

  // ── Wiki ─────────────────────────────────────────────────────────────────────
  printSection('📖', 'Wiki');

  patch.enableWiki = await askToggle(rl,
    'LLM Wiki (Karpathy-style structured knowledge base):',
    'Maintains a set of markdown pages that compound knowledge across sessions. Supports search, ingest (two-tool flow), conflict resolution, and health checks via kirograph_wiki_* tools.',
    false,
  );

  if (patch.enableWiki) {
    const wikiMode = await arrowSelect<KiroGraphConfig['wikiSynthesisMode']>(
      rl,
      'Wiki synthesis mode:',
      [
        {
          value: 'agent',
          label: 'Active agent (recommended)',
          description: 'Uses the active LLM agent to generate WIKI_DIFF blocks. Works with any AI tool. Consumes API tokens on ingest.',
        },
        {
          value: 'local',
          label: 'Local model',
          description: 'Runs a local HuggingFace model to generate diffs. Zero API cost, no data leaves your machine. Same infra as Watchmen.',
        },
      ],
    );
    patch.wikiSynthesisMode = wikiMode;

    if (wikiMode === 'local') {
      // ── Local model selection ──────────────────────────────────────────
      const WIKI_LOCAL_MODELS = [
        {
          value: 'onnx-community/gemma-4-E4B-it-ONNX',
          label: 'Gemma 4 E4B (recommended)',
          description: '~3–4 GB · Google DeepMind Gemma 4 · 4.5B params · 128K context · Best quality · Apache 2.0',
        },
        {
          value: 'onnx-community/Qwen2.5-1.5B-Instruct',
          label: 'Qwen2.5-1.5B',
          description: '~1.5 GB · Lighter option if RAM is limited · Acceptable quality',
        },
        {
          value: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
          label: 'SmolLM2-1.7B',
          description: '~1.7 GB · HuggingFace compact model · Good at following structured formats',
        },
        {
          value: '__other__',
          label: 'Other',
          description: 'Enter a custom HuggingFace model ID (must have ONNX weights on onnx-community)',
        },
      ] as const;

      const wikiModelChoice = await arrowSelect<string>(rl, 'Local wiki synthesis model:', WIKI_LOCAL_MODELS.map(m => ({ value: m.value, label: m.label, description: m.description })));

      if (wikiModelChoice === '__other__') {
        console.log(`\n  ${dim}Enter a HuggingFace model ID (e.g. onnx-community/gemma-4-E4B-it-ONNX).${reset}`);
        while (true) {
          const raw = (await ask(rl, `  ${violet}Model identifier:${reset} `)).trim();
          if (raw.includes('/')) { patch.wikiLocalModel = raw; break; }
          console.log(`  Expected a HuggingFace model ID in the format org/model-name.`);
        }
      } else {
        patch.wikiLocalModel = wikiModelChoice;
      }
    }
  }

  return { patch, hooksToImport };
}
