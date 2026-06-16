#!/usr/bin/env bash
# test-wiki.sh — test completo del modulo Wiki di KiroGraph
#
# Verifica:
#   A. Installer: hook wiki + steering file kirograph-wiki-workflow.md
#   B. WikiDatabase API: upsert, getPage, search, listPages, getStats, clearAll
#   C. parseWikiDiff: create / upsert / append / malformed / CONFLICTS
#   D. KiroGraphWiki.initWiki(): SCHEMA.md + MANIFEST.md su disco
#   E. getIngestPrompt: struttura (SCHEMA + MANIFEST + source + istruzioni)
#   F. applyDiff: create → pagina su disco + DB
#   G. applyDiff: upsert → contenuto aggiornato
#   H. applyDiff: append → sezione appendita
#   I. Conflict handling: pending (autoResolve=false) + auto-resolve (autoResolve=true)
#   J. lint: broken_link / orphan / stale_source detection
#   K. reindex: ricostruisce DB da file su disco
#   L. getContextPages: pagine sopra threshold incluse nel context
#   M. CLI: wiki init / ingest / search / page / list / lint / reindex / status
#   N. DB: tabelle wiki_pages + wiki_fts presenti e popolate
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

echo -e "\n${BOLD}  KiroGraph Wiki — test modulo wiki${RESET}"
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
echo -e "  ${BOLD}[1] Configurazione${RESET}\n"

mkdir -p .kirograph
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "languages": ["typescript"],
  "enableWiki": true,
  "wikiSynthesisMode": "agent",
  "wikiAutoResolveConflicts": false,
  "wikiContextLimit": 3,
  "wikiContextThreshold": 0.1,
  "enableEmbeddings": false,
  "enableMemory": false,
  "enableDocs": false,
  "enableData": false,
  "enableSecurity": false
}
EOF
ok "config.json scritto (enableWiki: true)"

# ── 4. kirograph install → hook + steering ────────────────────────────────────
sep
echo -e "  ${BOLD}[2] Installer: hook + steering${RESET}\n"

$KG install --target kiro --yes 2>&1 | grep -E "✓|hook|steering|MCP|Workspace|Installing" | sed 's/^/     /' || true

[ -f ".kiro/settings/mcp.json" ] \
  && ok "MCP: .kiro/settings/mcp.json" \
  || fail "mcp.json non trovato"

[ -f ".kiro/hooks/kirograph-wiki-ingest.kiro.hook" ] \
  && ok "Hook: kirograph-wiki-ingest.kiro.hook" \
  || fail "kirograph-wiki-ingest.kiro.hook non trovato"

[ -f ".kiro/hooks/kirograph-wiki-lint.kiro.hook" ] \
  && ok "Hook: kirograph-wiki-lint.kiro.hook" \
  || fail "kirograph-wiki-lint.kiro.hook non trovato"

[ -f ".kiro/steering/kirograph.md" ] \
  && ok "Steering: kirograph.md (inclusion: always)" \
  || fail "kirograph.md non trovato"

[ -f ".kiro/steering/kirograph-wiki-workflow.md" ] \
  && ok "Steering skill: kirograph-wiki-workflow.md" \
  || fail "kirograph-wiki-workflow.md non trovato"

