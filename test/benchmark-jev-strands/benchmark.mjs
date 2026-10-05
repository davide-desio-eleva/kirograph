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
const JEV_API_KEY   = process.env.JEV_API_KEY || 'mock-jev-key';
const JEV_BASE_URL  = process.env.JEV_BASE_URL || 'http://127.0.0.1:8842';
const JEV_IS_LIVE   = !!process.env.JEV_API_KEY;
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

  // Batched: all three questions about their combined state in ONE request,
  // ITERATIONS times. This is the shared-prefix path both servers optimize.
  const batchedState = USE_CASES.map((uc) => `[${uc.id}]\n${uc.state}`).join('\n\n');
  const batchedQuestions = Object.fromEntries(USE_CASES.map((uc) => [uc.questionId, uc.question]));
  const batchSamples = [];
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    let timed;
    try {
      timed = await timeCall(() => client.ask(batchedState, batchedQuestions));
    } catch (err) {
      return { name, isLive, error: `batched: ${err.message}` };
    }
    if (i >= WARMUP) batchSamples.push(timed.elapsed);
  }

  return { name, isLive, perUseCase, batched: summarize(batchSamples), sampleAnswers };
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
    // Agreement line when both backends ran
    if (live.length === 2) {
      const [a, b] = live;
      const agree = a.sampleAnswers[uc.id].split('@')[0] === b.sampleAnswers[uc.id].split('@')[0];
      console.log(`  ${DIM}${pad('', 26)}${pad('agreement', 12)}${agree ? '✓ same answer' : '✗ differ'}${RESET}`);
    }
  }

  console.log(`  ${DIM}${'─'.repeat(header.length + 4)}${RESET}`);
  for (const r of live) {
    const s = r.batched;
    console.log(
      `  ${pad('batched (3 questions)', 26)}${pad(r.name, 12)}${padL(ms(s.mean), 9)}${padL(ms(s.p50), 9)}${padL(ms(s.p95), 9)}${padL(ms(s.min), 9)}${padL(ms(s.max), 9)}  ${DIM}1 request${RESET}`,
    );
  }

  // Batching efficiency note
  for (const r of live) {
    const seqMean = USE_CASES.reduce((sum, uc) => sum + r.perUseCase[uc.id].mean, 0);
    const saved = seqMean > 0 ? (1 - r.batched.mean / seqMean) * 100 : 0;
    console.log(`  ${DIM}${r.name}: batching 3 questions vs 3 separate requests → ${saved.toFixed(0)}% faster (${ms(r.batched.mean)} vs ${ms(seqMean)})${RESET}`);
  }
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const results = [];

  if (ONLY !== 'strands') {
    const jev = new JevClient({ apiKey: JEV_API_KEY, baseUrl: JEV_BASE_URL });
    results.push(await benchBackend('jev', jev, JEV_IS_LIVE));
  }
  if (ONLY !== 'jev') {
    const strands = new StrandsClient({ baseUrl: STRANDS_BASE_URL });
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
