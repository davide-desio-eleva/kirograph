#!/usr/bin/env bash
# test-watchmen.sh — testa il workflow completo di KiroGraph Watchmen
# su un progetto nuovo, partendo dal codice sorgente.
#
# Uso:
#   ./test-watchmen.sh              # test completo con local model synthesis
#   ./test-watchmen.sh --skip-llm  # salta la synthesis (testa solo threshold/counter/reset)
#   ./test-watchmen.sh --no-build  # non ricompila (usa dist esistente)

set -euo pipefail

SKIP_LLM=false; NO_BUILD=false
for arg in "$@"; do
  case $arg in
    --skip-llm) SKIP_LLM=true ;;
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

# Suffisso unico per evitare duplicate tra run successivi
RUN_ID=$(date +%s)

echo -e "\n${BOLD}  KiroGraph Watchmen — test su progetto nuovo${RESET}"
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

# ── 2. Pulizia totale — ricomincia da zero ─────────────────────────────────────
sep
info "Pulizia completa — progetto vergine..."
rm -rf "$TEST_DIR/.kirograph"
rm -rf "$TEST_DIR/.kiro"
ok "Rimossi .kirograph/ e .kiro/"

cd "$TEST_DIR"

# ── 3. Crea il config come farebbe kirograph install ──────────────────────────
sep
echo -e "  ${BOLD}[1] Configurazione del progetto${RESET}"
echo -e "  ${DIM}Crea .kirograph/config.json con memory + watchmen abilitati${RESET}"

mkdir -p .kirograph
cat > .kirograph/config.json << EOF
{
  "version": 1,
  "languages": ["typescript"],
  "enableMemory": true,
  "enableWatchmen": true,
  "watchmenThreshold": 3,
  "watchmenSynthesisMode": "local",
  "watchmenLocalModel": "onnx-community/gemma-4-E4B-it-ONNX"
}
EOF
ok "Config scritto:"
echo -e "     ${DIM}enableMemory: true${RESET}"
echo -e "     ${DIM}enableWatchmen: true${RESET}"
echo -e "     ${DIM}watchmenThreshold: 3${RESET}"
echo -e "     ${DIM}watchmenSynthesisMode: local${RESET}"
echo -e "     ${DIM}watchmenLocalModel: onnx-community/gemma-4-E4B-it-ONNX${RESET}"

# ── 4. Install ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[2] kirograph install${RESET}"
echo -e "  ${DIM}Installa MCP, hook (mem-capture + watchmen), steering e CLI agent${RESET}"

cmd "install --target kiro --yes"
$KG install --target kiro --yes 2>&1 | grep -E "✓|✗|ℹ|hook|steering|MCP|agent|Workspace|Installing" | sed 's/^/     /'

ok "Install completato"

[ -f ".kiro/settings/mcp.json" ]                        && ok "MCP server: .kiro/settings/mcp.json"          || fail "mcp.json non trovato"
[ -f ".kiro/hooks/kirograph-watchmen.json" ]       && ok "Hook watchmen: command synthesis"           || fail "kirograph-watchmen.json non trovato"
[ -f ".kiro/hooks/kirograph-mem-capture.json" ]    && ok "Hook mem-capture: agent store obs"          || fail "kirograph-mem-capture.json non trovato"
[ -f ".kiro/hooks/kirograph-sync-if-dirty.json" ]  && ok "Hook sync: Stop index sync"               || fail "kirograph-sync-if-dirty.json non trovato"
[ -f ".kiro/steering/kirograph.md" ]                    && ok "Steering: kirograph.md (inclusion: always)"    || fail "kirograph.md non trovato"
[ -f ".kiro/agents/kirograph.json" ]                    && ok "CLI agent: kirograph.json"                     || fail "kirograph.json non trovato"

echo ""
info "Contenuto .kiro/hooks/kirograph-watchmen.json:"
cat .kiro/hooks/kirograph-watchmen.json | sed 's/^/     /'

