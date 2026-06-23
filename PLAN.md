# KiroGraph × PixelRAG — Bridge Plan

> **⚠ EXPERIMENTAL** — This feature is experimental. The API, config fields, and CLI commands may change in any release without notice. Not recommended for production use or resource-constrained machines.

## Goal

Integrazione trasparente di PixelRAG in KiroGraph: l'utente abilita `enableVisualPDF: true` nella config e non deve fare nient'altro. KiroGraph si occupa di verificare Python, installare PixelRAG, costruire l'indice e tenere il server in vita per tutta la sessione.

---

## Hardware minimo

Visual PDF search richiede risorse significativamente superiori al resto di KiroGraph. Prima di abilitare la feature, l'utente deve soddisfare questi requisiti:

| Risorsa | Minimo | Raccomandato |
|---------|--------|--------------|
| RAM | 8 GB | 16 GB |
| Disco libero | 6 GB | 10 GB+ |
| CPU | qualsiasi x64/ARM64 | — |
| GPU/NPU | non richiesta | Apple Silicon MPS, CUDA ≥ 8 GB VRAM |
| Python | 3.10+ | 3.11+ |
| OS | macOS 12, Linux (glibc 2.31+) | — |

**Windows nativo non è supportato.** PixelRAG usa percorsi Unix e `fork` subprocess — non funziona su Windows nativo.

**WSL2:** tecnicamente possibile ma con limitazioni importanti da comunicare all'utente:
- La RAM disponibile per WSL2 è condivisa con Windows — su una macchina da 16 GB, WSL2 può usarne al massimo 8 GB di default (configurabile in `.wslconfig`). Con meno di 8 GB allocati a WSL2 il server potrebbe non avviarsi.
- MPS non è disponibile su WSL2 (è Apple Silicon only). CUDA è disponibile solo se il driver Windows lo espone a WSL2 (richiede driver NVIDIA aggiornato + `CUDA on WSL`).
- I path Windows (`C:\...`) non sono accettati da PixelRAG — il progetto deve essere dentro il filesystem Linux di WSL2 (`/home/...`), non montato da Windows (`/mnt/c/...`), altrimenti le performance I/O degradano significativamente e il rendering PDF rallenta.

KiroGraph deve rilevare l'ambiente WSL2 a runtime (`/proc/version` contiene `microsoft` o `WSL`) e mostrare un warning al bootstrap:

```
⚠ WSL2 detected. Visual PDF search has known limitations on WSL2:
  • Ensure your project is on the Linux filesystem (/home/...), not /mnt/c/...
  • Allocate at least 8 GB to WSL2 in %USERPROFILE%\.wslconfig
  • CUDA requires updated NVIDIA drivers with WSL2 support
  See docs for details.
```

### Perché i requisiti sono alti

- `pixelrag-serve` carica Qwen3-VL-Embedding-2B in memoria all'avvio: **4–6 GB RAM**
- L'indice include tile PNG renderizzate dai PDF: **~500 KB/tile**, facilmente centinaia di MB per doc set grandi
- Su CPU senza accelerazione, l'index build è lento: ~5–20 secondi per tile

### Cosa succede se la macchina è al limite

Su macchine con 8 GB RAM il modello può entrare, ma con sistema operativo + Kiro + pixelrag-serve attivi simultaneamente si rischia swapping. KiroGraph deve:
1. Controllare RAM disponibile prima di avviare `pixelrag-serve` (non totale, ma libera)
2. Se disponibile < 4 GB: warning bloccante con istruzione esplicita, non avvia il server
3. Se disponibile 4–6 GB: warning non bloccante ("performance may be degraded")

---

## Architettura

```
kirograph index
    │
    ├─ verifica Python → installa pixelrag se manca
    ├─ pixelrag-index build (sui PDF flaggati needs_ocr/is_complex_layout)
    └─ salva .kirograph/pixelrag-index/

MCP server startup
    │
    └─ spawna pixelrag-serve come child process
         │  poll /health fino a ready
         └─ resta in vita per tutta la sessione

Kiro / agent
    │
    ▼
kirograph_pdf_visual_search("revenue Q3 chart")
    │  POST /search
    ▼
PixelRAG FastAPI  (localhost:30001)
    │
    ▼
VisualSearchResult[]
```

