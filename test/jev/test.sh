#!/usr/bin/env bash
# test/jev/test.sh — tests the opt-in jev (TypeSafe System One) integrations:
#
#   A. Memory relations   (memoryRelationMode: 'jev')
#      - high-confidence pair auto-judged, low-confidence pair left pending
#      - default mode ('agent') unaffected, --relation still required
#      - invalid API key surfaces a clean error, not a crash
#   B. Wiki contradictions (wikiContradictionMode: 'jev')
#      - genuinely contradicting pages flagged, unrelated pages not flagged
#   C. Attack-surface auth detection (securityAuthDetectionMode: 'jev')
#      - custom-named auth wrapper the heuristic misses is caught by jev
#      - a genuinely public route stays unauthenticated
#
# Uses a local mock server (mock-server.js) standing in for
# https://api.typesafe.ai — no real API key or network access required.
#
# Uso:
#   ./test.sh            # test completo (build inclusa)
#   ./test.sh --no-build # salta la compilazione TypeScript

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
fail() { echo -e "  ${RED}✗${RESET}  $1"; }
info() { echo -e "  ${CYAN}›${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
cmd()  { echo -e "\n  ${DIM}\$${RESET} ${CYAN}kirograph $1${RESET}"; }
sep()  { echo -e "\n${DIM}──────────────────────────────────────────────────────${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$SCRIPT_DIR/mock"
KG="node $ROOT/dist/bin/kirograph.js"
DB="$TEST_DIR/.kirograph/kirograph.db"
PORT=8842
API_KEY="mock-jev-key"
BASE_URL="http://127.0.0.1:$PORT"

echo -e "\n${BOLD}  KiroGraph jev integration — memory relations · wiki contradictions · attack-surface auth${RESET}"
echo -e "  ${DIM}$TEST_DIR${RESET}"

# ── 1. Build ──────────────────────────────────────────────────────────────────
sep
if [ "$NO_BUILD" = false ]; then
  info "Building..."
  cd "$ROOT" && npm run build > /dev/null 2>&1
  ok "Build OK  (v$(node "$ROOT/dist/bin/kirograph.js" --version 2>/dev/null || echo '?'))"
else
  warn "--no-build: usando dist esistente"
fi

# ── 2. Start mock jev server ───────────────────────────────────────────────────
sep
info "Avvio mock jev server su :$PORT..."
node "$SCRIPT_DIR/mock-server.js" "$PORT" "$API_KEY" > /tmp/jev-mock-server.log 2>&1 &
MOCK_PID=$!
cleanup() {
  kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/v1/systemone" -X POST; then
    break
  fi
  sleep 0.2
done
ok "Mock jev server avviato (pid $MOCK_PID)"

# ── 3. Pulizia + init ──────────────────────────────────────────────────────────
sep
info "Pulizia .kirograph/..."
rm -rf "$TEST_DIR/.kirograph"
cd "$TEST_DIR"

mkdir -p .kirograph
cat > .kirograph/config.json << EOF
{
  "version": 1,
  "enableMemory": true,
  "enableWiki": true,
  "enableArchitecture": true,
  "enableSecurity": true,
  "securityAutoEnrich": false,
  "jevApiKey": "$API_KEY",
  "jevBaseUrl": "$BASE_URL"
}
EOF
node -e "JSON.parse(require('fs').readFileSync('.kirograph/config.json','utf8'))" \
  && ok "config.json scritto e valido" || fail "config.json malformato"

cmd "index"
$KG index 2>&1 | grep -E "✓|file|symbol" | sed 's/^/     /'
[ -f ".kirograph/kirograph.db" ] && ok "kirograph.db creato" || { fail "kirograph.db non trovato"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# A. Memory relations — memoryRelationMode: 'jev'
# ══════════════════════════════════════════════════════════════════════════════

sep
echo -e "  ${BOLD}[A1] mem compare — default mode ('agent'): --relation still required${RESET}\n"

cmd "mem store (2 osservazioni per il caso 'supersedes')"
STORE_A1=$($KG mem store "We use in-memory session storage for the MVP." --kind architecture --topic-key "jev-test/session-storage-a" 2>&1)
STORE_A2=$($KG mem store "Migrated to Redis-backed session storage for production scale; the in-memory approach is no longer used." --kind architecture --topic-key "jev-test/session-storage-b" 2>&1)
echo "$STORE_A1" | sed 's/^/     /'
echo "$STORE_A2" | sed 's/^/     /'
echo "$STORE_A1" | grep -qi "Stored observation" && ok "observation A stored" || fail "observation A store failed"
echo "$STORE_A2" | grep -qi "Stored observation" && ok "observation B stored" || fail "observation B store failed"

cmd "mem conflicts compare jev-test/session-storage-a jev-test/session-storage-b   (nessun --relation, mode=agent)"
set +e
DEFAULT_MODE_ERR=$($KG mem conflicts compare "jev-test/session-storage-a" "jev-test/session-storage-b" 2>&1)
DEFAULT_MODE_EXIT=$?
set -e
echo "$DEFAULT_MODE_ERR" | sed 's/^/     /'
if [ "$DEFAULT_MODE_EXIT" -ne 0 ] && echo "$DEFAULT_MODE_ERR" | grep -qi "relation is required"; then
  ok "memoryRelationMode default (agent): --relation richiesto, nessuna chiamata a jev"
else
  fail "memoryRelationMode default: comportamento inatteso (exit=$DEFAULT_MODE_EXIT)"
fi

sep
echo -e "  ${BOLD}[A2] mem compare — memoryRelationMode: 'jev', caso alta confidenza (auto-judge)${RESET}\n"

info "Abilito memoryRelationMode: jev nel config..."
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('.kirograph/config.json', 'utf8'));
  cfg.memoryRelationMode = 'jev';
  fs.writeFileSync('.kirograph/config.json', JSON.stringify(cfg, null, 2));
"
ok "config.json: memoryRelationMode=jev"

cmd "mem conflicts compare jev-test/session-storage-a jev-test/session-storage-b   (nessun --relation, mode=jev)"
HIGH_CONF_OUT=$($KG mem conflicts compare "jev-test/session-storage-a" "jev-test/session-storage-b" 2>&1)
echo "$HIGH_CONF_OUT" | sed 's/^/     /'
echo "$HIGH_CONF_OUT" | grep -qi "supersedes" \
  && ok "jev classified relation: supersedes" \
  || fail "jev relation classification: 'supersedes' non trovato nell'output"
echo "$HIGH_CONF_OUT" | grep -qi "auto-judged" \
  && ok "confidence 0.92 >= threshold 0.8: auto-judged" \
  || fail "atteso auto-judged per confidence alta"

RELATION_ID_A=$(echo "$HIGH_CONF_OUT" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")
if [ -n "$RELATION_ID_A" ]; then
  DB_STATUS_A=$(sqlite3 "$DB" "SELECT judgment_status FROM mem_relations WHERE id = '$RELATION_ID_A';")
  DB_RELATION_A=$(sqlite3 "$DB" "SELECT relation FROM mem_relations WHERE id = '$RELATION_ID_A';")
  if [ "$DB_STATUS_A" = "judged" ] && [ "$DB_RELATION_A" = "supersedes" ]; then
    ok "DB: mem_relations riflette judgment_status=judged, relation=supersedes"
  else
    fail "DB: stato relazione inatteso (status=$DB_STATUS_A relation=$DB_RELATION_A)"
  fi
else
  fail "relationId non estratto dall'output"
fi

sep
echo -e "  ${BOLD}[A3] mem compare — memoryRelationMode: 'jev', caso bassa confidenza (pending)${RESET}\n"

cmd "mem store (2 osservazioni per il caso 'related', bassa confidenza)"
STORE_B1=$($KG mem store "Error handling uses try/catch blocks throughout the codebase." --kind pattern --topic-key "jev-test/error-handling" 2>&1)
STORE_B2=$($KG mem store "Logging now goes through a centralized logger utility." --kind pattern --topic-key "jev-test/logging" 2>&1)
echo "$STORE_B1" | grep -qi "Stored observation" && ok "observation C stored" || fail "observation C store failed"
echo "$STORE_B2" | grep -qi "Stored observation" && ok "observation D stored" || fail "observation D store failed"

cmd "mem conflicts compare jev-test/error-handling jev-test/logging   (nessun --relation, mode=jev)"
LOW_CONF_OUT=$($KG mem conflicts compare "jev-test/error-handling" "jev-test/logging" 2>&1)
echo "$LOW_CONF_OUT" | sed 's/^/     /'
echo "$LOW_CONF_OUT" | grep -qi "related" \
  && ok "jev classified relation: related" \
  || fail "jev relation classification: 'related' non trovato nell'output"
echo "$LOW_CONF_OUT" | grep -qi "pending review" \
  && ok "confidence 0.4 < threshold 0.8: left pending" \
  || fail "atteso 'pending review' per confidence bassa"

RELATION_ID_B=$(echo "$LOW_CONF_OUT" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")
if [ -n "$RELATION_ID_B" ]; then
  PENDING_LIST=$($KG mem conflicts list 2>&1)
  echo "$PENDING_LIST" | grep -q "$RELATION_ID_B" \
    && ok "relazione a bassa confidenza visibile in 'mem conflicts list' per review" \
    || fail "relazione pending non trovata in 'mem conflicts list'"
else
  fail "relationId non estratto dall'output"
fi

sep
echo -e "  ${BOLD}[A4] mem compare — chiave API non valida: errore pulito, non un crash${RESET}\n"

node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('.kirograph/config.json', 'utf8'));
  cfg.jevApiKey = 'wrong-key';
  fs.writeFileSync('.kirograph/config.json', JSON.stringify(cfg, null, 2));
"
cmd "mem conflicts compare (jevApiKey errata)"
set +e
BAD_KEY_OUT=$($KG mem conflicts compare "jev-test/error-handling" "jev-test/logging" 2>&1)
BAD_KEY_EXIT=$?
set -e
echo "$BAD_KEY_OUT" | sed 's/^/     /'
if [ "$BAD_KEY_EXIT" -ne 0 ] && echo "$BAD_KEY_OUT" | grep -qi "401"; then
  ok "chiave API non valida: errore pulito (401 propagato, exit=$BAD_KEY_EXIT)"
else
  fail "chiave API non valida: errore atteso non ricevuto (exit=$BAD_KEY_EXIT)"
fi

# Restore the correct key for the rest of the suite
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('.kirograph/config.json', 'utf8'));
  cfg.jevApiKey = '$API_KEY';
  cfg.memoryRelationMode = 'agent';
  fs.writeFileSync('.kirograph/config.json', JSON.stringify(cfg, null, 2));
"
ok "config.json: jevApiKey ripristinata, memoryRelationMode tornato ad 'agent'"

# ══════════════════════════════════════════════════════════════════════════════
# B. Wiki contradictions — wikiContradictionMode: 'jev'
# ══════════════════════════════════════════════════════════════════════════════

sep
echo -e "  ${BOLD}[B1] wiki lint — wikiContradictionMode: 'jev'${RESET}\n"

cmd "wiki apply-diff (2 pagine che si contraddicono)"
# Same title on both pages guarantees wikiDb.search(title) — an implicit
# AND-of-terms FTS5 query — pairs them as candidates regardless of which
# page lint visits first.
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
ok "pagine auth-model / auth-legacy create (contraddizione: scadenza JWT vs nessuna scadenza)"

cmd "wiki apply-diff (2 pagine correlate ma non in contraddizione)"
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

info "Abilito wikiContradictionMode: jev nel config..."
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('.kirograph/config.json', 'utf8'));
  cfg.wikiContradictionMode = 'jev';
  fs.writeFileSync('.kirograph/config.json', JSON.stringify(cfg, null, 2));
"
ok "config.json: wikiContradictionMode=jev"

cmd "wiki lint"
LINT_OUT=$($KG wiki lint 2>&1)
echo "$LINT_OUT" | sed 's/^/     /'

CONTRADICTION_BLOCK=$(echo "$LINT_OUT" | grep -A1 -i "\[contradiction\]" || true)
if echo "$CONTRADICTION_BLOCK" | grep -qi "auth-model" && echo "$CONTRADICTION_BLOCK" | grep -qi "auth-legacy"; then
  ok "contraddizione auth-model <-> auth-legacy rilevata da jev"
else
  fail "contraddizione auth-model <-> auth-legacy NON rilevata"
fi
if echo "$CONTRADICTION_BLOCK" | grep -qi "payment"; then
  fail "falso positivo: payment-flow/payment-webhooks segnalate come contraddizione"
else
  ok "nessun falso positivo tra payment-flow / payment-webhooks"
fi

# ══════════════════════════════════════════════════════════════════════════════
# C. Attack-surface auth detection — securityAuthDetectionMode: 'jev'
# ══════════════════════════════════════════════════════════════════════════════

sep
echo -e "  ${BOLD}[C1] AttackSurfaceAnalyzer — securityAuthDetectionMode heuristic vs jev${RESET}\n"
echo -e "  ${DIM}Route nodes + call-path edges inseriti direttamente nel grafo (bypassa la pipeline di framework-detection).${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" BASE_URL="$BASE_URL" API_KEY="$API_KEY" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;
const baseUrl = process.env.BASE_URL;
const apiKey = process.env.API_KEY;

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

// Route 1: /api/profile — calls a custom-named session guard the heuristic can't recognize.
upsertNode('route:app.ts:GET:/api/profile:1', 'route', 'GET /api/profile', 'src/app.ts');
upsertNode('fn:session.ts:withSession', 'function', 'withSession', 'src/session.ts');
insertEdge('route:app.ts:GET:/api/profile:1', 'fn:session.ts:withSession', 'calls');

// Route 2: /public/health — genuinely public, no auth-related call path at all.
upsertNode('route:app.ts:GET:/public/health:2', 'route', 'GET /public/health', 'src/app.ts');
upsertNode('fn:app.ts:healthCheck', 'function', 'healthCheck', 'src/app.ts');
insertEdge('route:app.ts:GET:/public/health:2', 'fn:app.ts:healthCheck', 'calls');

const { AttackSurfaceAnalyzer } = require(path.join(rootDir, 'dist/security/attack-surface.js'));

// ── Heuristic mode (default): both routes misclassified as unauthenticated ──
const heuristicAnalyzer = new AttackSurfaceAnalyzer(db, { authDetectionMode: 'heuristic' });
const heuristicResult = await heuristicAnalyzer.analyze();
const heuristicProfile = heuristicResult.allRoutes.find(r => r.route === 'GET /api/profile');
const heuristicHealth = heuristicResult.allRoutes.find(r => r.route === 'GET /public/health');

if (!heuristicProfile || !heuristicHealth) throw new Error('routes not found in heuristic result: ' + JSON.stringify(heuristicResult.allRoutes));
if (heuristicProfile.isAuthenticated !== false) throw new Error('expected heuristic to MISS the custom-named wrapper (false negative), got isAuthenticated=' + heuristicProfile.isAuthenticated);
if (heuristicHealth.isAuthenticated !== false) throw new Error('expected /public/health isAuthenticated=false in heuristic mode, got ' + heuristicHealth.isAuthenticated);
console.log('heuristic:ok /api/profile=false(missed) /public/health=false');

// ── jev mode: custom-named wrapper caught, public route still correctly unauthenticated ──
const jevAnalyzer = new AttackSurfaceAnalyzer(db, {
  authDetectionMode: 'jev',
  authConfidenceThreshold: 0.6,
  jevApiKey: apiKey,
  jevBaseUrl: baseUrl,
});
const jevResult = await jevAnalyzer.analyze();
const jevProfile = jevResult.allRoutes.find(r => r.route === 'GET /api/profile');
const jevHealth = jevResult.allRoutes.find(r => r.route === 'GET /public/health');

if (jevProfile.isAuthenticated !== true) throw new Error('expected jev to catch the custom-named wrapper, got isAuthenticated=' + jevProfile.isAuthenticated);
if (jevHealth.isAuthenticated !== false) throw new Error('expected /public/health isAuthenticated=false in jev mode too, got ' + jevHealth.isAuthenticated);
console.log('jev:ok /api/profile=true(caught) /public/health=false(confirmed)');

console.log('ALL_ATTACK_SURFACE_OK');
NODEEOF

if [ $? -eq 0 ]; then
  ok "heuristic mode: /api/profile misclassificata come non autenticata (falso negativo atteso)"
  ok "jev mode: /api/profile corretta a isAuthenticated=true (wrapper custom rilevato)"
  ok "jev mode: /public/health resta isAuthenticated=false (nessun falso positivo)"
else
  fail "attack-surface jev test fallito"
fi

# ── Fine ──────────────────────────────────────────────────────────────────────
sep
echo ""
echo -e "  ${BOLD}Feature testate:${RESET}"
echo -e "  ${DIM}·${RESET} memory relations: memoryRelationMode 'agent' (default, invariato) vs 'jev' (auto-judge + pending)"
echo -e "  ${DIM}·${RESET} memory relations: chiave API non valida -> errore pulito"
echo -e "  ${DIM}·${RESET} wiki lint: wikiContradictionMode 'jev' (contraddizione reale rilevata, falso positivo evitato)"
echo -e "  ${DIM}·${RESET} attack-surface: securityAuthDetectionMode 'jev' corregge il falso negativo dell'euristica"
echo ""
echo -e "  ${GREEN}${BOLD}Test completato.${RESET}"
echo ""
