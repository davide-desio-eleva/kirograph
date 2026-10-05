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
- **Batching** (the "asking many questions is nearly free" shared-prefix path):
  3 questions on **one fixed state**, measured both ways — as a single batched
  request vs 3 separate requests — and the resulting speedup. Both paths use the
  identical state, so this isolates the batching benefit alone (it does not
  conflate it with state length).
- Whether the two backends **agree** on each answer: the **label** (the actual
  decision) is compared separately from the **confidence**, so two backends
  picking the same label with different confidence (e.g. `supersedes@0.93` vs
  `supersedes@0.63`) is reported as "same label … confidence 0.93 vs 0.63
  (Δ0.30)", not hidden behind a blanket "same answer".

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

Configure real endpoints with a `.env` file in **this directory** (copy
`.env.example` to `.env`), or with environment variables. `run.sh` loads the
`.env` on startup; a variable already set in your shell wins over the file. The
`.env` is gitignored, so a real `JEV_API_KEY` never gets committed.

```bash
cp .env.example .env
# edit .env, then:
./run.sh
```

Example `.env`:

```sh
# benchmark the real jev cloud API
JEV_API_KEY=sk-...
# benchmark a local strands-decider server (auto-started if not already running)
STRANDS_BASE_URL=http://127.0.0.1:8000
```

**Auto-start.** When `STRANDS_BASE_URL` points at a localhost port and nothing
is listening there, `run.sh` starts `strands-decider serve <STRANDS_MODEL>
--port <port>` for you and stops it when the run finishes. It needs
`strands-decider` on your PATH (`pip install strands-decider`); the first run
downloads the model weights, so startup can take a while. If a server is
already running at that URL, it is used as-is. Set `STRANDS_AUTOSTART=0` to
disable auto-start.

Everything also works as inline env vars without a `.env` file:

```bash
# strands (real, local — auto-started) vs jev (real, cloud):
JEV_API_KEY=sk-... STRANDS_BASE_URL=http://127.0.0.1:8000 ./run.sh

# just the local model:
STRANDS_BASE_URL=http://127.0.0.1:8000 ./run.sh --only strands
```

| Key (`.env` or env var) | Effect |
|-------------------------|--------|
| `JEV_API_KEY` | Use the real jev cloud API (no jev mock started). |
| `JEV_BASE_URL` | Override the jev base URL (default: real API when a key is set, else mock `:8842`). |
| `STRANDS_BASE_URL` | The strands server to benchmark. Local + nothing listening → auto-started. No value → mock `:8843`. |
| `STRANDS_MODEL` | Checkpoint/model id for auto-start (default `StrandsAgents/strands-decider-2B-hobson-v19`). |
| `STRANDS_AUTOSTART` | `0` to never auto-start a local server (default `1`). |
| `STRANDS_READY_TIMEOUT` | Seconds `run.sh` waits for an auto-started server's `/health` (default `900` — first run downloads ~4.5GB). |
| `BENCH_TIMEOUT_MS` | Per-request client timeout (default `60000`; also `--timeout <ms>`). |

**First request is slow.** A freshly loaded strands-decider server pays a
one-time device/kernel warm-up on its first inference (a 2B model's first
forward pass can take tens of seconds). The benchmark isolates this: it makes
one cold-start call up front, reports it separately ("first (cold) request
took …"), and excludes it from the latency stats. If even that first call
exceeds the client timeout, raise it with `--timeout` / `BENCH_TIMEOUT_MS`.

The script exits non-zero if a requested backend errors (e.g. a dead server),
so it is safe to wire into CI as a smoke test of the client path.
