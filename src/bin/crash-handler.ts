// ── Global error handler for WASM runtime crashes ─────────────────────────────
//
// A WASM runtime (the tree-sitter parsers) can abort with a raw "Aborted()" or a RuntimeError
// and no context. We intercept it here to print a clear explanation before the process exits.
export function installCrashHandler(): void {
  process.on('uncaughtException', (err: Error) => {
    const msg = err?.message ?? String(err);
    const isWasmAbort = msg.includes('Aborted(') || msg.includes('RuntimeError') || (err as any)?.constructor?.name === 'RuntimeError';

    if (isWasmAbort) {
      process.stderr.write([
        '',
        '  ✖ KiroGraph crashed: a WASM runtime (a tree-sitter parser) aborted.',
        '',
        '  The graph is not damaged: the database is written in transactions.',
        '  Run the command again; if it fails on the same file, report it with',
        '  the output of: kirograph sync --errors',
        '',
      ].join('\n'));
      process.exit(1);
    }

    // Not a WASM crash — re-throw as normal
    process.stderr.write(`Uncaught error: ${msg}\n`);
    process.exit(1);
  });
}
