import type { IndexEntry, SearchResult } from './index-manager';

export type QueryOp = 'AND' | 'OR' | 'NOT';
export type SortOrder = 'asc' | 'desc';
export type SortField = 'score' | 'name' | 'file' | 'line';

export interface QueryClause {
  field: keyof IndexEntry | 'fulltext';
  value: string | number | boolean;
  op?: '=' | '!=' | '>' | '<' | 'contains' | 'startsWith';
}

export interface StructuredQuery {
  clauses: QueryClause[];
  combinator: QueryOp;
  sort?: { field: SortField; order: SortOrder };
  limit?: number;
  offset?: number;
}

export interface QueryPlan {
  steps: string[];
  estimatedCost: number;
  useVectorSearch: boolean;
}

export interface QueryResult {
  results: SearchResult[];
  total: number;
  durationMs: number;
  plan: QueryPlan;
}

export class QueryPlanner {
  plan(query: StructuredQuery): QueryPlan {
    const steps: string[] = [];
    let cost = 0;
    let useVectorSearch = false;

    const fulltextClause = query.clauses.find(c => c.field === 'fulltext');
    if (fulltextClause) {
      steps.push('vector-search');
      cost += 50;
      useVectorSearch = true;
    }

    const exactClauses = query.clauses.filter(c => c.field !== 'fulltext');
    for (const clause of exactClauses) {
      if (clause.op === '=') {
        steps.push(`index-lookup:${clause.field}`);
        cost += 5;
      } else {
        steps.push(`scan:${clause.field}`);
        cost += 20;
      }
    }

    if (query.sort) {
      steps.push(`sort:${query.sort.field}`);
      cost += 10;
    }

    steps.push('paginate');

    return { steps, estimatedCost: cost, useVectorSearch };
  }
}

export class QueryExecutor {
  private planner = new QueryPlanner();

  execute(entries: IndexEntry[], query: StructuredQuery): QueryResult {
    const start = performance.now();
    const plan = this.planner.plan(query);

    let results = entries.map(entry => ({
      entry,
      score: this.scoreEntry(entry, query),
      highlights: this.computeHighlights(entry, query),
    }));

    if (query.combinator === 'AND') {
      results = results.filter(r => this.matchesAll(r.entry, query.clauses));
    } else if (query.combinator === 'OR') {
      results = results.filter(r => this.matchesAny(r.entry, query.clauses));
    }

    const sortField = query.sort?.field ?? 'score';
    const sortOrder = query.sort?.order ?? 'desc';
    results.sort((a, b) => {
      const av = this.sortValue(a, sortField);
      const bv = this.sortValue(b, sortField);
      return sortOrder === 'asc' ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
    });

    const total = results.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;
    const paginated = results.slice(offset, offset + limit);

    return {
      results: paginated,
      total,
      durationMs: performance.now() - start,
      plan,
    };
  }

  private matchesAll(entry: IndexEntry, clauses: QueryClause[]): boolean {
    return clauses.every(c => this.matchClause(entry, c));
  }

  private matchesAny(entry: IndexEntry, clauses: QueryClause[]): boolean {
    return clauses.some(c => this.matchClause(entry, c));
  }

  private matchClause(entry: IndexEntry, clause: QueryClause): boolean {
    if (clause.field === 'fulltext') {
      const q = String(clause.value).toLowerCase();
      return entry.symbolName.toLowerCase().includes(q) ||
        (entry.docstring?.toLowerCase().includes(q) ?? false);
    }
    const val = entry[clause.field as keyof IndexEntry];
    const cval = clause.value;
    switch (clause.op ?? '=') {
      case '=': return val === cval;
      case '!=': return val !== cval;
      case '>': return (val as number) > (cval as number);
      case '<': return (val as number) < (cval as number);
      case 'contains': return String(val).toLowerCase().includes(String(cval).toLowerCase());
      case 'startsWith': return String(val).toLowerCase().startsWith(String(cval).toLowerCase());
      default: return false;
    }
  }

  private scoreEntry(entry: IndexEntry, query: StructuredQuery): number {
    const ft = query.clauses.find(c => c.field === 'fulltext');
    if (!ft) return 0.5;
    const q = String(ft.value).toLowerCase();
    const name = entry.symbolName.toLowerCase();
    if (name === q) return 1.0;
    if (name.startsWith(q)) return 0.85;
    if (name.includes(q)) return 0.65;
    if (entry.docstring?.toLowerCase().includes(q)) return 0.4;
    return 0.2;
  }

  private computeHighlights(entry: IndexEntry, query: StructuredQuery): string[] {
    const ft = query.clauses.find(c => c.field === 'fulltext');
    if (!ft) return [];
    const q = String(ft.value);
    const highlights: string[] = [];
    if (entry.symbolName.toLowerCase().includes(q.toLowerCase())) {
      highlights.push(entry.symbolName);
    }
    return highlights;
  }

  private sortValue(r: SearchResult, field: SortField): string | number {
    switch (field) {
      case 'score': return r.score;
      case 'name': return r.entry.symbolName;
      case 'file': return r.entry.filePath;
      case 'line': return r.entry.startLine;
      default: return r.score;
    }
  }
}

export function buildQuery(text: string, options: Partial<StructuredQuery> = {}): StructuredQuery {
  return {
    clauses: [{ field: 'fulltext', value: text, op: 'contains' }],
    combinator: 'OR',
    limit: 10,
    ...options,
  };
}

export function filterByKind(kind: IndexEntry['kind']): QueryClause {
  return { field: 'kind', value: kind, op: '=' };
}

export function filterByFile(filePath: string): QueryClause {
  return { field: 'filePath', value: filePath, op: '=' };
}
