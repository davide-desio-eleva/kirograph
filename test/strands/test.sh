#!/usr/bin/env bash
# test/strands/test.sh — tests the opt-in strands-decider integrations:
#
#   A. Memory relations   (memoryRelationMode: 'strands')
#      - high-confidence pair auto-judged, low-confidence pair left pending
#      - default mode ('agent') unaffected, --relation still required
#   B. Wiki contradictions (wikiContradictionMode: 'strands')
#      - genuinely contradicting pages flagged, unrelated pages not flagged
#   C. Attack-surface auth detection (securityAuthDetectionMode: 'strands')
#      - custom-named auth wrapper the heuristic misses is caught by strands
#      - a genuinely public route stays unauthenticated
#
# Unlike the jev suite there is no LIVE mode: strands-decider is a local
# server, so this always runs against a local mock (mock-server.js) that
# stands in for `strands-decider serve`. The mock additionally asserts that
# NO Authorization header is sent — pinning the no-auth contract of
# StrandsClient. No API key, no .env, no network.
#
# Uso:
#   ./test.sh                 # mock locale (unico modo)
#   ./test.sh --no-build      # salta la compilazione TypeScript

set -euo pipefail

NO_BUILD=false
for arg in "$@"; do
  case $arg in
    --no-build) NO_BUILD=true ;;
  esac
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
DIM='\033[2m'; RESET='\033[0m'; BOLD='\033[1m'; RED='\033[0;31m'

