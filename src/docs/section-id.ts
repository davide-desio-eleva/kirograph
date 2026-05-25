/**
 * Stable Section ID Generation
 *
 * Format: {file_path}::{ancestor-chain/slug}#{level}
 *
 * IDs remain stable across re-indexing when:
 * - file path doesn't change
 * - heading text doesn't change
 * - heading level doesn't change
 * - parent heading chain doesn't change
 */

/**
 * Convert a heading title to a URL-safe slug.
 * Matches common Markdown anchor generation (GitHub-style).
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    // Remove special characters except spaces and hyphens
    .replace(/[^\w\s-]/g, '')
    // Replace whitespace with hyphens
    .replace(/\s+/g, '-')
    // Collapse multiple hyphens
    .replace(/-+/g, '-')
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Fallback for empty result
    || 'untitled';
}

/**
 * Build the ancestor chain string from parent slugs.
 * Example: ['installation', 'prerequisites'] → 'installation/prerequisites'
 */
export function buildAncestorChain(parentSlugs: string[], currentSlug: string): string {
  return [...parentSlugs, currentSlug].join('/');
}

/**
 * Generate a stable section ID.
 *
 * @param filePath - Relative path to the doc file
 * @param ancestorSlugs - Slugified titles of all ancestor headings (root → parent)
 * @param title - The heading title of this section
 * @param level - The heading level (1–6)
 * @returns Stable section ID string
 *
 * @example
 * generateSectionId('docs/install.md', [], 'Installation', 1)
 * // → 'docs/install.md::installation#1'
 *
 * generateSectionId('docs/install.md', ['installation'], 'Prerequisites', 2)
 * // → 'docs/install.md::installation/prerequisites#2'
 */
export function generateSectionId(
  filePath: string,
  ancestorSlugs: string[],
  title: string,
  level: number,
): string {
  const slug = slugify(title);
  const chain = buildAncestorChain(ancestorSlugs, slug);
  return `${filePath}::${chain}#${level}`;
}

/**
 * Parse a section ID back into its components.
 * Returns null if the ID is malformed.
 */
export function parseSectionId(id: string): {
  filePath: string;
  ancestorChain: string;
  level: number;
} | null {
  const doubleColonIdx = id.indexOf('::');
  if (doubleColonIdx === -1) return null;

  const filePath = id.slice(0, doubleColonIdx);
  const rest = id.slice(doubleColonIdx + 2);

  const hashIdx = rest.lastIndexOf('#');
  if (hashIdx === -1) return null;

  const ancestorChain = rest.slice(0, hashIdx);
  const level = parseInt(rest.slice(hashIdx + 1), 10);

  if (isNaN(level) || level < 0) return null;

  return { filePath, ancestorChain, level };
}
