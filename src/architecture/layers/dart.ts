/**
 * Layer detector for Dart / Flutter projects.
 *
 * Detects: api, service, data, ui, shared layers based on
 * directory names common in Flutter projects under lib/.
 * Files in test/ are skipped (return no match).
 */
import type { LayerDetector, ArchLayerMatch } from '../types';
import picomatch from 'picomatch';

// Pattern definitions: each entry is [layerName, glob, confidence]
const LAYER_PATTERNS: Array<[string, string, number]> = [
  // UI layer
  ['ui', '**/lib/screens/**', 0.9],
  ['ui', '**/lib/pages/**', 0.9],
  ['ui', '**/lib/views/**', 0.85],
  ['ui', '**/lib/widgets/**', 0.9],
  ['ui', '**/lib/components/**', 0.85],

  // Service / Business logic layer
  ['service', '**/lib/services/**', 0.9],
  ['service', '**/lib/providers/**', 0.85],
  ['service', '**/lib/blocs/**', 0.9],
  ['service', '**/lib/cubits/**', 0.9],
  ['service', '**/lib/notifiers/**', 0.85],

  // Data layer
  ['data', '**/lib/repositories/**', 0.9],
  ['data', '**/lib/data/**', 0.85],
  ['data', '**/lib/datasources/**', 0.9],
  ['data', '**/lib/models/**', 0.85],
  ['data', '**/lib/entities/**', 0.85],
  ['data', '**/lib/domain/**', 0.8],

  // Shared / Infrastructure layer
  ['shared', '**/lib/core/**', 0.85],
  ['shared', '**/lib/utils/**', 0.85],
  ['shared', '**/lib/helpers/**', 0.85],
  ['shared', '**/lib/extensions/**', 0.85],
  ['shared', '**/lib/constants/**', 0.8],

  // API / Navigation layer
  ['api', '**/lib/routes/**', 0.9],
  ['api', '**/lib/navigation/**', 0.85],
  ['api', '**/lib/router/**', 0.85],
  ['api', '**/lib/main.dart', 0.8],
  ['api', '**/lib/app.dart', 0.8],
];

const TEST_PATTERN = picomatch('**/test/**');

export const dartLayerDetector: LayerDetector = {
  language: 'dart',

  async detect(files: string[], _projectRoot: string, configLayers?: Record<string, string[]>): Promise<ArchLayerMatch[]> {
    const results: ArchLayerMatch[] = [];
    const configMatchers = _buildConfigMatchers(configLayers ?? {});

    for (const file of files) {
      if (!file.endsWith('.dart')) continue;

      // Skip test files
      if (TEST_PATTERN(file)) continue;

      const configMatch = _matchConfig(file, configMatchers);
      if (configMatch) {
        results.push({ ...configMatch, filePath: file });
        continue;
      }

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

function _matchConfig(
  file: string,
  matchers: Array<[string, ReturnType<typeof picomatch>, string]>
): Omit<ArchLayerMatch, 'filePath'> | null {
  for (const [layerName, matcher, pattern] of matchers) {
    if (matcher(file)) return { layerName, confidence: 1.0, matchedPattern: `config:${pattern}` };
  }
  return null;
}
