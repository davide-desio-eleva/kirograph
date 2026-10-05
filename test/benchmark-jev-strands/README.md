# jev vs strands-decider benchmark

Compares the two typed-classification backends KiroGraph can use for its
opt-in `*Mode` toggles, across the three decisions it actually delegates:

| Use case | Question type | Production path |
|----------|---------------|-----------------|
| Memory relation | Choice | `memoryRelationMode` → `classifyRelationWithJev` |
| Wiki contradiction | Noul | `wikiContradictionMode` → `checkContradictionWithJev` |
| Attack-surface auth | Noul | `securityAuthDetectionMode` → `checkAuthWithJev` |

Both backends speak the same `POST /v1/systemone` protocol, so the benchmark
exercises the built clients in `dist/` — the full client path, not raw HTTP.

## What it measures

- Per-use-case latency over N iterations: **mean / p50 / p95 / min / max**.
- A single **batched** request carrying all three questions about one state
  (the "asking many questions is nearly free" shared-prefix path both servers
  support), plus how much faster that is than three separate requests.
- Whether the two backends **agree** on each answer (when both run).

## Running it

```bash
# Zero setup — starts both bundled mock servers, runs, tears them down.
./run.sh

# More samples:
./run.sh --iterations 100

# Machine-readable:
./run.sh --json
```

> ⚠ **Mock numbers are not model latency.** The bundled mocks reply instantly,
> so the default run measures client + HTTP + event-loop overhead only. It is
> useful for regression-checking the client path and for a fair protocol
> baseline, not for comparing how fast the two *models* think.

## Real latency comparison

Point the benchmark at real endpoints via env vars (the clients and `run.sh`
both read them). Any mock whose real endpoint is configured is **not** started.

```bash
# Start a local strands-decider server (see its docs/inference.md):
#   pip install strands-decider
#   strands-decider serve StrandsAgents/strands-decider-2B-hobson-v19 --port 8000

# strands (real, local) vs jev (real, cloud):
JEV_API_KEY=sk-... STRANDS_BASE_URL=http://127.0.0.1:8000 ./run.sh

# just the local model:
STRANDS_BASE_URL=http://127.0.0.1:8000 ./run.sh --only strands
```

| Env var | Effect |
|---------|--------|
| `JEV_API_KEY` | Use the real jev cloud API (no jev mock started). |
| `JEV_BASE_URL` | Override the jev base URL (default mock `:8842`). |
| `STRANDS_BASE_URL` | Use a real strands server (no strands mock started). Default mock `:8843`. |

The script exits non-zero if a requested backend errors (e.g. a dead server),
so it is safe to wire into CI as a smoke test of the client path.