---

## Lifecycle in 4 fasi

### Fase 1 — Verifica Python (al momento di `kirograph index`)

```
python3 --version  →  OK: continua
                   →  KO: stampa messaggio chiaro:
                       "PixelRAG requires Python 3.10+.
                        Install from https://python.org, then re-run kirograph index."
                       Exit — non blocca il resto di kirograph index
```

### Fase 2 — Installazione PixelRAG (se Python c'è)

```
python3 -c "import pixelrag_serve"  →  OK: già installato
                                    →  KO: esegue:
                                        python3 -m pip install 'pixelrag[index,serve]'
                                        (con output in streaming, stesso pattern del progress bar di kirograph install)
```

Entrambe le verifiche vivono in `src/data/pixelrag-manager.ts`, funzione `ensurePixelRAGInstalled()`.

### Fase 3 — Build indice (durante `kirograph index`)

**Selezione PDF:** non si passa l'intera root del progetto. KiroGraph legge dal proprio DB i PDF già analizzati da `@firecrawl/pdf-inspector` con flag `needs_ocr: true` o `is_complex_layout: true`, e passa solo quelli a PixelRAG. I PDF senza layout complesso non ne hanno bisogno e rallenterebbero l'indicizzazione inutilmente.

```
python3 -m pixelrag_index build \
  --source-files .kirograph/pixelrag-targets.txt \
  --output .kirograph/pixelrag-index \
  --device auto
```

dove `.kirograph/pixelrag-targets.txt` è un file di testo con un path PDF per riga, generato da KiroGraph prima della chiamata.

**Staleness / quando ricostruire l'indice:**

KiroGraph mantiene `.kirograph/pixelrag-manifest.json`: lista di `{path, mtime, size}` dei PDF indicizzati.

| Condizione | Azione |
|---|---|
| Indice non esiste | build completa |
| `--force` passato | build completa |
| Nuovi PDF flaggati non nel manifest | build completa (PixelRAG non supporta incremental append) |
| PDF rimossi o mtime cambiato | build completa |
| Manifest identico ai PDF flaggati attuali | skip — "PixelRAG index up to date" |

La build completa è necessaria anche per piccole modifiche perché FAISS IVFFlat non supporta insert incrementale senza retrain.

- `--device auto` lascia a PixelRAG la scelta (MPS su Apple Silicon, CUDA su GPU, CPU fallback)
- Output streamato in console (stesso pattern di `kirograph install`)

### Fase 4 — Server lifecycle (MCP server startup / shutdown)

In `src/index.ts` (entry point del server MCP), se `enableVisualPDF && pixelragEndpoint` punta a localhost:

```
isRunning = GET http://localhost:30001/health → 200?

→ già in esecuzione: riusa (utente lo aveva già avviato)

→ non in esecuzione:
    spawna: python3 -m pixelrag_serve.api
              --index-dir .kirograph/pixelrag-index
              --port 30001
              --device auto
    poll /health ogni 2s × max 60 tentativi (120s totali)
    → pronto: smette di pollare, da qui in poi zero monitoring
    → timeout: logga warning — le tool call falliranno con messaggio utile

Il polling è solo durante lo startup. Dopo che il server è ready non
viene più contattato fino alla prima query reale. Se crasha in seguito,
le chiamate HTTP falliscono naturalmente e il tool risponde con un
errore utile all'agent.

on MCP server exit:
    child.kill('SIGTERM')
    attendi max 5s, poi SIGKILL
```

Il child process viene registrato su `process.on('exit')` e `process.on('SIGINT')` per cleanup garantito.

---

## Files da creare

### `src/data/pixelrag-manager.ts`

Gestisce il lifecycle completo:

