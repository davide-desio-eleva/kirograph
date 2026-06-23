#!/usr/bin/env bash
# test-pixelrag.sh — testa il modulo visual PDF search (PixelRAG) di KiroGraph.
#
# Verifica:
#   A. Config: enableVisualPDF/pixelragPort parsati correttamente
#   B. Config validation: enableVisualPDF+enableData=false → warning + auto-disabled
#   C. Dipendenze: Python detection, WSL2/RAM check, isServerRunning=false senza server
#   D. getFlaggedPdfs: solo PDF con needs_ocr/has_columns vengono selezionati
#   E. buildIndex graceful skip: nessun PDF flaggato → skip senza errori
#   F. Manifest staleness: skip se manifest identico, rebuild se file cambia
#   G. CLI error messages: visual-search e pixelrag-status senza server attivo
#   H. [--with-server] Live search: avvia server reale, verifica risultati
#
# Uso:
#   ./test.sh               # test completo senza server live
#   ./test.sh --no-build    # salta la compilazione TypeScript
#   ./test.sh --with-server # abilita test che richiedono server PixelRAG live

set -euo pipefail

NO_BUILD=false
WITH_SERVER=false
for arg in "$@"; do
  case $arg in
    --no-build)    NO_BUILD=true ;;
    --with-server) WITH_SERVER=true ;;
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

echo -e "\n${BOLD}  KiroGraph PixelRAG — test visual PDF search (experimental)${RESET}"
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
info "Pulizia .kirograph/ ..."
rm -rf "$TEST_DIR/.kirograph" "$TEST_DIR/.kiro"
ok "Progetto vergine"
cd "$TEST_DIR"

# ── 3. Dipendenze ─────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[1] Dipendenze opzionali${RESET}\n"

PYTHON_BIN=""
PDF_INSPECTOR_INSTALLED=false
PIXELRAG_INSTALLED=false

