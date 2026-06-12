#!/usr/bin/env bash
# test-turbovec.sh — testa il workflow completo di KiroGraph TurboVec
# su un progetto nuovo, partendo dal codice sorgente.
#
# Uso:
#   ./test.sh                  # test completo (config, build, index, status, unit)
#   ./test.sh --skip-unit      # salta i test unitari di TurboVecIndex
#   ./test.sh --no-build       # non ricompila kirograph (usa dist esistente)
#   ./test.sh --skip-native    # non ricompila l'addon napi-rs (usa .node esistente)

set -euo pipefail

SKIP_UNIT=false; NO_BUILD=false; SKIP_NATIVE=false
for arg in "$@"; do
  case $arg in
    --skip-unit)   SKIP_UNIT=true ;;
    --no-build)    NO_BUILD=true ;;
    --skip-native) SKIP_NATIVE=true ;;
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
NATIVE_DIR="$ROOT/native/turbovec-node"
KG="node $ROOT/dist/bin/kirograph.js"

echo -e "\n${BOLD}  KiroGraph TurboVec — test su progetto nuovo${RESET}"
echo -e "  ${DIM}$TEST_DIR${RESET}"

# ── 1. Build kirograph ────────────────────────────────────────────────────────
sep
if [ "$NO_BUILD" = false ]; then
  info "Building kirograph..."
  cd "$ROOT" && npm run build > /dev/null 2>&1
  ok "Build OK  (v$(node "$ROOT/dist/bin/kirograph.js" --version 2>/dev/null || echo '?'))"
else
  warn "--no-build: usando dist esistente"
fi

# ── 2. Build native addon via installer ───────────────────────────────────────
sep
echo -e "  ${BOLD}[0] Build addon napi-rs via kirograph install${RESET}"
echo -e "  ${DIM}L'installer gestisce Rust + build — stessa path dell'utente reale${RESET}"

TV_AVAILABLE=false

if [ "$SKIP_NATIVE" = true ]; then
  warn "--skip-native: skipping build dell'addon"
else
  # Delegate entirely to the installer — it installs Rust if missing, then builds
  info "Eseguendo: kirograph install --target kiro --yes (fase Rust+build)..."
  cd "$TEST_DIR"
  mkdir -p .kirograph
  cat > .kirograph/config.json << 'CFGTMP'
{
  "version": 1,
  "languages": ["typescript"],
  "enableEmbeddings": true,
  "semanticEngine": "turbovec",
  "turbovecBits": 4
}
CFGTMP
  $KG install --target kiro --yes 2>&1 | grep -E "Rust|rustc|rustup|napi|turbovec|Building|built|✓|✗|⚠" | sed 's/^/     /'
fi

# Check result regardless of how we got here
if ls "$NATIVE_DIR"/turbovec_node.*.node 2>/dev/null | head -1 | grep -q ".node"; then
  TV_AVAILABLE=true
  ok "Addon disponibile: $(ls "$NATIVE_DIR"/turbovec_node.*.node 2>/dev/null | head -1 | xargs basename)"
else
  warn "Addon non compilato — unit test e turbovec engine saltati"
  warn "Installa Rust (https://rustup.rs) e ri-esegui: kirograph install"
fi

# Verify require works from node_modules
TV_REQUIRE=false
if [ "$TV_AVAILABLE" = true ]; then
  node -e "
    const m = require('$NATIVE_DIR/index.js');
    if (!m.TurboVecIndex) throw new Error('TurboVecIndex non esportato');
  " 2>/dev/null && TV_REQUIRE=true || true
  [ "$TV_REQUIRE" = true ] \
    && ok "require('turbovec-node') → TurboVecIndex disponibile" \
    || warn "turbovec-node caricato ma TurboVecIndex non disponibile"
fi

# ── 3. Pulizia totale ─────────────────────────────────────────────────────────
sep
info "Pulizia completa — progetto vergine..."
rm -rf "$TEST_DIR/.kirograph"
rm -rf "$TEST_DIR/.kiro"
ok "Rimossi .kirograph/ e .kiro/"

cd "$TEST_DIR"