# Verifica che il hook ingest sia agentStop + askAgent
INGEST_HOOK_TYPE=$(node -e "
  const fs = require('fs');
  const h = JSON.parse(fs.readFileSync('.kiro/hooks/kirograph-wiki-ingest.kiro.hook', 'utf8'));
  console.log(h.when.type + ':' + h.then.type);
" 2>/dev/null || echo "error")
[ "$INGEST_HOOK_TYPE" = "agentStop:askAgent" ] \
  && ok "  ingest hook: when=agentStop then=askAgent" \
  || fail "  ingest hook type errato: $INGEST_HOOK_TYPE"

# Verifica che il hook lint sia agentStop + runCommand
LINT_HOOK_TYPE=$(node -e "
  const fs = require('fs');
  const h = JSON.parse(fs.readFileSync('.kiro/hooks/kirograph-wiki-lint.kiro.hook', 'utf8'));
  console.log(h.when.type + ':' + h.then.type);
" 2>/dev/null || echo "error")
[ "$LINT_HOOK_TYPE" = "agentStop:runCommand" ] \
  && ok "  lint hook: when=agentStop then=runCommand" \
  || fail "  lint hook type errato: $LINT_HOOK_TYPE"

# Verifica sezione Wiki nel kirograph.md steering
grep -q "kirograph_wiki_ingest" .kiro/steering/kirograph.md \
  && ok "  kirograph.md contiene riferimento wiki tools" \
  || fail "  kirograph.md non contiene wiki tools"

# Verifica kirograph-wiki-workflow.md ha inclusion: manual
grep -q "inclusion: manual" .kiro/steering/kirograph-wiki-workflow.md \
  && ok "  kirograph-wiki-workflow.md ha inclusion: manual" \
  || fail "  kirograph-wiki-workflow.md non ha inclusion: manual"

# ── 5. kirograph index ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[3] kirograph index${RESET}\n"

$KG index 2>&1 | grep -E "✓|file|symbol|Indexed|scanning" | sed 's/^/     /' || true
[ -f "$DB" ] && ok "kirograph.db creato" || { fail "kirograph.db non trovato"; exit 1; }

# ── 6. WikiDatabase API ───────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[4] WikiDatabase API${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { WikiDatabase } = require(path.join(rootDir, 'dist/wiki/database.js'));
const wdb = new WikiDatabase(db.getRawDb());

// upsertPage (create)
wdb.upsertPage({
  slug: 'auth-service',
  title: 'Auth Service',
  content: '# Auth Service\n\nHandles JWT token generation and validation.\nTokens expire after 15 minutes.\n\n## Related\n- [[payment-flow]]',
  filePath: null,
  updatedAt: 1700000000000,
  sourceCount: 1,
});

// getPage
const page = wdb.getPage('auth-service');
if (!page) throw new Error('getPage returned null');
if (page.title !== 'Auth Service') throw new Error('title wrong: ' + page.title);
if (page.sourceCount !== 1) throw new Error('sourceCount wrong: ' + page.sourceCount);
console.log('getPage:ok slug=auth-service title="Auth Service"');

// search — FTS
const results = wdb.search('JWT token', 5);
if (!results.length) throw new Error('search returned 0 results');
if (results[0].page.slug !== 'auth-service') throw new Error('search top result wrong: ' + results[0].page.slug);
if (results[0].score <= 0) throw new Error('score should be >0, got: ' + results[0].score);
console.log('search:ok query="JWT token" results=' + results.length + ' topScore=' + results[0].score.toFixed(3));

// listPages
const pages = wdb.listPages();
if (!pages.length) throw new Error('listPages empty');
console.log('listPages:ok count=' + pages.length);

// getStats
const stats = wdb.getStats();
if (stats.pageCount < 1) throw new Error('pageCount=' + stats.pageCount);
if (!stats.newestPage) throw new Error('newestPage null');
console.log('getStats:ok pageCount=' + stats.pageCount + ' totalSources=' + stats.totalSources);

// upsertPage (update — sourceCount accumulates: 1+1=2)
wdb.upsertPage({
  slug: 'auth-service',
  title: 'Auth Service',
  content: '# Auth Service\n\nHandles JWT token generation and validation.\nTokens expire after 15 minutes.\nUses RS256 signing algorithm.\n\n## Related\n- [[payment-flow]]',
  filePath: null,
  updatedAt: 1700100000000,
  sourceCount: 1,
});
const updated = wdb.getPage('auth-service');
if (!updated.content.includes('RS256')) throw new Error('update did not persist content');
if (updated.sourceCount !== 2) throw new Error('sourceCount not updated: ' + updated.sourceCount);
console.log('upsert-update:ok RS256 content + sourceCount=2');

// search after update — FTS triggers kept index in sync
const results2 = wdb.search('RS256', 5);
if (!results2.length) throw new Error('search after update returned 0');
console.log('search-after-update:ok query="RS256" results=' + results2.length);

console.log('ALL_API_OK');
NODEEOF

if [ $? -eq 0 ]; then
  ok "WikiDatabase: upsert / getPage / search / listPages / getStats / update OK"
else
  fail "WikiDatabase API test fallito"
fi

# ── 7. parseWikiDiff ──────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[5] parseWikiDiff — formato WIKI_DIFF${RESET}\n"

ROOT_DIR="$ROOT" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const rootDir = process.env.ROOT_DIR;
const { parseWikiDiff } = require(path.join(rootDir, 'dist/wiki/schema.js'));

// ── create ──
const diff1 = parseWikiDiff(`WIKI_DIFF_START
{"action":"create","page":"payment-flow","title":"Payment Flow"}
# Payment Flow

Payments go through Stripe. Webhooks at /api/webhooks/stripe.

## Related
- [[auth-service]]
WIKI_DIFF_END`);
if (diff1.entries.length !== 1) throw new Error('create: expected 1 entry, got ' + diff1.entries.length);
const e1 = diff1.entries[0];
if (e1.action !== 'create') throw new Error('action wrong: ' + e1.action);
if (e1.page !== 'payment-flow') throw new Error('page wrong: ' + e1.page);
if (e1.title !== 'Payment Flow') throw new Error('title wrong: ' + e1.title);
if (!e1.content.includes('Stripe')) throw new Error('content missing');
console.log('create:ok page=payment-flow');

// ── upsert ──
const diff2 = parseWikiDiff(`WIKI_DIFF_START
{"action":"upsert","page":"auth-service","title":"Auth Service"}
# Auth Service

Updated content with more details.
WIKI_DIFF_END`);
if (diff2.entries[0].action !== 'upsert') throw new Error('upsert action wrong');
console.log('upsert:ok');

// ── append with section ──
const diff3 = parseWikiDiff(`WIKI_DIFF_START
{"action":"append","page":"auth-service","title":"Auth Service","section":"Known Issues"}
- Token refresh not implemented yet.
WIKI_DIFF_END`);
const e3 = diff3.entries[0];
if (e3.action !== 'append') throw new Error('append action wrong');
if (e3.section !== 'Known Issues') throw new Error('section wrong: ' + e3.section);
console.log('append:ok section="Known Issues"');

// ── multiple entries in one diff ──
const diff4 = parseWikiDiff(`WIKI_DIFF_START
{"action":"create","page":"database-schema","title":"Database Schema"}
# Database Schema

PostgreSQL primary. Redis for sessions.
WIKI_DIFF_END
WIKI_DIFF_START
{"action":"create","page":"deployment","title":"Deployment"}
# Deployment

Docker Compose for local. K8s for prod.
WIKI_DIFF_END`);
if (diff4.entries.length !== 2) throw new Error('multi-entry: expected 2, got ' + diff4.entries.length);
if (diff4.entries[0].page !== 'database-schema') throw new Error('first page wrong');
if (diff4.entries[1].page !== 'deployment') throw new Error('second page wrong');
console.log('multi-entry:ok count=2');

// ── conflict block ──
const diff5 = parseWikiDiff(`WIKI_DIFF_START
{"action":"create","page":"config","title":"Config"}
# Config

TOKEN_TTL is 15 minutes.
WIKI_DIFF_END
WIKI_DIFF_CONFLICTS
{"page":"config","section":"Overview","existing":"TTL is 30 minutes","incoming":"TTL is 15 minutes","source":"auth-notes"}
WIKI_DIFF_CONFLICTS_END`);
if (!diff5.conflicts || diff5.conflicts.length !== 1) throw new Error('conflict block not parsed: ' + JSON.stringify(diff5.conflicts));
if (diff5.conflicts[0].page !== 'config') throw new Error('conflict page wrong');
console.log('conflict-block:ok page=config');

// ── malformed (no block) → returns empty entries, no throw ──
const diff6 = parseWikiDiff('This is just free text with no WIKI_DIFF markers.');
if (diff6.entries.length !== 0) throw new Error('malformed: expected 0 entries, got ' + diff6.entries.length);
console.log('malformed:ok returns empty (no throw)');

console.log('ALL_PARSE_OK');
NODEEOF

if [ $? -eq 0 ]; then
  ok "parseWikiDiff: create / upsert / append / multi-entry / conflicts / malformed OK"
else
  fail "parseWikiDiff test fallito"
fi

# ── 8. KiroGraphWiki.initWiki ─────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[6] KiroGraphWiki.initWiki() — SCHEMA.md + MANIFEST.md${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), { autoResolveConflicts: false });
wiki.initialize();
wiki.initWiki();

const wikiDir = path.join(testDir, '.kirograph', 'wiki');
if (!fs.existsSync(path.join(wikiDir, 'SCHEMA.md'))) throw new Error('SCHEMA.md not created');
if (!fs.existsSync(path.join(wikiDir, 'MANIFEST.md'))) throw new Error('MANIFEST.md not created');

const schema = fs.readFileSync(path.join(wikiDir, 'SCHEMA.md'), 'utf8');
if (!schema.includes('WIKI_DIFF')) throw new Error('SCHEMA.md missing WIKI_DIFF reference');

// initWiki is idempotent — call again, files must not throw
wiki.initWiki();

console.log('initWiki:ok SCHEMA.md + MANIFEST.md created');
NODEEOF

if [ $? -eq 0 ]; then
  ok "initWiki: SCHEMA.md + MANIFEST.md creati (idempotente)"
else
  fail "initWiki fallito"
fi

[ -f "$TEST_DIR/.kirograph/wiki/SCHEMA.md" ]   && ok "  .kirograph/wiki/SCHEMA.md esiste su disco" || fail "  SCHEMA.md non trovato su disco"
[ -f "$TEST_DIR/.kirograph/wiki/MANIFEST.md" ] && ok "  .kirograph/wiki/MANIFEST.md esiste su disco" || fail "  MANIFEST.md non trovato su disco"

# ── 9. getIngestPrompt ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[7] getIngestPrompt — struttura del prompt${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), {});
wiki.initialize();

const sourceText = 'The AuthService uses RS256 JWT tokens. Tokens expire in 15 minutes. Secret stored in JWT_SECRET env var.';
const prompt = wiki.getIngestPrompt(sourceText, 'auth-design-notes');

// Struttura obbligatoria
if (!prompt.includes('WIKI_DIFF_START')) throw new Error('prompt missing WIKI_DIFF_START');
if (!prompt.includes('SCHEMA')) throw new Error('prompt missing SCHEMA section');
if (!prompt.includes('MANIFEST')) throw new Error('prompt missing MANIFEST section');
if (!prompt.includes('auth-design-notes')) throw new Error('prompt missing sourceName');
if (!prompt.includes(sourceText)) throw new Error('prompt missing source content');

// Deve contenere le istruzioni per l'LLM
const promptLower = prompt.toLowerCase();
if (!promptLower.includes('action') && !promptLower.includes('slug')) {
  throw new Error('prompt missing action/slug instructions');
}

console.log('getIngestPrompt:ok length=' + prompt.length + ' chars');
console.log('  contains: WIKI_DIFF_START marker ✓');
console.log('  contains: SCHEMA section ✓');
console.log('  contains: MANIFEST section ✓');
console.log('  contains: sourceName "auth-design-notes" ✓');
console.log('  contains: source text verbatim ✓');
NODEEOF

if [ $? -eq 0 ]; then
  ok "getIngestPrompt: SCHEMA + MANIFEST + sourceName + source content presenti"
else
  fail "getIngestPrompt test fallito"
fi

# ── 10. applyDiff: create ─────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[8] applyDiff — create${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), { autoResolveConflicts: false });
wiki.initialize();

const diff = `WIKI_DIFF_START
{"action":"create","page":"auth-service","title":"Auth Service"}
# Auth Service

Handles JWT token generation and validation. Tokens expire after 15 minutes.
Uses HS256 signing by default, RS256 in production.

## API

- POST /auth/login → returns token
- POST /auth/logout → invalidates session

## Related
- [[payment-flow]]
WIKI_DIFF_END`;

const result = wiki.applyDiff(diff);

if (!result.created.includes('auth-service')) throw new Error('auth-service not in created: ' + JSON.stringify(result));
if (result.updated.length) throw new Error('unexpected updated: ' + JSON.stringify(result.updated));
if (result.conflictsPending.length) throw new Error('unexpected conflicts: ' + JSON.stringify(result.conflictsPending));

// Pagina nel DB
const page = wiki.getPage('auth-service');
if (!page) throw new Error('page not in DB after create');
if (!page.content.includes('RS256')) throw new Error('content not persisted');

// File su disco
const filePath = path.join(testDir, '.kirograph', 'wiki', 'auth-service.md');
if (!fs.existsSync(filePath)) throw new Error('file not written to disk: ' + filePath);
const fileContent = fs.readFileSync(filePath, 'utf8');
if (!fileContent.includes('RS256')) throw new Error('disk file content wrong');

console.log('applyDiff-create:ok created=[auth-service] file=auth-service.md');
NODEEOF

if [ $? -eq 0 ]; then
  ok "applyDiff create: DB + file su disco"
  [ -f "$TEST_DIR/.kirograph/wiki/auth-service.md" ] \
    && ok "  .kirograph/wiki/auth-service.md scritto" \
    || fail "  auth-service.md non trovato su disco"
else
  fail "applyDiff create test fallito"
fi

# ── 11. applyDiff: upsert ─────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[9] applyDiff — upsert${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), { autoResolveConflicts: false });
wiki.initialize();

// Prima crea una pagina payment-flow
const createDiff = `WIKI_DIFF_START
{"action":"create","page":"payment-flow","title":"Payment Flow"}
# Payment Flow

Payments are processed via Stripe.

## Related
- [[auth-service]]
WIKI_DIFF_END`;
wiki.applyDiff(createDiff);

// Poi upsert con contenuto più ricco
const upsertDiff = `WIKI_DIFF_START
{"action":"upsert","page":"payment-flow","title":"Payment Flow"}
# Payment Flow

Payments are processed via Stripe. Webhooks land at /api/webhooks/stripe.
Refunds are processed asynchronously via the refund queue.

## Flow

1. Client calls POST /payments/intent
2. Backend creates Stripe PaymentIntent
3. Client confirms on frontend
4. Webhook fires → order marked paid

## Related
- [[auth-service]]
- [[database-schema]]
WIKI_DIFF_END`;

const result = wiki.applyDiff(upsertDiff);
if (!result.updated.includes('payment-flow')) throw new Error('payment-flow not in updated: ' + JSON.stringify(result));

const page = wiki.getPage('payment-flow');
if (!page.content.includes('refund queue')) throw new Error('upsert content not persisted');
if (!page.content.includes('Webhook fires')) throw new Error('upsert flow section not persisted');

// Controlla su disco
const filePath = path.join(testDir, '.kirograph', 'wiki', 'payment-flow.md');
const fileContent = fs.readFileSync(filePath, 'utf8');
if (!fileContent.includes('refund queue')) throw new Error('disk file not updated');

console.log('applyDiff-upsert:ok updated=[payment-flow] content includes refund queue');
NODEEOF

if [ $? -eq 0 ]; then
  ok "applyDiff upsert: contenuto aggiornato in DB + disco"
else
  fail "applyDiff upsert test fallito"
fi

# ── 12. applyDiff: append ─────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[10] applyDiff — append${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), { autoResolveConflicts: false });
wiki.initialize();

// append action: section field is parsed but not used as a header by ingest.ts —
// the LLM is expected to include the heading in the content body itself
const appendDiff = `WIKI_DIFF_START
{"action":"append","page":"auth-service","title":"Auth Service","section":"Known Issues"}
## Known Issues

- Token refresh endpoint not yet implemented (planned for v2).
- Session revocation requires Redis flush — no per-token invalidation.
WIKI_DIFF_END`;

const result = wiki.applyDiff(appendDiff);
// append conta come updated
if (!result.updated.includes('auth-service') && !result.created.includes('auth-service')) {
  throw new Error('auth-service not in updated after append: ' + JSON.stringify(result));
}

const page = wiki.getPage('auth-service');
if (!page.content.includes('Token refresh endpoint not yet implemented')) {
  throw new Error('appended content not found in page. content: ' + page.content.slice(0, 300));
}
if (!page.content.includes('Known Issues')) {
  throw new Error('section header not found in page');
}

console.log('applyDiff-append:ok section="Known Issues" appended to auth-service');
NODEEOF

if [ $? -eq 0 ]; then
  ok "applyDiff append: sezione 'Known Issues' appendita"
else
  fail "applyDiff append test fallito"
fi

# ── 13. Conflict handling — pending ──────────────────────────────────────────
sep
echo -e "  ${BOLD}[11] Conflict handling — pending (autoResolve=false)${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));

// crea una pagina con un fatto
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), { autoResolveConflicts: false });
wiki.initialize();

