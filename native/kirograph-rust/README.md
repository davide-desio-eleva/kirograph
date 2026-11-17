# kirograph-rust

Native index engine for KiroGraph, used when `.kirograph/config.json` has `"engine": "rust"`.

It replaces the two expensive phases of an index or sync:

- **extraction** (`src/extract.rs`, `src/routes.rs`, `src/complexity.rs`): a port of `src/extraction/extractor.ts` and `routes.ts`, run on every core with rayon;
- **writing** (`src/db.rs`): the rows `src/db/database.ts` writes, in the same order, with native SQLite;
- **resolution** (`src/resolve.rs`): a port of `ReferenceResolver.resolveUnresolvedRefs` and the name matcher.

The TypeScript side is `src/core/rust-engine.ts` (loading, fallback) and the `rust` branches of `src/core/pipeline.ts` and `src/resolution/index.ts`.

## Build

```bash
npm install
npm run build        # fetches the grammar sources, then builds the .node for this platform
```

Requires the Rust toolchain. `scripts/fetch-grammars.mjs` downloads the grammars listed in `grammars.json` from npm into `grammars/` (not committed): the versions are those the WASM grammars in `tree-sitter-wasms` were built from, so both engines parse every file into the same tree.

## Keeping the engines in step

The extractor and resolver are line-by-line ports. A change to `extractor.ts`, `routes.ts`, `resolution/index.ts` or to what `database.ts` writes needs the same change here. The parity tests catch a difference:

```bash
node test/rust/extract-parity.js <project>       # every file, both extractors, field by field
node test/rust/db-parity.js <project>            # index with each engine, compare every table in rowid order
node test/rust/sync-parity.js <git-project> <tmp> # same edits synced by each engine
```

## Notes

- Files are parsed from UTF-16, as web-tree-sitter parses JavaScript strings: tree-sitter's error recovery weighs skipped text by its byte size, so a file with syntax errors can recover into a different tree from UTF-8. Offsets are mapped back to the UTF-8 source, and columns are reported in UTF-16 units like the TypeScript engine.
- The WASM SQLite driver locks the database by creating the directory `kirograph.db.lock` and ignores POSIX locks; the native writer takes the same directory around each transaction (`src/lock.rs`) and keeps the process's writer marker fresh.
- The release build is not stripped: a stripped `.node` fails to load on recent macOS ("mis-aligned LINKEDIT string pool").
