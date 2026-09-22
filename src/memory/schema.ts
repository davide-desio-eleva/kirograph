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
 *
 * `memorySchemaValidation` (separate, also off by default) goes further:
 * it validates `input.fields` — free-form structured data beyond `content`
 * — against a JSON Schema registered per kind at
 * `.kirograph/memory-schemas/<kind>.schema.json`. A kind with no schema
 * file is never validated (schemas are opt-in per kind, not required), so
 * enabling this flag with zero schemas present is a no-op.
 */
import * as path from 'path';
import type { MemObservationInput, ObservationKind } from './types';
import { loadJsonSchema, validateAgainstSchema, SchemaLoadError } from '../shared/json-schema';

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

/**
 * Validate `input.fields` against `.kirograph/memory-schemas/<kind>.schema.json`
 * when a schema is registered for the observation's kind. Only invoked when
 * `memorySchemaValidation` is enabled; throws MemorySchemaError naming every
 * violation when the schema exists and fields don't conform.
 */
export function validateObservationFields(input: MemObservationInput, memorySchemasDir: string): void {
  const kind = input.kind ?? 'note';
  const schemaPath = path.join(memorySchemasDir, `${kind}.schema.json`);

  let schema;
  try {
    schema = loadJsonSchema(schemaPath);
  } catch (err) {
    if (err instanceof SchemaLoadError) {
      throw new MemorySchemaError(err.message);
    }
    throw err;
  }
  if (!schema) return; // no schema registered for this kind — nothing to validate

  const violations = validateAgainstSchema(input.fields ?? {}, schema);
  if (violations.length > 0) {
    throw new MemorySchemaError(
      `Observation fields for kind "${kind}" failed schema validation:\n  - ${violations.join('\n  - ')}`,
    );
  }
}