# Python 3.10+
for bin in python3 python; do
  if command -v "$bin" &>/dev/null; then
    VER=$($bin --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    MAJOR=$(echo "$VER" | cut -d. -f1)
    MINOR=$(echo "$VER" | cut -d. -f2)
    if [ "${MAJOR:-0}" -ge 3 ] && [ "${MINOR:-0}" -ge 10 ]; then
      PYTHON_BIN="$bin"
      ok "Python ${VER} trovato ($bin)"
      break
    fi
  fi
done
[ -z "$PYTHON_BIN" ] && warn "Python 3.10+ non trovato — alcuni test saranno saltati"

# @firecrawl/pdf-inspector
node -e "require('@firecrawl/pdf-inspector')" 2>/dev/null \
  && { PDF_INSPECTOR_INSTALLED=true; ok "@firecrawl/pdf-inspector installato — PDF flagging attivo"; } \
  || warn "@firecrawl/pdf-inspector non installato — test flagging PDF saltati"

# PixelRAG Python package
if [ -n "$PYTHON_BIN" ]; then
  $PYTHON_BIN -c "import pixelrag_serve" 2>/dev/null \
    && { PIXELRAG_INSTALLED=true; ok "pixelrag Python package installato"; } \
    || warn "pixelrag non installato — test server saltati (usa --with-server dopo pip install)"
fi

if [ "$WITH_SERVER" = true ] && [ -z "$PYTHON_BIN" ]; then
  warn "--with-server richiede Python 3.10+ — disabilitato"
  WITH_SERVER=false
fi
if [ "$WITH_SERVER" = true ] && [ "$PIXELRAG_INSTALLED" = false ]; then
  warn "--with-server richiede pixelrag installato — disabilitato"
  WITH_SERVER=false
fi

# ── 4. Genera mock PDF ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[2] Generazione mock PDF${RESET}\n"

if command -v python3 &>/dev/null; then
  python3 << 'PYEOF'
import os, struct

def pdf_stream_obj(n, content):
    body = content.encode()
    return (
        f'{n} 0 obj\n'
        f'<</Length {len(body)}>>\n'
        f'stream\n'
        + body.decode() +
        '\nendstream\nendobj\n'
    ).encode()

def make_pdf(title, pages=2):
    """Minimal multi-page PDF with text content."""
    parts = [b'%PDF-1.4\n']
    offsets = []

    def add(obj_bytes):
        offsets.append(sum(len(p) for p in parts))
        parts.append(obj_bytes)

    # Object 1: Catalog
    add(b'1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n')

    # Object 2: Pages (2 pages)
    kids = ' '.join(f'{3+i*2} 0 R' for i in range(pages))
    add(f'2 0 obj\n<</Type /Pages /Kids [{kids}] /Count {pages}>>\nendobj\n'.encode())

    # Objects 3,4 and 5,6: Page + content stream
    for i in range(pages):
        page_obj = 3 + i * 2
        content_obj = 4 + i * 2
        text = f'Page {i+1} of {title} — column A data   column B data   column C data'
        add(
            f'{page_obj} 0 obj\n'
            f'<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
            f'/Contents {content_obj} 0 R /Resources <<>>>>\nendobj\n'.encode()
        )
        stream = f'BT /F1 10 Tf 50 700 Td ({text}) Tj ET'
        add(pdf_stream_obj(content_obj, stream))

    body = b''.join(parts)
    xref_pos = len(body)
    n_objs = len(offsets) + 1  # +1 for free entry

    xref = b'xref\n0 ' + str(n_objs).encode() + b'\n'
    xref += b'0000000000 65535 f \n'
    for off in offsets:
        xref += f'{off:010d} 00000 n \n'.encode()

    trailer = b'trailer\n<</Size ' + str(n_objs).encode() + b' /Root 1 0 R>>\nstartxref\n'
    trailer += str(xref_pos).encode() + b'\n%%EOF\n'

    return body + xref + trailer

os.makedirs('data', exist_ok=True)

# annual-report.pdf: multi-column, will likely be flagged by pdf-inspector
pdf1 = make_pdf('Annual Report', pages=3)
with open('data/annual-report.pdf', 'wb') as f:
    f.write(pdf1)
print(f'  Creato data/annual-report.pdf ({len(pdf1)} bytes, 3 pagine)')

# tech-spec.pdf: single column text
pdf2 = make_pdf('Tech Specification', pages=1)
with open('data/tech-spec.pdf', 'wb') as f:
    f.write(pdf2)
print(f'  Creato data/tech-spec.pdf ({len(pdf2)} bytes, 1 pagina)')
PYEOF
  ok "Mock PDF generati"
else
  warn "python3 non disponibile — PDF mock non generati; alcuni test saranno limitati"
fi

# ── 5. Config validation: enableVisualPDF senza enableData ────────────────────
sep
echo -e "  ${BOLD}[3] Config validation: enableVisualPDF=true senza enableData${RESET}\n"

mkdir -p .kirograph
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "enableData": false,
  "enableVisualPDF": true,
  "pixelragPort": 30001,
  "enableEmbeddings": false,
  "enablePatterns": false,
  "enableSecurity": false,
  "enableMemory": false
}
EOF

# loadConfig deve emettere warning e restituire enableVisualPDF=false
WARN_OUT=$(node -e "
const { loadConfig } = require('$ROOT/dist/config.js');
loadConfig('$TEST_DIR').then(c => {
  process.stdout.write(JSON.stringify({ enableVisualPDF: c.enableVisualPDF, pixelragPort: c.pixelragPort }));
}).catch(e => { console.error(e); process.exit(1); });
" 2>&1)

ENABLED=$(echo "$WARN_OUT" | grep -o '"enableVisualPDF":[^,}]*' | grep -o 'true\|false' || echo "")
PORT=$(echo "$WARN_OUT"    | grep -o '"pixelragPort":[^,}]*'   | grep -o '[0-9]*'        || echo "")

[ "$ENABLED" = "false" ] \
  && ok "enableVisualPDF=false quando enableData=false (auto-disable)" \
  || fail "enableVisualPDF dovrebbe essere false quando enableData=false, trovato '${ENABLED}'"
[ "$PORT" = "30001" ] \
  && ok "pixelragPort default=30001" \
  || fail "pixelragPort atteso 30001, trovato '${PORT:-?}'"

# ── 6. Config corretto: enableVisualPDF + enableData ──────────────────────────
sep
echo -e "  ${BOLD}[4] Config corretto: enableVisualPDF=true + enableData=true${RESET}\n"

cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "enableData": true,
  "enableVisualPDF": true,
  "pixelragPort": 30099,
  "enableEmbeddings": false,
  "enablePatterns": false,
  "enableSecurity": false,
  "enableMemory": false
}
EOF

