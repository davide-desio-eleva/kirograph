/**
 * KiroGraph Reference Name Matcher
 *
 * Implements multi-strategy reference matching for the resolution engine.
 * Mirrors CodeGraph src/resolution/name-matcher.ts
 */

import type { Node } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MatchResult {
  nodeId: string;
  confidence: number; // 0.0–1.0
  strategy: 'qualified' | 'exact' | 'method' | 'fuzzy';
}

// ── matchReference ────────────────────────────────────────────────────────────

/**
 * Attempt to match a reference name against a set of candidate nodes using
 * multiple strategies in priority order. Returns the best match above the
 * given confidence threshold, or null if none qualifies.
 *
 * Strategy order (highest confidence first):
 *   1. Qualified name match  — confidence 0.95
 *   2. Exact name match      — confidence 0.90
 *   3. Method call pattern   — confidence 0.85  (refName contains '.')
 *   4. Fuzzy / lowercase     — confidence 0.50
 */
export function matchReference(
  refName: string,
  candidates: Node[],
  threshold: number
): MatchResult | null {
  if (!refName || candidates.length === 0) return null;

  // Strategy 1: Qualified name match (confidence 0.95)
  for (const node of candidates) {
    if (node.qualifiedName === refName) {
      const result: MatchResult = { nodeId: node.id, confidence: 0.95, strategy: 'qualified' };
      if (result.confidence >= threshold) return result;
    }
  }

  // Strategy 2: Exact name match (confidence 0.90)
  for (const node of candidates) {
    if (node.name === refName) {
      const result: MatchResult = { nodeId: node.id, confidence: 0.9, strategy: 'exact' };
      if (result.confidence >= threshold) return result;
    }
  }

  // Strategy 3: Method call pattern — if refName contains '.', match the part after '.' (confidence 0.85)
  if (refName.includes('.')) {
    const methodPart = refName.slice(refName.lastIndexOf('.') + 1);
    for (const node of candidates) {
      if (node.name === methodPart) {
        const result: MatchResult = { nodeId: node.id, confidence: 0.85, strategy: 'method' };
        if (result.confidence >= threshold) return result;
      }
    }
  }

  // Strategy 4: Fuzzy / lowercase match (confidence 0.50)
  const lowerRef = refName.toLowerCase();
  for (const node of candidates) {
    if (node.name.toLowerCase() === lowerRef) {
      const result: MatchResult = { nodeId: node.id, confidence: 0.5, strategy: 'fuzzy' };
      if (result.confidence >= threshold) return result;
    }
  }

  return null;
}
