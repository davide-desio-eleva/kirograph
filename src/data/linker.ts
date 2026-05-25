/**
 * Data ↔ Code Linker
 *
 * Detects references to data files in source code and populates data_code_refs.
 * Patterns detected:
 *   - readFileSync('data/users.csv'), readFile('path/to/file.csv')
 *   - pd.read_csv('data/file.csv'), pd.read_excel(...)
 *   - open('data/file.csv'), csv.reader(open(...))
 *   - COPY FROM 'file.csv', \copy ... from 'file.csv'
 *   - require('./data/file.json'), import ... from './data/file.json'
 *   - fs.createReadStream('data/file.csv')
 *   - String literals matching known data file paths
 */

import type { DataCodeRef } from './types';

/** Patterns that indicate a code symbol reads a data file */
const READ_PATTERNS = [
  // Node.js / TypeScript
  /readFileSync\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /readFile\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /createReadStream\s*\(\s*['"`]([^'"`]+)['"`]/g,
  // Python pandas
  /read_csv\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /read_excel\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /read_json\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /read_parquet\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /read_table\s*\(\s*['"`]([^'"`]+)['"`]/g,
  // Python open
  /open\s*\(\s*['"`]([^'"`]+\.(?:csv|tsv|jsonl|ndjson|json|xlsx|xls|parquet))['"`]/g,
  // SQL COPY
  /COPY\s+\w+\s+FROM\s+['"`]([^'"`]+)['"`]/gi,
  /\\copy\s+\w+\s+from\s+['"`]([^'"`]+)['"`]/gi,
  // Generic path references in strings (data file extensions)
  /['"`]((?:\.\.?\/)?(?:[\w\-./]+\/)?[\w\-]+\.(?:csv|tsv|jsonl|ndjson|xlsx|xls|parquet))['"`]/g,
];

/** Patterns that indicate a code symbol writes a data file */
const WRITE_PATTERNS = [
  /writeFileSync\s*\(\s*['"`]([^'"`]+\.(?:csv|tsv|jsonl|json|xlsx|parquet))['"`]/g,
  /writeFile\s*\(\s*['"`]([^'"`]+\.(?:csv|tsv|jsonl|json|xlsx|parquet))['"`]/g,
  /to_csv\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /to_excel\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /to_json\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /to_parquet\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /createWriteStream\s*\(\s*['"`]([^'"`]+\.(?:csv|tsv|jsonl|json|xlsx|parquet))['"`]/g,
  /COPY\s+\w+\s+TO\s+['"`]([^'"`]+)['"`]/gi,
];

/**
 * Scan source code content for references to data files.
 * Returns matched file paths with their reference type.
 */
export function detectDataReferences(
  sourceContent: string,
  knownDataPaths: Set<string>,
): Array<{ filePath: string; refType: 'reads' | 'writes'; confidence: number }> {
  const refs = new Map<string, { refType: 'reads' | 'writes'; confidence: number }>();

  // Check read patterns
  for (const pattern of READ_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sourceContent)) !== null) {
      const filePath = normalizePath(match[1]!);
      if (isDataFilePath(filePath, knownDataPaths)) {
        const existing = refs.get(filePath);
        if (!existing || existing.confidence < 0.9) {
          const confidence = knownDataPaths.has(filePath) ? 1.0 : 0.7;
          refs.set(filePath, { refType: 'reads', confidence });
        }
      }
    }
  }

  // Check write patterns
  for (const pattern of WRITE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sourceContent)) !== null) {
      const filePath = normalizePath(match[1]!);
      if (isDataFilePath(filePath, knownDataPaths)) {
        const confidence = knownDataPaths.has(filePath) ? 1.0 : 0.7;
        refs.set(filePath, { refType: 'writes', confidence });
      }
    }
  }

  return Array.from(refs.entries()).map(([filePath, info]) => ({
    filePath,
    ...info,
  }));
}

/**
 * Generate dataset ID from a file path (same logic as indexer).
 */
function generateDatasetId(filePath: string): string {
  return filePath
    .replace(/\.[^.]+$/, '')
    .replace(/[/\\]/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Normalize a path reference found in code.
 * Strips leading ./ and resolves simple relative paths.
 */
function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/');
}

/**
 * Check if a path looks like a data file (by extension or known path match).
 */
function isDataFilePath(filePath: string, knownPaths: Set<string>): boolean {
  if (knownPaths.has(filePath)) return true;
  // Check extension
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ['csv', 'tsv', 'jsonl', 'ndjson', 'json', 'xlsx', 'xls', 'parquet'].includes(ext ?? '');
}

/**
 * Link data files to code symbols.
 * Scans all indexed source files for references to known data file paths.
 */
export class DataCodeLinker {
  private readonly db: any;
  private readonly projectRoot: string;

  constructor(db: any, projectRoot: string) {
    this.db = db;
    this.projectRoot = projectRoot;
  }

  /**
   * Populate data_code_refs by scanning source files for data file references.
   * Returns the number of refs created.
   */
  linkAll(): number {
    const fs = require('fs');
    const path = require('path');

    // Get all known data file paths
    const datasets = this.db.all('SELECT id, file_path FROM data_datasets') as Array<{ id: string; file_path: string }>;
    if (datasets.length === 0) return 0;

    const knownPaths = new Set(datasets.map(d => d.file_path));
    const pathToDatasetId = new Map(datasets.map(d => [d.file_path, d.id]));

    // Get all indexed source files (from the graph)
    const sourceFiles = this.db.all(
      `SELECT file_path FROM files WHERE file_path NOT LIKE '%.csv' AND file_path NOT LIKE '%.tsv' AND file_path NOT LIKE '%.jsonl' AND file_path NOT LIKE '%.ndjson' AND file_path NOT LIKE '%.xlsx' AND file_path NOT LIKE '%.parquet'`
    ) as Array<{ file_path: string }>;

    // Clear existing refs
    this.db.run('DELETE FROM data_code_refs');

    let refsCreated = 0;

    for (const file of sourceFiles) {
      const absPath = path.join(this.projectRoot, file.file_path);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const refs = detectDataReferences(content, knownPaths);
      if (refs.length === 0) continue;

      // Find the qualified_name of the containing symbol (file-level)
      // Use the file path as the qualified name for file-level refs
      const qualifiedName = file.file_path;

      for (const ref of refs) {
        const datasetId = pathToDatasetId.get(ref.filePath);
        if (!datasetId) continue;

        try {
          this.db.run(
            `INSERT OR REPLACE INTO data_code_refs (dataset_id, qualified_name, ref_type, confidence) VALUES (?, ?, ?, ?)`,
            [datasetId, qualifiedName, ref.refType, ref.confidence],
          );
          refsCreated++;
        } catch {
          // Ignore duplicates
        }
      }
    }

    return refsCreated;
  }
}
