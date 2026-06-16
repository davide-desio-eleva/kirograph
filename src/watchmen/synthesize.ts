/**
 * KiroGraph Watchmen — local model synthesis
 *
 * Runs a local HuggingFace text-generation model (via @huggingface/transformers)
 * to synthesize memory observations into a workspace brief + skill files.
 * Same lazy-singleton pattern as src/memory/vectors.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MemObservation } from '../memory/types';
import type { WatchmenReadyResult } from '../memory/types';

// ── Model detection ───────────────────────────────────────────────────────────

function isGemma4(modelName: string): boolean {
  return /gemma-?4/i.test(modelName);
}

// ── Model singleton (same pattern as vectors.ts) ──────────────────────────────

let genPipeline: any = null;
let genPipelineModel: string | null = null;
let genProcessor: any = null;

export async function getGenPipeline(modelName: string, quiet = false) {
  if (genPipeline && genPipelineModel === modelName) return genPipeline;
  const cacheDir = path.join(os.homedir(), '.kirograph', 'models');

  const { pipeline, env } = await import('@huggingface/transformers') as any;
  env.cacheDir = cacheDir;

  // Same pattern as vectors/index.ts: if model is cached, disable remote access entirely
  // so transformers.js never makes a network request on subsequent runs.
  const cached = require('fs').existsSync(path.join(cacheDir, modelName));
  if (cached) env.allowRemoteModels = false;

  // Download progress bar — same pattern as src/vectors/index.ts
  const fileBytes = new Map<string, { loaded: number; total: number }>();
  let lastFile = '';

  function renderProgress(file: string, loaded: number, total: number, done: boolean) {
    const entry = fileBytes.get(file) ?? { loaded: 0, total: 0 };
    if (total > 0) entry.total = total;
    entry.loaded = done ? entry.total : loaded;
    fileBytes.set(file, entry);

    const knownFiles = Array.from(fileBytes.values()).filter(f => f.total > 0);
    const totalLoaded = knownFiles.reduce((s, f) => s + f.loaded, 0);
    const totalBytes  = knownFiles.reduce((s, f) => s + f.total, 0);
    const pct = totalBytes > 0 ? Math.min((totalLoaded / totalBytes) * 100, 100) : 0;
    const filled = Math.round(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const mb = (totalLoaded / 1024 / 1024).toFixed(1);
    const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
    process.stdout.write(`\r  [${bar}] ${pct.toFixed(0).padStart(3)}%  ${mb} / ${totalMb} MB   `);
  }

  const dtype = isGemma4(modelName) ? 'q4f16' : 'q4';
  genPipeline = await pipeline('text-generation', modelName, {
    cache_dir: cacheDir,
    dtype,
    ...(!cached && !quiet ? {
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file) {
          lastFile = p.file;
          renderProgress(p.file, p.loaded ?? 0, p.total ?? 0, false);
        } else if (p.status === 'done' && lastFile) {
          renderProgress(lastFile, 1, 1, true);
          lastFile = '';
        }
      },
    } : {}),
  } as any);

  if (!cached && !quiet && fileBytes.size > 0) {
    process.stdout.write('\n'); // newline after progress bar
  }

  genProcessor = null;
  genPipelineModel = modelName;
  return genPipeline;
}

// ── Prompt building ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a software project assistant. You receive coding session observations and produce structured workspace documentation.

Rules:
- Output ONLY raw markdown. Do NOT wrap in code fences (\`\`\`markdown or \`\`\`).
- Do NOT add preamble, explanation, or commentary outside the markdown sections.
- Use exactly the section headings requested. Do not invent new heading names.
- CRITICAL: copy tool names, function names, CLI commands, and symbol names EXACTLY as they appear in the observations. Do not paraphrase, rename, or abbreviate them. For example: if an observation says "kirograph_impact", write "kirograph_impact" — never "kilo-graph", "kirograph impact", "kiloGraph", or any other variation.`;

/** Extract kirograph_* tool names from observations for post-processing correction. */
export function extractKirographTools(observations: MemObservation[]): string[] {
  const tools = new Set<string>();
  for (const obs of observations) {
    for (const m of obs.content.matchAll(/\bkirograph_\w+/g)) tools.add(m[0]);
  }
  return [...tools];
}

/**
 * Replace common model hallucinations of kirograph tool names with the correct form.
 * The model often splits "kirograph_impact" into "kilo-graph", "kyrograph_", etc.
 */
