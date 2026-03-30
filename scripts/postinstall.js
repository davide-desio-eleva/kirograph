#!/usr/bin/env node
/**
 * Postinstall script — downloads the embedding model to ~/.kirograph/models/
 * Runs automatically after `npm install` or `npx kirograph`.
 *
 * Mirrors CodeGraph scripts/postinstall.js, adapted for KiroGraph:
 *   - Cache dir: ~/.kirograph/models/ (not ~/.codegraph/models/)
 *   - Debug env var: KIROGRAPH_DEBUG (not DEBUG)
 */

const { existsSync, mkdirSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const KIROGRAPH_DIR = join(homedir(), '.kirograph');
const MODELS_DIR = join(KIROGRAPH_DIR, 'models');
const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';

async function downloadModel() {
  // Ensure directories exist
  if (!existsSync(KIROGRAPH_DIR)) {
    mkdirSync(KIROGRAPH_DIR, { recursive: true });
  }
  if (!existsSync(MODELS_DIR)) {
    mkdirSync(MODELS_DIR, { recursive: true });
  }

  // Check if model is already cached
  const modelCachePath = join(MODELS_DIR, MODEL_ID.replace('/', '/'));
  if (existsSync(modelCachePath)) {
    console.log(modelCachePath);
    console.log('KiroGraph: Embedding model already downloaded.');
    return;
  }

  console.log('KiroGraph: Downloading embedding model (~130MB)...');
  console.log('This is a one-time download for semantic code search.\n');

  try {
    // Dynamic import for @xenova/transformers (ESM-only package)
    const { pipeline, env } = await import('@xenova/transformers');

    // Point cache at ~/.kirograph/models/
    env.cacheDir = MODELS_DIR;

    // Download with per-file progress
    await pipeline('feature-extraction', MODEL_ID, {
      progress_callback: (progress) => {
        if (progress.status === 'progress' && progress.file && progress.progress !== undefined) {
          const fileName = progress.file.split('/').pop();
          const percent = Math.round(progress.progress);
          process.stdout.write(`\rDownloading ${fileName}... ${percent}%   `);
        } else if (progress.status === 'done') {
          process.stdout.write('\n');
        }
      },
    });

    console.log('\nKiroGraph: Embedding model ready!');
  } catch (error) {
    // Never break npm install / npx — semantic search will download on first use instead
    console.log('\nKiroGraph: Could not download embedding model.');
    console.log('Semantic search will download it on first use.');
    if (process.env.KIROGRAPH_DEBUG) {
      console.error(error);
    }
  }
}

downloadModel().catch(() => {
  // Silent exit — don't break npm install
  process.exit(0);
});