# ── 4. Config con turbovec ────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[1] Configurazione TurboVec${RESET}"
echo -e "  ${DIM}Crea .kirograph/config.json con semanticEngine: turbovec${RESET}"

mkdir -p .kirograph
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "languages": ["typescript"],
  "enableEmbeddings": true,
  "semanticEngine": "turbovec",
  "turbovecBits": 4,
  "enableMemory": true
}
EOF
ok "Config scritto:"
echo -e "     ${DIM}enableEmbeddings: true${RESET}"
echo -e "     ${DIM}semanticEngine: turbovec${RESET}"
echo -e "     ${DIM}turbovecBits: 4${RESET}"
echo -e "     ${DIM}enableMemory: true${RESET}"

node -e "JSON.parse(require('fs').readFileSync('.kirograph/config.json','utf8'))" \
  && ok "JSON valido" || fail "config.json malformato"

# ── 5. Install ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[2] kirograph install${RESET}"
echo -e "  ${DIM}Installa MCP, hooks e steering per kiro${RESET}"

cmd "install --target kiro --yes"
$KG install --target kiro --yes 2>&1 | grep -E "✓|✗|ℹ|hook|steering|MCP|agent|Workspace|Installing|turbovec|Rust|napi" | sed 's/^/     /'

ok "Install completato"
[ -f ".kiro/settings/mcp.json" ]     && ok "MCP server: .kiro/settings/mcp.json"   || fail "mcp.json non trovato"
[ -f ".kiro/steering/kirograph.md" ] && ok "Steering: kirograph.md"                || fail "kirograph.md non trovato"
[ -f ".kiro/agents/kirograph.json" ] && ok "CLI agent: kirograph.json"              || fail "kirograph.json non trovato"

# Verifica che l'installer avverta correttamente per turbovec
INSTALL_OUT=$($KG install --target kiro --yes 2>&1 || true)
echo "$INSTALL_OUT" | grep -qi "turbovec\|napi\|rust\|native" \
  && ok "Installer menziona turbovec/napi/rust" \
  || warn "Installer non menziona turbovec (controlla src/bin/installer/index.ts)"

# ── 6. Index ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[3] kirograph index${RESET}"
echo -e "  ${DIM}Indicizza i sorgenti TypeScript del mock${RESET}"

cmd "index"
$KG index 2>&1 | grep -E "✓|file|symbol|edge|Indexed|scanning|languages|turbovec|fallback" | sed 's/^/     /'
[ -f ".kirograph/kirograph.db" ] && ok "kirograph.db creato" || fail "kirograph.db non trovato"

# Check se il bin turbovec è stato creato (solo se addon disponibile)
if [ "$TV_AVAILABLE" = true ] && [ "$TV_REQUIRE" = true ]; then
  [ -f ".kirograph/turbovec.tvim" ] \
    && ok "turbovec.tvim creato ($(du -h .kirograph/turbovec.tvim | cut -f1))" \
    || warn "turbovec.tvim non trovato — l'engine potrebbe essere caduto su cosine fallback"
else
  warn "TurboVec non disponibile — kirograph è caduto su cosine (atteso)"
fi

# ── 7. Status ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[4] Status — engine turbovec${RESET}"
echo -e "  ${DIM}Verifica che l'engine label sia visibile nello status${RESET}\n"

cmd "status"
STATUS_OUT=$($KG status 2>&1)
echo "$STATUS_OUT" | sed 's/^/     /'

echo ""
if [ "$TV_AVAILABLE" = true ] && [ "$TV_REQUIRE" = true ]; then
  echo "$STATUS_OUT" | grep -qi "turbovec" \
    && ok "Engine 'turbovec' visibile nello status" \
    || warn "'turbovec' non appare — controlla src/bin/commands/status.ts"
else
  echo "$STATUS_OUT" | grep -qi "cosine\|turbovec" \
    && ok "Status mostra engine (cosine fallback atteso senza addon)" \
    || warn "Status non mostra engine"
fi

