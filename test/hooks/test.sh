#!/usr/bin/env bash
# test-hooks.sh — verifica che i comandi shell generati per gli hook siano
# cross-platform (issue #40): sintassi POSIX su macOS/Linux, cmd.exe su Windows.
#
# Copre:
#   [1] silentCommand(): forma corretta per POSIX e per Windows (win32 simulato)
#   [2] Nessuna regressione di sintassi tra le due piattaforme
#   [3] File hook generati (writeHooks) usano silentCommand per Stop/watchmen/wiki
#   [4] Config agent CLI (writeCliAgent) usa la forma cross-platform nei 3 hook
#
# Non richiede rete né modello: esercita solo i generatori dell'installer.
#
# Uso:
#   ./test.sh              # build + verifica
#   ./test.sh --no-build   # usa dist esistente

set -euo pipefail

NO_BUILD=false
for arg in "$@"; do
  case $arg in
    --no-build) NO_BUILD=true ;;
  esac
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
DIM='\033[2m'; RESET='\033[0m'; BOLD='\033[1m'; RED='\033[0;31m'
FAILURES=0

ok()   { echo -e "  ${GREEN}✓${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "  ${CYAN}›${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
sep()  { echo -e "\n${DIM}──────────────────────────────────────────────────────${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo -e "\n${BOLD}  KiroGraph Hooks — cross-platform shell syntax (issue #40)${RESET}"

# ── 1. Build ──────────────────────────────────────────────────────────────────
sep
if [ "$NO_BUILD" = false ]; then
  info "Building..."
  cd "$ROOT" && npm run build > /dev/null 2>&1
  ok "Build OK  (v$(node "$ROOT/dist/bin/kirograph.js" --version 2>/dev/null || echo '?'))"
else
  warn "--no-build: usando dist esistente"
fi

# Helper: valuta silentCommand(base) forzando process.platform.
sc() {
  local platform="$1" base="$2"
  cd "$ROOT" && node -e "Object.defineProperty(process,'platform',{value:process.argv[1]});const {silentCommand}=require('./dist/bin/installer/common.js');process.stdout.write(silentCommand(process.argv[2]));" "$platform" "$base" 2>&1
}

# ── 2. silentCommand(): forma per piattaforma ─────────────────────────────────
sep
echo -e "  ${BOLD}[1] silentCommand() — forma per piattaforma${RESET}"

POSIX_OUT=$(sc linux "kirograph sync --quiet")
[ "$POSIX_OUT" = "kirograph sync --quiet >/dev/null 2>&1 || true" ] \
  && ok "POSIX: '$POSIX_OUT'" \
  || fail "POSIX: forma inattesa -> '$POSIX_OUT'"

WIN_OUT=$(sc win32 "kirograph sync --quiet")
[ "$WIN_OUT" = "kirograph sync --quiet >nul 2>&1 || exit /b 0" ] \
  && ok "Windows: '$WIN_OUT'" \
  || fail "Windows: forma inattesa -> '$WIN_OUT'"

# Tutti i comandi base devono mappare correttamente su entrambe le piattaforme.
BASES=("kirograph sync --quiet" "kirograph sync-if-dirty --quiet" "kirograph compress-hint" "kirograph mem watchmen synthesize --quiet" "kirograph wiki synthesize --quiet" "kirograph wiki lint")
for base in "${BASES[@]}"; do
  W=$(sc win32 "$base")
  P=$(sc linux "$base")
  if [ "$W" = "$base >nul 2>&1 || exit /b 0" ] && [ "$P" = "$base >/dev/null 2>&1 || true" ]; then
    ok "mappa entrambe le piattaforme: '$base'"
  else
    fail "mappatura errata per '$base' -> win:'$W' posix:'$P'"
  fi
done

# ── 3. Nessuna regressione di sintassi tra piattaforme ────────────────────────
sep
echo -e "  ${BOLD}[2] Nessuna sintassi bash nella forma Windows (e viceversa)${RESET}"

echo "$WIN_OUT" | grep -q "/dev/null" \
  && fail "Windows contiene ancora /dev/null" \
  || ok "Windows: nessun /dev/null"
echo "$WIN_OUT" | grep -q "|| true" \
  && fail "Windows contiene ancora '|| true'" \
  || ok "Windows: nessun '|| true'"
echo "$POSIX_OUT" | grep -q ">nul" \
  && fail "POSIX contiene '>nul' (specifico Windows)" \
  || ok "POSIX: nessun '>nul'"
echo "$POSIX_OUT" | grep -q "exit /b" \
  && fail "POSIX contiene 'exit /b' (specifico Windows)" \
  || ok "POSIX: nessun 'exit /b'"

# ── 4. File hook generati (writeHooks) ────────────────────────────────────────
sep
echo -e "  ${BOLD}[3] writeHooks() — comandi negli hook Stop/watchmen/wiki${RESET}"

# Genera in una dir temporanea forzando win32 e verifica ogni file.
# La tmp è creata da bash (mktemp): forzando process.platform=win32,
# os.tmpdir() di Node non risolverebbe su una macchina non-Windows.
HOOKS_TMP=$(mktemp -d)
HOOKS_JSON=$(cd "$ROOT" && HOOKS_TMP="$HOOKS_TMP" node -e "
Object.defineProperty(process,'platform',{value:'win32'});
console.log=()=>{}; // silenzia i log di conferma dell'installer, lascia solo il JSON su stdout
const fs=require('fs'),path=require('path');
const {writeHooks}=require('./dist/bin/installer/hooks.js');
const tmp=process.env.HOOKS_TMP;
writeHooks(tmp,{enableWatchmen:true,watchmenSynthesisMode:'local',enableWiki:true,wikiSynthesisMode:'local'});
const read=(f)=>JSON.parse(fs.readFileSync(path.join(tmp,'hooks',f),'utf8')).hooks[0].action.command;
const out={sync:read('kirograph-sync-if-dirty.json'),watchmen:read('kirograph-watchmen.json'),wiki:read('kirograph-wiki-ingest.json')};
process.stdout.write(JSON.stringify(out));
" 2>&1)
rm -rf "$HOOKS_TMP"

check_hook_cmd() {
  local label="$1" key="$2"
  local cmd
  cmd=$(echo "$HOOKS_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s)['$key']||'')}catch(e){process.stdout.write('PARSE_ERROR:'+s)}})")
  if echo "$cmd" | grep -q ">nul 2>&1 || exit /b 0"; then
    ok "$label: '$cmd'"
  else
    fail "$label: forma Windows attesa, trovato -> '$cmd'"
  fi
}
check_hook_cmd "hook sync-if-dirty" "sync"
check_hook_cmd "hook watchmen"      "watchmen"
check_hook_cmd "hook wiki"          "wiki"

# ── 5. Config agent CLI (writeCliAgent) ───────────────────────────────────────
sep
echo -e "  ${BOLD}[4] writeCliAgent() — 3 hook (agentSpawn/userPromptSubmit/stop)${RESET}"

AGENT_TMP=$(mktemp -d)
AGENT_JSON=$(cd "$ROOT" && AGENT_TMP="$AGENT_TMP" node -e "
Object.defineProperty(process,'platform',{value:'win32'});
console.log=()=>{}; // silenzia i log di conferma dell'installer, lascia solo il JSON su stdout
const fs=require('fs'),path=require('path');
const {writeCliAgent}=require('./dist/bin/installer/cli-agent.js');
const tmp=process.env.AGENT_TMP;
writeCliAgent(tmp,{});
const a=JSON.parse(fs.readFileSync(path.join(tmp,'agents','kirograph.json'),'utf8'));
const out={spawn:a.hooks.agentSpawn[0].command,prompt:a.hooks.userPromptSubmit[0].command,stop:a.hooks.stop[0].command};
process.stdout.write(JSON.stringify(out));
" 2>&1)
rm -rf "$AGENT_TMP"

check_agent_hook() {
  local label="$1" key="$2"
  local cmd
  cmd=$(echo "$AGENT_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s)['$key']||'')}catch(e){process.stdout.write('PARSE_ERROR:'+s)}})")
  if echo "$cmd" | grep -q ">nul 2>&1 || exit /b 0"; then
    ok "$label: '$cmd'"
  else
    fail "$label: forma Windows attesa, trovato -> '$cmd'"
  fi
}
check_agent_hook "agentSpawn"       "spawn"
check_agent_hook "userPromptSubmit" "prompt"
check_agent_hook "stop"             "stop"

# ── Fine ──────────────────────────────────────────────────────────────────────
sep
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}Tutti i controlli superati.${RESET}"
else
  echo -e "  ${RED}${BOLD}$FAILURES controllo/i fallito/i.${RESET}"
  exit 1
fi
echo ""
