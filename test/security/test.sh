#!/usr/bin/env bash
# test-security.sh — testa il modulo security di KiroGraph:
#
#   PARTE A — Ecosistemi (modulo sec):
#     A1. Nessun warn "Transitive resolution incomplete" (issue #26)
#     A2. Parsing manifesti: tutti i 13 ecosistemi producono righe in sec_dependencies
#     A3. Versioni risolte: lock file letti correttamente
#     A4. Scope: prod vs dev correttamente distinto
#     A5. Transitive status: Go marcato 'incomplete', npm + cargo 'complete'
#
#   PARTE B — Comandi CLI:
#     security, vulns, reachability, staleness, licenses, vex, sbom,
#     attack-surface, supply-chain, dep-confusion, remediation,
#     security export/secrets/flows/ci-report,
#     vuln suppress/unsuppress/suppressions, pattern --list/--coverage
#
# Mock: scripts/security/mock/ — progetto multi-ecosistema con sorgente TypeScript.
# Il mock è statico; il test rimuove solo .kirograph/ a ogni esecuzione.
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
FAILURES=0

ok()   { echo -e "  ${GREEN}✓${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "  ${CYAN}›${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
sep()  { echo -e "\n${DIM}──────────────────────────────────────────────────────${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="$SCRIPT_DIR/mock"
KG="node $ROOT/dist/bin/kirograph.js"
DB="$TEST_DIR/.kirograph/kirograph.db"

echo -e "\n${BOLD}  KiroGraph Security — ecosistemi · CLI commands · pattern${RESET}"
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

# ── 2. Pulizia + config + Index ───────────────────────────────────────────────
sep
info "Pulizia .kirograph/ e .kiro/..."
rm -rf "$TEST_DIR/.kirograph" "$TEST_DIR/.kiro"
cd "$TEST_DIR"

mkdir -p .kirograph
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "enablePatterns": false,
  "enableSecurity": true,
  "enableArchitecture": true,
  "enableNavigation": true,
  "enableEmbeddings": false,
  "enableDocs": false,
  "enableData": false,
  "enableMemory": false,
  "securityAutoEnrich": false,
  "securityDatabases": []
}
EOF
ok "config.json (enableSecurity + enableArchitecture, securityAutoEnrich: false)"

sep
echo -e "  ${BOLD}[1] kirograph index${RESET}"
INDEX_OUT=$($KG index 2>&1)
echo "$INDEX_OUT" | grep -E "✓|scanning|Indexed|security|manifests|dependencies" | sed 's/^/     /' || true

[ -f "$DB" ] && ok "kirograph.db creato" || { fail "kirograph.db non trovato"; exit 1; }

# ── Helpers SQLite ────────────────────────────────────────────────────────────
db_dep_count()      { sqlite3 "$DB" "SELECT COUNT(*) FROM sec_dependencies WHERE ecosystem='$1';" 2>/dev/null || echo 0; }
db_pkg()            { sqlite3 "$DB" "SELECT COUNT(*) FROM sec_dependencies WHERE package_name='$1';" 2>/dev/null || echo 0; }
db_resolved()       { sqlite3 "$DB" "SELECT resolved_version FROM sec_dependencies WHERE package_name='$1' LIMIT 1;" 2>/dev/null || echo ''; }
db_scope()          { sqlite3 "$DB" "SELECT scope FROM sec_dependencies WHERE package_name='$1' LIMIT 1;" 2>/dev/null || echo ''; }
db_transitive()     { sqlite3 "$DB" "SELECT transitive_status FROM sec_dependencies WHERE package_name='$1' LIMIT 1;" 2>/dev/null || echo ''; }

check_pkg() {
  local pkg="$1" exp_version="$2" exp_scope="$3"
  local cnt resolved scope
  cnt=$(db_pkg "$pkg")
  if [ "$cnt" -eq 0 ]; then
    fail "$pkg — non trovato in sec_dependencies"; return
  fi
  resolved=$(db_resolved "$pkg"); scope=$(db_scope "$pkg")
  local details="${DIM}(v${resolved:-?}  scope:${scope:-?})${RESET}"
  if [ -n "$exp_version" ] && [ "$resolved" != "$exp_version" ]; then
    fail "$pkg — attesa version '$exp_version', trovata '$resolved'  $details"
  elif [ -n "$exp_scope" ] && [ "$scope" != "$exp_scope" ]; then
    fail "$pkg — atteso scope '$exp_scope', trovato '$scope'  $details"
  else
    ok "$pkg  $details"
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# PARTE A — Ecosistemi
# ══════════════════════════════════════════════════════════════════════════════

# ── A1. Nessun warn "Transitive resolution incomplete" ────────────────────────
sep
echo -e "  ${BOLD}[A1] Nessun warn 'Transitive resolution incomplete' (issue #26)${RESET}"
ALL_TRANS_WARNS=$(echo "$INDEX_OUT" | grep -c "\[kirograph:warn\].*\[sec:integrator\].*Transitive resolution incomplete" || true)
if [ "$ALL_TRANS_WARNS" -gt 0 ]; then
  fail "Trovati $ALL_TRANS_WARNS warn 'Transitive resolution incomplete'"
  echo "$INDEX_OUT" | grep "Transitive resolution incomplete" | sed 's/^/     /'
else
  ok "Nessun warn 'Transitive resolution incomplete'"
fi

SEC_WARNS=$(echo "$INDEX_OUT" | grep "\[kirograph:warn\].*\[sec:" | grep -v "auto-enabling\|Unknown vulnerability\|No version extraction" || true)
if [ -n "$SEC_WARNS" ]; then
  warn "[sec:*] warn inattesi: $(echo "$SEC_WARNS" | wc -l | tr -d ' ')"
  echo "$SEC_WARNS" | head -5 | sed 's/^/     /'
else
  ok "Nessun warn [sec:*] inatteso"
fi

# ── A2. npm ───────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A2] npm  (package.json + package-lock.json)${RESET}"
NPM_COUNT=$(db_dep_count "npm")
[ "$NPM_COUNT" -ge 3 ] && ok "npm: $NPM_COUNT dep trovati" || fail "npm: attesi >=3 dep, trovati $NPM_COUNT"
check_pkg "express" "4.18.2"  "production"
check_pkg "lodash"  "4.17.21" "production"
check_pkg "jest"    "29.7.0"  "development"
# body-parser is NOT declared in package.json — it only exists as a transitive
# dependency of express in package-lock.json. Regression check for issue #39:
# purely transitive packages (e.g. elliptic, qs in a real audit) must still
# become their own Dependency_Node, or they silently skip vulnerability scanning.
check_pkg "body-parser" "1.20.1" "production"
EXPRESS_TS=$(db_transitive "express")
[ "$EXPRESS_TS" = "complete" ] \
  && ok "express transitive_status='complete' (lock parser attivo)" \
  || { [ "$EXPRESS_TS" = "incomplete" ] && fail "express transitive_status='incomplete'" || warn "express transitive_status='${EXPRESS_TS:-null}'"; }
EDGE_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM edges WHERE kind='depends_on' AND source='dep:npm:express' AND target='dep:npm:body-parser';" 2>/dev/null || echo 0)
[ "$EDGE_COUNT" -ge 1 ] \
  && ok "edge depends_on: express → body-parser (transitivo npm)" \
  || fail "edge depends_on express→body-parser non trovato"

# ── A3. Go ────────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A3] Go  (go.mod + go.sum)${RESET}"
GO_COUNT=$(db_dep_count "go")
[ "$GO_COUNT" -ge 2 ] && ok "go: $GO_COUNT dep trovati" || fail "go: attesi >=2 dep, trovati $GO_COUNT"
check_pkg "github.com/google/uuid" "v1.4.0" "production"
check_pkg "pgregory.net/rapid"     "v1.1.0" "production"
UUID_TS=$(db_transitive "github.com/google/uuid")
[ "$UUID_TS" = "incomplete" ] \
  && ok "go transitive_status='incomplete' (go.sum senza albero — comportamento corretto)" \
  || fail "go transitive_status='${UUID_TS:-null}' — atteso 'incomplete'"

# ── A4. Cargo ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A4] Cargo  (Cargo.toml + Cargo.lock)${RESET}"
CARGO_COUNT=$(db_dep_count "cargo")
[ "$CARGO_COUNT" -ge 2 ] && ok "cargo: $CARGO_COUNT dep trovati" || fail "cargo: attesi >=2 dep, trovati $CARGO_COUNT"
check_pkg "serde"   "1.0.193" "production"
check_pkg "reqwest" "0.11.22" "production"
check_pkg "tokio"   "1.35.1"  "development"
SERDE_TS=$(db_transitive "serde")
[ "$SERDE_TS" = "complete" ] \
  && ok "serde transitive_status='complete' (Cargo.lock parser attivo)" \
  || { [ "$SERDE_TS" = "incomplete" ] && fail "serde transitive_status='incomplete'" || warn "serde transitive_status='${SERDE_TS:-null}'"; }

# ── A5. pip + pyproject ───────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A5] pip + pyproject  (requirements.txt + pyproject.toml)${RESET}"
PYTHON_COUNT=$(db_dep_count "python")
[ "$PYTHON_COUNT" -ge 2 ] && ok "python: $PYTHON_COUNT dep trovati" || fail "python: attesi >=2 dep, trovati $PYTHON_COUNT"
[ "$(db_pkg 'fastapi')" -ge 1 ] && ok "fastapi  ${DIM}(ecosystem:python)${RESET}" || fail "fastapi non trovato"
[ "$(db_pkg 'httpx')"   -ge 1 ] && ok "httpx  ${DIM}(ecosystem:python)${RESET}"   || fail "httpx non trovato"

# ── A6. Maven ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A6] Maven  (pom.xml)${RESET}"
MAVEN_COUNT=$(db_dep_count "maven")
[ "$MAVEN_COUNT" -ge 2 ] && ok "maven: $MAVEN_COUNT dep trovati" || fail "maven: attesi >=2 dep, trovati $MAVEN_COUNT"
check_pkg "org.springframework:spring-core"                  "6.1.1"   "production"
check_pkg "junit:junit"                                      "4.13.2"  "development"
check_pkg "com.fasterxml.jackson.core:jackson-databind"      "2.16.0"  "production"

# ── A7. NuGet ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A7] NuGet  (Mock.csproj + packages.lock.json)${RESET}"
NUGET_COUNT=$(db_dep_count "nuget")
[ "$NUGET_COUNT" -ge 2 ] && ok "nuget: $NUGET_COUNT dep trovati" || fail "nuget: attesi >=2 dep, trovati $NUGET_COUNT"
check_pkg "Newtonsoft.Json" "13.0.3" "production"
check_pkg "Serilog"         "3.1.1"  "production"
check_pkg "xunit"           "2.6.2"  "development"

# ── A8. Gradle ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A8] Gradle  (build.gradle + gradle.lockfile)${RESET}"
GRADLE_COUNT=$(db_dep_count "gradle")
[ "$GRADLE_COUNT" -ge 2 ] && ok "gradle: $GRADLE_COUNT dep trovati" || fail "gradle: attesi >=2 dep, trovati $GRADLE_COUNT"
check_pkg "com.google.guava:guava"          "32.1.3-jre" "production"
check_pkg "org.junit.jupiter:junit-jupiter" "5.10.1"     "development"

# ── A9. RubyGems ──────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A9] RubyGems  (Gemfile + Gemfile.lock)${RESET}"
RUBYGEMS_COUNT=$(db_dep_count "rubygems")
[ "$RUBYGEMS_COUNT" -ge 2 ] && ok "rubygems: $RUBYGEMS_COUNT dep trovati" || fail "rubygems: attesi >=2 dep, trovati $RUBYGEMS_COUNT"
check_pkg "rails"       "7.1.2" "production"
check_pkg "pg"          "1.5.4" "production"
check_pkg "rspec-rails" "6.1.0" "development"

# ── A10. Composer ─────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A10] Composer  (composer.json + composer.lock)${RESET}"
COMPOSER_COUNT=$(db_dep_count "composer")
[ "$COMPOSER_COUNT" -ge 2 ] && ok "composer: $COMPOSER_COUNT dep trovati" || fail "composer: attesi >=2 dep, trovati $COMPOSER_COUNT"
check_pkg "symfony/http-foundation" "6.4.0"  "production"
check_pkg "monolog/monolog"         "3.4.0"  "production"
check_pkg "phpunit/phpunit"         "10.5.0" "development"

# ── A11. Swift ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A11] Swift  (Package.swift + Package.resolved)${RESET}"
SWIFT_COUNT=$(db_dep_count "swift")
[ "$SWIFT_COUNT" -ge 1 ] && ok "swift: $SWIFT_COUNT dep trovati" || fail "swift: attesi >=1 dep, trovati $SWIFT_COUNT"
check_pkg "swift-argument-parser" "1.3.0"  "production"
check_pkg "vapor"                 "4.83.2" "production"

# ── A12. Pub (Dart) ───────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A12] Pub (Dart)  (pubspec.yaml + pubspec.lock)${RESET}"
PUB_COUNT=$(db_dep_count "pub")
[ "$PUB_COUNT" -ge 2 ] && ok "pub: $PUB_COUNT dep trovati" || fail "pub: attesi >=2 dep, trovati $PUB_COUNT"
check_pkg "http"     "1.1.2" "production"
check_pkg "provider" "6.1.1" "production"
check_pkg "mockito"  "5.4.4" "development"

# ── A13. Hex (Elixir) ─────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A13] Hex (Elixir)  (mix.exs + mix.lock)${RESET}"
HEX_COUNT=$(db_dep_count "hex")
[ "$HEX_COUNT" -ge 2 ] && ok "hex: $HEX_COUNT dep trovati" || fail "hex: attesi >=2 dep, trovati $HEX_COUNT"
check_pkg "phoenix"    "1.7.10" "production"
check_pkg "ecto"       "3.11.1" "production"
check_pkg "ex_machina" "2.7.0"  "development"

# ── A14. Riepilogo ────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[A14] Riepilogo sec_dependencies per ecosistema${RESET}"
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

# ══════════════════════════════════════════════════════════════════════════════
# PARTE B — Comandi CLI
# ══════════════════════════════════════════════════════════════════════════════

# ── B1. security ──────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B1] security${RESET}"
OUT=$($KG security 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "security: exit 0"        || fail "security: exit $EXIT"
[ -n "$OUT"   ] && ok "security: output non vuoto" || fail "security: output vuoto"

# ── B2. vulns ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B2] vulns${RESET}"
OUT=$($KG vulns 2>&1);             EXIT=$?; [ $EXIT -eq 0 ] && ok "vulns: exit 0"             || fail "vulns: exit $EXIT"
OUT=$($KG vulns --sort risk 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "vulns --sort risk: exit 0" || fail "vulns --sort risk: exit $EXIT"
OUT=$($KG vulns --severity high 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "vulns --severity high: exit 0" || fail "vulns --severity high: exit $EXIT"

# ── B3. reachability ──────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B3] reachability${RESET}"
OUT=$($KG reachability express 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "reachability express: exit 0" || fail "reachability express: exit $EXIT"
[ -n "$OUT"   ] && ok "reachability: output non vuoto" || warn "reachability: output vuoto"

# ── B4. staleness ─────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B4] staleness${RESET}"
OUT=$($KG staleness 2>&1);               EXIT=$?; [ $EXIT -eq 0 ] && ok "staleness: exit 0"             || fail "staleness: exit $EXIT"
OUT=$($KG staleness --threshold 0.1 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "staleness --threshold: exit 0" || fail "staleness --threshold: exit $EXIT"
OUT=$($KG staleness --format json 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "staleness --format json: exit 0" || fail "staleness --format json: exit $EXIT"

# ── B5. licenses ──────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B5] licenses${RESET}"
OUT=$($KG licenses 2>&1);             EXIT=$?; [ $EXIT -eq 0 ] && ok "licenses: exit 0"             || fail "licenses: exit $EXIT"
[ -n "$OUT" ] && ok "licenses: output non vuoto" || warn "licenses: output vuoto"
OUT=$($KG licenses --format json 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "licenses --format json: exit 0" || fail "licenses --format json: exit $EXIT"

# ── B6. vex ───────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B6] vex${RESET}"
OUT=$($KG vex 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "vex: exit 0" || fail "vex: exit $EXIT"
[ -n "$OUT"   ] && ok "vex: output non vuoto" || fail "vex: output vuoto"
echo "$OUT" | grep -qi "cyclonedx\|vex\|bom\|component" && ok "vex: output CycloneDX VEX" || warn "vex: formato non riconosciuto"
VEX_FILE="$TEST_DIR/vex-out.json"
$KG vex --output "$VEX_FILE" > /dev/null 2>&1 || true
[ -f "$VEX_FILE" ] && ok "vex --output: file scritto" || fail "vex --output: file non creato"
rm -f "$VEX_FILE"

# ── B7. sbom ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B7] sbom${RESET}"
OUT=$($KG sbom 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "sbom: exit 0" || fail "sbom: exit $EXIT"
[ -n "$OUT"   ] && ok "sbom: output non vuoto" || fail "sbom: output vuoto"
echo "$OUT" | grep -qi "cyclonedx\|sbom\|bom\|component" && ok "sbom: output CycloneDX SBOM" || warn "sbom: formato non riconosciuto"
SBOM_FILE="$TEST_DIR/sbom-out.json"
$KG sbom --output "$SBOM_FILE" > /dev/null 2>&1 || true
[ -f "$SBOM_FILE" ] && ok "sbom --output: file scritto" || fail "sbom --output: file non creato"
rm -f "$SBOM_FILE"

# ── B8. attack-surface ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B8] attack-surface${RESET}"
OUT=$($KG attack-surface 2>&1);             EXIT=$?; [ $EXIT -eq 0 ] && ok "attack-surface: exit 0"             || fail "attack-surface: exit $EXIT"
OUT=$($KG attack-surface --format json 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "attack-surface --format json: exit 0" || fail "attack-surface --format json: exit $EXIT"

# ── B9. supply-chain ──────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B9] supply-chain${RESET}"
OUT=$($KG supply-chain 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "supply-chain: exit 0" || fail "supply-chain: exit $EXIT"

# ── B10. dep-confusion ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B10] dep-confusion${RESET}"
OUT=$($KG dep-confusion 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "dep-confusion: exit 0" || fail "dep-confusion: exit $EXIT"

# ── B11. remediation ──────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B11] remediation${RESET}"
OUT=$($KG remediation 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "remediation: exit 0" || fail "remediation: exit $EXIT"

# ── B12. security export ──────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B12] security export${RESET}"
EXPORT_FILE="$TEST_DIR/sec-report.html"
OUT=$($KG security export --output "$EXPORT_FILE" 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "security export: exit 0" || fail "security export: exit $EXIT"
[ -f "$EXPORT_FILE" ] && ok "security export: file HTML creato" || warn "security export: file HTML non creato"
rm -f "$EXPORT_FILE"

# ── B13. security secrets ─────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B13] security secrets${RESET}"
OUT=$($KG security secrets 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "security secrets: exit 0" || fail "security secrets: exit $EXIT"
[ -n "$OUT"   ] && ok "security secrets: output non vuoto" || warn "security secrets: output vuoto"

# ── B14. security flows ───────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B14] security flows${RESET}"
OUT=$($KG security flows 2>&1);           EXIT=$?; [ $EXIT -eq 0 ] && ok "security flows: exit 0"          || fail "security flows: exit $EXIT"
OUT=$($KG security flows --type all 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "security flows --type all: exit 0" || fail "security flows --type all: exit $EXIT"

# ── B15. security ci-report ───────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B15] security ci-report${RESET}"
OUT=$($KG security ci-report 2>&1);              EXIT=$?; [ $EXIT -eq 0 ] && ok "security ci-report: exit 0"             || fail "security ci-report: exit $EXIT"
OUT=$($KG security ci-report --format json 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "security ci-report --format json: exit 0" || fail "security ci-report --format json: exit $EXIT"
OUT=$($KG security ci-report --format sarif 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "security ci-report --format sarif: exit 0" || fail "security ci-report --format sarif: exit $EXIT"

# ── B16. vuln suppress / unsuppress / suppressions ───────────────────────────
sep
echo -e "  ${BOLD}[B16] vuln suppress / unsuppress / suppressions${RESET}"
OUT=$($KG vuln suppress CVE-TEST-9999 --reason "test suppression" 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "vuln suppress CVE-TEST-9999: exit 0" || fail "vuln suppress: exit $EXIT"
echo "$OUT" | grep -q "CVE-TEST-9999" && ok "vuln suppress: CVE-TEST-9999 nell'output" || warn "vuln suppress: CVE-TEST-9999 non nell'output"

OUT=$($KG vuln suppressions 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "vuln suppressions: exit 0" || fail "vuln suppressions: exit $EXIT"
echo "$OUT" | grep -q "CVE-TEST-9999" && ok "vuln suppressions: CVE-TEST-9999 nella lista" || fail "vuln suppressions: CVE-TEST-9999 non trovato"

OUT=$($KG vuln unsuppress CVE-TEST-9999 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "vuln unsuppress CVE-TEST-9999: exit 0" || fail "vuln unsuppress: exit $EXIT"

OUT=$($KG vuln suppressions 2>&1); EXIT=$?
[ $EXIT -eq 0 ] && ok "vuln suppressions dopo remove: exit 0" || fail "vuln suppressions dopo remove: exit $EXIT"
echo "$OUT" | grep -q "CVE-TEST-9999" \
  && fail "vuln suppressions: CVE-TEST-9999 ancora presente dopo unsuppress" \
  || ok "vuln suppressions: CVE-TEST-9999 rimosso correttamente"

# ── B17. pattern ──────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[B17] pattern${RESET}"
OUT=$($KG pattern --list 2>&1);     EXIT=$?; [ $EXIT -eq 0 ] && ok "pattern --list: exit 0"     || fail "pattern --list: exit $EXIT"
[ -n "$OUT" ] && ok "pattern --list: output non vuoto" || fail "pattern --list: output vuoto"
OUT=$($KG pattern --coverage 2>&1); EXIT=$?; [ $EXIT -eq 0 ] && ok "pattern --coverage: exit 0" || fail "pattern --coverage: exit $EXIT"
echo "$OUT" | grep -qi "OWASP\|A0[0-9]\|coverage\|Top 10" \
  && ok "pattern --coverage: output OWASP coverage report" \
  || warn "pattern --coverage: formato OWASP non riconosciuto"

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
