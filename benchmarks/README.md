# KiroGraph Benchmarks

Reproducible benchmarks measuring token efficiency of KiroGraph vs naive file reading.

## How It Works

1. Each benchmark repo is cloned at a pinned SHA (or HEAD of a branch)
2. The repo is indexed with `kirograph init` + `kirograph index`
3. A set of predefined queries are run against the graph
4. For each query, we measure:
   - **Graph tokens**: size of the MCP tool response (chars / 4)
   - **Naive tokens**: estimated cost of reading all files the agent would need to grep/read to answer the same question
   - **Savings %**: reduction in tokens

## Running

```bash
kirograph benchmark                    # Run all benchmarks
kirograph benchmark --repo express     # Run for a specific repo
kirograph benchmark --report           # Generate markdown report from results
```

## Configuration

Edit `benchmarks/config.json` to add repos and queries. Each repo needs:
- `url`: Git clone URL
- `sha`: Pinned commit SHA (or branch name for latest)
- `queries`: Array of `{ tool, args }` objects to run

## Results

Results are written to `benchmarks/results/` as JSON files. Run `--report` to generate a summary table.

## Determinism

- Repos are cloned at pinned SHAs so the codebase is identical across runs
- No embeddings are used (pure structural graph) so results are deterministic
- Token estimation uses chars/4 heuristic (consistent across machines)