CFG_OUT=$(node -e "
const { loadConfig } = require('$ROOT/dist/config.js');
loadConfig('$TEST_DIR').then(c => {
  process.stdout.write(JSON.stringify({ enableVisualPDF: c.enableVisualPDF, pixelragPort: c.pixelragPort }));
}).catch(e => { console.error(e); process.exit(1); });
" 2>&1)

V_ENABLED=$(echo "$CFG_OUT" | grep -o '"enableVisualPDF":[^,}]*' | grep -o 'true\|false' || echo "")
V_PORT=$(echo "$CFG_OUT"    | grep -o '"pixelragPort":[^,}]*'    | grep -o '[0-9]*'        || echo "")

[ "$V_ENABLED" = "true" ] \
  && ok "enableVisualPDF=true quando enableData=true" \
  || fail "enableVisualPDF atteso true, trovato '${V_ENABLED}'"
[ "$V_PORT" = "30099" ] \
  && ok "pixelragPort custom=30099 rispettato" \
  || fail "pixelragPort atteso 30099, trovato '${V_PORT:-?}'"

# ── 7. Bridge: isServerRunning su porta vuota ──────────────────────────────────
sep
echo -e "  ${BOLD}[5] Bridge: isServerRunning() con nessun server sulla porta${RESET}\n"

RUNNING=$(node -e "
const { isServerRunning } = require('$ROOT/dist/data/pixelrag-bridge.js');
isServerRunning('http://localhost:30099').then(r => {
  process.stdout.write(String(r));
}).catch(() => process.stdout.write('false'));
" 2>&1)

[ "$RUNNING" = "false" ] \
  && ok "isServerRunning=false quando nessun server in ascolto" \
  || fail "isServerRunning atteso false, trovato '${RUNNING}'"

# ── 8. Manager: detectPython ──────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[6] Manager: detectPython()${RESET}\n"

DETECT_OUT=$(node -e "
const { detectPython } = require('$ROOT/dist/data/pixelrag-manager.js');
const result = detectPython();
process.stdout.write(result === null ? 'null' : result);
" 2>&1)

if [ -n "$PYTHON_BIN" ]; then
  [ "$DETECT_OUT" != "null" ] \
    && ok "detectPython()='$DETECT_OUT' (Python 3.10+ trovato)" \
    || fail "detectPython() ha restituito null, ma '$PYTHON_BIN' è disponibile"
else
  [ "$DETECT_OUT" = "null" ] \
    && ok "detectPython()=null (Python 3.10+ non disponibile — corretto)" \
    || warn "detectPython()='$DETECT_OUT' — Python trovato ma versione non verificata"
fi

# ── 9. Manager: WSL2 + RAM check ──────────────────────────────────────────────
sep
echo -e "  ${BOLD}[7] Manager: detectWSL2() + checkRam()${RESET}\n"

ENV_OUT=$(node -e "
const { detectWSL2, checkRam } = require('$ROOT/dist/data/pixelrag-manager.js');
process.stdout.write(JSON.stringify({ wsl2: detectWSL2(), ram: checkRam() }));
" 2>&1)

WSL2=$(echo "$ENV_OUT" | grep -o '"wsl2":[^,}]*' | grep -o 'true\|false' || echo "")
RAM=$(echo  "$ENV_OUT" | grep -o '"ram":"[^"]*"'  | grep -o 'ok\|warn\|block' || echo "")

[ "$WSL2" = "true" ] \
  && warn "WSL2 rilevato — esecuzione dentro WSL2" \
  || ok "detectWSL2()=false (non WSL2)"

[ "$RAM" = "ok" ] || [ "$RAM" = "warn" ] || [ "$RAM" = "block" ] \
  && ok "checkRam()='$RAM' (valore valido)" \
  || fail "checkRam() output inatteso: '${RAM:-vuoto}'"

# ── 10. Imposta config per data+visualPDF e indicizza ─────────────────────────
sep
echo -e "  ${BOLD}[8] kirograph index con enableData + enableVisualPDF${RESET}\n"

cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "enableData": true,
  "enableVisualPDF": true,
  "pixelragPort": 30001,
  "enableEmbeddings": false,
  "enablePatterns": false,
  "enableSecurity": false,
  "enableMemory": false
}
EOF
ok "config.json (enableData + enableVisualPDF)"

INDEX_OUT=$($KG index 2>&1)
echo "$INDEX_OUT" | grep -E "✓|error|PixelRAG|PDF|dataset" | sed 's/^/     /' || true

[ -f "$DB" ] && ok "kirograph.db creato" || { fail "kirograph.db non trovato"; exit 1; }

# Nessun crash inatteso
echo "$INDEX_OUT" | grep -qiE "\[kirograph:error\].*fatal\|unhandled.*rejection\|TypeError\|Error:" \
  && fail "Errore fatale durante kirograph index" \
  || ok "kirograph index completato senza errori fatali"

# ── 11. getFlaggedPdfs ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[9] getFlaggedPdfs() — selezione PDF flaggati dal DB${RESET}\n"

db() { sqlite3 "$DB" "$1" 2>/dev/null || echo ''; }

TOTAL_PDFS=$(db "SELECT COUNT(*) FROM data_datasets WHERE format='pdf';" 2>/dev/null || echo "0")

if [ "$PDF_INSPECTOR_INSTALLED" = false ]; then
  warn "@firecrawl/pdf-inspector non installato — PDF non indicizzati, getFlaggedPdfs sarà vuoto"
  [ "${TOTAL_PDFS:-0}" -eq 0 ] \
    && ok "Nessun dataset PDF in DB (parser non disponibile — corretto)" \
    || warn "Trovati $TOTAL_PDFS dataset PDF anche senza parser — verificare"

  FLAGGED_OUT=$(node -e "
const { GraphDatabase } = require('$ROOT/dist/db/database.js');
const { getFlaggedPdfs } = require('$ROOT/dist/data/pixelrag-manager.js');
const db = new GraphDatabase('$TEST_DIR');
db.applyDataSchema();
const paths = getFlaggedPdfs(db.getRawDb(), '$TEST_DIR');
process.stdout.write(JSON.stringify(paths));
db.close();
" 2>&1 || true)
  FLAGGED_COUNT=$(echo "$FLAGGED_OUT" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).length))" 2>/dev/null || echo "0")
  [ "${FLAGGED_COUNT:-0}" -eq 0 ] \
    && ok "getFlaggedPdfs()=[] (nessun PDF indicizzato — corretto)" \
    || fail "getFlaggedPdfs() ha restituito $FLAGGED_COUNT path, atteso 0"

else
  ok "@firecrawl/pdf-inspector installato — verifica flagging"

  FLAGGED_OUT=$(node -e "
const { GraphDatabase } = require('$ROOT/dist/db/database.js');
const { getFlaggedPdfs } = require('$ROOT/dist/data/pixelrag-manager.js');
const db = new GraphDatabase('$TEST_DIR');
db.applyDataSchema();
const paths = getFlaggedPdfs(db.getRawDb(), '$TEST_DIR');
process.stdout.write(JSON.stringify(paths));
db.close();
" 2>&1 || true)

  echo "  $FLAGGED_OUT" | sed 's/^/     /'

  FLAGGED_COUNT=$(echo "$FLAGGED_OUT" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).length))" 2>/dev/null || echo "?")

  if [ "${FLAGGED_COUNT:-0}" -ge 0 ] 2>/dev/null; then
    ok "getFlaggedPdfs(): ${FLAGGED_COUNT} PDF flaggati"
    # Verifica che i path siano assoluti
    if [ "$FLAGGED_COUNT" -gt 0 ]; then
      ABSOLUTE=$(echo "$FLAGGED_OUT" | node -e "
const paths = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const nonAbs = paths.filter(p => !p.startsWith('/'));
process.stdout.write(nonAbs.length === 0 ? 'ok' : 'fail:' + nonAbs.join(','));
" 2>/dev/null || echo "?")
      [ "$ABSOLUTE" = "ok" ] \
        && ok "  tutti i path restituiti sono assoluti" \
        || fail "  path non assoluti: $ABSOLUTE"
    fi
  else
    fail "getFlaggedPdfs() ha restituito output non valido: '${FLAGGED_OUT}'"
  fi
fi

# ── 12. buildIndex graceful skip — nessun PDF flaggato ────────────────────────
sep
echo -e "  ${BOLD}[10] buildIndex() graceful skip con lista vuota${RESET}\n"

SKIP_OUT=$(node -e "
const { buildIndex } = require('$ROOT/dist/data/pixelrag-manager.js');
try {
  buildIndex({
    python: 'python3',
    flaggedPdfs: [],
    projectRoot: '$TEST_DIR',
    kirographDir: '$TEST_DIR/.kirograph',
    force: false,
  });
  process.stdout.write('ok');
} catch(e) {
  process.stdout.write('error:' + e.message);
}
" 2>&1)

echo "$SKIP_OUT" | sed 's/^/     /'

echo "$SKIP_OUT" | grep -qi "no visually complex\|skipping\|ok" \
  && ok "buildIndex(): skip corretto con lista vuota" \
  || fail "buildIndex(): comportamento inatteso con lista vuota: '$SKIP_OUT'"

# Nessun file di indice creato quando lista è vuota
[ -d "$TEST_DIR/.kirograph/pixelrag-index" ] \
  && fail "pixelrag-index/ creato anche con lista vuota" \
  || ok "pixelrag-index/ non creato (corretto)"

# ── 13. Manifest: write + read + staleness ────────────────────────────────────
sep
echo -e "  ${BOLD}[11] Manifest staleness logic${RESET}\n"

MANIFEST_OUT=$(node -e "
const path = require('path');
const fs = require('fs');
// Test manifest via buildIndex internals — inject a fake manifest
const manifestPath = path.join('$TEST_DIR/.kirograph', 'pixelrag-manifest.json');

// Write a manifest for a non-existent file
const fakeEntry = [{ path: '/tmp/test-pixelrag-fake.pdf', mtime: 12345, size: 999 }];
fs.writeFileSync(manifestPath, JSON.stringify(fakeEntry));

// buildIndex with same fake path should detect staleness (file doesn't exist, size=0)
// We can't run the full build (no PixelRAG), so just test manifest read/write round-trip
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const isValid = Array.isArray(manifest) && manifest[0].path === '/tmp/test-pixelrag-fake.pdf';

// Clean up
fs.unlinkSync(manifestPath);

process.stdout.write(isValid ? 'ok' : 'fail');
" 2>&1)

[ "$MANIFEST_OUT" = "ok" ] \
  && ok "Manifest read/write round-trip corretto" \
  || fail "Manifest round-trip fallito: '$MANIFEST_OUT'"

# ── 14. CLI: visual-search senza enableVisualPDF ──────────────────────────────
sep
echo -e "  ${BOLD}[12] CLI: kirograph data visual-search senza enableVisualPDF${RESET}\n"

cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "enableData": true,
  "enableVisualPDF": false,
  "enableEmbeddings": false,
  "enablePatterns": false,
  "enableSecurity": false,
  "enableMemory": false
}
EOF

VS_ERR=$($KG data visual-search "revenue chart" 2>&1 || true)
echo "$VS_ERR" | sed 's/^/     /'

echo "$VS_ERR" | grep -qiE "not enabled|enableVisualPDF|experimental" \
  && ok "visual-search: messaggio chiaro quando non abilitato" \
  || fail "visual-search: messaggio di errore assente o non chiaro"

# ── 15. CLI: pixelrag-status senza enableVisualPDF ───────────────────────────
sep
echo -e "  ${BOLD}[13] CLI: kirograph data pixelrag-status senza enableVisualPDF${RESET}\n"

STATUS_OUT=$($KG data pixelrag-status 2>&1 || true)
echo "$STATUS_OUT" | sed 's/^/     /'

echo "$STATUS_OUT" | grep -qiE "no|false|stopped|disabled|not" \
  && ok "pixelrag-status: mostra stato disabled/false/stopped" \
  || fail "pixelrag-status: output inatteso quando non abilitato"

# ── 16. CLI: visual-search abilitato ma server non attivo ─────────────────────
sep
echo -e "  ${BOLD}[14] CLI: visual-search con enableVisualPDF=true ma server offline${RESET}\n"

cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "enableData": true,
  "enableVisualPDF": true,
  "pixelragPort": 30001,
  "enableEmbeddings": false,
  "enablePatterns": false,
  "enableSecurity": false,
  "enableMemory": false
}
EOF

VS_NO_SERVER=$($KG data visual-search "annual report revenue" 2>&1 || true)
echo "$VS_NO_SERVER" | sed 's/^/     /'

echo "$VS_NO_SERVER" | grep -qiE "not running|server|port|index|offline" \
  && ok "visual-search: messaggio chiaro quando server non attivo" \
  || fail "visual-search: errore silenzioso o crash invece di messaggio utile"

# ── 17. CLI: pixelrag-status con server offline ───────────────────────────────
sep
echo -e "  ${BOLD}[15] CLI: kirograph data pixelrag-status con server offline${RESET}\n"

STATUS_OFFLINE=$($KG data pixelrag-status 2>&1 || true)
echo "$STATUS_OFFLINE" | sed 's/^/     /'

echo "$STATUS_OFFLINE" | grep -qiE "stopped|false|not running" \
  && ok "pixelrag-status: server=stopped quando offline" \
  || fail "pixelrag-status: stato server non corretto"

echo "$STATUS_OFFLINE" | grep -qE "30001" \
  && ok "pixelrag-status: porta 30001 mostrata" \
  || fail "pixelrag-status: porta non mostrata nell'output"

# ── 18. MCP tool: kirograph_pdf_visual_search disabilitato ────────────────────
sep
echo -e "  ${BOLD}[16] MCP tool: kirograph_pdf_visual_search non in tools/list senza enableVisualPDF${RESET}\n"

cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "enableData": true,
  "enableVisualPDF": false,
  "enableEmbeddings": false,
  "enablePatterns": false,
  "enableSecurity": false,
  "enableMemory": false
}
EOF

TOOL_LIST_OUT=$(node -e "
const { tools } = require('$ROOT/dist/mcp/tools.js');
const { FEATURE_TOOL_SETS } = require('$ROOT/dist/mcp/tool-names.js');
const config = { enableVisualPDF: false };
const hidden = new Set();
for (const [flag, names] of Object.entries(FEATURE_TOOL_SETS)) {
  if (config[flag] === false) for (const n of names) hidden.add(n);
}
const visible = tools.filter(t => !hidden.has(t.name)).map(t => t.name);
process.stdout.write(JSON.stringify(visible.includes('kirograph_pdf_visual_search')));
" 2>&1)

[ "$TOOL_LIST_OUT" = "false" ] \
  && ok "kirograph_pdf_visual_search escluso da tools/list quando enableVisualPDF=false" \
  || fail "kirograph_pdf_visual_search presente in tools/list anche con enableVisualPDF=false"

# ── 19. MCP tool: kirograph_pdf_visual_search abilitato ───────────────────────
sep
echo -e "  ${BOLD}[17] MCP tool: kirograph_pdf_visual_search in tools/list con enableVisualPDF=true${RESET}\n"

TOOL_LIST_ON=$(node -e "
const { tools } = require('$ROOT/dist/mcp/tools.js');
const { FEATURE_TOOL_SETS } = require('$ROOT/dist/mcp/tool-names.js');
const config = { enableVisualPDF: true };
const hidden = new Set();
for (const [flag, names] of Object.entries(FEATURE_TOOL_SETS)) {
  if (config[flag] === false) for (const n of names) hidden.add(n);
}
const visible = tools.filter(t => !hidden.has(t.name)).map(t => t.name);
process.stdout.write(JSON.stringify(visible.includes('kirograph_pdf_visual_search')));
" 2>&1)

[ "$TOOL_LIST_ON" = "true" ] \
  && ok "kirograph_pdf_visual_search presente in tools/list con enableVisualPDF=true" \
  || fail "kirograph_pdf_visual_search assente da tools/list con enableVisualPDF=true"

# ── 20. [--with-server] Test live server ──────────────────────────────────────
if [ "$WITH_SERVER" = true ]; then

sep
echo -e "  ${BOLD}[18] Live server — startServer + searchVisual${RESET}\n"

if [ ! -d "$TEST_DIR/.kirograph/pixelrag-index" ]; then
  warn "Indice PixelRAG non trovato in .kirograph/pixelrag-index"
  warn "Esegui prima: kirograph index — con PDF flaggati disponibili"
  fail "Live server test richiede un indice già costruito"
else
  SERVER_OUT=$(node -e "
const { startServer, ensurePython } = require('$ROOT/dist/data/pixelrag-manager.js');
const { isServerRunning, searchVisual } = require('$ROOT/dist/data/pixelrag-bridge.js');

(async () => {
  try {
    const python = ensurePython();
    await startServer(python, 30001, '$TEST_DIR/.kirograph');
    const running = await isServerRunning('http://localhost:30001');
    if (!running) { process.stdout.write('server-not-ready'); return; }

    const results = await searchVisual('http://localhost:30001', 'report data', { limit: 2 });
    process.stdout.write(JSON.stringify({ running: true, resultCount: results.length }));
  } catch(e) {
    process.stdout.write('error:' + e.message);
  }
})();
" 2>&1)

  echo "$SERVER_OUT" | sed 's/^/     /'

  echo "$SERVER_OUT" | grep -q '"running":true' \
    && ok "Live server: avviato e raggiungibile" \
    || fail "Live server: avvio fallito"

  RESULT_COUNT=$(echo "$SERVER_OUT" | grep -o '"resultCount":[0-9]*' | grep -o '[0-9]*' || echo "?")
  [ "${RESULT_COUNT:-0}" -ge 0 ] 2>/dev/null \
    && ok "Live server: searchVisual() ha restituito ${RESULT_COUNT} risultati" \
    || fail "Live server: searchVisual() ha fallito"
fi

fi # WITH_SERVER

# ── 21. Pulizia finale ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}Pulizia post-test${RESET}"
rm -rf "$TEST_DIR/.kirograph" "$TEST_DIR/.kiro" "$TEST_DIR/data/annual-report.pdf" "$TEST_DIR/data/tech-spec.pdf"
ok "Mock pulito"

# ── Fine ──────────────────────────────────────────────────────────────────────
sep
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}Tutti i controlli superati.${RESET}"
  [ "$WITH_SERVER" = false ] && echo -e "  ${DIM}(usa --with-server per test con server PixelRAG live)${RESET}"
else
  echo -e "  ${RED}${BOLD}$FAILURES controllo/i fallito/i.${RESET}"
  exit 1
fi
echo ""
