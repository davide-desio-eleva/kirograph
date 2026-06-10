#!/usr/bin/env bash
# test-patterns.sh — testa il PatternRunner di KiroGraph su un progetto multi-linguaggio.
#
# Verifica:
#   1. Nessun warning "is not supported in napi" durante l'index
#   2. Ogni regola built-in trova almeno un match nel file mock atteso
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
fail() { echo -e "  ${RED}✗${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "  ${CYAN}›${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
sep()  { echo -e "\n${DIM}──────────────────────────────────────────────────────${RESET}"; }

FAILURES=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$SCRIPT_DIR/mock"
KG="node $ROOT/dist/bin/kirograph.js"
DB="$TEST_DIR/.kirograph/kirograph.db"

echo -e "\n${BOLD}  KiroGraph Patterns — test multi-linguaggio${RESET}"
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

# ── 2. Pulizia ────────────────────────────────────────────────────────────────
sep
info "Pulizia .kirograph/ e .kiro/..."
rm -rf "$TEST_DIR/.kirograph" "$TEST_DIR/.kiro"
ok "Progetto vergine"
cd "$TEST_DIR"

# ── 3. Configurazione ─────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[1] Configurazione${RESET}"
mkdir -p .kirograph
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "enablePatterns": true,
  "enableSecurity": false,
  "enableEmbeddings": false,
  "enableDocs": false,
  "enableData": false,
  "enableMemory": false
}
EOF
ok "config.json scritto (enablePatterns: true)"

# ── 4. Install — hook IDE + lang packages ────────────────────────────────────
sep
echo -e "  ${BOLD}[2] kirograph install + lang packages${RESET}"
echo -e "  ${DIM}Installa hook IDE; poi installa @ast-grep/napi e tutti i @ast-grep/lang-*${RESET}"

$KG install --target kiro --yes 2>&1 \
  | grep -E "✓|✗" | head -5 | sed 's/^/     /' || true
ok "Install hooks completato"

LANG_PKGS=(
  "@ast-grep/napi"
  "@ast-grep/lang-go"
  "@ast-grep/lang-python"
  "@ast-grep/lang-java"
  "@ast-grep/lang-rust"
  "@ast-grep/lang-c"
  "@ast-grep/lang-cpp"
  "@ast-grep/lang-csharp"
  "@ast-grep/lang-kotlin"
  "@ast-grep/lang-swift"
  "@ast-grep/lang-ruby"
  "@ast-grep/lang-php"
  "@ast-grep/lang-bash"
  "@ast-grep/lang-scala"
  "@ast-grep/lang-dart"
  "@ast-grep/lang-lua"
  "@ast-grep/lang-elixir"
  "@ast-grep/lang-haskell"
)

echo -e "\n  ${DIM}Installazione lang packages in $ROOT/node_modules/ ...${RESET}"
(cd "$ROOT" && npm install --save-optional "${LANG_PKGS[@]}" 2>&1 \
  | tail -3 | sed 's/^/     /')

node -e "require.resolve('@ast-grep/napi')" 2>/dev/null \
  && ok "@ast-grep/napi installato" \
  || { fail "@ast-grep/napi non trovato — pattern matching disabilitato"; }

INSTALLED_LANGS=0
for pkg in "${LANG_PKGS[@]:1}"; do
  node -e "require.resolve('$pkg')" 2>/dev/null && INSTALLED_LANGS=$((INSTALLED_LANGS + 1)) || true
done
ok "$INSTALLED_LANGS/${#LANG_PKGS[@]}-1 @ast-grep/lang-* installati"

# ── 5. Index ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[3] kirograph index${RESET}"
echo -e "  ${DIM}Stderr non deve contenere 'not supported in napi'${RESET}"

INDEX_OUT=$($KG index 2>&1)
echo "$INDEX_OUT" | grep -E "✓|scanning|languages|Indexed|patterns" | sed 's/^/     /'

NAPI_WARNS=$(echo "$INDEX_OUT" | grep -c "not supported in napi" || true)
if [ "$NAPI_WARNS" -gt 0 ]; then
  fail "Trovati $NAPI_WARNS warning 'not supported in napi'"
  echo "$INDEX_OUT" | grep "not supported in napi" | sed 's/^/     /'
else
  ok "Nessun warning 'not supported in napi'"
fi

RULE_ERRS=$(echo "$INDEX_OUT" | grep -c "PatternRunner: error running rule" || true)
if [ "$RULE_ERRS" -gt 0 ]; then
  fail "Trovati $RULE_ERRS errori PatternRunner"
  echo "$INDEX_OUT" | grep "PatternRunner: error running rule" | sed 's/^/     /'
else
  ok "Nessun errore PatternRunner"
fi

[ -f "$DB" ] && ok "kirograph.db creato" || { fail "kirograph.db non trovato"; }

db_count() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM pattern_matches WHERE pattern_id='$1';" 2>/dev/null || echo 0
}

check_rule() {
  local rule_id="$1"; local expected_file="$2"; local min_matches="${3:-1}"
  local cnt
  cnt=$(db_count "$rule_id")
  if [ "$cnt" -ge "$min_matches" ]; then
    ok "$rule_id  ${DIM}($cnt match)${RESET}"
  else
    fail "$rule_id  attesi >=$min_matches match, trovati $cnt"
  fi
}

# ── 6. JavaScript / TypeScript ────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[4] Regole JavaScript / TypeScript${RESET}"
echo -e "  ${DIM}src/app.ts + src/server.js${RESET}\n"

check_rule "sql-injection-concat-js"    "app.ts/server.js"
check_rule "sql-injection-template-js"  "app.ts/server.js"
check_rule "dangerous-eval-js"          "app.ts/server.js"
check_rule "path-traversal-readfile-js" "app.ts/server.js"
check_rule "weak-crypto-md5-js"         "app.ts/server.js"
check_rule "prototype-pollution-js"     "app.ts/server.js"