# ── 8. Config validation — turbovecBits ──────────────────────────────────────
sep
echo -e "  ${BOLD}[5] Validazione config — turbovecBits${RESET}"
echo -e "  ${DIM}Verifica che solo i valori 2, 3, 4 siano accettati${RESET}\n"

node -e "
const { validateConfig } = require('$ROOT/dist/config.js');

const cases = [
  { input: 4,   expect: 4,   label: 'valid 4 → 4' },
  { input: 3,   expect: 3,   label: 'valid 3 → 3' },
  { input: 2,   expect: 2,   label: 'valid 2 → 2' },
  { input: 1,   expect: 4,   label: 'invalid 1 → default 4' },
  { input: 5,   expect: 4,   label: 'invalid 5 → default 4' },
  { input: 0,   expect: 4,   label: 'invalid 0 → default 4' },
  { input: 99,  expect: 4,   label: 'invalid 99 → default 4' },
];
let allOk = true;
for (const t of cases) {
  const cfg = validateConfig({ turbovecBits: t.input });
  const got = cfg.turbovecBits;
  if (got !== t.expect) {
    console.error('  FAIL  ' + t.label + '  got=' + got);
    allOk = false;
  } else {
    console.log('    ok  ' + t.label);
  }
}
process.exit(allOk ? 0 : 1);
" 2>&1 | sed 's/^/  /'

echo ""
ok "Validazione turbovecBits {2,3,4} verificata"

# Ripristina config
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "languages": ["typescript"],
  "enableEmbeddings": true,
  "semanticEngine": "turbovec",
  "turbovecBits": 4,
  "enableMemory": true
}
EOF
ok "Config ripristinato (turbovecBits: 4)"

# ── 9. Query ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[6] kirograph query${RESET}"
echo -e "  ${DIM}Ricerca simboli per nome${RESET}\n"

cmd "query VectorStore"
QUERY_OUT=$($KG query VectorStore 2>&1)
echo "$QUERY_OUT" | sed 's/^/     /'
echo ""
echo "$QUERY_OUT" | grep -qi "VectorStore\|No results\|symbol\|method\|class" \
  && ok "query: output prodotto" || fail "query: output inatteso"

cmd "query embed --kind function"
$KG query embed --kind function 2>&1 | sed 's/^/     /'
ok "query --kind: completato"

# ── 10. Context ───────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[7] kirograph context${RESET}"
echo -e "  ${DIM}Costruisce il contesto semantico per un task${RESET}\n"

cmd "context \"vector embedding search\""
CTX_OUT=$($KG context "vector embedding search" --no-code 2>&1)
echo "$CTX_OUT" | head -20 | sed 's/^/     /'
echo ""
echo "$CTX_OUT" | grep -qi "Entry\|symbol\|Result\|No \|embed\|vector\|store" \
  && ok "context: output prodotto" || warn "context: nessun risultato (senza embedding model è atteso)"

# ── 11. Files ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[8] kirograph files${RESET}"
echo -e "  ${DIM}Lista file indicizzati in vari formati${RESET}\n"

cmd "files"
FILES_OUT=$($KG files 2>&1)
echo "$FILES_OUT" | sed 's/^/     /'
echo ""
echo "$FILES_OUT" | grep -qi "embedder\|vector-store\|src\|\.ts" \
  && ok "files: file TypeScript trovati" || fail "files: nessun file TypeScript"

cmd "files --format flat"
$KG files --format flat 2>&1 | sed 's/^/     /'
ok "files --format flat: completato"

# ── 12. Read ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[9] kirograph read${RESET}"
echo -e "  ${DIM}Legge un file con modalità diverse${RESET}\n"

cmd "read src/embedder.ts --mode signatures"
READ_OUT=$($KG read src/embedder.ts --mode signatures 2>&1)
echo "$READ_OUT" | sed 's/^/     /'
echo ""
echo "$READ_OUT" | grep -qi "Embedder\|embed\|function\|class\|export\|interface" \
  && ok "read --mode signatures: simboli estratti" || fail "read: output vuoto"

# ── 13. Export ────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[10] kirograph export${RESET}"
echo -e "  ${DIM}Esporta il grafo come dashboard HTML${RESET}\n"