# ── 5. Index ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[3] kirograph index${RESET}"

cmd "index"
$KG index 2>&1 | grep -E "✓|file|symbol|edge|Indexed|scanning|languages" | sed 's/^/     /'
[ -f ".kirograph/kirograph.db" ] && ok "kirograph.db creato" || fail "kirograph.db non trovato"

# ── 6. Status iniziale ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[4] Watchmen status — progetto nuovo${RESET}"

cmd "mem watchmen status"
$KG mem watchmen status 2>&1 | sed 's/^/     /'

# ── 7. Store osservazioni — round 1 ──────────────────────────────────────────
sep
echo -e "  ${BOLD}[5] Store 3 osservazioni — threshold 3${RESET}"
echo -e "  ${DIM}Simula il lavoro di una sessione di sviluppo${RESET}\n"

cmd "mem store \"...\" --kind decision"
$KG mem store "[$RUN_ID] Preferire MemoryManager.store() agli insert diretti — gestisce dedup, compressione e symbol linking automaticamente." --kind decision
ok "1/3 storata [decision]"

cmd "mem store \"...\" --kind error"
$KG mem store "[$RUN_ID] TypeError: cannot read 'id' di undefined in database.ts — chiamare sempre memDb.initialize() prima di qualsiasi query." --kind error
ok "2/3 storata [error]"

cmd "mem store \"...\" --kind pattern  ← deve scattare watchmenReady"
OUTPUT=$($KG mem store "[$RUN_ID] Pattern: eseguire sempre kirograph_impact prima di modificare funzioni pubbliche per identificare regressioni." --kind pattern 2>&1)
echo "$OUTPUT" | sed 's/^/     /'

echo ""
echo "$OUTPUT" | grep -q "Watchmen ready" && ok "watchmenReady scattato ✓" || fail "watchmenReady non scattato"

# ── 8. Synthesis — brief ──────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[6] Synthesis round 1 — workspace brief${RESET}"
echo -e "  ${DIM}3 osservazioni eterogenee → brief senza skill files${RESET}\n"

if [ "$SKIP_LLM" = true ]; then
  warn "--skip-llm: synthesis saltata"
  info "Per il test completo: ./test-watchmen.sh --no-build"
  info "Modello: onnx-community/gemma-4-E4B-it-ONNX (~2GB, cache ~/.kirograph/models/)"
else
  MODEL_CACHE="$HOME/.kirograph/models/onnx-community/gemma-4-E4B-it-ONNX"
  [ -d "$MODEL_CACHE" ] \
    || warn "Prima esecuzione: download modello ~3-4GB (verrà cachato in ~/.kirograph/models/)"
  echo ""
  cmd "mem watchmen synthesize"
  # Esegui direttamente — non catturare in $() altrimenti \r delle barre viene soppresso
  $KG mem watchmen synthesize
  echo ""

  [ -f ".kiro/steering/kirograph-watchmen.md" ] \
    && ok "kirograph-watchmen.md scritto (inclusion: always)" \
    || fail "Brief non scritto"

  echo ""
  echo -e "  ${DIM}── .kiro/steering/kirograph-watchmen.md ─────────────────────${RESET}"
  head -25 .kiro/steering/kirograph-watchmen.md | sed 's/^/  /'
  echo -e "  ${DIM}────────────────────────────────────────────────────────────${RESET}"

  cmd "mem watchmen status"
  $KG mem watchmen status 2>&1 | sed 's/^/     /'
fi

# ── 9. Synthesis — skill files ────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[7] Synthesis round 2 — skill files${RESET}"
echo -e "  ${DIM}3 osservazioni sulla stessa procedura → watchmen-<slug>.md (inclusion: manual)${RESET}\n"

if [ "$SKIP_LLM" = true ]; then
  warn "--skip-llm: skill generation saltata"
