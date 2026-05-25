# Contributing to KiroGraph

Thanks for your interest in contributing to KiroGraph! This guide covers everything you need to get started.

## Getting Started

### Prerequisites

- Node.js ≥ 18
- npm

### Setup

```bash
git clone https://github.com/davide-desio-eleva/kirograph.git
cd kirograph
npm install
npm run build
```

### Development

```bash
npm run dev       # watch mode (rebuilds on change)
npm run build     # production build
npm run typecheck # TypeScript type checking
```

## How to Contribute

### Reporting Bugs

Open an issue using the **Bug Report** template. Include:

- KiroGraph version (`kirograph --version`)
- Node.js version
- OS and architecture
- Steps to reproduce
- Expected vs actual behavior

### Suggesting Features

Open an issue using the **Feature Request** template. Describe the problem you're solving and your proposed approach.

### Submitting Code

1. Fork the repository
2. Create a feature branch from `main`: `git checkout -b feat/your-feature`
3. Make your changes
4. Run `npm run build && npm run typecheck` to verify
5. Commit with a clear message (see below)
6. Push and open a Pull Request

### Commit Messages

Use conventional-style commits:

```
feat: add support for Haskell parsing
fix: resolve stale lock file on Windows
docs: update CLI reference for mem commands
refactor: simplify vector search merge logic
```

Prefix with the area when helpful: `feat(memory):`, `fix(mcp):`, `docs(cli):`.

## Project Structure

```
src/
├── architecture/    # Package/layer detection and coupling metrics
├── bin/             # CLI entry point and commands
├── compression/     # Shell output compression and token tracking
├── context/         # Context building logic
├── core/            # Indexing pipeline
├── db/              # SQLite database and schema
├── extraction/      # tree-sitter AST extraction
├── frameworks/      # Framework detection (React, Django, etc.)
├── graph/           # Graph traversal algorithms
├── mcp/             # MCP server and tool handlers
├── memory/          # Persistent cross-session memory
├── resolution/      # Symbol resolution across files
├── search/          # FTS and semantic search
├── sync/            # Incremental file sync
├── vectors/         # Embedding and vector engine integrations
├── config.ts        # Configuration loading
├── index.ts         # Public API (KiroGraph class)
└── types.ts         # Shared type definitions
```

## Guidelines

### Code Style

- TypeScript strict mode
- No `any` unless unavoidable (document why)
- Prefer named exports
- Keep functions focused and small
- Add JSDoc comments for public APIs

### Pull Request Scope

- Keep PRs focused on a single change
- Large features should be broken into smaller PRs when possible
- Update documentation if your change affects user-facing behavior
- Update CHANGELOG.md under an `## [Unreleased]` section

## Non-Kiro Targets

KiroGraph's primary target is Kiro. Experimental integrations for other tools (Claude Code, Codex, etc.) are community-contributed. If you're working on a non-Kiro target:

- Clearly mark it as experimental
- Don't break existing Kiro functionality
- Be prepared to maintain it — PRs without ongoing support may be reverted

## Questions?

Open a Discussion on GitHub or file an issue. We're happy to help you get oriented.
