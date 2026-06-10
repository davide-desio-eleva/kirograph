#!/usr/bin/env bash
# test-sec.sh — testa il modulo security di KiroGraph su un progetto multi-ecosistema.
#
# Verifica:
#   A. Issue #26 fix: nessun "[kirograph:warn] [sec:integrator] Transitive resolution
#      incomplete" per Go (abbassato a logDebug)
#   B. Parsing manifesti: tutti i 13 ecosistemi producono righe in sec_dependencies
#   C. Versioni risolte: lock file letti correttamente per ogni ecosistema
#   D. Scope: prod vs dev correttamente distinto
#   E. Transitive status: Go + pypi marcati 'incomplete', npm + cargo 'complete'
#
# NOTA: gli ecosistemi senza lock file parser nell'integrator (maven, nuget, gradle,
#       rubygems, composer, swift, pub, hex) producono ancora logWarn per package —
#       comportamento atteso documentato nella sezione [3].
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

echo -e "\n${BOLD}  KiroGraph Security — test modulo sec (tutti gli ecosistemi)${RESET}"
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
  "enablePatterns": false,
  "enableSecurity": true,
  "enableArchitecture": true,
  "enableEmbeddings": false,
  "enableDocs": false,
  "enableData": false,
  "enableMemory": false,
  "securityAutoEnrich": false,
  "securityDatabases": []
}
EOF
ok "config.json (enableSecurity: true, securityAutoEnrich: false — no chiamate OSV)"

# ── 4. Index ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[2] kirograph index${RESET}"
INDEX_OUT=$($KG index 2>&1)
echo "$INDEX_OUT" | grep -E "✓|scanning|Indexed|security|manifests|dependencies" | sed 's/^/     /' || true

[ -f "$DB" ] && ok "kirograph.db creato" || { fail "kirograph.db non trovato"; exit 1; }

# ── 5. Nessun warn "Transitive resolution incomplete" (issue #26 + fix esteso) ─
sep
echo -e "  ${BOLD}[3] Nessun warn 'Transitive resolution incomplete' per nessun ecosistema${RESET}"
echo -e "  ${DIM}Tutti i casi (lock file assente, go.sum/requirements.txt senza albero)${RESET}"
echo -e "  ${DIM}sono abbassati a logDebug — un messaggio per ecosistema, non per pacchetto.${RESET}\n"

ALL_TRANS_WARNS=$(echo "$INDEX_OUT" | grep -c "\[kirograph:warn\].*\[sec:integrator\].*Transitive resolution incomplete" || true)
if [ "$ALL_TRANS_WARNS" -gt 0 ]; then
  fail "Trovati $ALL_TRANS_WARNS warn 'Transitive resolution incomplete'"
  echo "$INDEX_OUT" | grep "Transitive resolution incomplete" | sed 's/^/     /'
else
  ok "Nessun warn 'Transitive resolution incomplete' (tutti gli ecosistemi)"
fi

# Controlla anche che non ci siano [kirograph:warn] inaspettati dal modulo sec
SEC_WARNS=$(echo "$INDEX_OUT" | grep "\[kirograph:warn\].*\[sec:" | grep -v "auto-enabling\|Unknown vulnerability\|No version extraction" || true)
if [ -n "$SEC_WARNS" ]; then
  SEC_WARN_COUNT=$(echo "$SEC_WARNS" | wc -l | tr -d ' ')
  warn "[sec:*] warn inattesi: $SEC_WARN_COUNT"
  echo "$SEC_WARNS" | head -5 | sed 's/^/     /'
else
  ok "Nessun warn [sec:*] inatteso"
fi

# ── Helper ────────────────────────────────────────────────────────────────────
db_dep_count() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM sec_dependencies WHERE ecosystem='$1';" 2>/dev/null || echo 0
}

db_pkg() {
  sqlite3 "$DB" "SELECT COUNT(*) FROM sec_dependencies WHERE package_name='$1';" 2>/dev/null || echo 0
}

db_resolved() {
  sqlite3 "$DB" "SELECT resolved_version FROM sec_dependencies WHERE package_name='$1' LIMIT 1;" 2>/dev/null || echo ''
}