# ── 7. Python ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[5] Regole Python${RESET}"
echo -e "  ${DIM}src/handler.py${RESET}\n"

check_rule "dangerous-exec-py"  "handler.py"
check_rule "weak-crypto-py"     "handler.py"
check_rule "sql-injection-py"   "handler.py"

# ── 8. Go ─────────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[6] Regole Go${RESET}"
echo -e "  ${DIM}src/main.go${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-go')" 2>/dev/null; then
  check_rule "command-injection-go" "main.go"
  check_rule "path-traversal-go"    "main.go"
else
  warn "@ast-grep/lang-go non installato — regole Go saltate"
fi

# ── 9. Java ───────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[7] Regole Java${RESET}"
echo -e "  ${DIM}src/Service.java${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-java')" 2>/dev/null; then
  check_rule "sql-injection-java"        "Service.java"
  check_rule "dangerous-reflection-java" "Service.java"
else
  warn "@ast-grep/lang-java non installato — regole Java saltate"
fi

# ── 10. Rust ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[8] Regole Rust${RESET}"
echo -e "  ${DIM}src/main.rs${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-rust')" 2>/dev/null; then
  check_rule "command-injection-rust" "main.rs"
  check_rule "unsafe-block-rust"      "main.rs"
else
  warn "@ast-grep/lang-rust non installato — regole Rust saltate"
fi

# ── 11. C / C++ ───────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[9] Regole C / C++${RESET}"
echo -e "  ${DIM}src/utils.c + src/utils.cpp${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-c')" 2>/dev/null; then
  check_rule "command-injection-c" "utils.c/utils.cpp" 2
  check_rule "unsafe-string-c"     "utils.c/utils.cpp" 2
else
  warn "@ast-grep/lang-c non installato — regole C/C++ saltate"
fi

# ── 12. Ruby ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[10] Regole Ruby${RESET}"
echo -e "  ${DIM}src/helpers.rb${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-ruby')" 2>/dev/null; then
  check_rule "command-injection-ruby"    "helpers.rb"
  check_rule "subshell-injection-ruby"   "helpers.rb"
  check_rule "dangerous-eval-ruby"       "helpers.rb"
else
  warn "@ast-grep/lang-ruby non installato — regole Ruby saltate"
fi

# ── 13. PHP ───────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[11] Regole PHP${RESET}"
echo -e "  ${DIM}src/lib.php${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-php')" 2>/dev/null; then
  check_rule "command-injection-php" "lib.php"
  check_rule "dangerous-eval-php"    "lib.php"
  check_rule "sql-injection-php"     "lib.php"
else
  warn "@ast-grep/lang-php non installato — regole PHP saltate"
fi

# ── 14. Bash ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[12] Regole Bash${RESET}"
echo -e "  ${DIM}src/script.sh${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-bash')" 2>/dev/null; then
  check_rule "dangerous-eval-bash"   "script.sh"
  check_rule "source-injection-bash" "script.sh"
else
  warn "@ast-grep/lang-bash non installato — regole Bash saltate"
fi

# ── 15. Lua ───────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[13] Regole Lua${RESET}"
echo -e "  ${DIM}src/helpers.lua${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-lua')" 2>/dev/null; then
  check_rule "os-execute-lua"   "helpers.lua"
  check_rule "dynamic-load-lua" "helpers.lua"
else
  warn "@ast-grep/lang-lua non installato — regole Lua saltate"
fi

# ── 16. Elixir ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[14] Regole Elixir${RESET}"
echo -e "  ${DIM}src/helper.ex${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-elixir')" 2>/dev/null; then
  check_rule "os-cmd-elixir"    "helper.ex"
  check_rule "code-eval-elixir" "helper.ex"
else
  warn "@ast-grep/lang-elixir non installato — regole Elixir saltate"
fi

# ── 17. Dart ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[15] Regole Dart${RESET}"
echo -e "  ${DIM}src/lib.dart${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-dart')" 2>/dev/null; then
  check_rule "process-run-dart"   "lib.dart"
  check_rule "sql-injection-dart" "lib.dart"
else
  warn "@ast-grep/lang-dart non installato — regole Dart saltate"
fi

# ── 18. Kotlin ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[16] Regole Kotlin${RESET}"
echo -e "  ${DIM}src/App.kt${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-kotlin')" 2>/dev/null; then
  check_rule "command-injection-kotlin" "App.kt"
  check_rule "sql-injection-kotlin"     "App.kt"
else
  warn "@ast-grep/lang-kotlin non installato — regole Kotlin saltate"
fi

# ── 19. Swift ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[17] Regole Swift${RESET}"
echo -e "  ${DIM}src/app.swift${RESET}\n"

if node -e "require.resolve('@ast-grep/lang-swift')" 2>/dev/null; then
  check_rule "process-launch-swift" "app.swift"
  check_rule "sql-injection-swift"  "app.swift"
else
  warn "@ast-grep/lang-swift non installato — regole Swift saltate"
fi

# ── 20. Riepilogo DB ──────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[18] Riepilogo pattern_matches per regola${RESET}\n"
sqlite3 "$DB" \
  "SELECT pattern_id, COUNT(*) as matches, COUNT(DISTINCT file_path) as files
   FROM pattern_matches
   GROUP BY pattern_id
   ORDER BY matches DESC;" 2>/dev/null \
  | while IFS='|' read -r pid cnt fct; do
      printf "     %-42s  %s match  in %s file\n" "$pid" "$cnt" "$fct"
    done || warn "Nessun match nel DB"

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
