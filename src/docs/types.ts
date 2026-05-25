/**
 * KiroGraph Documentation Module — Type Definitions
 *
 * These types model the documentation layer: sections extracted from
 * doc files, cross-references to code symbols, and search results.
 * All populated only when enableDocs=true in config.
 */

// ── Section ───────────────────────────────────────────────────────────────────

export interface DocSection {
  id: string;              // stable section ID (file_path::ancestor-chain/slug#level)
  filePath: string;        // relative path to doc file
  title: string;           // heading text
  level: number;           // heading depth (1–6, 0 for root/document-level)
  parentId: string | null; // parent section ID (null for top-level)
  summary: string | null;  // one-line summary (extractive or first-sentence)
  byteStart: number;       // byte offset in original file
  byteEnd: number;         // byte offset end
  contentHash: string;     // SHA-256 of section content (drift detection)
  tags: string[];          // extracted tags/refs (code refs, links, etc.)
  position: number;        // ordering among siblings
  updatedAt: number;       // timestamp
}

// ── Code Reference ────────────────────────────────────────────────────────────

export type DocRefType = 'mentions' | 'documents' | 'example' | 'configures';

export interface DocCodeRef {
  sectionId: string;
  qualifiedName: string;   // stable across reindex
  refType: DocRefType;
  confidence: number;      // 0.0–1.0
}

// ── Parser Output ─────────────────────────────────────────────────────────────

export interface ParsedSection {
  title: string;
  level: number;
  byteStart: number;
  byteEnd: number;
  content: string;         // raw content of the section (for hashing + summarization)
  children: ParsedSection[];
}

export interface ParseResult {
  sections: ParsedSection[];
  format: string;          // 'markdown' | 'rst' | 'asciidoc' | 'rdoc' | 'org' | 'html' | 'plaintext' | 'openapi'
}

// ── Format Parser Interface ───────────────────────────────────────────────────

export interface DocFormatParser {
  /** Unique name for this parser (e.g. 'markdown', 'rst') */
  name: string;
  /** File extensions this parser handles (e.g. ['.md', '.mdx']) */
  extensions: string[];
  /** Parse a file's content into a section hierarchy */
  parse(content: string, filePath: string): ParseResult;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface DocSearchResult {
  section: DocSection;
  score: number;
  matchType: 'fts' | 'semantic' | 'exact';
}

// ── Index Result ──────────────────────────────────────────────────────────────

export interface DocIndexResult {
  filesIndexed: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  sectionsRemoved: number;
  codeRefsCreated: number;
  errors: string[];
  duration: number;
}

// ── TOC Entry ─────────────────────────────────────────────────────────────────

export interface DocTocEntry {
  id: string;
  title: string;
  level: number;
  filePath: string;
  summary: string | null;
  children?: DocTocEntry[];
}
