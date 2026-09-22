import type { MemRelation } from './types';

/**
 * Human-readable, direction-aware description of how `observationId` relates
 * to the other observation in `rel`.
 *
 * `supersedes` is directional — per its classification criteria (see
 * relation-jev.ts), Observation B replaces Observation A, so A is the
 * outdated side and B is the replacing side. Rendering both sides of the
 * same relation with the identical "supersedes" label (as the CLI/MCP output
 * used to) makes a directional relation look symmetric and misleading — a
 * still-current observation and the exact one it just replaced show up with
 * the same annotation. Every other relation type is symmetric and needs no
 * such distinction.
 */
export function describeMemRelation(rel: MemRelation, observationId: string): { icon: string; label: string; otherId: string } {
  const otherId = rel.observationA === observationId ? rel.observationB : rel.observationA;

  if (rel.relation === 'supersedes') {
    const isOutdatedSide = rel.observationA === observationId;
    return isOutdatedSide
      ? { icon: '⚠', label: 'superseded by', otherId }
      : { icon: '↩', label: 'supersedes', otherId };
  }

  const icon = rel.relation === 'conflicts_with' ? '⚡' : '~';
  return { icon, label: rel.relation, otherId };
}