cmd "export build"
$KG export build 2>&1 | sed 's/^/     /'
EXPORT_FILE=".kirograph/export/index.html"
[ -f "$EXPORT_FILE" ] \
  && ok "export build: HTML scritto ($EXPORT_FILE — $(du -h "$EXPORT_FILE" | cut -f1))" \
  || warn "export build: file non trovato"

# ── 14. Sync ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[11] kirograph sync${RESET}"
echo -e "  ${DIM}Sincronizzazione incrementale${RESET}\n"

cmd "mark-dirty"
$KG mark-dirty 2>&1 | sed 's/^/     /'
cmd "sync-if-dirty"
$KG sync-if-dirty 2>&1 | sed 's/^/     /'
ok "sync cycle completato"

# ── 15. Memoria ───────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[12] Memory — store / search / timeline${RESET}"
echo -e "  ${DIM}Osservazioni di memoria${RESET}\n"

RUN_ID=$(date +%s)

cmd "mem store \"...\" --kind decision"
$KG mem store "[$RUN_ID] TurboVec: turbovecBits 4 offre il miglior tradeoff qualità/compressione per progetti medi." --kind decision 2>&1 | sed 's/^/     /'
ok "1/2 osservazione storata [decision]"

cmd "mem store \"...\" --kind pattern"
$KG mem store "[$RUN_ID] Pattern: TurboVecIndex.close() libera memoria Rust — chiamarlo esplicitamente in ambienti con vincoli di memoria." --kind pattern 2>&1 | sed 's/^/     /'
ok "2/2 osservazione storata [pattern]"

cmd "mem search \"turbovec compression\""
MEM_SEARCH=$($KG mem search "turbovec compression" 2>&1)
echo "$MEM_SEARCH" | sed 's/^/     /'
echo ""
echo "$MEM_SEARCH" | grep -qi "TurboVec\|turbovec\|result\|No result\|observation" \
  && ok "mem search: output prodotto" || warn "mem search: nessun risultato (richiede embedding model)"

cmd "mem timeline"
MEM_TL=$($KG mem timeline 2>&1)
echo "$MEM_TL" | sed 's/^/     /'
echo ""
echo "$MEM_TL" | grep -qi "decision\|pattern\|observation\|timeline" \
  && ok "mem timeline: osservazioni visibili" || fail "mem timeline: nessuna osservazione"

# ── 16. Gain ─────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[13] kirograph gain${RESET}"
echo -e "  ${DIM}Analytics token savings${RESET}\n"

cmd "gain"
$KG gain 2>&1 | sed 's/^/     /'
ok "gain: completato"

cmd "gain --json"
GAIN_JSON=$($KG gain --json 2>&1)
node -e "JSON.parse(process.argv[1])" "$GAIN_JSON" 2>/dev/null \
  && ok "gain --json: JSON valido" \
  || warn "gain --json: output non JSON (nessun dato ancora)"

# ── 17. Unit test TurboVecIndex ───────────────────────────────────────────────
sep
echo -e "  ${BOLD}[14] Unit test TurboVecIndex${RESET}"
echo -e "  ${DIM}Test diretto: costruzione → upsert → search → save → load → close${RESET}\n"

if [ "$SKIP_UNIT" = true ]; then
  warn "--skip-unit: unit test saltato"
elif [ "$TV_AVAILABLE" = false ] || [ "$TV_REQUIRE" = false ]; then
  warn "turbovec-node non disponibile — unit test saltato"
  warn "Compila l'addon: cd native/turbovec-node && npm install && npm run build"
else
  ok "turbovec-node trovato — avvio unit test"
  echo ""

  NATIVE_DIR_JS="$NATIVE_DIR" ROOT_JS="$ROOT" node << 'NODETEST'
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const nativeDir = process.env.NATIVE_DIR_JS;
const rootDir   = process.env.ROOT_JS;

// Load the napi binding directly from the native directory
const tv = require(path.join(nativeDir, 'index.js'));
const { TurboVecIndex } = tv;
if (!TurboVecIndex) throw new Error('TurboVecIndex non esportato da turbovec-node');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tv-test-'));
const DIM = 64;   // multiple of 8 ✓
const BITS = 4;