db_scope() {
  sqlite3 "$DB" "SELECT scope FROM sec_dependencies WHERE package_name='$1' LIMIT 1;" 2>/dev/null || echo ''
}

db_transitive_status() {
  sqlite3 "$DB" "SELECT transitive_status FROM sec_dependencies WHERE package_name='$1' LIMIT 1;" 2>/dev/null || echo ''
}

check_pkg() {
  local pkg="$1" exp_version="$2" exp_scope="$3"
  local cnt resolved scope
  cnt=$(db_pkg "$pkg")
  if [ "$cnt" -eq 0 ]; then
    fail "$pkg — non trovato in sec_dependencies"
    return
  fi
  resolved=$(db_resolved "$pkg")
  scope=$(db_scope "$pkg")
  local details="${DIM}(v${resolved:-?}  scope:${scope:-?})${RESET}"
  if [ -n "$exp_version" ] && [ "$resolved" != "$exp_version" ]; then
    fail "$pkg — attesa version '$exp_version', trovata '$resolved'  $details"
  elif [ -n "$exp_scope" ] && [ "$scope" != "$exp_scope" ]; then
    fail "$pkg — atteso scope '$exp_scope', trovato '$scope'  $details"
  else
    ok "$pkg  $details"
  fi
}

# ── 6. npm ────────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[4] npm  (package.json + package-lock.json)${RESET}\n"

NPM_COUNT=$(db_dep_count "npm")
[ "$NPM_COUNT" -ge 3 ] && ok "npm: $NPM_COUNT dep trovati" || fail "npm: attesi >=3 dep, trovati $NPM_COUNT"

check_pkg "express"   "4.18.2"  "production"
check_pkg "lodash"    "4.17.21" "production"
check_pkg "jest"      "29.7.0"  "development"

# Transitive: npm ha il lock parser → deve essere complete
EXPRESS_TS=$(db_transitive_status "express")
if [ "$EXPRESS_TS" = "complete" ]; then
  ok "express transitive_status='complete' (lock parser attivo)"
elif [ "$EXPRESS_TS" = "incomplete" ]; then
  fail "express transitive_status='incomplete' — lock parser non ha funzionato"
else
  warn "express transitive_status='${EXPRESS_TS:-null}' — valore inatteso"
fi

