/**
 * Bridge Resolver Registry
 *
 * Manages cross-language bridge resolvers that synthesize edges between
 * symbols in different languages (Swift ↔ ObjC, JS ↔ Native, etc.).
 * Bridges run after standard resolution and emit heuristic-based edges.
 */

import type { Node, Edge, EdgeKind } from '../../types';
import type { ResolutionContext } from '../../frameworks/types';
import type { GraphDatabase } from '../../db/database';
import { logDebug, logWarn } from '../../errors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SynthesizedEdge {
  source: string; // node ID
  target: string; // node ID
  kind: EdgeKind;
  confidence: 'inferred';
  confidenceScore: number;
  metadata: {
    synthesizedBy: string; // e.g. 'swift-objc-bridge'
    provenance: 'heuristic';
    [key: string]: unknown;
  };
}

export interface BridgeResolver {
  name: string;
  /** Detect if this bridge is relevant for the project */
  detect(context: ResolutionContext): boolean;
  /** Synthesize cross-language edges */
  resolve(context: ResolutionContext): SynthesizedEdge[];
}

// ── Bridge Registry ───────────────────────────────────────────────────────────

import { swiftObjcBridge } from './swift-objc';
import { reactNativeLegacyBridge } from './react-native';
import { turboModulesBridge } from './turbomodules';
import { expoModulesBridge } from './expo-modules';
import { nativeEventsBridge } from './native-events';
import { nativeViewsBridge } from './native-views';

const ALL_BRIDGES: BridgeResolver[] = [
  swiftObjcBridge,
  reactNativeLegacyBridge,
  turboModulesBridge,
  expoModulesBridge,
  nativeEventsBridge,
  nativeViewsBridge,
];

// ── Public API ────────────────────────────────────────────────────────────────

export interface BridgeResolutionResult {
  totalEdges: number;
  bridgesRun: string[];
  durationMs: number;
}

/**
 * Run all applicable bridge resolvers and insert synthesized edges into the database.
 * Bridges that are not relevant for the project are skipped via detect().
 */
export function runBridgeResolvers(
  context: ResolutionContext,
  db: GraphDatabase
): BridgeResolutionResult {
  const start = Date.now();
  const bridgesRun: string[] = [];
  let totalEdges = 0;

  for (const bridge of ALL_BRIDGES) {
    try {
      if (!bridge.detect(context)) {
        continue;
      }

      logDebug(`Bridge: running ${bridge.name}`);
      const edges = bridge.resolve(context);

      for (const synth of edges) {
        const edge: Edge = {
          source: synth.source,
          target: synth.target,
          kind: synth.kind,
          confidence: synth.confidence,
          confidenceScore: synth.confidenceScore,
          metadata: synth.metadata,
        };
        db.insertEdge(edge);
      }

      totalEdges += edges.length;
      bridgesRun.push(bridge.name);
      logDebug(`Bridge: ${bridge.name} synthesized ${edges.length} edges`);
    } catch (err) {
      logWarn(`Bridge: ${bridge.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const durationMs = Date.now() - start;
  logDebug(`Bridge resolution complete: ${totalEdges} edges from ${bridgesRun.length} bridges in ${durationMs}ms`);

  return { totalEdges, bridgesRun, durationMs };
}