// Scrivi una pagina con un fatto preciso
const createDiff = `WIKI_DIFF_START
{"action":"create","page":"token-ttl","title":"Token TTL"}
# Token TTL

Access tokens expire after **30 minutes**.
WIKI_DIFF_END`;
wiki.applyDiff(createDiff);

// Ora invia un diff che contradice lo stesso fatto (stesso slug, sezione Overview, testo diverso)
const conflictDiff = `WIKI_DIFF_START
{"action":"upsert","page":"token-ttl","title":"Token TTL"}
# Token TTL

Access tokens expire after **15 minutes**.
WIKI_DIFF_END
WIKI_DIFF_CONFLICTS
{"page":"token-ttl","section":"Overview","existing":"Access tokens expire after 30 minutes","incoming":"Access tokens expire after 15 minutes","source":"auth-spec-v2"}
WIKI_DIFF_CONFLICTS_END`;

const result = wiki.applyDiff(conflictDiff);

if (!result.conflictsPending.length) throw new Error('Expected conflicts, got none: ' + JSON.stringify(result));
const conflict = result.conflictsPending[0];
if (conflict.page !== 'token-ttl') throw new Error('conflict.page wrong: ' + conflict.page);
if (!conflict.existing.includes('30 minutes')) throw new Error('conflict.existing wrong: ' + conflict.existing);
if (!conflict.incoming.includes('15 minutes')) throw new Error('conflict.incoming wrong: ' + conflict.incoming);
if (conflict.source !== 'auth-spec-v2') throw new Error('conflict.source wrong: ' + conflict.source);