# Verifica edge depends_on (express → body-parser)
EDGE_COUNT=$(sqlite3 "$DB" \
  "SELECT COUNT(*) FROM edges
   WHERE kind='depends_on'
     AND source_id=(SELECT id FROM nodes WHERE label='express')
     AND target_id=(SELECT id FROM nodes WHERE label='body-parser');" 2>/dev/null || echo 0)
[ "$EDGE_COUNT" -ge 1 ] \
  && ok "edge depends_on: express → body-parser (transitivo npm)" \
  || warn "edge depends_on express→body-parser non trovato (potrebbe non essere indicizzato)"

# ── 7. Go ─────────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[5] Go  (go.mod + go.sum)${RESET}\n"

GO_COUNT=$(db_dep_count "go")
[ "$GO_COUNT" -ge 2 ] && ok "go: $GO_COUNT dep trovati" || fail "go: attesi >=2 dep, trovati $GO_COUNT"

check_pkg "github.com/google/uuid" "v1.4.0" "production"
check_pkg "pgregory.net/rapid"     "v1.1.0" "production"

# Go: transitive_status deve essere 'incomplete' (go.sum non ha albero dep)
UUID_TS=$(db_transitive_status "github.com/google/uuid")
if [ "$UUID_TS" = "incomplete" ]; then
  ok "go transitive_status='incomplete' (go.sum non ha albero — comportamento corretto)"
else
  fail "go transitive_status='${UUID_TS:-null}' — atteso 'incomplete'"
fi

# ── 8. Cargo ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[6] Cargo  (Cargo.toml + Cargo.lock)${RESET}\n"

CARGO_COUNT=$(db_dep_count "cargo")
[ "$CARGO_COUNT" -ge 2 ] && ok "cargo: $CARGO_COUNT dep trovati" || fail "cargo: attesi >=2 dep, trovati $CARGO_COUNT"

check_pkg "serde"   "1.0.193" "production"
check_pkg "reqwest" "0.11.22" "production"
check_pkg "tokio"   "1.35.1"  "development"

SERDE_TS=$(db_transitive_status "serde")
if [ "$SERDE_TS" = "complete" ]; then
  ok "serde transitive_status='complete' (Cargo.lock parser attivo)"
elif [ "$SERDE_TS" = "incomplete" ]; then
  fail "serde transitive_status='incomplete' — Cargo.lock parser non ha funzionato"
else
  warn "serde transitive_status='${SERDE_TS:-null}'"
fi

# ── 9. pip (requirements.txt) + pyproject (pyproject.toml) ───────────────────
sep
echo -e "  ${BOLD}[7] pip + pyproject  (requirements.txt + pyproject.toml + poetry.lock)${RESET}"
echo -e "  ${DIM}Comportamento noto: requirements.txt NON è nei manifestFiles dell'arch Python parser →${RESET}"
echo -e "  ${DIM}i suoi dep non vengono indicizzati. pyproject.toml cade nel fallback Python →${RESET}"
echo -e "  ${DIM}ecosystem='python', versioni null (poetry.lock non viene letto in fallback mode).${RESET}\n"

PYTHON_COUNT=$(db_dep_count "python")
[ "$PYTHON_COUNT" -ge 2 ] && ok "python: $PYTHON_COUNT dep trovati (da pyproject.toml via fallback)" \
  || fail "python: attesi >=2 dep (fastapi, httpx), trovati $PYTHON_COUNT"

# pyproject deps: ecosystem='python' (fallback), resolved_version=null (poetry.lock non letto)
CNT_FASTAPI=$(db_pkg "fastapi")
CNT_HTTPX=$(db_pkg "httpx")
[ "$CNT_FASTAPI" -ge 1 ] && ok "fastapi  ${DIM}(ecosystem:python, versione non risolta — comportamento atteso)${RESET}" \
  || fail "fastapi non trovato in sec_dependencies"
[ "$CNT_HTTPX" -ge 1 ] && ok "httpx  ${DIM}(ecosystem:python, versione non risolta — comportamento atteso)${RESET}" \
  || fail "httpx non trovato in sec_dependencies"

# ── 11. Maven ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[9] Maven  (pom.xml)${RESET}\n"

MAVEN_COUNT=$(db_dep_count "maven")
[ "$MAVEN_COUNT" -ge 2 ] && ok "maven: $MAVEN_COUNT dep trovati" || fail "maven: attesi >=2 dep, trovati $MAVEN_COUNT"

check_pkg "org.springframework:spring-core" "6.1.1" "production"
check_pkg "junit:junit"                     "4.13.2" "development"
check_pkg "com.fasterxml.jackson.core:jackson-databind" "2.16.0" "production"

# ── 12. NuGet ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[10] NuGet  (Mock.csproj + packages.lock.json)${RESET}\n"

NUGET_COUNT=$(db_dep_count "nuget")
[ "$NUGET_COUNT" -ge 2 ] && ok "nuget: $NUGET_COUNT dep trovati" || fail "nuget: attesi >=2 dep, trovati $NUGET_COUNT"

check_pkg "Newtonsoft.Json" "13.0.3" "production"
check_pkg "Serilog"         "3.1.1"  "production"
check_pkg "xunit"           "2.6.2"  "development"

# ── 13. Gradle ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[11] Gradle  (build.gradle + gradle.lockfile)${RESET}\n"

GRADLE_COUNT=$(db_dep_count "gradle")
[ "$GRADLE_COUNT" -ge 2 ] && ok "gradle: $GRADLE_COUNT dep trovati" || fail "gradle: attesi >=2 dep, trovati $GRADLE_COUNT"

check_pkg "com.google.guava:guava"          "32.1.3-jre" "production"
check_pkg "org.junit.jupiter:junit-jupiter" "5.10.1"     "development"

# ── 14. RubyGems ──────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[12] RubyGems  (Gemfile + Gemfile.lock)${RESET}\n"

RUBYGEMS_COUNT=$(db_dep_count "rubygems")
[ "$RUBYGEMS_COUNT" -ge 2 ] && ok "rubygems: $RUBYGEMS_COUNT dep trovati" || fail "rubygems: attesi >=2 dep, trovati $RUBYGEMS_COUNT"

check_pkg "rails"       "7.1.2" "production"
check_pkg "pg"          "1.5.4" "production"
check_pkg "rspec-rails" "6.1.0" "development"

# ── 15. Composer ──────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[13] Composer  (composer.json + composer.lock)${RESET}\n"

COMPOSER_COUNT=$(db_dep_count "composer")
[ "$COMPOSER_COUNT" -ge 2 ] && ok "composer: $COMPOSER_COUNT dep trovati" || fail "composer: attesi >=2 dep, trovati $COMPOSER_COUNT"

check_pkg "symfony/http-foundation" "6.4.0"  "production"
check_pkg "monolog/monolog"         "3.4.0"  "production"
check_pkg "phpunit/phpunit"         "10.5.0" "development"

# ── 16. Swift ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[14] Swift  (Package.swift + Package.resolved)${RESET}\n"

SWIFT_COUNT=$(db_dep_count "swift")
[ "$SWIFT_COUNT" -ge 1 ] && ok "swift: $SWIFT_COUNT dep trovati" || fail "swift: attesi >=1 dep, trovati $SWIFT_COUNT"

check_pkg "swift-argument-parser" "1.3.0" "production"
check_pkg "vapor"                 "4.83.2" "production"

# ── 17. Pub (Dart) ────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[15] Pub (Dart)  (pubspec.yaml + pubspec.lock)${RESET}\n"

PUB_COUNT=$(db_dep_count "pub")
[ "$PUB_COUNT" -ge 2 ] && ok "pub: $PUB_COUNT dep trovati" || fail "pub: attesi >=2 dep, trovati $PUB_COUNT"

check_pkg "http"     "1.1.2" "production"
check_pkg "provider" "6.1.1" "production"
check_pkg "mockito"  "5.4.4" "development"

# ── 18. Hex (Elixir) ──────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[16] Hex (Elixir)  (mix.exs + mix.lock)${RESET}\n"

HEX_COUNT=$(db_dep_count "hex")
[ "$HEX_COUNT" -ge 2 ] && ok "hex: $HEX_COUNT dep trovati" || fail "hex: attesi >=2 dep, trovati $HEX_COUNT"

check_pkg "phoenix"    "1.7.10" "production"
check_pkg "ecto"       "3.11.1" "production"
check_pkg "ex_machina" "2.7.0"  "development"

# ── 19. Riepilogo totale ──────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[17] Riepilogo sec_dependencies per ecosistema${RESET}\n"

TOTAL_DEPS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sec_dependencies;" 2>/dev/null || echo 0)
ok "Totale dep: $TOTAL_DEPS"
echo ""

sqlite3 "$DB" \
  "SELECT ecosystem, COUNT(*) as n,
          SUM(CASE WHEN scope='production' THEN 1 ELSE 0 END) as prod,
          SUM(CASE WHEN scope='development' THEN 1 ELSE 0 END) as dev,
          SUM(CASE WHEN resolved_version IS NOT NULL THEN 1 ELSE 0 END) as resolved,
          SUM(CASE WHEN transitive_status='incomplete' THEN 1 ELSE 0 END) as incomplete
   FROM sec_dependencies
   GROUP BY ecosystem
   ORDER BY ecosystem;" 2>/dev/null \
  | while IFS='|' read -r eco n prod dev resolved incomplete; do
      printf "     %-12s  %2s dep  prod:%s  dev:%s  resolved:%s  incomplete:%s\n" \
             "$eco" "$n" "$prod" "$dev" "$resolved" "$incomplete"
    done || warn "Nessuna dipendenza nel DB"

# ── 20. Riepilogo dettagliato ─────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[18] Dettaglio sec_dependencies${RESET}\n"
sqlite3 "$DB" \
  "SELECT ecosystem, package_name, resolved_version, scope, transitive_status
   FROM sec_dependencies
   ORDER BY ecosystem, package_name;" 2>/dev/null \
  | while IFS='|' read -r eco pkg ver scope ts; do
      printf "     %-12s  %-45s  %-12s  %-12s  %s\n" "$eco" "$pkg" "${ver:-null}" "$scope" "$ts"
    done || warn "Nessuna dipendenza nel DB"

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