async function run() {
  console.log('  Unit: TurboVecIndex');

  // 1. Construct
  const idx = new TurboVecIndex(DIM, BITS);
  console.log('    ✓  TurboVecIndex costruito (dim=%d, bits=%d)', DIM, BITS);

  // 2. dim / bitWidth accessors
  if (idx.dim() !== DIM)      throw new Error(`dim() atteso ${DIM}, ottenuto ${idx.dim()}`);
  if (idx.bitWidth() !== BITS) throw new Error(`bitWidth() atteso ${BITS}, ottenuto ${idx.bitWidth()}`);
  console.log('    ✓  dim() / bitWidth() corretti');

  // 3. isEmpty on fresh index
  if (!idx.isEmpty()) throw new Error('isEmpty() dovrebbe essere true su indice vuoto');
  if (idx.len() !== 0) throw new Error('len() dovrebbe essere 0 su indice vuoto');
  console.log('    ✓  isEmpty() / len() su indice vuoto');

  // 4. upsert N vectors
  const N = 20;
  for (let i = 0; i < N; i++) {
    const v = new Float32Array(DIM);
    // Create unit vectors so cosine similarity is well-defined
    let norm = 0;
    for (let j = 0; j < DIM; j++) { v[j] = Math.sin(i * 0.3 + j * 0.1); norm += v[j] * v[j]; }
    norm = Math.sqrt(norm);
    for (let j = 0; j < DIM; j++) v[j] /= norm;
    idx.add(`node-${i}`, v);
  }
  if (idx.len() !== N) throw new Error(`len() atteso ${N}, ottenuto ${idx.len()}`);
  if (idx.isEmpty())   throw new Error('isEmpty() dovrebbe essere false dopo upsert');
  console.log(`    ✓  add() ${N} vettori  (len=${idx.len()})`);

  // 5. getIds
  const ids = idx.getIds();
  if (ids.length !== N) throw new Error(`getIds() lunghezza attesa ${N}, ottenuta ${ids.length}`);
  if (!ids.includes('node-5')) throw new Error('getIds() non include node-5');
  console.log(`    ✓  getIds() → ${ids.length} id`);

  // 6. search
  const queryV = new Float32Array(DIM);
  let norm = 0;
  for (let j = 0; j < DIM; j++) { queryV[j] = Math.sin(5 * 0.3 + j * 0.1); norm += queryV[j] * queryV[j]; }
  norm = Math.sqrt(norm);
  for (let j = 0; j < DIM; j++) queryV[j] /= norm;

  const results = idx.search(queryV, 5);
  if (!Array.isArray(results) || results.length === 0) throw new Error('search() ha restituito 0 risultati');
  if (typeof results[0].id !== 'string')     throw new Error('search() item.id non è stringa');
  if (typeof results[0].score !== 'number')  throw new Error('search() item.score non è number');
  console.log(`    ✓  search() → [${results.map(r => r.id).join(', ')}]`);
  console.log(`         top: ${results[0].id}  score=${results[0].score.toFixed(4)}`);

  // 7. upsert (update existing)
  const updatedV = new Float32Array(DIM).fill(0.1);
  idx.add('node-5', updatedV);
  if (idx.len() !== N) throw new Error(`upsert aggiornamento non dovrebbe cambiare len (atteso ${N}, ottenuto ${idx.len()})`);
  console.log('    ✓  upsert aggiornamento (len invariato)');

  // 8. prepare (SIMD cache warmup — should not throw)
  idx.prepare();
  console.log('    ✓  prepare()');

  // 9. remove
  const removedOk = idx.remove('node-0');
  if (!removedOk) throw new Error('remove() ha restituito false per id esistente');
  if (idx.len() !== N - 1) throw new Error(`len() dopo remove: atteso ${N - 1}, ottenuto ${idx.len()}`);
  const afterRemove = idx.search(queryV, N);
  if (afterRemove.some(r => r.id === 'node-0')) throw new Error('node-0 ancora nei risultati dopo remove()');
  console.log(`    ✓  remove() → len=${idx.len()}, node-0 assente dalla ricerca`);

  // 10. save
  const binPath = path.join(tmpDir, 'test.tvim');
  idx.save(binPath);
  if (!fs.existsSync(binPath)) throw new Error(`File ${binPath} non salvato`);
  const idsPath = binPath + '.ids';
  if (!fs.existsSync(idsPath)) throw new Error(`Sidecar ${idsPath} non salvato`);
  console.log(`    ✓  save() → ${binPath} (${fs.statSync(binPath).size}B) + .ids (${fs.statSync(idsPath).size}B)`);

  // 11. load — ricarica e verifica round-trip
  const idx2 = TurboVecIndex.load(binPath);
  if (idx2.len() !== idx.len()) throw new Error(`Indice ricaricato: len ${idx2.len()} ≠ ${idx.len()}`);
  const results2 = idx2.search(queryV, 5);
  if (!Array.isArray(results2) || results2.length === 0) throw new Error('Indice ricaricato: search() vuoto');
  const ids2 = idx2.getIds();
  if (!ids2.includes('node-5')) throw new Error('Indice ricaricato: node-5 non trovato in getIds()');
  console.log(`    ✓  load() → len=${idx2.len()}, search OK [${results2.map(r => r.id).join(', ')}]`);

  // 12. close
  idx.close();
  idx2.close();
  console.log('    ✓  close()');

  // 13. invalid dim should throw
  try {
    new TurboVecIndex(63, 4);  // 63 not multiple of 8
    throw new Error('Avrebbe dovuto lanciare per dim non multiplo di 8');
  } catch (e) {
    if (e.message.includes('Avrebbe dovuto')) throw e;
    console.log('    ✓  constructor lancia per dim non multiplo di 8 (atteso)');
  }

  // 14. invalid bit_width should throw
  try {
    new TurboVecIndex(64, 5);  // 5 not in {2,3,4}
    throw new Error('Avrebbe dovuto lanciare per bit_width fuori {2,3,4}');
  } catch (e) {
    if (e.message.includes('Avrebbe dovuto')) throw e;
    console.log('    ✓  constructor lancia per bit_width fuori {2,3,4} (atteso)');
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });

  console.log('\n  Tutti gli unit test superati.');
}