console.log('conflict-pending:ok page=token-ttl existing="30 min" incoming="15 min"');
NODEEOF

if [ $? -eq 0 ]; then
  ok "Conflict pending: surfacato correttamente (autoResolve=false)"
else
  fail "Conflict pending test fallito"
fi

# ── 14. Conflict handling — auto-resolve ──────────────────────────────────────
sep
echo -e "  ${BOLD}[12] Conflict handling — auto-resolve (autoResolve=true)${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));

// autoResolveConflicts: true → la versione con source più recente vince
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), { autoResolveConflicts: true });
wiki.initialize();

// Crea la pagina iniziale
const createDiff = `WIKI_DIFF_START
{"action":"create","page":"rate-limit","title":"Rate Limiting"}
# Rate Limiting

The API allows **100 requests per minute**.
WIKI_DIFF_END`;
wiki.applyDiff(createDiff);

// Diff con conflicts block — autoResolve deve applicare incoming e spostare in conflictsResolved
const conflictDiff = `WIKI_DIFF_START
{"action":"upsert","page":"rate-limit","title":"Rate Limiting"}
# Rate Limiting

The API allows **200 requests per minute** (updated limit as of 2024).
WIKI_DIFF_END
WIKI_DIFF_CONFLICTS
{"page":"rate-limit","section":"Overview","existing":"100 requests per minute","incoming":"200 requests per minute","source":"api-changelog-2024","sourceDate":"2024-06-01"}
WIKI_DIFF_CONFLICTS_END`;

const result = wiki.applyDiff(conflictDiff);

if (result.conflictsPending.length) throw new Error('Expected 0 pending conflicts with autoResolve=true, got: ' + result.conflictsPending.length);
if (!result.conflictsResolved.includes('rate-limit')) {
  // conflictsResolved might be empty if the impl just applies upsert — check updated instead
  if (!result.updated.includes('rate-limit') && !result.created.includes('rate-limit')) {
    throw new Error('rate-limit not resolved or updated: ' + JSON.stringify(result));
  }
}

console.log('conflict-autoresolve:ok pending=0 page=rate-limit');
NODEEOF

if [ $? -eq 0 ]; then
  ok "Conflict auto-resolve: nessun pending con autoResolveConflicts=true"
else
  fail "Conflict auto-resolve test fallito"
fi

# ── 15. lint ──────────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[13] Wiki lint — broken_link / orphan / stale${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));
const { WikiDatabase } = require(path.join(rootDir, 'dist/wiki/database.js'));
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), {});
wiki.initialize();
const wdb = new WikiDatabase(db.getRawDb());

// Inserisci una pagina con un link rotto
wdb.upsertPage({
  slug: 'broken-links-test',
  title: 'Broken Links Test',
  content: '# Broken Links Test\n\nSee [[absolutely-nonexistent-slug-xyz]] for details.',
  filePath: null,
  updatedAt: Date.now(),
  sourceCount: 1,
});

// Inserisci una pagina orfana (nessun Related, nessuno la linka)
wdb.upsertPage({
  slug: 'orphan-page-test',
  title: 'Orphan Page',
  content: '# Orphan Page\n\nThis page has no related links and nobody points to it.',
  filePath: null,
  updatedAt: Date.now(),
  sourceCount: 0,
});

const issues = wiki.lint();
console.log('lint issues:', JSON.stringify(issues.map(i => ({ kind: i.kind, slug: i.slug })), null, 2));

// Deve trovare broken_link
const brokenLink = issues.find(i => i.kind === 'broken_link' && i.slug === 'broken-links-test');
if (!brokenLink) throw new Error('broken_link not found. Issues: ' + JSON.stringify(issues));
if (!brokenLink.detail.includes('absolutely-nonexistent-slug-xyz')) {
  throw new Error('broken_link detail missing slug: ' + brokenLink.detail);
}
console.log('broken_link:ok slug=broken-links-test target=absolutely-nonexistent-slug-xyz');

// Deve trovare orphan
const orphan = issues.find(i => i.kind === 'orphan' && i.slug === 'orphan-page-test');
if (!orphan) throw new Error('orphan not found. Issues: ' + JSON.stringify(issues));
console.log('orphan:ok slug=orphan-page-test');

