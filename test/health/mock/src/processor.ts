export class DataProcessor {
  processAll(items: unknown[]): unknown[] {
    const results: unknown[] = [];
    for (const item of items) {
      if (!item) continue;
      if (typeof item === 'string') {
        if (item.length === 0) continue;
        if (item.startsWith('skip')) continue;
        if (item.includes('@')) { results.push({ type: 'email', value: item }); }
        else if (item.match(/^\d+$/)) { results.push({ type: 'number', value: parseInt(item) }); }
        else { results.push({ type: 'text', value: item }); }
      } else if (typeof item === 'number') {
        if (item < 0) results.push({ type: 'neg', value: item });
        else if (item === 0) results.push({ type: 'zero', value: item });
        else if (item > 1000) results.push({ type: 'large', value: item });
        else results.push({ type: 'pos', value: item });
      } else if (Array.isArray(item)) {
        for (const n of item) { if (n != null) results.push({ type: 'nested', value: n }); }
      }
    }
    return results;
  }
  simpleAdd(a: number, b: number): number { return a + b; }
}
