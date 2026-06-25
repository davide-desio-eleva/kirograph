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

/**
 * Actual /search response shape (from live testing with pixelrag 0.3.x):
 *   { "results": [ { "hits": [ { score, article_id, tile_index, chunk_index,
 *                                y_offset, tile_height, path, url, … } ] } ] }
 *
 * @param idMap  Optional mapping from article_id (string) → original PDF absolute path.
 *               Loaded from <kirographDir>/pixelrag-id-map.json by the caller.
 */
export async function searchVisual(
  endpoint: string,
  query: string,
  opts: { limit?: number; minTileHeight?: number; idMap?: Record<string, string> } = {},
): Promise<VisualSearchResult[]> {
  const limit         = opts.limit ?? 3;
  const minTileHeight = opts.minTileHeight ?? 50;
  const idMap         = opts.idMap ?? {};

  const res = await fetch(`${endpoint}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ text: query }], n_docs: limit }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PixelRAG /search returned ${res.status}: ${body}`);
  }

  // results[0].hits contains the actual hit list
  const data = await res.json() as { results?: { hits?: unknown[] }[] };
  const hits = data.results?.[0]?.hits ?? [];

  const out: VisualSearchResult[] = [];
  for (const hit of hits) {
    const h = hit as Record<string, unknown>;

    const tileHeight = typeof h.tile_height === 'number' ? h.tile_height : 0;
    if (tileHeight < minTileHeight) continue;

    const articleId = String(h.article_id ?? h.url ?? '');
    const filePath  = idMap[articleId] ?? articleId;

    out.push({
      score:          typeof h.score === 'number' ? h.score : 0,
      filePath,
      tileIndex:      typeof h.tile_index   === 'number' ? h.tile_index   : 0,
      chunkIndex:     typeof h.chunk_index  === 'number' ? h.chunk_index  : 0,
      yOffset:        typeof h.y_offset     === 'number' ? h.y_offset     : 0,
      chunkHeight:    tileHeight,
      chunkImagePath: typeof h.path === 'string' ? h.path : '',
    });

    if (out.length >= limit) break;
  }

  return out;
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