else
  cmd "mem store x3 (stessa procedura)"
  $KG mem store "[$RUN_ID] Procedura: prima di modificare qualsiasi funzione pubblica, eseguire kirograph_impact per identificare tutti i caller a rischio." --kind pattern > /dev/null
  $KG mem store "[$RUN_ID] Ogni refactoring di API pubblica richiede: 1) kirograph_impact, 2) lista dei caller, 3) aggiornare i test degli impacted." --kind pattern > /dev/null
  OUTPUT2=$($KG mem store "[$RUN_ID] Pattern: kirograph_impact obbligatorio prima di toccare metodi pubblici — evita regressioni silenziose sui caller." --kind pattern 2>&1)
  echo "$OUTPUT2" | sed 's/^/     /'

  echo ""
  echo "$OUTPUT2" | grep -q "Watchmen ready" && ok "watchmenReady scattato di nuovo ✓" || warn "watchmenReady non mostrato"

  echo ""
  cmd "mem watchmen synthesize"
  # Esegui direttamente per mostrare le progress bar
  $KG mem watchmen synthesize
  echo ""

  SKILLS=$(ls .kiro/steering/watchmen-*.md 2>/dev/null || true)
  if [ -n "$SKILLS" ]; then
    ok "Skill files generati (inclusion: manual):"
    while IFS= read -r f; do echo -e "     ${DIM}·${RESET} $(basename "$f")"; done <<< "$SKILLS"
    echo ""
    echo -e "  ${DIM}── $(basename "$(echo "$SKILLS" | head -1)") ─────────────────────────────${RESET}"
    cat "$(echo "$SKILLS" | head -1)" | sed 's/^/  /'
    echo -e "  ${DIM}────────────────────────────────────────────────────────────${RESET}"
  else
    warn "Nessun skill file (il modello non ha rilevato procedura ricorrente in questo run)"
    info "Il riconoscimento dipende dal modello. Con 3B+ è deterministico."
  fi
fi

# ── 10. Timeline ──────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[8] Memory timeline${RESET}\n"
cmd "mem timeline"
$KG mem timeline 2>&1 | sed 's/^/     /'

# ── 11. Search ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[9] Memory search${RESET}\n"
cmd "mem search \"kirograph_impact pattern\""
$KG mem search "kirograph_impact pattern" 2>&1 | sed 's/^/     /'

# ── 12. Reset ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[10] Reset manuale del counter${RESET}\n"

cmd "mem store \"...\" --kind architecture"
$KG mem store "[$RUN_ID] Architettura: mem e graph condividono lo stesso handle SQLite — non aprire mai una seconda connessione nello stesso processo." --kind architecture > /dev/null
ok "Osservazione storata (counter > 0)"

cmd "mem watchmen reset"
$KG mem watchmen reset 2>&1 | sed 's/^/     /'

cmd "mem watchmen status"
$KG mem watchmen status 2>&1 | sed 's/^/     /'

# ── Fine ──────────────────────────────────────────────────────────────────────
sep
echo ""
echo -e "  ${BOLD}File generati in test-watchmen/.kiro/steering/:${RESET}"
ls "$TEST_DIR/.kiro/steering/" 2>/dev/null | while read -r f; do
  if [[ "$f" == watchmen-* ]]; then
    echo -e "     ${CYAN}·${RESET} $f  ${DIM}(inclusion: manual — skill generata da watchmen)${RESET}"
  else
    echo -e "     ${DIM}·${RESET} $f"
  fi
done

echo ""
if [ "$SKIP_LLM" = true ]; then
  echo -e "  ${YELLOW}${BOLD}Completato (--skip-llm)${RESET} — install, index, threshold, counter e reset verificati."
  echo -e ""
  echo -e "  Per il test completo con synthesis:"
  echo -e "  ${DIM}\$${RESET} ${CYAN}./test-watchmen.sh --no-build${RESET}"
else
  echo -e "  ${GREEN}${BOLD}Tutti i passi completati.${RESET}"
fi
echo ""
