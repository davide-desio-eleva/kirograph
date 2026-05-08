/**
 * Layer detector for Elixir / Phoenix projects.
 */
import type { LayerDetector, ArchLayerMatch } from '../types';
import picomatch from 'picomatch';

const LAYER_PATTERNS: Array<[string, string, number]> = [
  // API / web layer
  ['api', '**/controllers/**', 0.95],
  ['api', '**/*_controller.ex', 0.95],
  ['api', '**/channels/**', 0.9],
  ['api', '**/*_channel.ex', 0.9],
  ['api', '**/router.ex', 0.95],
  ['api', '**/endpoint.ex', 0.85],
  ['api', '**/plugs/**', 0.8],
  ['api', '**/*_plug.ex', 0.8],
  // Service / context layer (Phoenix contexts)
  ['service', '**/contexts/**', 0.95],
  ['service', '**/context/**', 0.9],
  ['service', '**/workers/**', 0.85],
  ['service', '**/jobs/**', 0.85],
  ['service', '**/*_worker.ex', 0.85],
  // Data layer
  ['data', '**/schemas/**', 0.95],
  ['data', '**/*_schema.ex', 0.95],
  ['data', '**/repo.ex', 0.9],
  ['data', '**/migrations/**', 0.9],
  ['data', '**/priv/repo/migrations/**', 0.95],
  ['data', '**/models/**', 0.85],
  // UI / LiveView layer
  ['ui', '**/live/**', 0.95],
  ['ui', '**/*_live.ex', 0.95],
  ['ui', '**/*_live_view.ex', 0.95],
  ['ui', '**/components/**', 0.9],
  ['ui', '**/*_component.ex', 0.9],
  ['ui', '**/views/**', 0.85],
  ['ui', '**/*_view.ex', 0.85],
  ['ui', '**/templates/**', 0.8],
  // Shared / infrastructure
  ['shared', '**/helpers/**', 0.8],
  ['shared', '**/lib/**', 0.75],
  ['shared', '**/config/**', 0.75],
  ['shared', '**/mailers/**', 0.8],
  ['shared', '**/*_mailer.ex', 0.8],
];

export const elixirLayerDetector: LayerDetector = {
  language: 'elixir',

  async detect(files: string[], _projectRoot: string, configLayers?: Record<string, string[]>): Promise<ArchLayerMatch[]> {
    const results: ArchLayerMatch[] = [];
    const configMatchers = _buildConfigMatchers(configLayers ?? {});

    for (const file of files) {
      if (!file.endsWith('.ex') && !file.endsWith('.exs')) continue;

      const configMatch = _matchConfig(file, configMatchers);
      if (configMatch) { results.push({ ...configMatch, filePath: file }); continue; }

      let best: ArchLayerMatch | null = null;
      for (const [layerName, pattern, confidence] of LAYER_PATTERNS) {
        if (picomatch(pattern)(file)) {
          if (!best || confidence > best.confidence) {
            best = { layerName, filePath: file, confidence, matchedPattern: pattern };
          }
        }
      }
      if (best) results.push(best);
    }
    return results;
  },
};

function _buildConfigMatchers(configLayers: Record<string, string[]>): Array<[string, ReturnType<typeof picomatch>, string]> {
  return Object.entries(configLayers).flatMap(([layerName, patterns]) =>
    patterns.map((pattern): [string, ReturnType<typeof picomatch>, string] =>
      [layerName, picomatch(pattern), pattern]
    )
  );
}

function _matchConfig(file: string, matchers: Array<[string, ReturnType<typeof picomatch>, string]>): Omit<ArchLayerMatch, 'filePath'> | null {
  for (const [layerName, matcher, pattern] of matchers) {
    if (matcher(file)) return { layerName, confidence: 1.0, matchedPattern: `config:${pattern}` };
  }
  return null;
}