/**
 * Replace model hallucinations of kirograph tool names with the correct form.
 * Matches broad variants: kilo-graph, kyrograph, kirographtest, kirograph_X, etc.
 * Uses the known tool list from observations to pick the right replacement.
 */
export function fixKirographToolNames(text: string, knownTools: string[]): string {
  if (knownTools.length === 0) return text;

  // Map tool suffix → correct full name (e.g. 'impact' → 'kirograph_impact')
  const toolMap = new Map<string, string>();
  for (const tool of knownTools) {
    const parts = tool.split('_');
    if (parts.length >= 2) toolMap.set(parts.slice(1).join('_'), tool);
  }

  return text.replace(
    /\b(?:kilo|kiro|kyro|kero)[a-z]*[_\- ]?graph[a-z_\- ]*\b/gi,
    (match) => {
      const lower = match.toLowerCase().replace(/[^a-z]/g, '');
      // Find the known tool whose suffix appears in the match
      for (const [suffix, tool] of toolMap) {
        if (lower.includes(suffix.replace(/_/g, ''))) return tool;
      }
      // Fallback: return the first known tool (likely the only one)
      return knownTools[0];
    }
  );
}

/** Prompt for the workspace brief only — no skills. */
export function buildBriefPrompt(observations: MemObservation[]): string {
  const byKind: Record<string, string[]> = {};
  for (const obs of observations) {
    (byKind[obs.kind] ??= []).push(obs.content);
  }

  const lines: string[] = ['Observations from recent coding sessions:\n'];
  for (const [kind, contents] of Object.entries(byKind)) {
    lines.push(`[${kind}]`);
    for (const c of contents) lines.push(`- ${c}`);
    lines.push('');
  }

  lines.push(
    'Write a workspace brief using ONLY these sections (skip any with no content):\n',
    '## Decisions',
    '(one bullet per architectural or implementation decision)\n',
    '## Known Errors & Fixes',
    '(one bullet per error — what broke and the fix)\n',
    '## Recurring Patterns',
    '(one bullet per recurring pattern)\n',
    '## Architecture Notes',
    '(one bullet per architectural constraint)\n',
    'Be concise. One fact per bullet. Do not repeat observations verbatim. Do NOT use code fences.',
  );

  return lines.join('\n');
}

/** Prompt for a single skill file given a group of related observations. */
export function buildSkillPrompt(procedureObservations: string[]): string {
  const lines = [
    'The following observations all describe the same recurring development procedure:\n',
    ...procedureObservations.map(o => `- ${o}`),
    '',
    'Write a skill file in EXACTLY this format (fill in the placeholders, keep the structure):\n',
    '---',
    'name: <short-kebab-case-slug>',
    'description: <one sentence describing the procedure>',
    'trigger_phrases:',
    '  - <phrase that means "I should use this skill">',
    '  - <another trigger phrase>',
    '---',
    '',
    '## When to use',
    '<One sentence: when should a developer run this procedure?>',
    '',
    '## Steps',
    '1. <First step — include the exact command/tool if relevant>',
    '2. <Second step>',
    '3. <Third step>',
    '',
    'Use the EXACT tool names from the observations (e.g. kirograph_impact, not "kirograph impact").',
    'Write ONLY the skill file content. No explanation, no preamble, no code fences.',
  ];
  return lines.join('\n');
}

/** Group pattern/decision observations that share a common procedure theme. */
export function detectRecurringProcedures(observations: MemObservation[]): string[][] {
  // Only look at pattern observations — they most likely describe recurring steps
  const patterns = observations
    .filter(o => o.kind === 'pattern' || o.kind === 'decision')
    .map(o => o.content);

  if (patterns.length < 3) return [];

  // Simple heuristic: if 3+ pattern observations exist, treat them as one procedure group.
  // A more sophisticated implementation could cluster by keyword overlap.
  return [patterns];
}

// ── Output parsing ────────────────────────────────────────────────────────────

/** Extract the assistant reply from a transformers.js text-generation output. */
export function extractGeneratedText(output: any): string {
  const generated = output?.[0]?.generated_text;
  let text: string;
  if (Array.isArray(generated)) {
    // Chat model: returns array of messages — last one is assistant
    text = generated.at(-1)?.content ?? '';
  } else {
    // Plain text model
    text = typeof generated === 'string' ? generated : '';
  }
  return stripCodeFences(text);
}

