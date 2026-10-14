#!/usr/bin/env bash
# test-routes.sh — testa l'estrazione delle route e il collegamento dei prefissi di mount:
#
#   A1. route Fastify su plugin (receiver = primo parametro), con prefissi annidati
#   A2. forme di mount: alias, namespace, default anonimo, require(), inline
#   A3. argKind per i sink SQL nei linguaggi non JS (Python)
#
# Mock: test/routes/mock — progetto Fastify multi-file + sorgente Python.
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

GREEN='\033[0;32m'; CYAN='\033[0;36m'; DIM='\033[2m'; RESET='\033[0m'; BOLD='\033[1m'; RED='\033[0;31m'
FAILURES=0

ok()   { echo -e "  ${GREEN}✓${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "  ${CYAN}›${RESET}  $1"; }
sep()  { echo -e "\n${DIM}──────────────────────────────────────────────────────${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$SCRIPT_DIR/mock"
KG="node $ROOT/dist/bin/kirograph.js"
DB="$TEST_DIR/.kirograph/kirograph.db"

echo -e "\n${BOLD}  KiroGraph Routes — mount prefixes · argKind${RESET}"
echo -e "  ${DIM}$TEST_DIR${RESET}"

sep
if [ "$NO_BUILD" = false ]; then
  info "Building..."
  cd "$ROOT" && npm run build > /dev/null 2>&1
  ok "Build OK"
else
  info "--no-build: usando dist esistente"
fi

sep
info "Indexing mock..."
cd "$TEST_DIR"
rm -rf .kirograph
$KG init > /dev/null 2>&1
$KG index --force > /dev/null 2>&1
ok "Index OK"

# Query helper: prints one row per line, using the repo's own better-sqlite3
query() {
  node -e '
    const D = require(process.argv[1] + "/node_modules/better-sqlite3");
    const db = new D(process.argv[2], { readonly: true });
    for (const r of db.prepare(process.argv[3]).all()) console.log(Object.values(r).join("\t"));
  ' "$ROOT" "$DB" "$1"
}

sep
echo -e "${BOLD}  [A1–A2] route names${RESET}"
ACTUAL_ROUTES="$(query "SELECT name FROM nodes WHERE kind = 'route' ORDER BY name")"
EXPECTED_ROUTES="GET /api/status
GET /api/users/:id
GET /health
GET /inline/inline
GET /legacy/x
GET /root
GET /v1/items
POST /api/users"
if [ "$ACTUAL_ROUTES" = "$EXPECTED_ROUTES" ]; then
  ok "8 route con il path completo (nidificazione, alias, namespace, default, require, inline)"
else
  fail "route inattese:"
  echo "$ACTUAL_ROUTES" | sed 's/^/        /'
fi

sep
echo -e "${BOLD}  [A3] argKind sui sink Python${RESET}"
ARGKINDS="$(query "SELECT s.name || ' ' || json_extract(e.metadata, '\$.argKind') FROM edges e JOIN nodes s ON s.id = e.source WHERE e.kind = 'calls' AND e.metadata LIKE '%argKind%' ORDER BY s.name")"
EXPECTED_ARGKINDS="by_id static
by_name dynamic
concat dynamic
formatted dynamic"
if [ "$ARGKINDS" = "$EXPECTED_ARGKINDS" ]; then
  ok "f-string e concatenazione/formattazione → dynamic; params (%s, tuple) → static"
else
  fail "argKind inattesi:"
  echo "$ARGKINDS" | sed 's/^/        /'
fi

sep
if [ "$FAILURES" -eq 0 ]; then
  echo -e "  ${GREEN}Tutti i controlli superati.${RESET}\n"
else
  echo -e "  ${RED}$FAILURES controllo/i fallito/i.${RESET}\n"
  exit 1
fi
