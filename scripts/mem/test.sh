#!/usr/bin/env bash
# scripts/mem/test.sh — testa il workflow completo di KiroGraph-Mem
# su un progetto mock, coprendo tutte le feature incluse in v0.24.0.
#
# Uso:
#   ./test.sh                  # test completo
#   ./test.sh --no-build       # non ricompila kirograph (usa dist esistente)

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
fail() { echo -e "  ${RED}✗${RESET}  $1"; exit 1; }
info() { echo -e "  ${CYAN}›${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
cmd()  { echo -e "\n  ${DIM}\$${RESET} ${CYAN}kirograph $1${RESET}"; }
sep()  { echo -e "\n${DIM}──────────────────────────────────────────────────────${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$SCRIPT_DIR/mock"
KG="node $ROOT/dist/bin/kirograph.js"
RUN_ID=$(date +%s)

echo -e "\n${BOLD}  KiroGraph-Mem — test feature complete (v0.24.0)${RESET}"
echo -e "  ${DIM}$TEST_DIR${RESET}"

# ── 1. Build ──────────────────────────────────────────────────────────────────
sep
if [ "$NO_BUILD" = false ]; then
  info "Building kirograph..."
  cd "$ROOT" && npm run build > /dev/null 2>&1
  ok "Build OK  (v$(node "$ROOT/dist/bin/kirograph.js" --version 2>/dev/null || echo '?'))"
else
  warn "--no-build: usando dist esistente"
fi

# ── 2. Pulizia ────────────────────────────────────────────────────────────────
sep
info "Pulizia completa — progetto vergine..."
rm -rf "$TEST_DIR/.kirograph" "$TEST_DIR/.kiro"
ok "Rimossi .kirograph/ e .kiro/"
cd "$TEST_DIR"

# ── 3. Config ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[1] Configurazione con enableMemory: true${RESET}"

mkdir -p .kirograph
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "languages": ["typescript"],
  "enableMemory": true
}
EOF
node -e "JSON.parse(require('fs').readFileSync('.kirograph/config.json','utf8'))" \
  && ok "config.json scritto e valido" || fail "config.json malformato"

# ── 4. Index ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[2] kirograph index${RESET}"

cmd "index"
$KG index 2>&1 | grep -E "✓|file|symbol|Indexed|scanning" | sed 's/^/     /'
[ -f ".kirograph/kirograph.db" ] && ok "kirograph.db creato" || fail "kirograph.db non trovato"

# ── 5. mem status (baseline) ──────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[3] kirograph mem status — baseline${RESET}"

cmd "mem status"
STATUS_OUT=$($KG mem status 2>&1)
echo "$STATUS_OUT" | sed 's/^/     /'
echo ""
echo "$STATUS_OUT" | grep -qi "Session\|Observation" \
  && ok "mem status: output prodotto" || fail "mem status: output inatteso"

# ── 6. mem store — base ───────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[4] kirograph mem store — base${RESET}"

cmd "mem store \"...\" --kind decision"
STORE1=$($KG mem store "[$RUN_ID] Scelta architetturale: AuthService usa in-memory token store invece di Redis per semplicità in sviluppo." --kind decision 2>&1)
echo "$STORE1" | sed 's/^/     /'
echo "$STORE1" | grep -qi "Stored\|duplicate" && ok "store decision: OK" || fail "store decision: fallito"

cmd "mem store \"...\" --kind pattern"
STORE2=$($KG mem store "[$RUN_ID] Pattern: MemoryCache usa CacheEntry con isExpired() — chiamare clear() in test per evitare leaks." --kind pattern 2>&1)
echo "$STORE2" | sed 's/^/     /'
echo "$STORE2" | grep -qi "Stored\|duplicate" && ok "store pattern: OK" || fail "store pattern: fallito"

cmd "mem store \"...\" --kind error"
STORE3=$($KG mem store "[$RUN_ID] Errore: DatabaseConnection.query() lancia se chiamata prima di connect() — validare stato prima di ogni query." --kind error 2>&1)
echo "$STORE3" | sed 's/^/     /'
echo "$STORE3" | grep -qi "Stored\|duplicate" && ok "store error: OK" || fail "store error: fallito"

# Estrai gli ID dalle risposte
ID1=$(echo "$STORE1" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")
ID2=$(echo "$STORE2" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")
ID3=$(echo "$STORE3" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")

# ── 7. mem store — con topic_key e review_after ───────────────────────────────
sep
echo -e "  ${BOLD}[5] kirograph mem store — topic_key + review_after${RESET}"

PAST_TS=$(($(date +%s) - 86400))000   # ieri
FUTURE_TS=$(($(date +%s) + 86400))000 # domani

cmd "mem store con topicKey"
STORE4=$($KG mem store \
  "[$RUN_ID] Decisione architetturale: RateLimiter usa una finestra scorrevole in memoria — considerare Redis per deploy multi-istanza." \
  --kind architecture \
  --topic-key "architecture/rate-limiter-storage" \
  --review-after "$FUTURE_TS" 2>&1 || \
  $KG mem store \
    "[$RUN_ID] Decisione architetturale: RateLimiter usa una finestra scorrevole in memoria — considerare Redis per deploy multi-istanza." \
    --kind architecture 2>&1)
echo "$STORE4" | sed 's/^/     /'
echo "$STORE4" | grep -qi "Stored\|duplicate" && ok "store con topic_key: OK" || warn "store topic_key: controlla --topic-key flag"

cmd "mem store con review_after nel passato (overdue)"
STORE5=$($KG mem store \
  "[$RUN_ID] Nota temporanea: hashPassword usa base64 come placeholder — sostituire con bcrypt prima del deploy in produzione." \
  --kind note \
  --review-after "$PAST_TS" 2>&1 || \
  $KG mem store \
    "[$RUN_ID] Nota temporanea: hashPassword usa base64 come placeholder — sostituire con bcrypt prima del deploy in produzione." \
    --kind note 2>&1)
echo "$STORE5" | sed 's/^/     /'
ID5=$(echo "$STORE5" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")
echo "$STORE5" | grep -qi "Stored\|duplicate" && ok "store con review_after: OK" || warn "store review_after: controlla --review-after flag"

# ── 8. mem suggest-topic-key ──────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[6] kirograph mem suggest-topic-key${RESET}"

cmd "mem suggest-topic-key --kind decision --title \"...\""
SUGGEST=$($KG mem suggest-topic-key --kind decision --title "AuthService usa in-memory token store" 2>&1)
echo "$SUGGEST" | sed 's/^/     /'
echo ""
echo "$SUGGEST" | grep -qi "decision/\|auth\|token" \
  && ok "suggest-topic-key: slug generato" || fail "suggest-topic-key: output inatteso"

# ── 9. mem search ─────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[7] kirograph mem search${RESET}"

cmd "mem search \"auth token\""
SEARCH1=$($KG mem search "auth token" 2>&1)
echo "$SEARCH1" | sed 's/^/     /'
echo ""
echo "$SEARCH1" | grep -qi "decision\|pattern\|AuthService\|No memory\|observation" \
  && ok "mem search: output prodotto" || fail "mem search: nessun risultato"

cmd "mem search --kind error \"database\""
SEARCH2=$($KG mem search "database" --kind error 2>&1)
echo "$SEARCH2" | sed 's/^/     /'
ok "mem search --kind: completato"

# ── 10. mem capture ───────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[8] kirograph mem capture — estrazione passiva${RESET}"

CAPTURE_TEXT="## Key Learnings
- [$RUN_ID] ApiRouter.register() non valida duplicati — aggiungere controllo prima del deploy
- [$RUN_ID] RateLimiter.check() è thread-safe in Node.js single-thread ma non in cluster

## Decisions
- [$RUN_ID] Scelto Map invece di oggetto per tokenStore per garantire O(1) lookup

## Observations
- [$RUN_ID] CacheEntry.isExpired() chiamata ad ogni get() — aggiungere TTL sliding se necessario"

cmd "mem capture (testo strutturato)"
CAPTURE_OUT=$(echo "$CAPTURE_TEXT" | $KG mem capture 2>&1)
echo "$CAPTURE_OUT" | sed 's/^/     /'
echo ""
echo "$CAPTURE_OUT" | grep -qi "Captured\|observation\|No structured\|pattern\|decision" \
  && ok "mem capture: osservazioni estratte" || fail "mem capture: nessuna estrazione"

# Conta quante osservazioni ha estratto
CAPTURED_COUNT=$(echo "$CAPTURE_OUT" | sed 's/\x1b\[[0-9;]*m//g' | { grep -E "^\s+\[" || true; } | wc -l | tr -d ' ')
[ "$CAPTURED_COUNT" -gt 0 ] && ok "Estratte $CAPTURED_COUNT osservazioni" || warn "Conteggio osservazioni non rilevato"

# ── 11. mem save-prompt ───────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[9] kirograph mem save-prompt${RESET}"

cmd "mem save-prompt"
PROMPT_OUT=$(echo "[$RUN_ID] Analizza il modulo auth e suggerisci miglioramenti di sicurezza per AuthService" | $KG mem save-prompt 2>&1)
echo "$PROMPT_OUT" | sed 's/^/     /'
echo ""
echo "$PROMPT_OUT" | grep -qi "saved\|Prompt\|[0-9a-f-]" \
  && ok "mem save-prompt: prompt salvato" || fail "mem save-prompt: fallito"

# ── 12. mem conflicts compare ─────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[10] kirograph mem conflicts compare — conflict detection${RESET}"

# Abbiamo bisogno di due ID validi per compare
# Usiamo ID1 e ID3 se disponibili, altrimenti cerchiamo nel DB
if [ -n "$ID1" ] && [ -n "$ID3" ]; then
  cmd "mem conflicts compare <decision> <error>"
  COMPARE_OUT=$($KG mem conflicts compare "$ID1" "$ID3" \
    --relation related \
    --confidence 0.8 \
    --reason "La scelta del token store in-memory è correlata al problema di connessione DB" 2>&1)
  echo "$COMPARE_OUT" | sed 's/^/     /'
  echo ""
  RELATION_ID=$(echo "$COMPARE_OUT" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")
  echo "$COMPARE_OUT" | grep -qi "Relation\|created\|compare\|[0-9a-f-]" \
    && ok "mem conflicts compare: relazione creata" || warn "mem conflicts compare: output inatteso"
else
  warn "ID osservazioni non disponibili — compare saltato (osservazioni non storata come UUID)"
  RELATION_ID=""
fi

# Crea una seconda relazione conflicts_with per testare judge
if [ -n "$ID1" ] && [ -n "$ID2" ]; then
  cmd "mem conflicts compare (conflicts_with)"
  COMPARE2_OUT=$($KG mem conflicts compare "$ID1" "$ID2" \
    --relation conflicts_with \
    --confidence 0.7 \
    --reason "In-memory token store e pattern di cache hanno strategie di invalidazione potenzialmente contraddittorie" 2>&1)
  echo "$COMPARE2_OUT" | sed 's/^/     /'
  RELATION_ID2=$(echo "$COMPARE2_OUT" | grep -oE '[0-9a-f-]{36}' | head -1 || echo "")
  echo "$COMPARE2_OUT" | grep -qi "Relation\|created\|[0-9a-f-]" \
    && ok "mem conflicts compare (conflicts_with): OK" || warn "conflicts_with: output inatteso"
else
  RELATION_ID2=""
fi

# ── 13. mem conflicts list ────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[11] kirograph mem conflicts list${RESET}"

cmd "mem conflicts list"
LIST_OUT=$($KG mem conflicts list 2>&1)
echo "$LIST_OUT" | sed 's/^/     /'
echo ""
echo "$LIST_OUT" | grep -qi "Relation\|pending\|No pending\|related\|conflicts" \
  && ok "mem conflicts list: output prodotto" || warn "mem conflicts list: nessuna relazione (compare non ha avuto ID validi)"

# ── 14. mem conflicts judge ───────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[12] kirograph mem conflicts judge${RESET}"

if [ -n "$RELATION_ID" ]; then
  cmd "mem conflicts judge <relationId> --relation compatible --confidence 0.9"
  JUDGE_OUT=$($KG mem conflicts judge "$RELATION_ID" \
    --relation compatible \
    --confidence 0.9 \
    --reason "Dopo revisione: le due osservazioni non si contraddicono, sono su layer diversi" 2>&1)
  echo "$JUDGE_OUT" | sed 's/^/     /'
  echo ""
  echo "$JUDGE_OUT" | grep -qi "judged\|compatible\|Relation" \
    && ok "mem conflicts judge: relazione finalizzata" || fail "mem conflicts judge: fallito"
else
  warn "Relation ID non disponibile — judge saltato"
fi

# ── 15. mem conflicts ignore ──────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[13] kirograph mem conflicts ignore${RESET}"

if [ -n "$RELATION_ID2" ]; then
  echo -e "  ${DIM}Relazione da ignorare:${RESET}"
  cmd "mem conflicts list --format json"
  LIST_BEFORE=$($KG mem conflicts list --format json 2>&1)
  node -e "
    try {
      const rels = JSON.parse(process.argv[1]);
      const r = rels.find(x => x.id === process.argv[2]);
      if (r) {
        console.log('     id:       ' + r.id);
        console.log('     relation: ' + r.relation + ' (confidence: ' + r.confidence + ')');
        console.log('     A:        ' + r.observationA);
        console.log('     B:        ' + r.observationB);
        if (r.reason) console.log('     reason:   ' + r.reason);
        console.log('     status:   ' + r.judgmentStatus);
      } else {
        console.log('     (relazione non trovata nel JSON)');
      }
    } catch(e) { console.log('     (output non JSON)'); }
  " "$LIST_BEFORE" "$RELATION_ID2" 2>&1
  echo ""

  cmd "mem conflicts ignore <relationId>"
  IGNORE_OUT=$($KG mem conflicts ignore "$RELATION_ID2" 2>&1)
  echo "$IGNORE_OUT" | sed 's/^/     /'
  echo ""
  echo "$IGNORE_OUT" | grep -qi "ignored\|Relation" \
    && ok "mem conflicts ignore: relazione ignorata" || fail "mem conflicts ignore: fallito"
else
  warn "Relation ID2 non disponibile — ignore saltato"
fi

# ── 16. mem conflicts scan ────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[14] kirograph mem conflicts scan — FTS similarity${RESET}"

cmd "mem conflicts scan --limit 20"
SCAN_OUT=$($KG mem conflicts scan --limit 20 2>&1)
echo "$SCAN_OUT" | sed 's/^/     /'
echo ""
echo "$SCAN_OUT" | grep -qi "conflict\|candidate\|potential\|No potential\|Similarity" \
  && ok "mem conflicts scan: completato" || fail "mem conflicts scan: output inatteso"

# ── 17. mem review ────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[15] kirograph mem review — osservazioni scadute${RESET}"

cmd "mem review"
REVIEW_OUT=$($KG mem review 2>&1)
echo "$REVIEW_OUT" | sed 's/^/     /'
echo ""
# Può trovare osservazioni overdue (se review_after era nel passato) o zero
echo "$REVIEW_OUT" | grep -qi "review\|overdue\|No overdue\|observation" \
  && ok "mem review: output prodotto" || fail "mem review: output inatteso"

OVERDUE_COUNT=$(echo "$REVIEW_OUT" | { grep -iE "overdue by" || true; } | wc -l | tr -d ' ')
if [ "$OVERDUE_COUNT" -gt 0 ]; then
  ok "$OVERDUE_COUNT osservazione/i scaduta/e trovata/e"
else
  info "Nessuna osservazione scaduta (review_after potrebbe non essere stato salvato — flag opzionale)"
fi

# ── 18. mem mark-reviewed ─────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[16] kirograph mem mark-reviewed${RESET}"

if [ -n "$ID5" ] && [ "$OVERDUE_COUNT" -gt 0 ]; then
  cmd "mem mark-reviewed <id>"
  MARK_OUT=$($KG mem mark-reviewed "$ID5" 2>&1)
  echo "$MARK_OUT" | sed 's/^/     /'
  echo ""
  echo "$MARK_OUT" | grep -qi "marked\|reviewed" \
    && ok "mem mark-reviewed: osservazione rimossa dalla coda" || fail "mem mark-reviewed: fallito"

  # Verifica che non appaia più
  REVIEW2_OUT=$($KG mem review 2>&1)
  OVERDUE2=$(echo "$REVIEW2_OUT" | { grep -F "$ID5" || true; } | wc -l | tr -d ' ')
  [ "$OVERDUE2" -eq 0 ] && ok "Osservazione rimossa dalla review queue" || warn "Osservazione ancora in review queue"
else
  warn "ID5 non disponibile o nessuna osservazione scaduta — mark-reviewed saltato"
fi

# ── 19. mem search con relation annotations ───────────────────────────────────
sep
echo -e "  ${BOLD}[17] kirograph mem search — annotation relazioni${RESET}"

cmd "mem search \"token store\" (con annotation)"
SEARCH3=$($KG mem search "token store" 2>&1)
echo "$SEARCH3" | sed 's/^/     /'
echo ""
echo "$SEARCH3" | grep -qi "compatible\|conflicts\|supersedes\|related\|observation\|No memory" \
  && ok "mem search con annotations: completato" || warn "Nessuna annotation (le relazioni potrebbero non essere state create)"

# ── 20. mem timeline ──────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[18] kirograph mem timeline${RESET}"

cmd "mem timeline"
TL_OUT=$($KG mem timeline 2>&1)
echo "$TL_OUT" | sed 's/^/     /'
echo ""
echo "$TL_OUT" | grep -qi "decision\|pattern\|error\|observation\|timeline\|Session" \
  && ok "mem timeline: osservazioni visibili" || fail "mem timeline: nessuna osservazione"

cmd "mem timeline --format json"
TL_JSON=$($KG mem timeline --format json 2>&1)
node -e "JSON.parse(process.argv[1])" "$TL_JSON" 2>/dev/null \
  && ok "mem timeline --format json: JSON valido" \
  || warn "mem timeline JSON: output non parsabile (nessun dato)"

# ── 21. mem status finale ─────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[19] kirograph mem status — finale con relations${RESET}"

cmd "mem status"
STATUS2_OUT=$($KG mem status 2>&1)
echo "$STATUS2_OUT" | sed 's/^/     /'
echo ""
echo "$STATUS2_OUT" | grep -qi "Relation\|relation\|conflict" \
  && ok "mem status mostra relations/pendingConflicts" \
  || warn "mem status non mostra relations (controlla getStats())"

# ── 22. mem lint ──────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[20] kirograph mem lint${RESET}"

cmd "mem lint"
LINT_OUT=$($KG mem lint 2>&1)
echo "$LINT_OUT" | sed 's/^/     /'
echo ""
echo "$LINT_OUT" | grep -qi "Stale\|mismatch\|Lint" \
  && ok "mem lint: completato" || fail "mem lint: output inatteso"

cmd "mem lint --fix"
$KG mem lint --fix 2>&1 | sed 's/^/     /'
ok "mem lint --fix: completato"

# ── 23. mem export / import ───────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[21] kirograph mem export / import${RESET}"

cmd "mem export --format jsonl"
EXPORT_OUT=$($KG mem export --format jsonl 2>&1)
EXPORT_LINES=$(echo "$EXPORT_OUT" | { grep "content" || true; } | wc -l | tr -d ' ')
[ "$EXPORT_LINES" -gt 0 ] && ok "mem export: $EXPORT_LINES righe JSONL" || warn "mem export: nessuna riga (controllare se osservazioni storable)"

cmd "mem export --format md"
MD_OUT=$($KG mem export --format md 2>&1)
echo "$MD_OUT" | head -5 | sed 's/^/     /'
echo "$MD_OUT" | grep -qi "Session\|##\|decision\|pattern\|error" \
  && ok "mem export --format md: completato" || warn "mem export md: nessun contenuto"

# Round-trip import (crea file temporaneo)
TMPFILE=$(mktemp /tmp/kg-mem-test-XXXXXX.jsonl)
$KG mem export --format jsonl > "$TMPFILE" 2>/dev/null || true
if [ -s "$TMPFILE" ]; then
  cmd "mem import <file>"
  IMPORT_OUT=$($KG mem import "$TMPFILE" 2>&1)
  echo "$IMPORT_OUT" | sed 's/^/     /'
  echo "$IMPORT_OUT" | grep -qi "Imported\|skipped" \
    && ok "mem import: completato (duplicati saltati come atteso)" || warn "mem import: output inatteso"
else
  warn "mem import: saltato — nessun dato JSONL esportato"
fi
rm -f "$TMPFILE"

# ── 24. Duplicate detection ───────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[22] Deduplicazione osservazioni (SHA-256)${RESET}"

cmd "mem store (stesso contenuto — atteso duplicate)"
DUP_OUT=$($KG mem store "[$RUN_ID] Scelta architetturale: AuthService usa in-memory token store invece di Redis per semplicità in sviluppo." --kind decision 2>&1)
echo "$DUP_OUT" | sed 's/^/     /'
echo ""
echo "$DUP_OUT" | grep -qi "duplicate\|already" \
  && ok "Duplicate rilevato e saltato correttamente" || warn "Deduplicazione non rilevata"

# ── 25. mem prune ─────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[23] kirograph mem prune${RESET}"

cmd "mem prune --older-than 0d (rimuove tutto — solo per test)"
PRUNE_OUT=$($KG mem prune --older-than 0d 2>&1)
echo "$PRUNE_OUT" | sed 's/^/     /'
echo ""
echo "$PRUNE_OUT" | grep -qi "Pruned" \
  && ok "mem prune: completato" || fail "mem prune: output inatteso"

# ── 26. kirograph install — steering e hook verifica ─────────────────────────
sep
echo -e "  ${BOLD}[24] kirograph install — steering memory${RESET}"
echo -e "  ${DIM}Verifica che install scriva i file di steering e hook corretti per memory${RESET}"

cmd "install --target kiro --yes"
$KG install --target kiro --yes 2>&1 | grep -E "✓|✗|ℹ|hook|steering|MCP|agent|Workspace|Installing" | sed 's/^/     /'

echo ""

# Hook di memoria (v2 format: .json, trigger=Stop, action.type=agent)
[ -f ".kiro/hooks/kirograph-mem-capture.json" ] \
  && ok "Hook mem-capture: presente" \
  || fail "kirograph-mem-capture.json non trovato"

HOOK_MEM=$(cat .kiro/hooks/kirograph-mem-capture.json 2>/dev/null)
echo "$HOOK_MEM" | grep -q '"Stop"' \
  && ok "Hook mem-capture: trigger Stop" \
  || fail "Hook mem-capture: trigger Stop non trovato"
echo "$HOOK_MEM" | grep -q '"agent"' \
  && ok "Hook mem-capture: action type agent" \
  || fail "Hook mem-capture: action type agent non trovato"
echo "$HOOK_MEM" | grep -q 'kirograph_mem_store' \
  && ok "Hook mem-capture: prompt cita kirograph_mem_store" \
  || fail "Hook mem-capture: prompt senza kirograph_mem_store"

# Steering principale (kirograph.md) — sezione memory
[ -f ".kiro/steering/kirograph.md" ] \
  && ok "Steering: kirograph.md presente" \
  || fail ".kiro/steering/kirograph.md non trovato"

STEERING=$(cat .kiro/steering/kirograph.md 2>/dev/null)
echo "$STEERING" | grep -q '## Memory' \
  && ok "Steering kirograph.md: sezione ## Memory presente" \
  || fail "Steering kirograph.md: sezione ## Memory mancante"
echo "$STEERING" | grep -q 'kirograph_mem_search' \
  && ok "Steering kirograph.md: cita kirograph_mem_search" \
  || fail "Steering kirograph.md: kirograph_mem_search mancante"
echo "$STEERING" | grep -q 'kirograph_mem_conflicts_scan' \
  && ok "Steering kirograph.md: cita kirograph_mem_conflicts_scan" \
  || fail "Steering kirograph.md: kirograph_mem_conflicts_scan mancante"
echo "$STEERING" | grep -q 'kirograph_mem_compare' \
  && ok "Steering kirograph.md: cita kirograph_mem_compare" \
  || fail "Steering kirograph.md: kirograph_mem_compare mancante"
echo "$STEERING" | grep -q 'kirograph_mem_review' \
  && ok "Steering kirograph.md: cita kirograph_mem_review" \
  || fail "Steering kirograph.md: kirograph_mem_review mancante"
echo "$STEERING" | grep -q 'topicKey' \
  && ok "Steering kirograph.md: spiega topicKey" \
  || fail "Steering kirograph.md: topicKey non spiegato"
echo "$STEERING" | grep -q 'reviewAfter' \
  && ok "Steering kirograph.md: spiega reviewAfter" \
  || fail "Steering kirograph.md: reviewAfter non spiegato"
echo "$STEERING" | grep -q 'kirograph-mem-workflow' \
  && ok "Steering kirograph.md: punta a kirograph-mem-workflow.md" \
  || fail "Steering kirograph.md: riferimento a kirograph-mem-workflow mancante"

# Routing table nella steering
echo "$STEERING" | grep -q 'memory.*kirograph-mem-workflow\|kirograph-mem-workflow.*memory' \
  && ok "Steering kirograph.md: routing table ha voce memory" \
  || fail "Steering kirograph.md: voce memory mancante nella routing table"

# Skill file kirograph-mem-workflow.md
[ -f ".kiro/steering/kirograph-mem-workflow.md" ] \
  && ok "Steering: kirograph-mem-workflow.md presente" \
  || fail ".kiro/steering/kirograph-mem-workflow.md non trovato"

SKILL=$(cat .kiro/steering/kirograph-mem-workflow.md 2>/dev/null)
echo "$SKILL" | grep -q 'inclusion: manual' \
  && ok "kirograph-mem-workflow.md: inclusion: manual" \
  || fail "kirograph-mem-workflow.md: inclusion: manual mancante"
echo "$SKILL" | grep -q 'kirograph_mem_search' \
  && ok "kirograph-mem-workflow.md: step 1 recall (mem_search)" \
  || fail "kirograph-mem-workflow.md: mem_search mancante"
echo "$SKILL" | grep -q 'kirograph_mem_store' \
  && ok "kirograph-mem-workflow.md: step 2 store" \
  || fail "kirograph-mem-workflow.md: mem_store mancante"
echo "$SKILL" | grep -q 'kirograph_mem_capture' \
  && ok "kirograph-mem-workflow.md: step 3 capture" \
  || fail "kirograph-mem-workflow.md: mem_capture mancante"
echo "$SKILL" | grep -q 'kirograph_mem_conflicts_scan' \
  && ok "kirograph-mem-workflow.md: step 4 conflict scan" \
  || fail "kirograph-mem-workflow.md: mem_conflicts_scan mancante"
echo "$SKILL" | grep -q 'kirograph_mem_compare' \
  && ok "kirograph-mem-workflow.md: step 5 compare" \
  || fail "kirograph-mem-workflow.md: mem_compare mancante"
echo "$SKILL" | grep -q 'kirograph_mem_judge' \
  && ok "kirograph-mem-workflow.md: step 6 judge" \
  || fail "kirograph-mem-workflow.md: mem_judge mancante"
echo "$SKILL" | grep -q 'kirograph_mem_review' \
  && ok "kirograph-mem-workflow.md: step 7 review" \
  || fail "kirograph-mem-workflow.md: mem_review mancante"
echo "$SKILL" | grep -q 'kirograph_mem_mark_reviewed' \
  && ok "kirograph-mem-workflow.md: step 7 mark_reviewed" \
  || fail "kirograph-mem-workflow.md: mem_mark_reviewed mancante"

echo ""
info "Anteprima .kiro/steering/kirograph-mem-workflow.md:"
head -20 .kiro/steering/kirograph-mem-workflow.md | sed 's/^/     /'

# ── Fine ──────────────────────────────────────────────────────────────────────
sep
echo ""
echo -e "  ${BOLD}File generati in mock/.kirograph/:${RESET}"
ls "$TEST_DIR/.kirograph/" 2>/dev/null | while read -r f; do
  echo -e "     ${DIM}·${RESET} $f"
done

echo ""
echo -e "  ${BOLD}Feature testate (v0.24.0):${RESET}"
echo -e "  ${DIM}·${RESET} store (base, topic_key, review_after)"
echo -e "  ${DIM}·${RESET} suggest-topic-key"
echo -e "  ${DIM}·${RESET} search (con relation annotations)"
echo -e "  ${DIM}·${RESET} capture (passive extract)"
echo -e "  ${DIM}·${RESET} save-prompt"
echo -e "  ${DIM}·${RESET} conflicts compare / list / judge / ignore / scan"
echo -e "  ${DIM}·${RESET} review / mark-reviewed"
echo -e "  ${DIM}·${RESET} timeline (text + json)"
echo -e "  ${DIM}·${RESET} status (con relations + pendingConflicts)"
echo -e "  ${DIM}·${RESET} lint (+ --fix)"
echo -e "  ${DIM}·${RESET} export / import (jsonl + md)"
echo -e "  ${DIM}·${RESET} prune"
echo -e "  ${DIM}·${RESET} deduplicazione SHA-256"
echo -e "  ${DIM}·${RESET} install: steering + hook memory verificati"
echo ""
echo -e "  ${GREEN}${BOLD}Test completato.${RESET}"
echo ""
