/**
 * PixelRAG HTTP bridge — pure client, no lifecycle management.
 * All lifecycle (install, index build, server spawn) lives in pixelrag-manager.ts.
 *
 * EXPERIMENTAL: This module is experimental and may change without notice.
 */

import type { VisualSearchResult, PixelRAGStatus } from './types';

export async function isServerRunning(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function searchVisual(
  endpoint: string,
  query: string,
  opts: { limit?: number; minTileHeight?: number } = {},
): Promise<VisualSearchResult[]> {
  const limit = opts.limit ?? 3;
  const minTileHeight = opts.minTileHeight ?? 50;

  const res = await fetch(`${endpoint}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: limit, min_tile_height: minTileHeight }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PixelRAG /search returned ${res.status}: ${body}`);
  }

  const data = await res.json() as { results?: unknown[] };
  const raw = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data as unknown[] : []);

  return raw.map((hit: unknown) => {
    const h = hit as Record<string, unknown>;
    return {
      score: typeof h.score === 'number' ? h.score : 0,
      filePath: typeof h.url === 'string' ? h.url : String(h.url ?? ''),
      tileIndex: typeof h.tile_index === 'number' ? h.tile_index : 0,
      chunkIndex: typeof h.chunk_index === 'number' ? h.chunk_index : 0,
      yOffset: typeof h.y_offset === 'number' ? h.y_offset : 0,
      chunkHeight: typeof h.chunk_height === 'number' ? h.chunk_height : 0,
      chunkImagePath: typeof h.chunk_image_path === 'string' ? h.chunk_image_path : '',
    };
  });
}

export async function getStatus(endpoint: string, indexPath: string | null): Promise<PixelRAGStatus> {
  const running = await isServerRunning(endpoint);
  let tileCount: number | null = null;
  let lastBuilt: number | null = null;

  if (running) {
    try {
      const res = await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        if (typeof data.tile_count === 'number') tileCount = data.tile_count;
        if (typeof data.built_at === 'number') lastBuilt = data.built_at * 1000;
      }
    } catch { /* best-effort */ }
  }

  return { running, endpoint, indexPath, tileCount, lastBuilt };
}