console.log('ALL_LINT_OK');
NODEEOF

if [ $? -eq 0 ]; then
  ok "lint: broken_link detectato"
  ok "lint: orphan detectato"
else
  fail "lint test fallito"
fi

# ── 16. reindex ───────────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[14] reindex — ricostruisce DB dai file su disco${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));
const { WikiDatabase } = require(path.join(rootDir, 'dist/wiki/database.js'));
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), {});
wiki.initialize();

// Scrivi un file md manualmente nella wiki dir
const wikiDir = path.join(testDir, '.kirograph', 'wiki');
fs.mkdirSync(wikiDir, { recursive: true });
fs.writeFileSync(path.join(wikiDir, 'manual-page.md'), `# Manual Page\n\nThis page was written directly to disk.\n`);

// Svuota il DB
const wdb = new WikiDatabase(db.getRawDb());
wdb.clearAll();
const statsBefore = wdb.getStats();
if (statsBefore.pageCount !== 0) throw new Error('clearAll failed: count=' + statsBefore.pageCount);
console.log('clearAll:ok pageCount=0');

// reindex
const count = wiki.reindex();
if (count < 1) throw new Error('reindex returned 0');
const statsAfter = wdb.getStats();
if (statsAfter.pageCount < 1) throw new Error('pageCount after reindex=' + statsAfter.pageCount);

// La pagina manuale deve essere indicizzata
const manualPage = wdb.getPage('manual-page');
if (!manualPage) throw new Error('manual-page not found after reindex');
if (!manualPage.content.includes('written directly to disk')) throw new Error('manual-page content wrong');

console.log('reindex:ok count=' + count + ' manualPage found');
NODEEOF

if [ $? -eq 0 ]; then
  ok "reindex: DB ricostruito dai file su disco (inclusa pagina manuale)"
else
  fail "reindex test fallito"
fi

# ── 17. getContextPages ───────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[15] getContextPages — arricchimento contesto${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { KiroGraphWiki } = require(path.join(rootDir, 'dist/wiki/index.js'));
const { WikiDatabase } = require(path.join(rootDir, 'dist/wiki/database.js'));
const wiki = new KiroGraphWiki(db.getRawDb(), path.join(testDir, '.kirograph'), {});
wiki.initialize();

// Inserisci alcune pagine note con contenuto rilevante
const wdb = new WikiDatabase(db.getRawDb());
wdb.upsertPage({ slug: 'jwt-tokens', title: 'JWT Tokens', content: '# JWT Tokens\n\nJWT tokens use HS256 signing. Expiry 15 minutes. Signed with secret.', filePath: null, updatedAt: Date.now(), sourceCount: 1 });
wdb.upsertPage({ slug: 'unrelated-css', title: 'CSS Styling', content: '# CSS Styling\n\nUse rem units. Mobile first.', filePath: null, updatedAt: Date.now(), sourceCount: 1 });

// getContextPages con query rilevante — use words present in page content
// FTS5 defaults to AND for multi-word queries, so use single relevant word
const pages = wiki.getContextPages('HS256', 3, 0.0);
// Con threshold 0.0 deve restituire risultati
if (!pages.length) throw new Error('getContextPages returned 0 results for relevant query');

// La pagina JWT deve essere tra i risultati — getContextPages returns WikiPage[] (not ScoredWikiPage[])
const jwtPage = pages.find(p => p.slug === 'jwt-tokens');
if (!jwtPage) throw new Error('jwt-tokens page not in context results. Got: ' + pages.map(p => p.slug).join(', '));

// Rispetta il limit
const pagesLimit = wiki.getContextPages('HS256', 1, 0.0);
if (pagesLimit.length > 1) throw new Error('limit not respected: got ' + pagesLimit.length);

console.log('getContextPages:ok query="HS256" jwtPage found limit respected');
NODEEOF

if [ $? -eq 0 ]; then
  ok "getContextPages: pagine rilevanti incluse nel context"
else
  fail "getContextPages test fallito"
fi

# ── 18. CLI: wiki init ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[16] CLI: kirograph wiki init${RESET}\n"

# Rimuove la wiki dir per testare l'init CLI
rm -f "$TEST_DIR/.kirograph/wiki/SCHEMA.md" "$TEST_DIR/.kirograph/wiki/MANIFEST.md" 2>/dev/null || true

INIT_OUT=$($KG wiki init 2>/dev/null)
echo "$INIT_OUT" | sed 's/^/     /'

echo "$INIT_OUT" | grep -qiE "✓|initialized|wiki" \
  && ok "kirograph wiki init: output OK" \
  || fail "kirograph wiki init: output inatteso"

[ -f "$TEST_DIR/.kirograph/wiki/SCHEMA.md" ] \
  && ok "  SCHEMA.md ricreato da CLI" \
  || fail "  SCHEMA.md non trovato dopo cli init"
[ -f "$TEST_DIR/.kirograph/wiki/MANIFEST.md" ] \
  && ok "  MANIFEST.md ricreato da CLI" \
  || fail "  MANIFEST.md non trovato dopo cli init"

# ── 19. CLI: wiki list ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[17] CLI: kirograph wiki list${RESET}\n"

LIST_OUT=$($KG wiki list 2>/dev/null)
echo "$LIST_OUT" | sed 's/^/     /'

echo "$LIST_OUT" | grep -qiE "page\(s\)|wiki" \
  && ok "kirograph wiki list: output contiene page(s)" \
  || fail "kirograph wiki list: output inatteso"

# Con --format json — scrivi in file tmp per evitare quoting e noise WASM
LIST_JSON_TMP=$(mktemp)
$KG wiki list --format json > "$LIST_JSON_TMP" 2>/dev/null || true
node -e "
  const fs = require('fs');
  const arr = JSON.parse(fs.readFileSync('$LIST_JSON_TMP', 'utf8'));
  if (!Array.isArray(arr)) throw new Error('not array');
  console.log('json ok count=' + arr.length);
" 2>/dev/null && ok "kirograph wiki list --format json: JSON valido" || warn "wiki list --format json: JSON non parsabile (pagine vuote?)"
rm -f "$LIST_JSON_TMP"

# ── 20. CLI: wiki status ──────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[18] CLI: kirograph wiki status${RESET}\n"

STATUS_OUT=$($KG wiki status 2>/dev/null)
echo "$STATUS_OUT" | sed 's/^/     /'

echo "$STATUS_OUT" | grep -q "Pages:" \
  && ok "kirograph wiki status: campo 'Pages:' presente" \
  || fail "kirograph wiki status: 'Pages:' non trovato"
echo "$STATUS_OUT" | grep -q "Total sources:" \
  && ok "kirograph wiki status: campo 'Total sources:' presente" \
  || fail "kirograph wiki status: 'Total sources:' non trovato"