/** Strip outer markdown code fences that small models tend to add. */
export function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
}

/**
 * Detect and truncate repetition loops that small models fall into.
 * Splits into sentences and cuts at the first one that closely repeats a prior sentence.
 */
export function truncateAtRepetitionLoop(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const seen: string[] = [];
  const result: string[] = [];

  for (const sentence of sentences) {
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (normalized.length < 10) { result.push(sentence); continue; }
    // If this sentence is very similar to a recent one, stop
    const isDuplicate = seen.slice(-5).some(s => {
      const overlap = [...normalized].filter((c, i) => s[i] === c).length;
      return overlap / normalized.length > 0.8;
    });
    if (isDuplicate) break;
    seen.push(normalized);
    result.push(sentence);
  }

  return result.join(' ').trim();
}

/** Remove hallucinated image markdown and leaked run-IDs from model output. */
export function removeHallucinatedContent(text: string): string {
  return text
    // Remove image markdown: ![alt](url) — models hallucinate URLs
    .replace(/!\[.*?\]\(.*?\)/g, '')
    // Remove run-id timestamps [1780913041] wherever they appear (inline or line-start)
    .replace(/\*?\*?\[\d{9,}\]\*?\*?\s*/g, '')
    // Collapse 3+ consecutive blank lines into 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split generated text into brief body and skill sections.
 *
 * Primary: looks for `## Skill: <slug>` (explicit format requested in prompt).
 * Fallback: looks for `### <Title>` subsections inside a `## Recurring Procedures`
 *           block — small models often use this structure instead.
 */
export function parseOutput(text: string): { brief: string; skills: Array<{ slug: string; content: string }> } {
  // ── Primary: flexible skill heading detection ─────────────────────────────
  // Small models use many variations:
  //   ## Skill: slug          (ideal)
  //   # Skills: Title         (common)
  //   Skill: Title            (no heading marker)
  //   Skill:\nTitle           (name on next line)
  const skillRegex = /^(?:#{1,3}\s+)?Skills?:\s*(.*)$/gim;
  const skillMatches: Array<{ index: number; slug: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = skillRegex.exec(text)) !== null) {
    let title = match[1].trim();
    // If no title on same line, grab the next non-empty line as the title
    if (!title) {
      const rest = text.slice(match.index + match[0].length);
      const nextLine = rest.split('\n').find(l => l.trim());
      title = nextLine?.trim() ?? '';
    }
    if (!title) continue;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    skillMatches.push({ index: match.index, slug });
  }

  if (skillMatches.length > 0) {
    const briefEnd = skillMatches[0].index;
    const skills = skillMatches.map((m, i) => {
      const start = m.index;
      const end = i + 1 < skillMatches.length ? skillMatches[i + 1].index : text.length;
      // Normalise heading to ## Skill: <slug> for the file writer
      const body = text.slice(start, end).replace(/^#{1,3} Skills?: .+$/im, '').trim();
      return { slug: m.slug, content: `## Skill: ${m.slug}\n\n${body}` };
    });
    return { brief: text.slice(0, briefEnd).trim(), skills };
  }

  // ── Fallback: ### subsections inside ## Recurring Procedures ──────────────
  const recurringMatch = /^## Recurring Procedures\b.*$/m.exec(text);
  if (recurringMatch) {
    const sectionStart = recurringMatch.index;
    // Find the end of this section (next ## heading or end of text)
    const nextH2 = /^## /m.exec(text.slice(sectionStart + recurringMatch[0].length));
    const sectionEnd = nextH2
      ? sectionStart + recurringMatch[0].length + nextH2.index
      : text.length;

    const sectionBody = text.slice(sectionStart, sectionEnd);
    const subRegex = /^### (.+)$/gm;
    const subMatches: Array<{ index: number; title: string }> = [];
    let sub: RegExpExecArray | null;
    while ((sub = subRegex.exec(sectionBody)) !== null) {
      subMatches.push({ index: sectionStart + sub.index, title: sub[1].trim() });
    }

    if (subMatches.length > 0) {
      const brief = (text.slice(0, sectionStart) + text.slice(sectionEnd)).trim();
      const skills = subMatches.map((m, i) => {
        const start = m.index;
        const end = i + 1 < subMatches.length ? subMatches[i + 1].index : sectionEnd;
        const slug = m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        // Reformat as ## Skill: heading for the file writer
        const content = `## Skill: ${slug}\n\n` + text.slice(start + m.title.length + 4, end).trim();
        return { slug, content };
      });
      return { brief, skills };
    }
  }

  return { brief: text.trim(), skills: [] };
}

// ── File writing ──────────────────────────────────────────────────────────────

const WATCHMEN_BLOCK_START = '<!-- kirograph-watchmen:start -->';
const WATCHMEN_BLOCK_END = '<!-- kirograph-watchmen:end -->';

/** Upsert the KiroGraph Watchmen block in a plain text/markdown file. */
export function upsertBriefBlock(filePath: string, brief: string): void {
  const header = `## KiroGraph Watchmen\n\n_Auto-generated by KiroGraph Watchmen. Last updated: ${new Date().toISOString().slice(0, 10)}._\n\n`;
  const block = `${WATCHMEN_BLOCK_START}\n${header}${brief}\n${WATCHMEN_BLOCK_END}`;

  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf8'); } catch { /* new file */ }

  const startIdx = existing.indexOf(WATCHMEN_BLOCK_START);
  const endIdx = existing.indexOf(WATCHMEN_BLOCK_END);

  let updated: string;
  if (startIdx !== -1 && endIdx !== -1) {
    updated = existing.slice(0, startIdx) + block + existing.slice(endIdx + WATCHMEN_BLOCK_END.length);
  } else {
    updated = existing ? `${existing}\n\n${block}\n` : `${block}\n`;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, updated, 'utf8');
}

/** Write the Kiro steering workspace brief (inclusion: always). */
export function writeKiroBrief(steeringDir: string, brief: string): void {
  const content =
    `---\ninclusion: always\n---\n\n` +
    `# Workspace Knowledge (KiroGraph Watchmen)\n\n` +
    `_Auto-generated. Last updated: ${new Date().toISOString().slice(0, 10)}._\n\n` +
    `${brief}\n`;
  const filePath = path.join(steeringDir, 'kirograph-watchmen.md');
  fs.mkdirSync(steeringDir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Write a Kiro skill file (inclusion: manual) with SKILL.md format.
 * Merges the `inclusion: manual` Kiro frontmatter with whatever name/description/
 * trigger_phrases frontmatter the model generated inside the content.
 */
export function writeKiroSkill(steeringDir: string, slug: string, content: string): void {
  // The model may have produced its own frontmatter block — extract it
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let modelFrontmatter = '';
  let body = content;

  if (frontmatterMatch) {
    modelFrontmatter = frontmatterMatch[1].trim();
    body = frontmatterMatch[2].trim();
  }

  // Build the final frontmatter: Kiro inclusion first, then model metadata
  const frontmatter = ['---', 'inclusion: manual'];
  if (modelFrontmatter) {
    for (const line of modelFrontmatter.split('\n')) {
      // Skip if it would duplicate inclusion
      if (!line.startsWith('inclusion:')) frontmatter.push(line);
    }
  }
  frontmatter.push('---');

  const filePath = path.join(steeringDir, `watchmen-${slug}.md`);
  fs.mkdirSync(steeringDir, { recursive: true });
  fs.writeFileSync(filePath, frontmatter.join('\n') + '\n\n' + body + '\n', 'utf8');
}

/** Remove stale watchmen-*.md skill files that are not in the current slug set. */
export function pruneStaleSkills(steeringDir: string, currentSlugs: Set<string>): string[] {
  const pruned: string[] = [];
  if (!fs.existsSync(steeringDir)) return pruned;
  for (const file of fs.readdirSync(steeringDir)) {
    if (!file.startsWith('watchmen-') || !file.endsWith('.md')) continue;
    const slug = file.slice('watchmen-'.length, -'.md'.length);
    if (!currentSlugs.has(slug)) {
      fs.unlinkSync(path.join(steeringDir, file));
      pruned.push(file);
    }
  }
  return pruned;
}

// ── Main synthesis entry point ────────────────────────────────────────────────

export interface SynthesisResult {
  skipped: boolean;
  reason?: string;
  filesWritten: string[];
  skillsWritten: string[];
  skillsPruned: string[];
  summaryObservation: string;
}

/** Run one model call with a token progress bar. Returns cleaned text. */
async function generate(
  pipe: any,
  systemPrompt: string,
  userPrompt: string,
  modelName: string,
  label: string,
  quiet: boolean,
  maxNewTokens = 500,
): Promise<string> {
  const knownTools: string[] = []; // filled per-call by caller if needed
  let tokenCount = 0;

  let streamer: any = undefined;
  if (!quiet && pipe.tokenizer) {
    const { TextStreamer } = await import('@huggingface/transformers') as any;
    streamer = new TextStreamer(pipe.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: () => {
        tokenCount++;
        const pct = Math.min(Math.round((tokenCount / maxNewTokens) * 100), 99);
        const filled = Math.round(pct / 5);
        const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
        process.stdout.write(`\r  ${label.padEnd(14)} [${bar}] ${String(tokenCount).padStart(3)} tokens`);
      },
    });
  }

  const genOpts: any = {
    ...(isGemma4(modelName)
      ? { temperature: 1.0, top_p: 0.95, top_k: 64, do_sample: true }
      : { do_sample: false, repetition_penalty: 1.3 }),
    max_new_tokens: maxNewTokens,
    ...(streamer ? { streamer } : {}),
  };

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];

  const output = await pipe(messages, genOpts);

  if (!quiet && tokenCount > 0) {
    process.stdout.write(`\r  ${' '.repeat(64)}\r`);
  }

  return truncateAtRepetitionLoop(
    removeHallucinatedContent(stripCodeFences(extractGeneratedText(output)))
  );
}

export async function runLocalSynthesis(
  observations: MemObservation[],
  readyResult: WatchmenReadyResult,
  modelName: string,
  projectRoot: string,
  quiet = false,
): Promise<SynthesisResult> {
  const pipe = await getGenPipeline(modelName, quiet);
  const knownTools = extractKirographTools(observations);

  const filesWritten: string[] = [];
  const skillsWritten: string[] = [];
  let skillsPruned: string[] = [];

  // ── Pass 1: workspace brief ───────────────────────────────────────────────
  if (!quiet) process.stdout.write('  Generating brief...\n');
  const briefRaw = await generate(pipe, SYSTEM_PROMPT, buildBriefPrompt(observations), modelName, 'Brief', quiet);
  const brief = fixKirographToolNames(briefRaw, knownTools);

  for (const target of readyResult.targetFiles) {
    const absPath = path.isAbsolute(target) ? target : path.join(projectRoot, target);
    if (target === '.kiro/steering/kirograph-watchmen.md') {
      const steeringDir = path.join(projectRoot, readyResult.skillTargetDir ?? '.kiro/steering');
      writeKiroBrief(steeringDir, brief);
    } else {
      upsertBriefBlock(absPath, brief);
    }
    filesWritten.push(target);
  }

  // ── Pass 2: skill files (Kiro only, one call per procedure group) ─────────
  if (readyResult.skillTargetDir) {
    const steeringDir = path.join(projectRoot, readyResult.skillTargetDir);
    const currentSlugs = new Set<string>();
    const procedureGroups = detectRecurringProcedures(observations);

    for (let i = 0; i < procedureGroups.length; i++) {
      const group = procedureGroups[i];
      const label = `Skill ${i + 1}/${procedureGroups.length}`;
      if (!quiet) process.stdout.write(`  Generating ${label}...\n`);

      const skillRaw = await generate(
        pipe, SYSTEM_PROMPT, buildSkillPrompt(group), modelName, label, quiet, 350,
      );
      const skillText = fixKirographToolNames(skillRaw, knownTools);

      // Extract slug from name: field in model frontmatter, or derive from content
      const nameMatch = skillText.match(/^name:\s*(.+)$/m);
      const slug = nameMatch
        ? nameMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        : `procedure-${i + 1}`;

      if (!currentSlugs.has(slug)) {
        writeKiroSkill(steeringDir, slug, skillText);
        skillsWritten.push(`watchmen-${slug}.md`);
        currentSlugs.add(slug);
      }
    }

    skillsPruned = pruneStaleSkills(steeringDir, currentSlugs);
  }

  const summaryParts = [`Synthesized ${observations.length} observations`];
  if (filesWritten.length) summaryParts.push(`into ${filesWritten.join(', ')}`);
  if (skillsWritten.length) summaryParts.push(`wrote skills: ${skillsWritten.join(', ')}`);
  if (skillsPruned.length) summaryParts.push(`pruned: ${skillsPruned.join(', ')}`);

  return {
    skipped: false,
    filesWritten,
    skillsWritten,
    skillsPruned,
    summaryObservation: summaryParts.join('; ') + '.',
  };
}