ok()   { echo -e "  ${GREEN}✓${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; FAILED=1; }
info() { echo -e "  ${CYAN}›${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
cmd()  { echo -e "\n  ${DIM}\$${RESET} ${CYAN}kirograph $1${RESET}"; }
sep()  { echo -e "\n${DIM}──────────────────────────────────────────────────────${RESET}"; }
strip_ansi() { sed -E $'s/\x1b\[[0-9;]*[A-Za-z]//g'; }

FAILED=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$SCRIPT_DIR/mock"
KG="node $ROOT/dist/bin/kirograph.js"
DB="$TEST_DIR/.kirograph/kirograph.db"
PORT=8843
BASE_URL="http://127.0.0.1:$PORT"

# Parse a "classified by strands: <relation> (confidence: <n>, ...)" line into
# $REL_OUT/$CONF_OUT and assert the wiring-level invariants.
validate_relation_wiring() {
  local output="$1" plain relation_id db_status db_relation expect_judged
  plain=$(echo "$output" | strip_ansi)
  REL_OUT=$(echo "$plain" | grep -oE 'classified by strands: [a-z_]+' | sed 's/classified by strands: //' || echo "")
  CONF_OUT=$(echo "$plain" | grep -oE 'confidence: [0-9.]+' | sed 's/confidence: //' || echo "")
  relation_id=$(echo "$plain" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")

  case "$REL_OUT" in
    supersedes|conflicts_with|compatible|scoped|related|not_conflict) ok "relation è un tipo valido: $REL_OUT" ;;
    *) fail "relation non valida restituita: '$REL_OUT'" ;;
  esac

  if node -e "process.exit((Number('$CONF_OUT') >= 0 && Number('$CONF_OUT') <= 1) ? 0 : 1)" 2>/dev/null; then
    ok "confidence in range [0,1]: $CONF_OUT"
  else
    fail "confidence fuori range o non numerica: '$CONF_OUT'"
  fi

  if [ -z "$relation_id" ]; then
    fail "relationId non estratto dall'output"
    return
  fi
  db_status=$(sqlite3 "$DB" "SELECT judgment_status FROM mem_relations WHERE id = '$relation_id';")
  db_relation=$(sqlite3 "$DB" "SELECT relation FROM mem_relations WHERE id = '$relation_id';")
  [ "$db_relation" = "$REL_OUT" ] \
    && ok "DB: mem_relations.relation coerente con l'output ($db_relation)" \
    || fail "DB: relation incoerente (output=$REL_OUT db=$db_relation)"
  if node -e "process.exit(Number('$CONF_OUT') >= 0.8 ? 0 : 1)" 2>/dev/null; then expect_judged=judged; else expect_judged=pending; fi
  [ "$db_status" = "$expect_judged" ] \
    && ok "DB: judgment_status coerente con la soglia (confidence=$CONF_OUT -> $expect_judged)" \
    || fail "DB: judgment_status inatteso (status=$db_status atteso=$expect_judged per confidence=$CONF_OUT)"
}

assert_expected_relation() {
  local expected_relation="$1" expected_judged="$2" actual_judged
  if node -e "process.exit(Number('$CONF_OUT') >= 0.8 ? 0 : 1)" 2>/dev/null; then actual_judged=judged; else actual_judged=pending; fi
  [ "$REL_OUT" = "$expected_relation" ] \
    && ok "mock: relation esatta attesa '$expected_relation'" \
    || fail "mock: attesa '$expected_relation', ottenuta '$REL_OUT'"
  [ "$actual_judged" = "$expected_judged" ] \
    && ok "mock: $actual_judged come atteso (confidence=$CONF_OUT)" \
    || fail "mock: atteso $expected_judged, ottenuto $actual_judged (confidence=$CONF_OUT)"
}

echo -e "\n${BOLD}  KiroGraph strands-decider integration — memory relations · wiki contradictions · attack-surface auth${RESET}"
echo -e "  ${DIM}$TEST_DIR${RESET}"
echo -e "  ${DIM}MOCK mode — local strands-decider stand-in on :$PORT (no API key, no auth header)${RESET}"

# ── 1. Build ──────────────────────────────────────────────────────────────────
sep
if [ "$NO_BUILD" = false ]; then
  info "Building..."
  cd "$ROOT" && npm run build > /dev/null 2>&1
  ok "Build OK  (v$(node "$ROOT/dist/bin/kirograph.js" --version 2>/dev/null || echo '?'))"
else
  warn "--no-build: usando dist esistente"
fi

# ── 2. Start mock strands-decider server ───────────────────────────────────────
sep
info "Avvio mock strands-decider server su :$PORT..."
node "$SCRIPT_DIR/mock-server.js" "$PORT" > /tmp/strands-mock-server.log 2>&1 &
MOCK_PID=$!
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then break; fi
  sleep 0.2
done
ok "Mock strands-decider server avviato (pid $MOCK_PID)"
cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

# ── 3. Pulizia + init ──────────────────────────────────────────────────────────
sep
info "Pulizia .kirograph/..."
rm -rf "$TEST_DIR/.kirograph"
cd "$TEST_DIR"
mkdir -p .kirograph

# No .env, no API key — strands needs neither. strandsBaseUrl (not a secret)
# points at the local mock; that's the only config required.
cat > .kirograph/config.json << EOF
{
  "version": 1,
  "enableMemory": true,
  "enableWiki": true,
  "enableArchitecture": true,
  "enableSecurity": true,
  "securityAutoEnrich": false,
  "strandsBaseUrl": "$BASE_URL"
}
EOF
node -e "JSON.parse(require('fs').readFileSync('.kirograph/config.json','utf8'))" \
  && ok "config.json scritto e valido (nessuna API key, strandsBaseUrl -> mock)" || fail "config.json malformato"

cmd "index"
$KG index 2>&1 | grep -E "✓|file|symbol" | sed 's/^/     /'
[ -f ".kirograph/kirograph.db" ] && ok "kirograph.db creato" || { fail "kirograph.db non trovato"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# A. Memory relations — memoryRelationMode: 'strands'
# ══════════════════════════════════════════════════════════════════════════════

sep
echo -e "  ${BOLD}[A1] mem conflicts compare — default mode ('agent'): --relation still required${RESET}\n"

cmd "mem store (2 osservazioni per il caso 'supersedes')"
STORE_A1=$($KG mem store "We use in-memory session storage for the MVP." --kind architecture --topic-key "strands-test/session-storage-a" 2>&1)
STORE_A2=$($KG mem store "Migrated to Redis-backed session storage for production scale; the in-memory approach is no longer used." --kind architecture --topic-key "strands-test/session-storage-b" 2>&1)
echo "$STORE_A1" | grep -qi "Stored observation" && ok "observation A stored" || fail "observation A store failed"
echo "$STORE_A2" | grep -qi "Stored observation" && ok "observation B stored" || fail "observation B store failed"

cmd "mem conflicts compare (nessun --relation, mode=agent)"
set +e
DEFAULT_MODE_ERR=$($KG mem conflicts compare "strands-test/session-storage-a" "strands-test/session-storage-b" 2>&1)
DEFAULT_MODE_EXIT=$?
set -e
echo "$DEFAULT_MODE_ERR" | sed 's/^/     /'
if [ "$DEFAULT_MODE_EXIT" -ne 0 ] && echo "$DEFAULT_MODE_ERR" | grep -qi "relation is required"; then
  ok "memoryRelationMode default (agent): --relation richiesto, nessuna chiamata al modello"
else
  fail "memoryRelationMode default: comportamento inatteso (exit=$DEFAULT_MODE_EXIT)"
fi

sep
echo -e "  ${BOLD}[A2] mem conflicts compare — memoryRelationMode: 'strands', alta confidenza (auto-judge atteso)${RESET}\n"

info "Abilito memoryRelationMode: strands nel config..."
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('.kirograph/config.json', 'utf8'));
  cfg.memoryRelationMode = 'strands';
  fs.writeFileSync('.kirograph/config.json', JSON.stringify(cfg, null, 2));
"
ok "config.json: memoryRelationMode=strands"

cmd "mem conflicts compare (nessun --relation, mode=strands)"
HIGH_CONF_OUT=$($KG mem conflicts compare "strands-test/session-storage-a" "strands-test/session-storage-b" 2>&1)
echo "$HIGH_CONF_OUT" | sed 's/^/     /'
validate_relation_wiring "$HIGH_CONF_OUT"
assert_expected_relation "supersedes" "judged"

sep
echo -e "  ${BOLD}[A3] mem conflicts compare — memoryRelationMode: 'strands', bassa confidenza (pending atteso)${RESET}\n"

cmd "mem store (2 osservazioni per il caso 'related', bassa confidenza)"
STORE_B1=$($KG mem store "Error handling uses try/catch blocks throughout the codebase." --kind pattern --topic-key "strands-test/error-handling" 2>&1)
STORE_B2=$($KG mem store "Logging now goes through a centralized logger utility." --kind pattern --topic-key "strands-test/logging" 2>&1)
echo "$STORE_B1" | grep -qi "Stored observation" && ok "observation C stored" || fail "observation C store failed"
echo "$STORE_B2" | grep -qi "Stored observation" && ok "observation D stored" || fail "observation D store failed"

cmd "mem conflicts compare (nessun --relation, mode=strands)"
LOW_CONF_OUT=$($KG mem conflicts compare "strands-test/error-handling" "strands-test/logging" 2>&1)
echo "$LOW_CONF_OUT" | sed 's/^/     /'
validate_relation_wiring "$LOW_CONF_OUT"
assert_expected_relation "related" "pending"

# ══════════════════════════════════════════════════════════════════════════════
# B. Wiki contradictions — wikiContradictionMode: 'strands'
# ══════════════════════════════════════════════════════════════════════════════

sep
echo -e "  ${BOLD}[B1] wiki lint — wikiContradictionMode: 'strands'${RESET}\n"

DIFF1="WIKI_DIFF_START
{\"action\":\"create\",\"page\":\"auth-model\",\"title\":\"Authentication\"}
# Authentication

We use JWT tokens with 15 minute expiry for session auth.
WIKI_DIFF_END"
$KG wiki apply-diff "$DIFF1" > /dev/null 2>&1

DIFF2="WIKI_DIFF_START
{\"action\":\"create\",\"page\":\"auth-legacy\",\"title\":\"Authentication\"}
# Authentication

We use session cookies with no expiry. JWT was removed in the last refactor.
WIKI_DIFF_END"
$KG wiki apply-diff "$DIFF2" > /dev/null 2>&1
ok "pagine auth-model / auth-legacy create (contraddizione)"

DIFF3="WIKI_DIFF_START
{\"action\":\"create\",\"page\":\"payment-flow\",\"title\":\"Payments\"}
# Payments

Payments are processed via Stripe PaymentIntents.
WIKI_DIFF_END"
$KG wiki apply-diff "$DIFF3" > /dev/null 2>&1

DIFF4="WIKI_DIFF_START
{\"action\":\"create\",\"page\":\"payment-webhooks\",\"title\":\"Payments\"}
# Payments

Stripe webhooks confirm payment completion asynchronously.
WIKI_DIFF_END"
$KG wiki apply-diff "$DIFF4" > /dev/null 2>&1
ok "pagine payment-flow / payment-webhooks create (correlate, non in contraddizione)"

info "Abilito wikiContradictionMode: strands nel config..."
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('.kirograph/config.json', 'utf8'));
  cfg.wikiContradictionMode = 'strands';
  fs.writeFileSync('.kirograph/config.json', JSON.stringify(cfg, null, 2));
"
ok "config.json: wikiContradictionMode=strands"

cmd "wiki lint"
LINT_OUT=$($KG wiki lint 2>&1)
echo "$LINT_OUT" | sed 's/^/     /'

CONTRADICTION_BLOCK=$(echo "$LINT_OUT" | grep -A1 -i "\[contradiction\]" || true)
AUTH_FLAGGED=false
echo "$CONTRADICTION_BLOCK" | grep -qi "auth-model" && echo "$CONTRADICTION_BLOCK" | grep -qi "auth-legacy" && AUTH_FLAGGED=true
PAYMENT_FLAGGED=false
echo "$CONTRADICTION_BLOCK" | grep -qi "payment" && PAYMENT_FLAGGED=true

[ "$AUTH_FLAGGED" = true ] \
  && ok "contraddizione auth-model <-> auth-legacy rilevata da strands" \
  || fail "contraddizione auth-model <-> auth-legacy NON rilevata"
[ "$PAYMENT_FLAGGED" = false ] \
  && ok "nessun falso positivo tra payment-flow / payment-webhooks" \
  || fail "falso positivo: payment-flow/payment-webhooks segnalate come contraddizione"

# ══════════════════════════════════════════════════════════════════════════════
# C. Attack-surface auth detection — securityAuthDetectionMode: 'strands'
# ══════════════════════════════════════════════════════════════════════════════

sep
echo -e "  ${BOLD}[C1] AttackSurfaceAnalyzer — securityAuthDetectionMode heuristic vs strands${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" BASE_URL="$BASE_URL" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;
const baseUrl = process.env.BASE_URL;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applySecuritySchema();
const rawDb = db.getRawDb();

const now = Date.now();
function upsertNode(id, kind, name, filePath) {
  rawDb.run(
    `INSERT OR REPLACE INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, is_async, is_static, is_abstract, updated_at)
     VALUES (?, ?, ?, ?, ?, 'typescript', 1, 1, 0, 0, 0, 0, 0, 0, ?)`,
    [id, kind, name, `${filePath}::${name}`, filePath, now],
  );
}
function insertEdge(source, target, kind) {
  rawDb.run(`INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)`, [source, target, kind]);
}

upsertNode('route:app.ts:GET:/api/profile:1', 'route', 'GET /api/profile', 'src/app.ts');
upsertNode('fn:session.ts:withSession', 'function', 'withSession', 'src/session.ts');
insertEdge('route:app.ts:GET:/api/profile:1', 'fn:session.ts:withSession', 'calls');

upsertNode('route:app.ts:GET:/public/health:2', 'route', 'GET /public/health', 'src/app.ts');
upsertNode('fn:app.ts:healthCheck', 'function', 'healthCheck', 'src/app.ts');
insertEdge('route:app.ts:GET:/public/health:2', 'fn:app.ts:healthCheck', 'calls');

const { AttackSurfaceAnalyzer } = require(path.join(rootDir, 'dist/security/attack-surface.js'));

// Heuristic mode: both routes misclassified as unauthenticated (deterministic, no model call).
const heuristicAnalyzer = new AttackSurfaceAnalyzer(db, { authDetectionMode: 'heuristic' });
const heuristicResult = await heuristicAnalyzer.analyze();
const hProfile = heuristicResult.allRoutes.find(r => r.route === 'GET /api/profile');
const hHealth = heuristicResult.allRoutes.find(r => r.route === 'GET /public/health');
if (!hProfile || !hHealth) throw new Error('routes not found in heuristic result');
if (hProfile.isAuthenticated !== false) throw new Error('expected heuristic to MISS withSession, got ' + hProfile.isAuthenticated);
if (hHealth.isAuthenticated !== false) throw new Error('expected /public/health=false in heuristic, got ' + hHealth.isAuthenticated);
console.log('heuristic:ok /api/profile=false(missed) /public/health=false');

// strands mode: custom-named wrapper caught, public route stays unauthenticated.
// NOTE: no jevApiKey / no Authorization header — the mock rejects any auth header.
const strandsAnalyzer = new AttackSurfaceAnalyzer(db, {
  authDetectionMode: 'strands',
  authConfidenceThreshold: 0.6,
  strandsBaseUrl: baseUrl,
});
const strandsResult = await strandsAnalyzer.analyze();
const sProfile = strandsResult.allRoutes.find(r => r.route === 'GET /api/profile');
const sHealth = strandsResult.allRoutes.find(r => r.route === 'GET /public/health');
if (typeof sProfile?.isAuthenticated !== 'boolean' || typeof sHealth?.isAuthenticated !== 'boolean') {
  throw new Error('strands mode did not return boolean isAuthenticated for both routes');
}
if (sProfile.isAuthenticated !== true) throw new Error('expected strands to catch withSession, got ' + sProfile.isAuthenticated);
if (sHealth.isAuthenticated !== false) throw new Error('expected /public/health=false, got ' + sHealth.isAuthenticated);
console.log('strands:ok /api/profile=true(caught) /public/health=false(confirmed)');
console.log('ALL_ATTACK_SURFACE_OK');
NODEEOF
NODE_EXIT=$?

if [ "$NODE_EXIT" -eq 0 ]; then
  ok "heuristic mode: /api/profile misclassificata come non autenticata (falso negativo atteso)"
  ok "strands mode: /api/profile corretta a isAuthenticated=true, /public/health resta false"
else
  fail "attack-surface strands test fallito (node exit=$NODE_EXIT)"
fi

# Pin the no-auth contract: the mock logs a REJECT line if any Authorization
# header ever arrives. Assert none was logged across the whole run.
if grep -q "REJECT unexpected Authorization header" /tmp/strands-mock-server.log; then
  fail "StrandsClient ha inviato un header Authorization (strands-decider è senza auth)"
else
  ok "nessun header Authorization inviato in tutta la suite (contratto no-auth rispettato)"
fi

# ── Fine ──────────────────────────────────────────────────────────────────────
sep
echo ""
echo -e "  ${BOLD}Feature testate:${RESET}"
echo -e "  ${DIM}·${RESET} memory relations: memoryRelationMode 'strands' (auto-judge + pending)"
echo -e "  ${DIM}·${RESET} wiki lint: wikiContradictionMode 'strands' (contraddizione rilevata, falso positivo evitato)"
echo -e "  ${DIM}·${RESET} attack-surface: securityAuthDetectionMode 'strands' corregge il falso negativo dell'euristica"
echo -e "  ${DIM}·${RESET} StrandsClient: nessun header Authorization, nessuna API key, server locale"
echo ""
if [ "$FAILED" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}Test completato — tutte le asserzioni superate.${RESET}"
else
  echo -e "  ${RED}${BOLD}Test completato con fallimenti.${RESET}"
  exit 1
fi
echo ""