```ts
// Verifica Python, lancia errore con istruzioni se manca
ensurePython(): Promise<void>

// Verifica/installa pixelrag via pip, con progress streaming
ensurePixelRAGInstalled(): Promise<void>

// Esegue pixelrag-index build, skip se indice già aggiornato
buildIndex(projectRoot: string, kirographDir: string, force?: boolean): Promise<void>

// Spawna pixelrag-serve, poll /health, registra cleanup
startServer(port: number, kirographDir: string): Promise<ChildProcess>

// Controlla se il server è raggiungibile
isServerRunning(endpoint: string): Promise<boolean>
```

### `src/data/pixelrag-bridge.ts`

HTTP client puro:

```ts
// POST /search → VisualSearchResult[]
searchVisual(endpoint: string, query: string, opts?): Promise<VisualSearchResult[]>

// GET /status → info diagnostica
getStatus(endpoint: string): Promise<PixelRAGStatus>
```

---

## Files da modificare

### `src/config.ts`

```ts
enableVisualPDF?: boolean      // default: false
pixelragPort?: number          // default: 30001
```

`pixelragEndpoint` non è più un campo config — viene derivato da `pixelragPort`:
`http://localhost:${config.pixelragPort ?? 30001}`
L'endpoint remoto non è supportato nel piano base (ma il codice non lo impedisce).

### `src/data/types.ts`

```ts
export interface VisualSearchResult {
  score: number;
  filePath: string;        // path PDF originale (da hit.url)
  tileIndex: number;       // quale tile (pagina per PDF)
  chunkIndex: number;      // quale strip nella pagina
  yOffset: number;         // px dal top della pagina
  chunkHeight: number;     // altezza strip in px
  chunkImagePath: string;  // path al PNG del chunk
}
```

### `src/index.ts` (MCP server entry point)

Aggiunge al bootstrap, se `enableVisualPDF`:

```ts
await ensurePython()                    // lancia se manca
await ensurePixelRAGInstalled()         // installa se manca
await startServer(port, kirographDir)   // spawna + poll ready
```

### `src/bin/commands/index.ts` (CLI `kirograph index`)

Aggiunge dopo l'indicizzazione normale, se `enableVisualPDF`:

```ts
await ensurePython()
await ensurePixelRAGInstalled()
await buildIndex(projectRoot, kirographDir, force)
```

### `src/mcp/` — nuovo tool `kirograph_pdf_visual_search`

```
Input:
  query           string
  limit?          number   (default 5)
  minTileHeight?  number   (default 50)

Precondition:
  se server non raggiungibile → messaggio utile ("PixelRAG is starting, retry in a moment"
                                                 oppure "run kirograph index first")

Flow:
  searchVisual(endpoint, query, {limit, minTileHeight})
  → VisualSearchResult[]
```

### `src/bin/commands/data.ts`

```bash
kirograph data visual-search "<query>" [--limit 5]
kirograph data pixelrag-status
```

### `src/bin/installer/config-prompt.ts`

Aggiungere, subito dopo il blocco `enableData` / `dataInstallPdf`, una sezione per PixelRAG:

```ts
if ((patch as any).enableData && (patch as any).dataInstallPdf) {
  (patch as any).enableVisualPDF = await askToggle(
    rl,
    'Visual PDF search via PixelRAG (Qwen3-VL-Embedding-2B)?',
    'Enables semantic search over scanned PDFs and complex layouts. ' +
    'Requires Python 3.10+. Downloads Qwen3-VL-Embedding-2B (~4 GB) now.',
    false,
  );

  if ((patch as any).enableVisualPDF) {
    // 1. Verifica Python — se manca, disabilita e avvisa
    const pythonOk = await checkPython();   // ritorna false se python3 non trovato
    if (!pythonOk) {
      log.warn('Python 3.10+ not found. Skipping PixelRAG install. ' +
               'Install Python and re-run kirograph install.');
      (patch as any).enableVisualPDF = false;
    } else {
      // 2. pip install (con progress streaming)
      await runPipInstall('pixelrag[index,serve]');

      // 3. Download modello (~4 GB, fatto qui una volta sola)
      log.info('Downloading Qwen3-VL-Embedding-2B model (~4 GB)...');
      await runPixelRAGModelDownload();   // python3 -m pixelrag_embed.download

      // 4. Porta (opzionale, default 30001)
      (patch as any).pixelragPort = await askNumber(
        rl,
        'PixelRAG server port',
        30001,
      );
    }
  }
}
```

