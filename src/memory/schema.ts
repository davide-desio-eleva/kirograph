/**
 * KiroGraph Memory — Opt-in write validation
 *
 * Off by default (config `memoryStrictWrites`): MemoryManager.store() has
 * never validated its input — `kind` is typed as a fixed union in
 * MemObservationInput, but every call site (CLI `--kind`, the
 * `kirograph_mem_store` MCP tool, direct API use) casts through `any` with
 * no runtime check, so an arbitrary string silently lands in the `kind`
 * column and breaks every downstream consumer that pattern-matches against
 * the known set (search filters, watchmen's passive-capture kind map,
 * timeline rendering). When `memoryStrictWrites` is enabled, writes that
 * don't conform are rejected with the violation named instead of silently
 * corrupting the store.
 */
import type { MemObservationInput, ObservationKind } from './types';

export const OBSERVATION_KINDS: readonly ObservationKind[] = [
  'decision', 'error', 'pattern', 'architecture', 'summary', 'note',
];

export class MemorySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemorySchemaError';
  }
}

/**
 * Validate an observation write against KiroGraph's memory model.
 * Throws MemorySchemaError naming the violation; callers only invoke this
 * when `memoryStrictWrites` is on.
 */
export function validateObservationInput(input: MemObservationInput): void {
  const kind = input.kind ?? 'note';
  if (!OBSERVATION_KINDS.includes(kind)) {
    throw new MemorySchemaError(
      `Invalid observation kind "${kind}" — must be one of: ${OBSERVATION_KINDS.join(', ')}`,
    );
  }

  if (input.tags?.some(t => typeof t !== 'string' || t.trim() === '')) {
    throw new MemorySchemaError('Observation tags must be non-empty strings');
  }
}
