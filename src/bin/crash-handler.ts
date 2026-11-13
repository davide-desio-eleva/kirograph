// ── Global error handler for WASM runtime crashes ─────────────────────────────
//
// node-sqlite3-wasm calls process.abort() when it hits a fatal error (e.g.
// database is locked by another process). This produces a raw "Aborted()"
// message with no context. We intercept it here to print a clear explanation
// before the process exits.
export function installCrashHandler(): void {
  process.on('uncaughtException', (err: Error) => {
    const msg = err?.message ?? String(err);
    const isWasmAbort = msg.includes('Aborted(') || msg.includes('RuntimeError') || (err as any)?.constructor?.name === 'RuntimeError';

    if (isWasmAbort) {
      process.stderr.write([
        '',
        '  ✖ KiroGraph crashed: SQLite WASM runtime aborted.',
        '',
        '  Most likely cause: another process (e.g. the Kiro MCP server) is',
        '  holding the database open while indexing is running.',
        '',
        '  How to fix:',
        '    1. Close Kiro IDE (or disable the kirograph MCP server) before indexing',
        '    2. Run: kirograph unlock',
        '    3. Then retry: kirograph index',
        '',
        '  If the problem persists, delete the lock manually:',
        '    del .kirograph\\kirograph.db.lock  (Windows)',
        '    rm -rf .kirograph/kirograph.db.lock  (macOS/Linux)',
        '',
      ].join('\n'));
      process.exit(1);
    }

    // Not a WASM crash — re-throw as normal
    process.stderr.write(`Uncaught error: ${msg}\n`);
    process.exit(1);
  });
}