Vantaggi di fare il download nell'installer:
- L'utente vede il progresso e il warning ~4 GB in un momento esplicito
- `kirograph index` e il server non hanno sorprese di download al primo avvio
- Coerente con il pattern Watchmen (modello scaricato alla configurazione, non al primo uso)

---

## Fasi implementazione

| Fase | Cosa | Rischio |
|------|------|---------|
| 1 | `VisualSearchResult` type + `pixelrag-manifest.json` schema | Zero |
| 2 | `pixelrag-bridge.ts` (HTTP client) | Basso |
| 3 | `pixelrag-manager.ts` — Python check + pip install | Basso |
| 4 | `pixelrag-manager.ts` — lettura PDF flaggati dal DB + generazione targets.txt | Basso |
| 5 | `pixelrag-manager.ts` — manifest staleness check + build index | Medio — dipende da PixelRAG CLI |
| 6 | `pixelrag-manager.ts` — server spawn + health poll | Medio — lifecycle management |
| 7 | Installer section in `config-prompt.ts` (Python check + pip + model download) | Medio — UX install-time |
| 8 | Wiring in `src/index.ts` (MCP bootstrap) | Basso |
| 9 | Wiring in `kirograph index` CLI | Basso |
| 10 | MCP tool + CLI subcommands | Basso |

---

## Considerazioni di integrazione

### Config validation

Se `enableVisualPDF: true` ma `enableData: false` o `dataInstallPdf: false`, KiroGraph deve emettere un warning al bootstrap e auto-disabilitare visual PDF:

```
⚠ enableVisualPDF requires enableData and dataInstallPdf.
  Run kirograph install to configure PDF support first.
```

Non è un errore fatale — il resto di kirograph funziona normalmente.

### `kirograph_status` integration

Il tool `kirograph_status` (già esistente) deve includere la sezione PixelRAG quando `enableVisualPDF: true`:

```
pixelrag:
  server: running | stopped | not_configured
  index:  present (847 tiles, built 2025-06-20) | missing | stale
  port:   30001
```

"stale" = manifest diverge dai PDF flaggati attuali.

### Port conflict handling

Durante lo startup poll, distinguere due casi:
- `ECONNREFUSED` → server non ancora avviato, continua a fare poll
- `200 OK` ma body non riconosciuto → qualcosa d'altro su quella porta, logga warning e abbandona il poll (non bloccare l'avvio di kirograph)

### Tool routing: descrizione MCP

La descrizione di `kirograph_pdf_visual_search` deve essere esplicita su **quando usarlo** per evitare che l'agent lo chiami al posto di `kirograph_context`:

```
Use this tool ONLY for queries about content in scanned PDFs, photographed
documents, or PDFs with complex visual layouts (charts, multi-column, mixed
images and text). Do NOT use for source code, structured data, or normal
text documents — use kirograph_context for those.
```

### `kirograph index --force` propagation

Quando `kirograph index --force` è eseguito, il flag viene propagato a `buildIndex()` che bypassa il manifest check e ricrea l'indice PixelRAG da zero.

### `pixelrag-targets.txt` lifecycle

Il file `.kirograph/pixelrag-targets.txt` è generato **ogni volta** che si esegue `kirograph index`, non cachato. Va nella `.kirograph/` directory e deve essere escluso da `.gitignore` assieme a `.kirograph/pixelrag-index/` e `.kirograph/pixelrag-manifest.json`.

---

## Cosa non fa KiroGraph

- Nessun rendering PDF
- Nessun chunking
- Nessun modello di embedding
- Nessun vettore in SQLite per le tile visive

Tutto questo è PixelRAG. KiroGraph gestisce solo installazione, avvio e routing delle query.

---

