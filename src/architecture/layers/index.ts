/**
 * Layer Detector Registry
 *
 * Dispatches layer detection to language-specific detectors.
 * Config-defined layers always win over auto-detection.
 */
import type { LayerDetector, ArchLayerMatch, ArchLayer } from '../types';
import { typescriptLayerDetector } from './typescript';
import { pythonLayerDetector } from './python';
import { goLayerDetector } from './go';
import { javaLayerDetector } from './java';
import { rubyLayerDetector } from './ruby';
import { rustLayerDetector } from './rust';
import { csharpLayerDetector } from './csharp';
import { elixirLayerDetector } from './elixir';

const LAYER_DETECTORS: LayerDetector[] = [
  typescriptLayerDetector,
  pythonLayerDetector,
  goLayerDetector,
  javaLayerDetector,
  rubyLayerDetector,
  rustLayerDetector,
  csharpLayerDetector,
  elixirLayerDetector,
];

export function getAllLayerDetectors(): LayerDetector[] {
  return LAYER_DETECTORS;
}

export function registerLayerDetector(detector: LayerDetector): void {
  const idx = LAYER_DETECTORS.findIndex(d => d.language === detector.language && d.framework === detector.framework);
  if (idx >= 0) LAYER_DETECTORS[idx] = detector;
  else LAYER_DETECTORS.push(detector);
}

export interface FileLayerAssignment {
  filePath: string;
  layerName: string;
  confidence: number;
  matchedPattern: string;
}

/**
 * Run all language-specific layer detectors against the file list.
 * Each file gets at most one layer assignment (highest confidence wins).
 * Config-defined layers (confidence=1.0) always beat auto-detected ones.
 *
 * @param files - relative file paths (from project root)
 * @param projectRoot - absolute project root path
 * @param configLayers - user-defined layer→glob overrides from config
 */
export async function detectAllLayers(
  files: string[],
  projectRoot: string,
  configLayers?: Record<string, string[]>
): Promise<FileLayerAssignment[]> {
  // Collect all matches from all detectors
  const allMatches: ArchLayerMatch[] = [];
  for (const detector of LAYER_DETECTORS) {
    const matches = await detector.detect(files, projectRoot, configLayers);
    allMatches.push(...matches);
  }

  // Per file, keep the highest-confidence match
  const best = new Map<string, ArchLayerMatch>();
  for (const match of allMatches) {
    const existing = best.get(match.filePath);
    if (!existing || match.confidence > existing.confidence) {
      best.set(match.filePath, match);
    }
  }

  return [...best.values()].map(m => ({
    filePath: m.filePath,
    layerName: m.layerName,
    confidence: m.confidence,
    matchedPattern: m.matchedPattern,
  }));
}

/**
 * From a list of FileLayerAssignment, derive the unique ArchLayer records.
 */
export function buildArchLayers(
  assignments: FileLayerAssignment[],
  configLayers?: Record<string, string[]>
): ArchLayer[] {
  const layerMap = new Map<string, ArchLayer>();

  for (const a of assignments) {
    if (!layerMap.has(a.layerName)) {
      const isConfig = configLayers && a.layerName in configLayers;
      layerMap.set(a.layerName, {
        id: `layer:${a.layerName}`,
        name: a.layerName,
        source: isConfig ? 'config' : 'auto',
        patterns: [],
        updatedAt: Date.now(),
      });
    }
    const layer = layerMap.get(a.layerName)!;
    if (!layer.patterns.includes(a.matchedPattern)) {
      layer.patterns.push(a.matchedPattern);
    }
  }

  return [...layerMap.values()];
}
