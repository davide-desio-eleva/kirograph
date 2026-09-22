/**
 * KiroGraph — Minimal JSON Schema subset validator
 *
 * No runtime dependency (ajv, etc.) — this validates the subset of JSON
 * Schema actually needed for opt-in structured-field validation in the
 * memory (memorySchemaValidation) and wiki (wikiTypedPages) modules:
 * type, enum, required, properties (recursive), items (arrays),
 * additionalProperties, pattern, min/maxLength, minimum/maximum, and a
 * basic `format: "date"` check. Unknown schema keywords (title,
 * description, $schema, x-* extensions, etc.) are ignored rather than
 * rejected, so a schema authored for a fuller validator still loads here.
 */

import * as fs from 'fs';

export interface JsonSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  [key: string]: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

/**
 * Validate `data` against `schema`, returning one human-readable message per
 * violation (empty array = valid). `pathPrefix` is prepended to field paths
 * for nested calls — pass '' at the top level.
 */
export function validateAgainstSchema(data: unknown, schema: JsonSchema, pathPrefix = ''): string[] {
  const errors: string[] = [];
  const label = pathPrefix || '(root)';

  if (schema.type) {
    const actual = typeOf(data);
    const matches = schema.type === 'integer'
      ? actual === 'number' && Number.isInteger(data)
      : actual === schema.type;
    if (!matches) {
      errors.push(`${label}: expected type ${schema.type}, got ${actual}`);
      return errors; // further checks would be meaningless against the wrong type
    }
  }

  if (schema.enum && !schema.enum.some(v => v === data)) {
    errors.push(`${label}: expected one of ${schema.enum.map(describe).join(', ')}, got ${describe(data)}`);
  }

  if (typeof data === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      errors.push(`${label}: does not match pattern ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${label}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push(`${label}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.format === 'date' && !DATE_RE.test(data)) {
      errors.push(`${label}: expected format date (YYYY-MM-DD), got ${describe(data)}`);
    }
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${label}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`${label}: above maximum ${schema.maximum}`);
    }
  }

  if (schema.properties && typeOf(data) === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`${pathPrefix ? pathPrefix + '.' : ''}${key}: missing required field`);
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      const propSchema = schema.properties[key];
      if (!propSchema) {
        if (schema.additionalProperties === false) {
          errors.push(`${childPath}: unknown field, not allowed by schema`);
        }
        continue;
      }
      errors.push(...validateAgainstSchema(value, propSchema, childPath));
    }
  }

  if (schema.items && Array.isArray(data)) {
    data.forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${pathPrefix}[${i}]`));
    });
  }

  return errors;
}

export class SchemaLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaLoadError';
  }
}

/**
 * Load a `.schema.json` file from `schemaPath`. Returns null when the file
 * doesn't exist — schemas are opt-in per kind/type, so "no schema for this
 * kind" is a normal, silent no-op rather than an error. Throws
 * SchemaLoadError when the file exists but isn't valid JSON, since that's
 * an authoring mistake worth surfacing.
 */
export function loadJsonSchema(schemaPath: string): JsonSchema | null {
  if (!fs.existsSync(schemaPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    throw new SchemaLoadError(`Failed to read schema "${schemaPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as JsonSchema;
  } catch (err) {
    throw new SchemaLoadError(`Schema "${schemaPath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