## Impatto risorse locali

### Disco

| Cosa | Dimensione stimata |
|------|-------------------|
| Qwen3-VL-Embedding-2B (scaricato nell'installer) | ~4 GB |
| Tile PNG in `.kirograph/pixelrag-index/` | ~300–800 KB/tile × numero tile |
| FAISS vectors + `metadata.npz` | piccolo (KB) |
| `pixelrag-manifest.json` + `pixelrag-targets.txt` | trascurabile |

**Stima tile:** un PDF A4 a 200 DPI = ~2 tile da 1024px per pagina. 10 PDF × 20 pagine × 2 tile = 400 tile × 500 KB media = **~200 MB solo per i PNG**.

`.kirograph/pixelrag-index/` deve essere in `.gitignore` (analogamente a `.kirograph/*.db`).

### RAM

`pixelrag-serve` carica Qwen3-VL-2B all'avvio e lo tiene in memoria per l'intera sessione:

- **~4–6 GB RAM** (float16, no quantization)
- Su macchine con ≤8 GB il server potrebbe degradare le performance del sistema
- Il check di sistema dovrebbe avvertire se RAM disponibile < 6 GB prima di avviare il server (non bloccante, solo warning)

### Startup time — aggiustare il timeout del poll

Il caricamento del modello richiede tempo. La stima del poll (120s attuale) potrebbe non bastare:

| Hardware | Tempo stimato avvio `pixelrag-serve` |
|----------|--------------------------------------|
| Apple Silicon MPS | 20–40s |
| CPU only | 60–120s |
| CUDA | 10–20s |

**Proposta:** aumentare max tentativi a 90 (3 minuti) e loggare lo stato ogni 15s ("PixelRAG loading model… 30s elapsed").

### CPU/GPU

- **Index build:** pesante — un forward pass Qwen3-VL-2B per ogni tile. Su CPU: 5–20s/tile. Con 400 tile: 30 minuti+ su CPU, 3–13 minuti su MPS. Da comunicare all'utente prima di avviare.
- **Query time:** leggero — un solo forward pass per la query text, poi FAISS search (ms).

`kirograph index` deve stampare una stima prima di partire: `"Building PixelRAG index: 400 tiles (~8 min on CPU, ~3 min on MPS)…"`

---

## Costo token nelle risposte MCP

### Come funziona la risposta

`kirograph_pdf_visual_search` ritorna `VisualSearchResult[]` con `chunkImagePath` (path assoluto al PNG). **Non embeds le immagini inline** nella risposta MCP — l'agent riceve solo metadati e path.

Se l'agent vuole vedere il contenuto visivo, usa `read_file` (o equivalente in Kiro) sul path ricevuto. Questo è intenzionale: il tool è economico di default, l'agent decide se e quante immagini leggere.

### Stima costo se l'agent legge le immagini

Tile size: 875 × 1024px. Claude calcola i token immagine in base alla risoluzione:

| Tiles lette | Token stimati |
|-------------|--------------|
| 1 | ~1 500 tok |
| 3 (default limit) | ~4 500 tok |
| 5 | ~7 500 tok |

Questo è **aggiuntivo** al contesto normale della conversazione. Con 5 risultati tutti letti: ~7 500 token solo per le immagini.

### Implicazioni per il design del tool

1. **Default `limit: 3`** invece di 5 — riduce il worst-case token cost
2. **Nella descrizione MCP**, includere: *"Each result includes a tile image path. Reading all images adds ~1 500 tokens/tile. Read only what the user's question requires."*
3. **Ordinamento per score** già garantito da PixelRAG — l'agent dovrebbe leggere prima la tile con score più alto
4. Il `minTileHeight` default (50px) filtra automaticamente i frammenti troppo piccoli per essere utili, riducendo rumore nei risultati

### Confronto con gli altri tool

| Tool | Costo risposta tipica |
|------|-----------------------|
| `kirograph_context` | ~2 000–8 000 tok (codice sorgente) |
| `kirograph_pdf_visual_search` (senza leggere immagini) | ~200 tok |
| `kirograph_pdf_visual_search` + 3 immagini lette | ~4 700 tok |

Il tool da solo è **molto economico**. Il costo reale dipende da quante immagini l'agent sceglie di leggere.

---

## Documentazione da aggiornare

| File | Cosa aggiungere |
|------|-----------------|
| `CHANGELOG.md` | Entry `[experimental]` per visual PDF search via PixelRAG bridge |
| `README.md` | (1) Bullet nella feature table con badge `(experimental)` e "Powered by [PixelRAG](https://github.com/StarTrail-org/PixelRAG) by StarTrail-org"; (2) sezione "Visual PDF Search _(experimental)_" con tabella hardware minimo, prerequisito Python, come abilitare; (3) entry in `## Credits`; (4) riga in "Key Dependencies" table |
| `docs/guide/configuration.md` | Nuovi campi: `enableVisualPDF` (boolean, false), `pixelragPort` (number, 30001) con nota `experimental` e hardware requirements inline |
| `docs/guide/mcp-tools.md` | Sezione `kirograph_pdf_visual_search` con badge experimental; parametri; how it works; when to use vs `kirograph_context`; avviso token cost se l'agent legge le immagini |
| `docs/guide/cli.md` | Nuovi subcommand con badge experimental: `kirograph data visual-search "<query>"`, `kirograph data pixelrag-status` |
| `docs/guide/installation.md` | Box warning dedicato: hardware minimo (tabella), Python 3.10+, nota Windows non supportato, nota WSL2; posizionato prima della sezione optional deps |
| `docs/index.html` | (1) Feature card con badge "Experimental" visivamente distinto (colore diverso dagli altri badge) e nota hardware; (2) entry nel timeline della versione; (3) citazione PixelRAG nella sezione credits HTML |
| `docs/docs.html` | (1) Sezione visual PDF search nel body con badge experimental; (2) link nella sidebar; (3) entry nella tabella dei formati/dipendenze dove compare `@firecrawl/pdf-inspector`; (4) entry credits |

### Cosa scrivere nei Credits (testo standard da usare in tutti i file)

Seguire esattamente il formato usato per gli altri progetti:

**README.md `## Credits`:**
```markdown
- [PixelRAG](https://github.com/StarTrail-org/PixelRAG) by [StarTrail-org](https://github.com/StarTrail-org): the visual PDF search engine — renders PDFs as image strips, embeds via Qwen3-VL-Embedding-2B, FAISS IVFFlat index, FastAPI HTTP serve. KiroGraph uses it as an HTTP bridge: lifecycle management, index targeting, and query routing only.
- [Qwen3-VL-Embedding-2B](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B) by [Qwen / Alibaba Cloud](https://huggingface.co/Qwen): the vision-language embedding model used by PixelRAG to embed PDF tile images.
```

**README.md "Key Dependencies" table:**
```markdown
| Visual PDF search | [PixelRAG](https://github.com/StarTrail-org/PixelRAG) | HTTP bridge to PixelRAG FastAPI; KiroGraph handles install, index build, server lifecycle |
| Visual embedding model | [Qwen3-VL-Embedding-2B](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B) | ~4 GB, downloaded at install time via PixelRAG |
```

**`docs/index.html` e `docs/docs.html` credits section** — stesso contenuto, HTML inline con link.

### Linee guida per il badge experimental nella documentazione

Il badge deve essere **consistente e visibile** in tutti i punti:

- In Markdown: `` `experimental` `` inline oppure `> ⚠ **Experimental** — ...` come blockquote di apertura della sezione
- In HTML: `<span class="badge badge-experimental">Experimental</span>` con stile distinto (es. sfondo giallo/arancio, non il verde delle feature stable)
- La frase standard da usare ovunque:

  > **Experimental.** This feature may change or be removed in future releases. Hardware requirements are significant — see [hardware requirements](#hardware-requirements) before enabling.

- Non usare "beta" o "preview" — usare sempre "experimental" per consistenza con il resto di KiroGraph (altri moduli opt-in usano lo stesso termine)
