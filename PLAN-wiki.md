# KiroGraph-Wiki — Piano di implementazione v0.25.0

> Ispirato al pattern **LLM Wiki** di Andrej Karpathy
> (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
>
> Branch: `feature/llmwiki`
> Versione target: `0.25.0`

---

## 1. Perché un modulo wiki — differenza con memory

KiroGraph-Mem e KiroGraph-Wiki sono complementari, non alternativi:

| | KiroGraph-Mem | KiroGraph-Wiki |
|---|---|---|
| **Unità** | Osservazione atomica (un fatto) | Pagina per entità/concetto (sintesi) |
| **Crescita** | Accumulo bottom-up (append-only) | Integrazione top-down (pagine aggiornate) |
| **Chi scrive** | LLM scrive fatti grezzi | LLM sintetizza e aggiorna pagine esistenti |
| **Compounding** | No — ogni obs è isolata | Sì — ogni ingest converge nelle pagine |
| **Output** | SQLite → ricerca a runtime | Markdown in `.kirograph/wiki/` → leggibili direttamente |
| **Stale** | `reviewAfter` per osservazione | Lint periodico + auto-resolve per data |
| **Analogia** | Git log | Wikipedia |

**Flusso tipico combinato:**

```
Sessione → mem_store (fatti atomici)
         → Watchmen threshold → LLM sintetizza brief
         → wiki ingest brief → pagine entità aggiornate (AuthService.md, arch/auth-model.md)
```

Il wiki è il layer di sintesi duratura; memory è il buffer di fatti grezzi di sessione.

---

## 2. Architettura

### 2.1 Tre layer (fedele a Karpathy)

```
Raw sources (immutabili)
  docs/, ADR/, RFC/, note, brief Watchmen, PR description, stdin
       ↓  kirograph wiki ingest <source>
Wiki (.kirograph/wiki/*.md)           ← LLM-owned, human-readable
  AuthService.md, rate-limiter.md
  arch/auth-model.md
  pattern/error-handling.md
       ↓  kirograph_wiki_search / kirograph_wiki_page / kirograph_context
Risposta con citazioni
  "secondo arch/auth-model.md §Decisions (2025-06-10)..."
```

### 2.2 Schema

`.kirograph/wiki/SCHEMA.md` — generato da `kirograph wiki init`, editabile dall'utente.
Il file è incluso nel prompt di ogni ingest in modo che il LLM segua le convenzioni del progetto.

Contenuto default:

```markdown
# Wiki Schema

## Naming convention
- Entità codice: <ClassName>.md, <module-name>.md
- Decisioni architetturali: arch/<slug>.md
- Pattern ricorrenti: pattern/<slug>.md
- Integrazioni esterne: ext/<service>.md

## Struttura pagina standard
- ## Summary (1-3 righe — cosa è, perché esiste)
- ## Decisions (lista datata: YYYY-MM-DD — decisione)
- ## Known Issues / Gotchas
- ## Related (link ad altre pagine wiki con slug)
- ## Sources (sorgenti usate per aggiornare questa pagina)

## Ingest workflow
1. Leggi la sorgente
2. Identifica entità menzionate → cerca pagine esistenti in MANIFEST.md
3. Per ogni pagina esistente: integra nuove info nelle sezioni appropriate
4. Per ogni nuova entità rilevante: crea pagina con struttura standard
5. Aggiorna ## Sources con nome sorgente e data
6. Aggiorna ## Related cross-reference in tutte le pagine toccate
7. Segnala contraddizioni trovate rispetto alle pagine esistenti
```

### 2.3 Diff format (Karpathy-style)

L'LLM produce output strutturato che KiroGraph applica deterministicamente.
Formato: un blocco JSON per ogni pagina toccata, poi il contenuto markdown della sezione.

```
WIKI_DIFF_START
{"action":"upsert","page":"AuthService","section":"Decisions","mode":"append"}
- 2025-06-15 — Token store rimane in-memory; Redis rivalutare dopo scaling a 10k RPS
WIKI_DIFF_END
WIKI_DIFF_START
{"action":"create","page":"arch/auth-model","title":"Auth Model"}
## Summary
AuthService gestisce emissione e validazione token JWT...
## Decisions
- 2025-06-15 — In-memory token store per semplicità in sviluppo
## Sources
- ADR-001.md (2025-06-15)
WIKI_DIFF_END
WIKI_DIFF_CONFLICTS
{"page":"rate-limiter","section":"Decisions","existing":"Redis sliding window","incoming":"In-memory sliding window","source":"ADR-002.md","existingDate":"2025-05-01","incomingDate":"2025-06-15"}
WIKI_DIFF_CONFLICTS_END
```

Il parser di KiroGraph legge i blocchi `WIKI_DIFF_START/END` e applica le operazioni;
i blocchi `WIKI_DIFF_CONFLICTS` vengono gestiti separatamente (vedi §2.4).

### 2.4 Conflict resolution (auto-resolve opt-in)

Quando il diff contiene `WIKI_DIFF_CONFLICTS`:

- **Default (opt-in: false):** segnala i conflitti come warning in output, non auto-risolve
- **`wikiAutoResolveConflicts: true`:** auto-resolve per data — la sorgente con `incomingDate` più recente vince, la sezione viene sovrascritta, viene aggiunta una nota `> ⚠ Superseded by <source> on <date>`

Nessun LLM aggiuntivo: la risoluzione è deterministica sulla data.

### 2.5 Storage

```
.kirograph/
  wiki/
    SCHEMA.md              ← config LLM (editabile)
    MANIFEST.md            ← indice: slug | title | updated_at | source_count
    AuthService.md
    rate-limiter.md
    arch/
      auth-model.md
    pattern/
      error-handling.md
  kirograph.db             ← tabella wiki_pages per FTS
```

**Schema SQLite** (aggiunta a `memory-schema.sql` o nuovo `wiki-schema.sql`):

```sql
CREATE TABLE IF NOT EXISTS wiki_pages (
  slug      TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  content   TEXT NOT NULL,
  file_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  source_count INTEGER DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts
  USING fts5(slug, title, content, content='wiki_pages', content_rowid='rowid');
```

I file `.md` sono source of truth. SQLite è un indice rigenerabile via `kirograph wiki reindex`.

---

## 3. Integrazione con `kirograph_context`

`kirograph_context(task)` includerà automaticamente pagine wiki rilevanti nel risultato.

**Logica:**
1. La ricerca FTS sul wiki usa la stessa query del context
2. Le pagine wiki con score > soglia vengono incluse come sezione `## Wiki` nella risposta
3. Ogni pagina è troncata a max 400 token (solo Summary + Decisions)
4. L'agente vede le pagine wiki accanto ai simboli del grafo senza tool call aggiuntiva

Configurable via `wikiContextLimit` (default: 3 pagine) e `wikiContextThreshold` (default: 0.4).

---

## 4. Synthesis modes (come Watchmen)

Due modalità di ingest (analoghe a `watchmenSynthesisMode`):

### `local` — modello HF locale

```bash
kirograph wiki ingest docs/ADR-001.md --model Xenova/LaMini-Flan-T5-783M
```

Il modello locale produce il diff. Qualità inferiore ma zero costo API.
Stessa infrastruttura di `runLocalSynthesis` in Watchmen.

### `agent` — LLM dell'IDE (default)

L'ingest avviene tramite `askAgent` hook su Kiro, o tramite istruzioni su altri target.
L'agente chiama `kirograph_wiki_ingest(source)` → il tool ritorna SCHEMA.md + MANIFEST.md + contenuto sorgente come prompt → l'agente produce il diff → `kirograph_wiki_apply_diff(diff)` applica le modifiche.

Separazione in due tool per dare all'agente il controllo sul diff prima di applicarlo:

| Tool | Cosa fa |
|---|---|
| `kirograph_wiki_ingest(source)` | Legge sorgente, ritorna prompt per il LLM (SCHEMA + MANIFEST + content) |
| `kirograph_wiki_apply_diff(diff)` | Applica il diff WIKI_DIFF al filesystem e SQLite |
| `kirograph_wiki_search(query)` | FTS sulle pagine wiki |
| `kirograph_wiki_page(slug)` | Ritorna pagina completa |
| `kirograph_wiki_lint()` | Health check contraddizioni, orfani, stale |
| `kirograph_wiki_list()` | MANIFEST.md come struttura navigabile |

---

## 5. Hooks

### 5.1 Kiro — hook generati da `kirograph install`

**`kirograph-wiki-ingest.kiro.hook`** (se `enableWiki: true`):

```json
{
  "name": "KiroGraph Wiki Ingest",
  "version": "1.0.0",
  "description": "After session, ingest significant decisions into the project wiki.",
  "when": { "type": "agentStop" },
  "then": {
    "type": "askAgent",
    "prompt": "Review this session. If there are durable architectural decisions, entity-level patterns, or integration insights worth preserving in the project wiki, call kirograph_wiki_ingest to get the prompt, then produce a WIKI_DIFF and call kirograph_wiki_apply_diff. Focus on entities (classes, modules, services) and architecture decisions, not ephemeral session details. Skip if nothing wiki-worthy happened."
  }
}
```

**`kirograph-wiki-lint.kiro.hook`** (se `wikiLintFrequency: "weekly"`):

```json
{
  "name": "KiroGraph Wiki Lint",
  "version": "1.0.0",
  "description": "Periodically check the wiki for contradictions and stale content.",
  "when": { "type": "agentStop", "every": 20 },
  "then": {
    "type": "askAgent",
    "prompt": "Run kirograph_wiki_lint. For each issue found: contradictions — report which page should be authoritative and why; orphan pages — suggest which entity they relate to; stale sources — flag but do not auto-fix."
  }
}
```

### 5.2 Target non-Kiro

Nessun hook nativo. Il wiki funziona via:

1. **Istruzioni nel system prompt** (`buildAgentInstructions` in `instructions.ts`):
   - Tabella quick-guide con `kirograph_wiki_search`, `kirograph_wiki_page`, `kirograph_wiki_ingest`
   - Session hygiene: "before ending, if wiki-worthy decisions were made, call `kirograph_wiki_ingest`"

2. **CLI manuale**: l'utente triggera `kirograph wiki ingest <file>` fuori dall'agente

3. **`local` mode**: su qualsiasi target, `kirograph wiki ingest --local` usa il modello HF senza LLM dell'agente

| | Kiro | Claude Code | Cursor / Cline / Roo | Altri |
|---|---|---|---|---|
| Hook agentStop | ✅ askAgent | ❌ | ❌ | ❌ |
| System prompt | ✅ steering | ✅ CLAUDE.md | ✅ rules file | ✅ instructions |
| CLI manuale | ✅ | ✅ | ✅ | ✅ |
| Local mode | ✅ | ✅ | ✅ | ✅ |
| MCP tools | ✅ | ✅ | ✅ | ✅ |

---

## 6. Config

Aggiunta a `.kirograph/config.json`:

```json
{
  "enableWiki": true,
  "wikiSynthesisMode": "agent",
  "wikiLocalModel": "Xenova/LaMini-Flan-T5-783M",
  "wikiSources": ["docs/", "ADR/"],
  "wikiAutoResolveConflicts": false,
  "wikiLintFrequency": "off",
  "wikiContextLimit": 3,
  "wikiContextThreshold": 0.4
}
```

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `enableWiki` | boolean | `false` | Abilita il modulo wiki |
| `wikiSynthesisMode` | `"agent"` \| `"local"` | `"agent"` | Modalità ingest LLM |
| `wikiLocalModel` | string | `"Xenova/LaMini-Flan-T5-783M"` | Modello HF per local mode |
| `wikiSources` | string[] | `["docs/"]` | Glob sorgenti predefinite |
| `wikiAutoResolveConflicts` | boolean | `false` | Auto-resolve conflitti per data |
| `wikiLintFrequency` | `"weekly"` \| `"off"` | `"off"` | Frequenza hook lint |
| `wikiContextLimit` | number | `3` | Max pagine wiki in kirograph_context |
| `wikiContextThreshold` | number | `0.4` | Score minimo per includere pagina in context |

---

## 7. Installer interattivo

`kirograph install -i` aggiunge un nuovo blocco di domande dopo `enableMemory`:

```
? Enable KiroGraph Wiki? (Persistent structured knowledge base — LLM-maintained markdown pages per entity) (y/N)

  If yes:
  ? Wiki synthesis mode:
    ❯ agent  — use the IDE's LLM to write wiki pages (best quality)
      local  — use a local HuggingFace model (zero API cost)

  ? Auto-resolve conflicts between pages by source date? (y/N)

  ? Wiki lint frequency:
    ❯ off     — lint manually with `kirograph wiki lint`
      weekly  — lint every ~20 agent sessions
```

File da modificare: `src/bin/installer/config-prompt.ts`

---

## 8. Steering e istruzioni

### 8.1 Kiro steering

**In `kirograph.md` (inclusion: always)** — aggiunta sezione `## Wiki` (se `enableWiki: true`):

```markdown
## Wiki

KiroGraph mantiene un wiki strutturato in `.kirograph/wiki/`. Usa le pagine wiki prima di
leggere file di documentazione o prendere decisioni architetturali.

| Domanda | Tool |
|---------|------|
| Cosa sappiamo su questo modulo/classe? | `kirograph_wiki_search` |
| Leggi la pagina completa di un'entità | `kirograph_wiki_page` |
| Aggiorna il wiki con nuove decisioni | `kirograph_wiki_ingest` → `kirograph_wiki_apply_diff` |
| Lista tutte le pagine wiki | `kirograph_wiki_list` |
| Contraddizioni nel wiki? | `kirograph_wiki_lint` |

Le pagine wiki appaiono automaticamente in `kirograph_context` quando rilevanti.
Per il workflow completo: `.kiro/steering/kirograph-wiki-workflow.md`
```

**Nuovo file skill `kirograph-wiki-workflow.md` (inclusion: manual)**:
- Step 1: Search before acting
- Step 2: Ingest (agent mode: ingest → produce diff → apply_diff)
- Step 3: Ingest (local mode: CLI)
- Step 4: Lint
- Step 5: Auto-resolve conflicts
- Quick reference table

### 8.2 Non-Kiro (instructions.ts)

Aggiunta a `buildAgentInstructions` se `enableWiki: true`:

```markdown
## Wiki

KiroGraph maintains a structured wiki in `.kirograph/wiki/`.
Use `kirograph_wiki_search` to find what's known about a module or decision before acting.
Use `kirograph_wiki_page` to read a full entity page.

Before ending: if architectural decisions, entity-level patterns, or integration insights
were made this session, call `kirograph_wiki_ingest` to get the ingest prompt, produce a
WIKI_DIFF following the SCHEMA.md format, then call `kirograph_wiki_apply_diff`.
```

Quick guide nel decision table (riga aggiunta):
```
| What's known about this module? | `kirograph_wiki_search` |
```

---

## 9. File da creare / modificare

### Nuovi file
- `src/wiki/schema.ts` — default SCHEMA.md template + parser diff WIKI_DIFF
- `src/wiki/database.ts` — SQLite wiki_pages + wiki_fts + MANIFEST
- `src/wiki/ingest.ts` — local synthesis (HF), apply_diff, conflict resolution
- `src/wiki/lint.ts` — contraddizioni, orfani, stale sources
- `src/wiki/index.ts` — API pubblica: ingest, applyDiff, search, page, lint, list, reindex
- `src/mcp/wiki-tool-names.ts`
- `src/bin/commands/wiki.ts` — CLI: ingest, apply-diff, search, page, lint, list, reindex, init
- `scripts/wiki/test.sh`
- `scripts/wiki/mock/` — sorgenti mock (ADR-001.md, ADR-002.md, note di sessione)

### File modificati
- `src/db/wiki-schema.sql` — nuovo (o aggiunto a memory-schema.sql)
- `src/mcp/tools.ts` — 6 nuovi tool wiki
- `src/config.ts` — enableWiki, wikiSynthesisMode, wikiSources, ecc.
- `src/core/context.ts` — integrazione wiki in kirograph_context
- `src/bin/installer/hooks.ts` — hook wiki-ingest + wiki-lint (Kiro)
- `src/bin/installer/steering.ts` — sezione ## Wiki + skill file kirograph-wiki-workflow.md
- `src/bin/installer/instructions.ts` — sezione ## Wiki + session hygiene (non-Kiro)
- `src/bin/installer/index.ts` — propagazione enableWiki
- `src/bin/installer/targets/kiro.ts` — propagazione a writeHooks
- `src/bin/installer/config-prompt.ts` — domande wiki nell'installer interattivo
- `CHANGELOG.md` — entry v0.25.0
- `README.md` — feature table + inspirations (Karpathy/LLM Wiki pattern)
- `docs/docs.html` — sezione Wiki + tabella comparativa + Karpathy nelle inspirations
- `docs/index.html` — timeline v0.25.0 + tabella capabilities (colonna wiki)
- `docs/guide/comparison.md` — riga wiki nel feature matrix

---

## 10. Changelog entry (da prepend in CHANGELOG.md)

```markdown
## [0.25.0] — 2025-06-XX

### Added — KiroGraph-Wiki

- **`enableWiki`** — new module: LLM-maintained structured wiki per entity in `.kirograph/wiki/`
- **`kirograph_wiki_ingest`** — returns ingest prompt (SCHEMA + MANIFEST + source content) for LLM to produce a WIKI_DIFF
- **`kirograph_wiki_apply_diff`** — applies WIKI_DIFF to filesystem + SQLite index atomically
- **`kirograph_wiki_search`** — FTS search over wiki pages
- **`kirograph_wiki_page`** — retrieve full wiki page by slug
- **`kirograph_wiki_lint`** — health check: contradictions, orphan pages, stale sources
- **`kirograph_wiki_list`** — MANIFEST.md as navigable structured list
- **CLI**: `kirograph wiki ingest|search|page|lint|list|reindex|init`
- **`wikiSynthesisMode`**: `agent` (IDE LLM) or `local` (HuggingFace, zero API cost)
- **`wikiAutoResolveConflicts`**: deterministic conflict resolution by source date
- **`kirograph_context` enrichment**: wiki pages auto-surface alongside code symbols
- **Kiro hooks**: `kirograph-wiki-ingest.kiro.hook` (agentStop) + optional `kirograph-wiki-lint.kiro.hook`
- **Steering**: `kirograph-wiki-workflow.md` skill file (inclusion: manual)
- **Installer**: interactive prompts for wiki config (`kirograph install -i`)
- Inspired by the LLM Wiki pattern by Andrej Karpathy
```

---

## 11. README — sezione da aggiornare

- Feature table: aggiunta riga "Wiki — LLM-maintained entity pages"
- Inspirations: aggiunto "LLM Wiki pattern by Andrej Karpathy"
- Quick start: menzione enableWiki in config example

## 12. docs.html — sezioni da aggiungere/modificare

- Nuova sezione `#wiki` con: intro, how it works (ingest→diff→apply), WIKI_DIFF format, synthesis modes, conflict resolution, kirograph_context integration
- Tabella MCP tools wiki
- CLI commands wiki
- Config table wiki
- Inspirations: Andrej Karpathy / LLM Wiki pattern
- Comparison table: aggiunta colonna "Wiki" per tutti i comparables (nessuno ha questo)

## 13. index.html — modifiche

- Timeline: aggiunta `v0.25.0 — KiroGraph-Wiki`
- "One tool, N capabilities": aggiunta riga "LLM-maintained wiki" con ✅ solo KiroGraph
- Heading aggiornato al nuovo conteggio

---

## Decisioni prese

| # | Domanda | Decisione |
|---|---|---|
| 1 | LLM per ingest | Entrambi: `agent` (IDE LLM via askAgent/tool) e `local` (HF, come Watchmen) |
| 2 | Diff format | WIKI_DIFF block format (Karpathy-style, deterministico) |
| 3 | Conflitti | Auto-resolve per data sorgente se `wikiAutoResolveConflicts: true` (default: false) |
| 4 | kirograph_context | Sì — pagine wiki auto-incluse accanto ai simboli del grafo |
| 5 | Versione + branch | v0.25.0, branch `feature/llmwiki` |