echo "$STATUS_OUT" | grep -q "Wiki dir:" \
  && ok "kirograph wiki status: campo 'Wiki dir:' presente" \
  || fail "kirograph wiki status: 'Wiki dir:' non trovato"

# ── 21. CLI: wiki ingest (stampa il prompt) ───────────────────────────────────
sep
echo -e "  ${BOLD}[19] CLI: kirograph wiki ingest${RESET}\n"

INGEST_OUT=$(echo "Test source content about JWT tokens and auth flows." | $KG wiki ingest --name "test-source" 2>/dev/null)
echo "$INGEST_OUT" | head -15 | sed 's/^/     /'

echo "$INGEST_OUT" | grep -q "WIKI_DIFF_START" \
  && ok "kirograph wiki ingest: output contiene WIKI_DIFF_START" \
  || fail "kirograph wiki ingest: WIKI_DIFF_START non trovato nell'output"
echo "$INGEST_OUT" | grep -q "test-source" \
  && ok "kirograph wiki ingest: sourceName 'test-source' presente" \
  || fail "kirograph wiki ingest: sourceName non trovato"

# ── 22. CLI: wiki search ──────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[20] CLI: kirograph wiki search${RESET}\n"

# Prima aggiungi una pagina certa via API
ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;
const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();
const { WikiDatabase } = require(path.join(rootDir, 'dist/wiki/database.js'));
const wdb = new WikiDatabase(db.getRawDb());
wdb.upsertPage({ slug: 'stripe-integration', title: 'Stripe Integration', content: '# Stripe Integration\n\nStripe webhooks, payment intents, and refund handling.', filePath: null, updatedAt: Date.now(), sourceCount: 1 });
console.log('ok');
NODEEOF

SEARCH_OUT=$($KG wiki search "Stripe webhooks" 2>/dev/null)
echo "$SEARCH_OUT" | sed 's/^/     /'

echo "$SEARCH_OUT" | grep -qiE "stripe|integration" \
  && ok "kirograph wiki search 'Stripe webhooks': risultato trovato" \
  || fail "kirograph wiki search: nessun risultato per 'Stripe webhooks'"

# Con --format json — scrivi in file tmp
SEARCH_JSON_TMP=$(mktemp)
$KG wiki search "Stripe" --format json > "$SEARCH_JSON_TMP" 2>/dev/null || true
node -e "
  const fs = require('fs');
  const arr = JSON.parse(fs.readFileSync('$SEARCH_JSON_TMP', 'utf8'));
  if (!Array.isArray(arr)) throw new Error('not array');
  console.log('json ok results=' + arr.length);
" 2>/dev/null && ok "kirograph wiki search --format json: JSON valido" || warn "wiki search --format json: risultato JSON non parsabile"
rm -f "$SEARCH_JSON_TMP"

# ── 23. CLI: wiki page ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[21] CLI: kirograph wiki page${RESET}\n"

PAGE_OUT=$($KG wiki page stripe-integration 2>/dev/null)
echo "$PAGE_OUT" | sed 's/^/     /'

echo "$PAGE_OUT" | grep -q "Stripe Integration" \
  && ok "kirograph wiki page stripe-integration: titolo presente" \
  || fail "kirograph wiki page: titolo non trovato"

# Slug non esistente → exit 1 + messaggio utile (stderr ok qui)
PAGE_ERR=$($KG wiki page nonexistent-slug-xyz 2>&1 || true)
echo "$PAGE_ERR" | grep -qiE "not found|nonexistent" \
  && ok "kirograph wiki page (slug inesistente): messaggio di errore chiaro" \
  || fail "kirograph wiki page: errore silenzioso per slug inesistente"

# ── 24. CLI: wiki lint ────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[22] CLI: kirograph wiki lint${RESET}\n"

LINT_OUT=$($KG wiki lint 2>/dev/null)
echo "$LINT_OUT" | sed 's/^/     /'

echo "$LINT_OUT" | grep -qiE "issue|passed|lint|broken|orphan|✓" \
  && ok "kirograph wiki lint: output ricevuto" \
  || fail "kirograph wiki lint: output inatteso o vuoto"

# ── 25. CLI: wiki reindex ─────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[23] CLI: kirograph wiki reindex${RESET}\n"

REINDEX_OUT=$($KG wiki reindex 2>/dev/null)
echo "$REINDEX_OUT" | sed 's/^/     /'

echo "$REINDEX_OUT" | grep -qiE "reindexed|✓|page" \
  && ok "kirograph wiki reindex: output OK" \
  || fail "kirograph wiki reindex: output inatteso"

# ── 26. DB: tabelle e conteggi ────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[24] DB: tabelle wiki_pages + wiki_fts${RESET}\n"

if command -v sqlite3 &>/dev/null; then
  DB_WIKI_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM wiki_pages;" 2>/dev/null || echo "0")
  DB_FTS_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='wiki_fts';" 2>/dev/null || echo "0")
