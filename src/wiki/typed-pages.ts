/**
 * KiroGraph Wiki — Typed pages (opt-in, config `wikiTypedPages`)
 *
 * A wiki page may optionally start with a YAML frontmatter block declaring
 * `_type: <type>` plus arbitrary structured fields. When wikiTypedPages is
 * enabled, `wiki lint` validates those fields against a JSON Schema
 * registered at `.kirograph/wiki-schemas/<type>.schema.json`. Pages with no
 * frontmatter, or a `_type` with no schema registered, are never validated —
 * this is purely additive on top of the existing prose-only wiki pages.
 */
import * as path from 'path';
import { parseYaml } from '../shared/yaml';
import { loadJsonSchema, validateAgainstSchema, SchemaLoadError } from '../shared/json-schema';

export interface ParsedFrontmatter {
  /** The declared `_type`, if any. */
  type?: string;
  /** All other frontmatter fields (`_type` excluded). */
  fields: Record<string, unknown>;
  /** Page content with the frontmatter block stripped. */
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a leading `---\n...\n---\n` YAML frontmatter block, if present.
 * Returns `{ fields: {}, body: content }` unchanged when there's no
 * frontmatter block at the very start of the content.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { fields: {}, body: content };

  const parsed = parseYaml(match[1]);
  const { _type, ...fields } = parsed as Record<string, unknown> & { _type?: unknown };

  return {
    type: typeof _type === 'string' ? _type : undefined,
    fields,
    body: content.slice(match[0].length),
  };
}

/**
 * Validate `fields` against `.kirograph/wiki-schemas/<type>.schema.json`.
 * Returns one message per violation. Returns [] when no schema is
 * registered for `type` — schemas are opt-in per type, not required.
 */
export function validatePageSchema(fields: Record<string, unknown>, type: string, wikiSchemasDir: string): string[] {
  const schemaPath = path.join(wikiSchemasDir, `${type}.schema.json`);

  let schema;
  try {
    schema = loadJsonSchema(schemaPath);
  } catch (err) {
    if (err instanceof SchemaLoadError) return [err.message];
    throw err;
  }
  if (!schema) return [];

  return validateAgainstSchema(fields, schema);
}
