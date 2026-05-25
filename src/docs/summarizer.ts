/**
 * Documentation Section Summarizer
 *
 * Strategies:
 * - 'first-sentence': Extract the first meaningful sentence from section content
 * - 'embedding': Use the embedding model to score sentences by relevance to heading (future)
 * - 'off': No summary, return null
 */

/**
 * Extract a summary from section content based on the configured strategy.
 */
export function summarizeSection(
  content: string,
  title: string,
  strategy: 'embedding' | 'first-sentence' | 'off',
): string | null {
  if (strategy === 'off') return null;

  // For now, both 'embedding' and 'first-sentence' use first-sentence extraction.
  // The 'embedding' strategy will be enhanced when vector scoring is integrated.
  return extractFirstSentence(content, title);
}

/**
 * Extract the first meaningful sentence from section content.
 * Skips the heading line itself, code blocks, and empty lines.
 */
function extractFirstSentence(content: string, title: string): string | null {
  const lines = content.split('\n');
  const bodyLines = lines.filter(l => {
    const trimmed = l.trim();
    if (trimmed === '') return false;
    // Skip heading markers
    if (trimmed.startsWith('#') || trimmed.startsWith('=') || trimmed.startsWith('*')) {
      // But only if it looks like a heading (starts with marker + space)
      if (/^[#=*]+\s/.test(trimmed)) return false;
    }
    // Skip code fence markers
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) return false;
    // Skip setext underlines
    if (/^[=-]+\s*$/.test(trimmed)) return false;
    // Skip HTML tags that are likely structural
    if (/^<\/?(?:h[1-6]|div|section|article|nav|header|footer)[^>]*>$/i.test(trimmed)) return false;
    // Skip lines that are just the title repeated
    if (trimmed.toLowerCase() === title.toLowerCase()) return false;
    return true;
  });

  if (bodyLines.length === 0) return null;

  // Take first non-empty line, truncate at sentence boundary
  const firstLine = bodyLines[0].trim();

  // Strip leading list markers (-, *, 1.)
  const cleaned = firstLine.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '');

  const sentenceEnd = cleaned.search(/[.!?]\s|[.!?]$/);
  if (sentenceEnd > 0 && sentenceEnd < 200) {
    return cleaned.slice(0, sentenceEnd + 1).trim();
  }

  // No sentence boundary — take the whole first line (truncated)
  return cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
}
