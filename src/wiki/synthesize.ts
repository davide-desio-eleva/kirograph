/**
 * KiroGraph Wiki — Local model synthesis
 *
 * Reads the pending wiki_queue, runs a local HuggingFace model to produce
 * WIKI_DIFF blocks for each queued source, then applies them.
 * Mirrors the watchmen local synthesis pattern.
 */

import {
  getGenPipeline,
  stripCodeFences,
  removeHallucinatedContent,
  truncateAtRepetitionLoop,
} from '../watchmen/synthesize';
import type { KiroGraphWiki } from './index';

export interface WikiSynthesisResult {
  processed: number;
  created: string[];
  updated: string[];
  errors: string[];
}

const SYSTEM_PROMPT = `You are a project wiki assistant. You receive a source text and a wiki schema, and you produce structured WIKI_DIFF blocks.

Rules:
- Output ONLY WIKI_DIFF_START / WIKI_DIFF_END blocks. No explanations, no prose.
- Follow the schema exactly — use the JSON header format shown.
- Use "page" field (not "slug") in the JSON header.
- Keep page slugs lowercase-kebab-case.
- Copy technical terms, function names, and identifiers exactly as they appear in the source.
- If the source contradicts an existing page, add a WIKI_DIFF_CONFLICTS block.`;

function isGemma4(modelName: string): boolean {
  return modelName.includes('gemma-4');
}

async function generate(
  pipe: any,
  userPrompt: string,
  modelName: string,
  quiet: boolean,
): Promise<string> {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const genOpts: any = {
    max_new_tokens: 600,
    return_full_text: false,
  };

  if (isGemma4(modelName)) {
    genOpts.temperature = 1.0;
    genOpts.top_p = 0.95;
    genOpts.top_k = 64;
    genOpts.do_sample = true;
  } else {
    genOpts.do_sample = false;
    genOpts.repetition_penalty = 1.3;
  }

  const output = await pipe(messages, genOpts);

  let text: string;
  if (Array.isArray(output) && output[0]?.generated_text) {
    const gt = output[0].generated_text;
    text = Array.isArray(gt) ? gt[gt.length - 1]?.content ?? '' : String(gt);
  } else {
    text = String(output);
  }

  return removeHallucinatedContent(truncateAtRepetitionLoop(stripCodeFences(text)));
}

export async function runWikiLocalSynthesis(
  wiki: KiroGraphWiki,
  modelName: string,
  quiet = false,
): Promise<WikiSynthesisResult> {
  const result: WikiSynthesisResult = {
    processed: 0,
    created: [],
    updated: [],
    errors: [],
  };

  const queue = wiki.getPendingQueue();
  if (queue.length === 0) return result;

  if (!quiet) process.stderr.write(`[wiki] Loading model ${modelName}...\n`);
  const pipe = await getGenPipeline(modelName, quiet);

  for (const entry of queue) {
    if (!quiet) process.stderr.write(`[wiki] Synthesizing source "${entry.sourceName}"...\n`);
    try {
      const prompt = wiki.getIngestPrompt(entry.sourceText, entry.sourceName);
      const raw = await generate(pipe, prompt, modelName, quiet);

      if (!raw.includes('WIKI_DIFF_START')) {
        if (!quiet) process.stderr.write(`[wiki] No WIKI_DIFF found for "${entry.sourceName}" — skipping\n`);
        result.errors.push(`No WIKI_DIFF produced for source "${entry.sourceName}"`);
        continue;
      }

      const applyResult = wiki.applyDiff(raw);
      result.created.push(...applyResult.created);
      result.updated.push(...applyResult.updated);
      result.processed++;
    } catch (e: any) {
      result.errors.push(`Error processing "${entry.sourceName}": ${e?.message ?? e}`);
    }
  }

  wiki.clearQueue();
  return result;
}
