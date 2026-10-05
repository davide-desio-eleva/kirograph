#!/usr/bin/env node
/**
 * test/benchmark-jev-strands/benchmark.mjs
 *
 * Compares jev (TypeSafe System One, cloud) and strands-decider (local server)
 * on the three decisions KiroGraph actually delegates to a classification
 * backend, using the real question shapes from the production code paths:
 *
 *   relation      — Choice (memory relation classification)
 *   contradiction — Noul   (wiki contradiction detection)
 *   auth          — Noul   (attack-surface auth detection)
 *
 * Both backends speak the same POST /v1/systemone protocol via the built
 * clients in dist/, so this measures the full client path, not raw HTTP.
 *
 * For each use case it reports latency (mean / p50 / p95 / min / max) over N
 * iterations, and separately times a single batched request carrying all
 * three questions about one state — the "asking many questions is nearly
 * free" path both servers support. It also records whether the two backends
 * agree on each answer.
 *
 * ── Endpoints ────────────────────────────────────────────────────────────────
 * By default both point at the local mock servers bundled with the test
 * suites (jev :8842, strands :8843), so the script runs with zero external
 * setup and the numbers reflect protocol/client overhead, not model inference.
 * Point at real endpoints with env vars:
 *
 *   JEV_API_KEY=sk-...                 # enables the real jev cloud API
 *   JEV_BASE_URL=https://api.typesafe.ai
 *   STRANDS_BASE_URL=http://127.0.0.1:8000   # a running `strands-decider serve`
 *
 * Flags:
 *   --iterations N   per-use-case samples (default 30)
 *   --warmup N       discarded warmup calls per backend (default 3)
 *   --timeout MS     per-request timeout (default 60000, or BENCH_TIMEOUT_MS)
 *   --only jev|strands   benchmark a single backend
 *   --json           emit machine-readable JSON instead of the table
 *
 * Usage:
 *   # zero-setup, both mocks (start them first — see run.sh which does it for you):
 *   node benchmark.mjs
 *   # real strands server + mock jev:
 *   STRANDS_BASE_URL=http://127.0.0.1:8000 node benchmark.mjs --only strands
 *   # real both:
 *   JEV_API_KEY=sk-... STRANDS_BASE_URL=http://127.0.0.1:8000 node benchmark.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const ITERATIONS = parseInt(flag('iterations', '30'), 10);
const WARMUP = parseInt(flag('warmup', '3'), 10);
const ONLY = flag('only', null);           // 'jev' | 'strands' | null
const AS_JSON = flag('json', false) === true;
// Per-request timeout for the clients. A real strands-decider server's FIRST
// inference includes a device/kernel warm-up (and a 2B model's first forward
// pass is slow), so the default is generous. Override with --timeout <ms> or
// BENCH_TIMEOUT_MS. The warmup iterations exist precisely to absorb this, so
// steady-state numbers are unaffected.
const TIMEOUT_MS = parseInt(flag('timeout', process.env.BENCH_TIMEOUT_MS || '60000'), 10);

// ── Load the built clients from dist/ ────────────────────────────────────────
let JevClient, StrandsClient;
try {
  ({ JevClient } = require(path.join(ROOT, 'dist/jev/client.js')));
  ({ StrandsClient } = require(path.join(ROOT, 'dist/jev/strands-client.js')));
} catch (err) {
  console.error('Could not load built clients from dist/. Run `npm run build` first.');
  console.error(err.message);
  process.exit(1);
}

// ── Backend configuration ────────────────────────────────────────────────────
// jev base URL default depends on mode: when a real key is set (live), default
// to the production API; otherwise default to the bundled mock (run.sh starts
// it on :8842). An explicit JEV_BASE_URL always wins. This avoids the trap of
// "key set, but URL still points at a mock that was never started".
const JEV_IS_LIVE   = !!process.env.JEV_API_KEY;
const JEV_API_KEY   = process.env.JEV_API_KEY || 'mock-jev-key';
const JEV_BASE_URL  = process.env.JEV_BASE_URL || (JEV_IS_LIVE ? 'https://api.typesafe.ai' : 'http://127.0.0.1:8842');
const STRANDS_BASE_URL = process.env.STRANDS_BASE_URL || 'http://127.0.0.1:8843';
const STRANDS_IS_LIVE  = !!process.env.STRANDS_BASE_URL;

// ── Use cases — the real question shapes from the production code paths ───────
// Each carries a `state` and the exact question object the corresponding
// KiroGraph helper sends. The `expectDifferent` flag is informational only.
const RELATION_CRITERIA = {
  supersedes: 'Observation B replaces or invalidates Observation A as the current decision or fact — A is now outdated.',
  conflicts_with: 'A and B make contradictory claims about the same thing that cannot both be true at the same time.',
  compatible: 'A and B are both true and can coexist without contradiction, even if they discuss related things.',
  scoped: 'A and B both apply, but in different, non-overlapping contexts or scopes.',
  related: 'A and B are on the same topic and worth cross-referencing, but neither conflicts with nor supersedes the other.',
  not_conflict: 'A and B only appear related on the surface (shared keywords) but are not meaningfully connected.',
};

const USE_CASES = [
  {
    id: 'relation',
    label: 'Memory relation (Choice)',
    state:
      'Observation A: We use in-memory session storage for the MVP.\n\n' +
      'Observation B: Migrated to Redis-backed session storage for production scale; the in-memory approach is no longer used.',
    questionId: 'relation',
    question: { type: 'choice', instructions: 'How does Observation B relate to Observation A?', criteria: RELATION_CRITERIA },
    readAnswer: (a) => (a && a.type === 'choice' ? `${a.choice}@${(a.confidence ?? 0).toFixed(2)}` : 'n/a'),
  },
  {
    id: 'contradiction',
    label: 'Wiki contradiction (Noul)',
    state:
      'Page A:\nWe use JWT tokens with 15 minute expiry for session auth.\n\n' +
      'Page B:\nWe use session cookies with no expiry. JWT was removed in the last refactor.',
    questionId: 'contradicts',
    question: { type: 'noul', instructions: 'Page A and Page B make claims that directly contradict each other about the same subject.' },
    readAnswer: (a) => (a && a.type === 'noul' ? `${a.noul >= 0.5 ? 'yes' : 'no'}@${(a.confidence ?? a.noul).toFixed(2)}` : 'n/a'),
  },
  {
    id: 'auth',
    label: 'Attack-surface auth (Noul)',
    state:
      'Route: GET /api/profile\n\nFunctions/middleware on its call path: withSession',
    questionId: 'authenticated',
    question: { type: 'noul', instructions: 'This route is protected by authentication or authorization before its handler logic runs.' },
    readAnswer: (a) => (a && a.type === 'noul' ? `${a.noul >= 0.5 ? 'auth' : 'public'}@${(a.confidence ?? a.noul).toFixed(2)}` : 'n/a'),
  },
];

// Batching test fixture — ONE fixed state, asked N times. Uses the memory
// relation case (a Choice question), which is the richest of the three.
const BATCH_STATE = USE_CASES[0].state;
const BATCH_QUESTION = USE_CASES[0].question;

// ── Stats helpers ─────────────────────────────────────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, x) => s + x, 0);
  return {
    n: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
const ms = (x) => `${x.toFixed(1)}ms`;

// ── Core timing ───────────────────────────────────────────────────────────────
async function timeCall(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { elapsed: performance.now() - t0, result };
}

async function benchBackend(name, client, isLive) {
  const perUseCase = {};
  const sampleAnswers = {};

  // One-time cold-start warm-up, isolated and reported. A freshly loaded model
  // server's first inference pays a device/kernel warm-up cost that is not
  // representative of steady-state latency. We do it once up front (outside the
  // timed loops) so it doesn't skew the samples, and report how long it took.
  let coldStartMs = null;
  if (isLive) {
    const uc0 = USE_CASES[0];
    try {
      const t = await timeCall(() => client.ask(uc0.state, { [uc0.questionId]: uc0.question }));
      coldStartMs = t.elapsed;
    } catch (err) {
      return { name, isLive, error: `cold-start warm-up: ${err.message}` };
    }
  }

  // Per-use-case: one question per request, ITERATIONS times (+ warmup).
  for (const uc of USE_CASES) {
    const samples = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      let timed;
      try {
        timed = await timeCall(() => client.ask(uc.state, { [uc.questionId]: uc.question }));
      } catch (err) {
        return { name, isLive, error: `${uc.id}: ${err.message}` };
      }
      if (i >= WARMUP) {
        samples.push(timed.elapsed);
        if (!sampleAnswers[uc.id]) sampleAnswers[uc.id] = uc.readAnswer(timed.result.answers[uc.questionId]);
      }
    }
    perUseCase[uc.id] = summarize(samples);
  }

  // Batching: the "one state, many questions" shared-prefix path. To make this
  // a FAIR apples-to-apples measurement, we hold the state FIXED (one single
  // state, encoded once) and vary only the number of questions — 3 questions
  // on that one state, as one batched request vs three separate requests.
  //
  // (An earlier version concatenated all three use-case states into one giant
  // state; that penalised a local model unfairly, because it then had to encode
  // a 3x-longer state in the "batched" case but short states in the "separate"
  // case — measuring state length, not batching. Here both paths use the SAME
  // single state, so the only variable is how many requests carry the questions.)
  const BATCH_N = 3;
  const batchState = BATCH_STATE;
  // N distinct question ids, all about the same state (same shape, independent).
  const batchQuestions = {};
  for (let k = 0; k < BATCH_N; k++) batchQuestions[`q${k}`] = BATCH_QUESTION;

  const batchSamples = [];      // one request carrying all N questions
  const separateSamples = [];   // N separate requests, summed per iteration
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    let batched, sepTotal = 0;
    try {
      batched = await timeCall(() => client.ask(batchState, batchQuestions));
      for (let k = 0; k < BATCH_N; k++) {
        const t = await timeCall(() => client.ask(batchState, { [`q${k}`]: BATCH_QUESTION }));
        sepTotal += t.elapsed;
      }
    } catch (err) {
      return { name, isLive, error: `batched: ${err.message}` };
    }
    if (i >= WARMUP) { batchSamples.push(batched.elapsed); separateSamples.push(sepTotal); }
  }

  return {
    name, isLive, perUseCase,
    batched: summarize(batchSamples),
    separate: summarize(separateSamples),
    batchN: BATCH_N,
    sampleAnswers, coldStartMs,
  };
}

// ── Reporting ─────────────────────────────────────────────────────────────────
function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padL(s, w) { s = String(s); return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

function printTable(results) {
  const BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m', CYAN = '\x1b[36m';
  console.log(`\n${BOLD}  jev vs strands-decider — latency over ${ITERATIONS} iterations (${WARMUP} warmup)${RESET}`);
  for (const r of results) {
    const mode = r.isLive ? 'LIVE' : 'mock';
    console.log(`  ${DIM}${r.name} [${mode}]${r.error ? ` — ERROR: ${r.error}` : ''}${RESET}`);
  }
  console.log('');

  const live = results.filter((r) => !r.error);
  if (live.length === 0) { console.log('  No backend produced results.\n'); return; }

  const header = `  ${pad('use case', 26)}${pad('backend', 12)}${padL('mean', 9)}${padL('p50', 9)}${padL('p95', 9)}${padL('min', 9)}${padL('max', 9)}  answer`;
  console.log(`${CYAN}${header}${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(header.length + 4)}${RESET}`);

  for (const uc of USE_CASES) {
    for (const r of live) {
      const s = r.perUseCase[uc.id];
      console.log(
        `  ${pad(uc.label, 26)}${pad(r.name, 12)}${padL(ms(s.mean), 9)}${padL(ms(s.p50), 9)}${padL(ms(s.p95), 9)}${padL(ms(s.min), 9)}${padL(ms(s.max), 9)}  ${DIM}${r.sampleAnswers[uc.id]}${RESET}`,
      );
    }
    // Agreement line when both backends ran. Compare the label (the actual
    // decision) separately from the confidence — two backends can pick the same
    // label with very different confidence, which is worth surfacing, not hiding.
    if (live.length === 2) {
      const [a, b] = live;
      const [la, ca] = a.sampleAnswers[uc.id].split('@');
      const [lb, cb] = b.sampleAnswers[uc.id].split('@');
      const sameLabel = la === lb;
      let note;
      if (!sameLabel) {
        note = `✗ differ (${la} vs ${lb})`;
      } else {
        const na = parseFloat(ca), nb = parseFloat(cb);
        const confGap = (!isNaN(na) && !isNaN(nb)) ? Math.abs(na - nb) : null;
        note = `✓ same label (${la})`;
        if (confGap != null) note += `, confidence ${ca} vs ${cb} (Δ${confGap.toFixed(2)})`;
      }
      console.log(`  ${DIM}${pad('', 26)}${pad('agreement', 12)}${note}${RESET}`);
    }
  }

  console.log(`  ${DIM}${'─'.repeat(header.length + 4)}${RESET}`);
  console.log(`  ${DIM}Batching: ${live[0].batchN} questions on ONE fixed state (same state both ways)${RESET}`);
  for (const r of live) {
    const b = r.batched, s = r.separate;
    console.log(
      `  ${pad(`${r.batchN} q, 1 request`, 26)}${pad(r.name, 12)}${padL(ms(b.mean), 9)}${padL(ms(b.p50), 9)}${padL(ms(b.p95), 9)}${padL(ms(b.min), 9)}${padL(ms(b.max), 9)}  ${DIM}batched${RESET}`,
    );
    console.log(
      `  ${pad(`${r.batchN} q, ${r.batchN} requests`, 26)}${pad(r.name, 12)}${padL(ms(s.mean), 9)}${padL(ms(s.p50), 9)}${padL(ms(s.p95), 9)}${padL(ms(s.min), 9)}${padL(ms(s.max), 9)}  ${DIM}separate${RESET}`,
    );
  }

  // Batching efficiency note — both paths use the identical state, so this is
  // a clean measure of the shared-prefix benefit. Negative → batching is slower.
  for (const r of live) {
    const sepMean = r.separate.mean;
    const delta = sepMean > 0 ? (1 - r.batched.mean / sepMean) * 100 : 0;
    const verb = delta >= 0 ? `${delta.toFixed(0)}% faster` : `${(-delta).toFixed(0)}% slower`;
    console.log(`  ${DIM}${r.name}: ${r.batchN} questions batched vs ${r.batchN} separate requests → ${verb} (${ms(r.batched.mean)} vs ${ms(sepMean)})${RESET}`);
  }
  // Cold-start note (one-time, excluded from the samples above)
  for (const r of live) {
    if (r.coldStartMs != null) {
      console.log(`  ${DIM}${r.name}: first (cold) request took ${ms(r.coldStartMs)} — one-time warm-up, not counted in the stats above${RESET}`);
    }
  }
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const results = [];

  if (ONLY !== 'strands') {
    const jev = new JevClient({ apiKey: JEV_API_KEY, baseUrl: JEV_BASE_URL, timeoutMs: TIMEOUT_MS });
    results.push(await benchBackend('jev', jev, JEV_IS_LIVE));
  }
  if (ONLY !== 'jev') {
    const strands = new StrandsClient({ baseUrl: STRANDS_BASE_URL, timeoutMs: TIMEOUT_MS });
    results.push(await benchBackend('strands', strands, STRANDS_IS_LIVE));
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ iterations: ITERATIONS, warmup: WARMUP, results }, null, 2));
  } else {
    printTable(results);
  }

  // Exit non-zero if a requested backend errored, so CI can catch a dead server.
  if (results.some((r) => r.error)) process.exit(1);
})();