run().catch(e => {
  console.error('\n  ✗  Unit test FALLITO: ' + e.message);
  process.exit(1);
});
NODETEST

  [ $? -eq 0 ] && ok "Unit test TurboVecIndex: tutti superati" || fail "Unit test falliti"
fi

# ── Fine ──────────────────────────────────────────────────────────────────────
sep
echo ""
echo -e "  ${BOLD}File generati in mock/.kirograph/:${RESET}"
ls "$TEST_DIR/.kirograph/" 2>/dev/null | while read -r f; do
  if [[ "$f" == turbovec* ]]; then
    echo -e "     ${CYAN}·${RESET} $f  ${DIM}(TurboVec)${RESET}"
  else
    echo -e "     ${DIM}·${RESET} $f"
  fi
done

echo ""
STEPS=14
SKIPPED=0
[ "$SKIP_UNIT" = true ] && SKIPPED=$((SKIPPED+1))
[ "$TV_AVAILABLE" = false ] && SKIPPED=$((SKIPPED+1))

if [ "$SKIPPED" -gt 0 ]; then
  echo -e "  ${YELLOW}${BOLD}Completato ($SKIPPED passi saltati)${RESET} — $((STEPS - SKIPPED)) di ${STEPS} passi verificati."
  if [ "$TV_AVAILABLE" = false ]; then
    echo -e "  ${DIM}turbovec-node non compilato. Per abilitare tutti i test:${RESET}"
    echo -e "  ${DIM}  rustup (https://rustup.rs) poi:${RESET}"
    echo -e "  ${DIM}  cd native/turbovec-node && npm install && npm run build${RESET}"
  fi
else
  echo -e "  ${GREEN}${BOLD}Tutti i ${STEPS} passi completati.${RESET}"
fi
echo ""