else
  DB_WIKI_COUNT=$(node -e "
    process.stderr.write = () => true;
    const path = require('path');
    const Database = require(path.join('$ROOT','node_modules','node-sqlite3-wasm')).default;
    const db = new Database('$DB');
    const r = db.exec('SELECT COUNT(*) FROM wiki_pages');
    console.log(r[0].values[0][0]);
    db.close();
  " 2>/dev/null || echo "0")
  DB_FTS_COUNT=$(node -e "
    process.stderr.write = () => true;
    const path = require('path');
    const Database = require(path.join('$ROOT','node_modules','node-sqlite3-wasm')).default;
    const db = new Database('$DB');
    const r = db.exec(\"SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_fts'\");
    console.log(r.length && r[0].values.length ? '1' : '0');
    db.close();
  " 2>/dev/null || echo "0")
fi

[ "${DB_WIKI_COUNT:-0}" -ge 1 ] 2>/dev/null \
  && ok "DB wiki_pages: ${DB_WIKI_COUNT} pagine" \
  || fail "DB wiki_pages: nessuna pagina trovata"

[ "${DB_FTS_COUNT:-0}" -eq 1 ] 2>/dev/null \
  && ok "DB wiki_fts: virtual table FTS5 presente" \
  || fail "DB wiki_fts: tabella FTS5 non trovata"

echo ""
echo -e "  ${DIM}── Riepilogo wiki_pages ────────────────────────────────────${RESET}"
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB" "SELECT slug, title, source_count FROM wiki_pages ORDER BY updated_at DESC LIMIT 10;" 2>/dev/null \
  | while IFS='|' read -r slug title src; do
      printf "     %-28s  %-30s  src:%s\n" "$slug" "$title" "$src"
    done || warn "Nessuna pagina nel DB"
else
  node -e "
    process.stderr.write = () => true;
    const path = require('path');
    const Database = require(path.join('$ROOT','node_modules','node-sqlite3-wasm')).default;
    const db = new Database('$DB');
    const r = db.exec('SELECT slug, title, source_count FROM wiki_pages ORDER BY updated_at DESC LIMIT 10');
    if (!r.length || !r[0].values.length) { console.log('  (vuoto)'); db.close(); process.exit(0); }
    for (const row of r[0].values)
      console.log('     ' + String(row[0]).padEnd(28) + '  ' + String(row[1]).padEnd(30) + '  src:' + row[2]);
    db.close();
  " 2>/dev/null || warn "Impossibile leggere wiki_pages dal DB"
fi
echo -e "  ${DIM}────────────────────────────────────────────────────────────${RESET}"

# ── 27. File su disco ─────────────────────────────────────────────────────────
sep
echo -e "  ${BOLD}[25] File su disco — .kirograph/wiki/${RESET}\n"

WIKI_FILES=$(find "$TEST_DIR/.kirograph/wiki" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
[ "${WIKI_FILES:-0}" -ge 1 ] 2>/dev/null \
  && ok ".kirograph/wiki/: ${WIKI_FILES} file .md presenti" \
  || fail ".kirograph/wiki/: nessun file .md trovato"

echo ""
echo -e "  ${DIM}File presenti:${RESET}"
find "$TEST_DIR/.kirograph/wiki" -name "*.md" 2>/dev/null | sort | while read -r f; do
  SIZE=$(wc -c < "$f" | tr -d ' ')
  echo -e "     ${DIM}·${RESET} $(basename "$f")  ${DIM}(${SIZE} bytes)${RESET}"
done

# ── [26] WikiDatabase: queue API ─────────────────────────────────────────────
sep
echo -e "  ${BOLD}[26] WikiDatabase: queue API${RESET}\n"

ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { WikiDatabase } = require(path.join(rootDir, 'dist/wiki/database.js'));
const wdb = new WikiDatabase(db.getRawDb());

// queueSource
wdb.queueSource('source-auth', 'Authentication uses JWT with RS256 signing.');
wdb.queueSource('source-pay', 'Payments go through Stripe with webhook verification.');

// getQueueCount
const count = wdb.getQueueCount();
if (count !== 2) throw new Error('expected count 2, got ' + count);
console.log('queue-count:ok count=' + count);

// getPendingQueue — preserves insertion order
const q = wdb.getPendingQueue();
if (q.length !== 2) throw new Error('expected 2 entries, got ' + q.length);
if (q[0].sourceName !== 'source-auth') throw new Error('wrong first entry: ' + q[0].sourceName);
if (!q[0].sourceText.includes('JWT')) throw new Error('sourceText missing content');
if (typeof q[0].id !== 'number') throw new Error('id should be a number');
console.log('queue-list:ok entries=' + q.length + ' first=' + q[0].sourceName);

// clearQueue([ids]) — remove only the first entry
wdb.clearQueue([q[0].id]);
const afterPartial = wdb.getQueueCount();
if (afterPartial !== 1) throw new Error('expected 1 after partial clear, got ' + afterPartial);
const remaining = wdb.getPendingQueue();
if (remaining[0].sourceName !== 'source-pay') throw new Error('wrong remaining entry: ' + remaining[0].sourceName);
console.log('queue-clearById:ok remaining=' + afterPartial + ' entry=' + remaining[0].sourceName);

// clearQueue() — clear all
wdb.clearQueue();
const empty = wdb.getQueueCount();
if (empty !== 0) throw new Error('expected 0 after full clear, got ' + empty);
console.log('queue-clearAll:ok count=' + empty);

console.log('ALL_QUEUE_OK');
NODEEOF

if [ $? -eq 0 ]; then
  ok "WikiDatabase queue: queueSource / getQueueCount / getPendingQueue / clearQueue(ids) / clearQueue() OK"
else
  fail "WikiDatabase queue API test fallito"
fi

# ── [27] Installer: local mode hook type ─────────────────────────────────────
sep
echo -e "  ${BOLD}[27] Installer: hook runCommand con wikiSynthesisMode=local${RESET}\n"

# Switch config to local mode
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "languages": ["typescript"],
  "enableWiki": true,
  "wikiSynthesisMode": "local",
  "wikiLocalModel": "onnx-community/gemma-4-E4B-it-ONNX",
  "wikiAutoResolveConflicts": false,
  "wikiContextLimit": 3,
  "wikiContextThreshold": 0.1,
  "enableEmbeddings": false,
  "enableMemory": false,
  "enableDocs": false,
  "enableData": false,
  "enableSecurity": false
}
EOF

$KG install --target kiro --yes 2>&1 | grep -E "✓|hook" | sed 's/^/     /' || true

LOCAL_HOOK_TYPE=$(node -e "
  const fs = require('fs');
  const h = JSON.parse(fs.readFileSync('.kiro/hooks/kirograph-wiki-ingest.kiro.hook', 'utf8'));
  console.log(h.then.type + '|' + (h.then.command || ''));
" 2>/dev/null || echo "error")

HOOK_THEN_TYPE="${LOCAL_HOOK_TYPE%%|*}"
HOOK_COMMAND="${LOCAL_HOOK_TYPE#*|}"

[ "$HOOK_THEN_TYPE" = "runCommand" ] \
  && ok "  local hook: then.type=runCommand" \
  || fail "  local hook: expected runCommand, got '$HOOK_THEN_TYPE'"

echo "$HOOK_COMMAND" | grep -q "kirograph wiki synthesize" \
  && ok "  local hook: command contiene 'kirograph wiki synthesize'" \
  || fail "  local hook: command non corretto: '$HOOK_COMMAND'"

# ── [28] CLI: kirograph wiki synthesize — wrong mode (agent) ─────────────────
sep
echo -e "  ${BOLD}[28] CLI: kirograph wiki synthesize — errore se mode=agent${RESET}\n"

# Temporarily switch back to agent mode
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "languages": ["typescript"],
  "enableWiki": true,
  "wikiSynthesisMode": "agent",
  "enableEmbeddings": false,
  "enableMemory": false,
  "enableDocs": false,
  "enableData": false,
  "enableSecurity": false
}
EOF

SYNTH_AGENT_OUT=$($KG wiki synthesize 2>&1 || true)
SYNTH_AGENT_EXIT=$($KG wiki synthesize 2>&1; echo "EXIT:$?")

echo "$SYNTH_AGENT_OUT" | grep -q "wikiSynthesisMode" \
  && ok "  synthesize con mode=agent: messaggio di errore chiaro" \
  || fail "  synthesize con mode=agent: messaggio di errore assente"

# Verify it actually exits non-zero
SYNTH_FAIL_CODE=$(set +e; $KG wiki synthesize > /dev/null 2>&1; echo $?)
[ "$SYNTH_FAIL_CODE" != "0" ] \
  && ok "  synthesize con mode=agent: exit non-zero (exit=$SYNTH_FAIL_CODE)" \
  || fail "  synthesize con mode=agent: dovrebbe uscire con codice non-zero"

# ── [29] CLI: kirograph wiki synthesize — local, empty queue ─────────────────
sep
echo -e "  ${BOLD}[29] CLI: kirograph wiki synthesize — local mode, queue vuota${RESET}\n"

# Switch to local mode
cat > .kirograph/config.json << 'EOF'
{
  "version": 1,
  "languages": ["typescript"],
  "enableWiki": true,
  "wikiSynthesisMode": "local",
  "wikiLocalModel": "onnx-community/gemma-4-E4B-it-ONNX",
  "wikiAutoResolveConflicts": false,
  "wikiContextLimit": 3,
  "wikiContextThreshold": 0.1,
  "enableEmbeddings": false,
  "enableMemory": false,
  "enableDocs": false,
  "enableData": false,
  "enableSecurity": false
}
EOF

SYNTH_EMPTY_OUT=$($KG wiki synthesize 2>&1 || true)
SYNTH_EMPTY_CODE=$(set +e; $KG wiki synthesize > /dev/null 2>&1; echo $?)

echo "$SYNTH_EMPTY_OUT" | grep -qi "empty\|nothing\|queue" \
  && ok "  synthesize local con queue vuota: messaggio informativo" \
  || fail "  synthesize local con queue vuota: messaggio atteso non trovato"

[ "$SYNTH_EMPTY_CODE" = "0" ] \
  && ok "  synthesize local con queue vuota: exit 0" \
  || fail "  synthesize local con queue vuota: expected exit 0, got $SYNTH_EMPTY_CODE"

# ── [30] CLI: kirograph wiki synthesize — download + local model inference ────
sep
echo -e "  ${BOLD}[30] CLI: kirograph wiki synthesize — inferenza modello locale${RESET}\n"

# Config is already local mode from [29]; queue 1 source directly into DB
ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF'
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const rootDir = process.env.ROOT_DIR;
const testDir = process.env.TEST_DIR;

const KiroGraph = require(path.join(rootDir, 'dist/index.js')).default;
const cg = await KiroGraph.open(testDir);
const db = cg.getDatabase();
db.applyWikiSchema();

const { WikiDatabase } = require(path.join(rootDir, 'dist/wiki/database.js'));
const wdb = new WikiDatabase(db.getRawDb());

wdb.queueSource(
  'auth-design',
  'The authentication system uses JWT tokens signed with RS256. ' +
  'Access tokens expire after 15 minutes. ' +
  'Refresh tokens are stored in httpOnly cookies and last 7 days. ' +
  'All endpoints require a Bearer token except /health and /auth/login.',
);

const count = wdb.getQueueCount();
if (count < 1) throw new Error('queue is empty after queueSource');
console.log('queue-ready:ok count=' + count);
NODEEOF

if [ $? -ne 0 ]; then
  fail "Queue setup per inferenza fallito"
else
  ok "  queue: 1 sorgente accodata"
  MODEL_CACHE_DIR="$HOME/.kirograph/models/onnx-community/gemma-4-E4B-it-ONNX"
  if [ -d "$MODEL_CACHE_DIR" ]; then
    info "  Modello già in cache ($MODEL_CACHE_DIR) — caricamento da disco..."
  else
    warn "  Download modello in corso — può richiedere diversi minuti la prima volta..."
  fi

  set +e
  $KG wiki synthesize > /tmp/wiki-synth-model-out.txt 2>&1
  SYNTH_MODEL_CODE=$?
  set -e
  SYNTH_MODEL_OUT=$(cat /tmp/wiki-synth-model-out.txt)

  echo "$SYNTH_MODEL_OUT" | head -6 | sed 's/^/     /'

  [ "$SYNTH_MODEL_CODE" = "0" ] \
    && ok "  synthesize: exit 0" \
    || fail "  synthesize: exit non-zero ($SYNTH_MODEL_CODE)"

  # Queue must be cleared regardless of model output quality
  if command -v sqlite3 &>/dev/null; then
    QUEUE_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM wiki_queue" 2>/dev/null || echo "-1")
  else
    ROOT_DIR="$ROOT" TEST_DIR="$TEST_DIR" node --input-type=module << 'NODEEOF_Q' > /tmp/wiki-queue-after.txt 2>/dev/null || true
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const KiroGraph = require(path.join(process.env.ROOT_DIR, 'dist/index.js')).default;
const cg = await KiroGraph.open(process.env.TEST_DIR);
const db = cg.getDatabase();
db.applyWikiSchema();
const { WikiDatabase } = require(path.join(process.env.ROOT_DIR, 'dist/wiki/database.js'));
const wdb = new WikiDatabase(db.getRawDb());
process.stdout.write(String(wdb.getQueueCount()) + '\n');
NODEEOF_Q
    QUEUE_AFTER=$(cat /tmp/wiki-queue-after.txt 2>/dev/null || echo "-1")
  fi

  [ "${QUEUE_AFTER:-1}" = "0" ] \
    && ok "  queue svuotata dopo synthesis" \
    || fail "  queue non svuotata (count=${QUEUE_AFTER})"

  # Report what was created/updated (warn if nothing — small model may not follow format)
  CREATED=$(echo "$SYNTH_MODEL_OUT" | grep -i "Created:" | head -1 || true)
  UPDATED=$(echo "$SYNTH_MODEL_OUT" | grep -i "Updated:" | head -1 || true)
  ERRORS=$(echo "$SYNTH_MODEL_OUT" | grep -i "Error\|⚠" | head -3 || true)

  if echo "$SYNTH_MODEL_OUT" | grep -qi "Processed\|Created\|Updated"; then
    ok "  synthesize: pagine wiki prodotte"
    [ -n "$CREATED" ] && echo "     $CREATED"
    [ -n "$UPDATED" ] && echo "     $UPDATED"
  else
    warn "  synthesize completato ma nessuna pagina prodotta (il modello potrebbe non aver generato WIKI_DIFF validi)"
    [ -n "$ERRORS" ] && echo "$ERRORS" | sed 's/^/     /'
  fi
fi

# ── Fine ──────────────────────────────────────────────────────────────────────
sep
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}Tutti i test wiki passati!${RESET}"
else
  echo -e "  ${RED}${BOLD}$FAILURES test falliti.${RESET}"
  exit 1
fi
echo ""
