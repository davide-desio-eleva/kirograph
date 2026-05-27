import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Command } from 'commander';
import { bold, dim, green, reset, violet } from '../ui';

function openBrowser(filePath: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'start'
            : 'xdg-open';
  spawn(cmd, [filePath], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

async function generateExport(
  projectPath: string | undefined,
  opts: { output?: string; includeContains: boolean },
): Promise<string> {
  const KiroGraph = (await import('../../index')).default;
  const target = path.resolve(projectPath ?? process.cwd());
  const cg = await KiroGraph.open(target);

  const nodes = cg.getAllNodes();
  const edges = cg.getAllEdges();
  cg.close();

  const projectName = path.basename(target);

  // Embed logo as base64 if it exists next to this package
  let logoBase64: string | undefined;
  const logoCandidates = [
    path.join(__dirname, '../../assets/logo.png'),
    path.join(__dirname, '../../../assets/logo.png'),
  ];
  for (const p of logoCandidates) {
    if (fs.existsSync(p)) {
      logoBase64 = fs.readFileSync(p).toString('base64');
      break;
    }
  }

  // Build file modification time map (Feature 5)
  const fileModified: Record<string, number> = {};
  const uniquePaths = [...new Set(nodes.map((n: any) => n.filePath as string))];
  for (const fp of uniquePaths) {
    try {
      fileModified[fp] = fs.statSync(path.join(target, fp)).mtimeMs;
    } catch {
      fileModified[fp] = 0;
    }
  }

  const outDir = opts.output
    ? path.resolve(opts.output)
    : path.join(target, '.kirograph', 'export');

  fs.mkdirSync(outDir, { recursive: true });

  const { html, css, js } = buildFiles(nodes, edges, projectName, opts.includeContains, logoBase64, fileModified);

  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(outDir, 'app.css'),    css,  'utf8');
  fs.writeFileSync(path.join(outDir, 'app.js'),     js,   'utf8');

  const indexPath = path.join(outDir, 'index.html');

  const edgeCount = opts.includeContains
    ? edges.length
    : edges.filter((e: any) => e.kind !== 'contains').length;

  console.log();
  console.log(`  ${violet}${bold}Graph exported${reset}`);
  console.log(`  ${dim}nodes   ${reset}${bold}${nodes.length}${reset}`);
  console.log(`  ${dim}edges   ${reset}${bold}${edgeCount}${reset}${opts.includeContains ? '' : dim + '  (contains edges excluded)' + reset}`);
  console.log(`  ${dim}output  ${reset}${green}${outDir}${reset}`);
  console.log();

  return indexPath;
}

// ── Color palettes ────────────────────────────────────────────────────────────
const KIND_COLOR: Record<string, string> = {
  class:       '#9b59b6',
  struct:      '#8e44ad',
  interface:   '#6c3483',
  trait:       '#7d3c98',
  protocol:    '#6c3483',
  function:    '#5b6abf',
  method:      '#7986cb',
  component:   '#26a69a',
  route:       '#2e7d32',
  variable:    '#546e7a',
  constant:    '#455a64',
  property:    '#607d8b',
  field:       '#78909c',
  enum:        '#e67e22',
  enum_member: '#f39c12',
  type_alias:  '#00838f',
  namespace:   '#00695c',
  parameter:   '#616161',
  import:      '#37474f',
  export:      '#37474f',
  file:        '#263238',
  module:      '#1c313a',
};

const EDGE_COLOR: Record<string, string> = {
  calls:        '#7986cb',
  imports:      '#546e7a',
  exports:      '#546e7a',
  extends:      '#ab47bc',
  implements:   '#8e24aa',
  references:   '#455a64',
  type_of:      '#00838f',
  returns:      '#0277bd',
  instantiates: '#6a1b9a',
  overrides:    '#ad1457',
  decorates:    '#e67e22',
  contains:     '#263238',
};

const EDGE_DASHED: Record<string, boolean> = {
  imports:    true,
  references: true,
  type_of:    true,
  returns:    true,
};

function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + 60);
  const g = Math.min(255, ((n >> 8)  & 0xff) + 60);
  const b = Math.min(255, ( n        & 0xff) + 60);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildFiles(
  nodes: any[], edges: any[], projectName: string, includeContains: boolean, logoBase64?: string,
  fileModified?: Record<string, number>,
): { html: string; css: string; js: string } {
  const filteredEdges = includeContains ? edges : edges.filter(e => e.kind !== 'contains');

  const degree = new Map<string, number>();
  for (const e of filteredEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const maxDegree = Math.max(0, ...degree.values());

  const visNodes = nodes.map(n => {
    const fp: string = n.filePath ?? '';
    const parts = fp.split('/').filter(Boolean);
    const dir = parts.length >= 2 ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
    return {
      id:           n.id,
      label:        n.name,
      color: {
        background: KIND_COLOR[n.kind] ?? '#424242',
        border:     lighten(KIND_COLOR[n.kind] ?? '#424242'),
        highlight:  { background: '#e040fb', border: '#ea80fc' },
        hover:      { background: lighten(KIND_COLOR[n.kind] ?? '#424242'), border: '#ea80fc' },
      },
      size:         Math.max(8, Math.min(40, 8 + (degree.get(n.id) ?? 0) * 1.5)),
      font:         { size: 11, color: '#e0e0e0', face: 'monospace' },
      kind:         n.kind,
      filePath:     n.filePath,
      dir,
      startLine:    n.startLine,
      qualifiedName: n.qualifiedName,
      signature:    n.signature ?? null,
      isExported:   n.isExported ?? false,
      degree:       degree.get(n.id) ?? 0,
      borderWidth:  n.isExported ? 2 : 1,
      borderWidthSelected: 3,
      lastModified: fileModified ? (fileModified[fp] ?? 0) : 0,
    };
  });

  const visEdges = filteredEdges.map((e: any, i: number) => ({
    id:     i,
    ekind:  e.kind,
    from:   e.source,
    to:     e.target,
    label:  e.kind,
    dashes: EDGE_DASHED[e.kind] ?? false,
    color:  { color: EDGE_COLOR[e.kind] ?? '#546e7a', opacity: e.kind === 'contains' ? 0.2 : 0.6 },
    width:  ['extends', 'implements', 'calls'].includes(e.kind) ? 2 : 1,
    font:   { size: 9, color: '#546e7a', align: 'middle' },
    arrows: e.kind !== 'contains' ? { to: { enabled: true, scaleFactor: 0.5 } } : {},
    smooth: { type: 'curvedCW', roundness: 0.1 },
  }));

  const allNodeKinds = [...new Set(nodes.map((n: any) => n.kind))].sort();
  const allEdgeKinds = [...new Set(filteredEdges.map((e: any) => e.kind))].sort();

  const logoTag = logoBase64
    ? `<img src="data:image/png;base64,${logoBase64}" alt="KiroGraph">`
    : `<h1>⬡ KiroGraph</h1>`;

  const loaderLogoTag = logoBase64
    ? `<img src="data:image/png;base64,${logoBase64}" alt="KiroGraph">`
    : `<div style="color:#c792ea;font-size:18px;font-weight:600;letter-spacing:.05em">⬡ KiroGraph</div>`;

  const nodeLegend = allNodeKinds.map(k => `<div class="legend-item" data-nkind="${k}">
            <div class="legend-dot" style="background:${KIND_COLOR[k] ?? '#424242'}"></div>
            <span>${k}</span>
            <span class="legend-count">${nodes.filter((n: any) => n.kind === k).length}</span>
          </div>`).join('');

  const edgeLegend = allEdgeKinds.map(k => `<div class="legend-item" data-ekind="${k}">
            <div class="legend-line" style="${EDGE_DASHED[k] ? `border-top:2px dashed ${EDGE_COLOR[k] ?? '#546e7a'};height:0` : `background:${EDGE_COLOR[k] ?? '#546e7a'}`}"></div>
            <span>${k}</span>
            <span class="legend-count">${filteredEdges.filter((e: any) => e.kind === k).length}</span>
          </div>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KiroGraph — ${escHtml(projectName)}</title>
<link rel="stylesheet" href="./app.css">
<link rel="preload" href="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js" as="script">
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
</head>
<body>

<div id="init-loader">
  ${loaderLogoTag}
  <div class="init-title">${visNodes.length} nodes · ${visEdges.length} edges · ${escHtml(projectName)}</div>
  <div id="init-progress-wrap"><div id="init-progress-bar"></div></div>
  <div id="init-status">Loading…</div>
</div>

<div id="main">
  <div id="loader"><div class="spinner"></div></div>
  <div id="path-bar">Click a node to set start…</div>
  <div id="graph"></div>

  <!-- Floating left sidebar: brand + search + tools, all stacked -->
  <div id="float-sidebar">
  <div id="float-brand">
    ${logoTag}
    <div id="float-brand-info">
      <span id="proj">${escHtml(projectName)}</span>
      <span id="stats">${visNodes.length} nodes · ${visEdges.length} edges</span>
    </div>
  </div>

  <div id="float-left">
    <input id="search" type="text" placeholder="🔍  Search symbols…">

    <div class="float-group vertical">
      <button class="fbtn"        id="btn-fit"        title="Fit graph to view">⊞ <span class="fbtn-label">Fit</span></button>
      <button class="fbtn active" id="btn-physics"    title="Toggle physics">⚡ <span class="fbtn-label">Physics</span></button>

      <div class="fslider-row" id="physics-speed-row">
        <span class="fslider-label">Slow</span>
        <input type="range" id="physics-speed" min="1" max="10" value="5" step="1" title="Physics speed">
        <span class="fslider-label">Fast</span>
      </div>

      <button class="fbtn"        id="btn-png"        title="Export PNG">📷 <span class="fbtn-label">PNG</span></button>
    </div>

    <div class="float-group vertical">
      <button class="fbtn" id="btn-focus"   title="Focus on node and neighbors">◎ <span class="fbtn-label">Focus</span></button>
      <button class="fbtn" id="btn-path"    title="Find path between two nodes">⟶ <span class="fbtn-label">Path</span></button>
      <button class="fbtn" id="btn-cluster" title="Cluster by directory">⬡ <span class="fbtn-label">Cluster</span></button>
      <button class="fbtn" id="btn-heat"    title="Heat map by file recency">🌡 <span class="fbtn-label">Heat</span></button>
      <button class="fbtn" id="btn-charts"  title="Analytics charts">📊 <span class="fbtn-label">Charts</span></button>
    </div>

    <div id="heat-legend">
      <div class="heat-legend-title">🌡 File recency</div>
      <div id="heat-gradient"></div>
      <div class="heat-stops">
        <div class="heat-stop" data-tip="Modified in the last 24 hours"><span class="heat-stop-dot" style="background:#e74c3c"></span>Today</div>
        <div class="heat-stop" data-tip="Modified in the last week"><span class="heat-stop-dot" style="background:#e67e22"></span>This week</div>
        <div class="heat-stop" data-tip="Modified in the last month"><span class="heat-stop-dot" style="background:#f1c40f"></span>This month</div>
        <div class="heat-stop" data-tip="Modified in the last 6 months"><span class="heat-stop-dot" style="background:#27ae60"></span>6 months</div>
        <div class="heat-stop" data-tip="Modified more than 6 months ago"><span class="heat-stop-dot" style="background:#2980b9"></span>Older</div>
      </div>
      <div id="heat-tip"></div>
    </div>
  </div>
  </div><!-- /float-sidebar -->

  <div id="minimap"><canvas id="minimap-canvas" width="180" height="120"></canvas></div>
  <div id="ctx-menu"></div>

  <!-- Charts modal -->
  <div id="charts-modal" style="display:none">
    <div id="charts-panel">
      <div id="charts-header">
        <span>📊 Graph Analytics</span>
        <button id="charts-close">✕</button>
      </div>
      <div id="charts-body">
        <div class="chart-block span-3">
          <div class="chart-title">Top 15 Most Connected Symbols</div>

          <div class="chart-insight">Symbols with the highest combined in + out degree are the load-bearing pillars of your codebase.<br>A very long bar on an internal helper is a red flag — it means many things depend on one place that wasn't designed as an API.</div>
          <canvas id="chart-bar" width="1080" height="280"></canvas>
        </div>
        <div class="chart-block span-1">
          <div class="chart-title">Node Distribution by Kind</div>
          <div class="chart-insight">Shows what your codebase is made of at a glance — heavy on functions vs. classes vs. types.<br>A dominant slice (e.g. 80% variables) can indicate over-abstraction or, conversely, too little structure.</div>
          <canvas id="chart-pie" width="540" height="280"></canvas>
        </div>
        <div class="chart-block span-2">
          <div class="chart-title">Degree Distribution — Connectivity Curve</div>
          <div class="chart-insight">Healthy codebases show a steep left peak (most symbols have few connections) and a long tail.<br>A flat or multi-modal curve signals coupling problems — too many symbols are over-connected.</div>
          <canvas id="chart-line" width="720" height="280"></canvas>
        </div>

        <div class="chart-block span-3">
          <div class="chart-title">Top 15 Callers — Highest Out-Degree</div>
          <div class="chart-insight">High out-degree means this symbol knows too much about the rest of the system — a classic god-object signal.<br>If the top callers are entry points or orchestrators that's fine; if they're utility helpers, consider splitting them.</div>
          <canvas id="chart-callers" width="1080" height="280"></canvas>
        </div>

        <div class="chart-block span-3">
          <div class="chart-title">Top 15 Callees — Highest In-Degree</div>
          <div class="chart-insight">These are your real public API — change them and many things break. High in-degree is expected for core utilities.<br>Surprise entries here (a private helper, a constant) indicate hidden coupling you should make explicit.</div>
          <canvas id="chart-callees" width="1080" height="280"></canvas>
        </div>

        <div class="chart-block span-3">
          <div class="chart-title">Files by Symbol Count</div>
          <div class="chart-insight">Files with many symbols are candidates for splitting — they likely handle multiple responsibilities.<br>Cross-reference with the coupling matrix: a large file that also couples to many directories is a high-priority refactor target.</div>
          <canvas id="chart-files" width="1080" height="280"></canvas>
        </div>

        <div class="chart-block span-1">
          <div class="chart-title">Edge Kind Distribution</div>
          <div class="chart-insight">Tells you which relationship patterns dominate: calls, imports, inheritance, containment.<br>An unusually high import ratio vs. calls can mean modules are tightly wired at the file level without using each other's symbols.</div>
          <canvas id="chart-edgekinds" width="400" height="280"></canvas>
        </div>

        <div class="chart-block span-1">
          <div class="chart-title">Dead Code by Kind</div>
          <div class="chart-insight">These symbols are never referenced from within the indexed codebase — strong deletion candidates.<br>Focus on functions and classes; variables and constants are more likely to be used via dynamic patterns not captured by static analysis.</div>
          <canvas id="chart-deadcode" width="400" height="280"></canvas>
        </div>

        <div class="chart-block span-1">
          <div class="chart-title">Symbol Count per Directory</div>
          <div class="chart-insight">A single directory holding most symbols is a monolith smell — the rest of the structure may be cosmetic.<br>Balanced distribution suggests good separation of concerns; a very tall single bar suggests your folder structure doesn't reflect your actual architecture.</div>
          <canvas id="chart-dirs" width="400" height="280"></canvas>
        </div>

        <div class="chart-block span-3">
          <div class="chart-title">Exported vs Unexported by Kind</div>
          <div class="chart-insight">Shows how much of each symbol type is intentionally public. A large unexported slice is healthy — it means most logic is encapsulated.<br>If nearly everything is exported, your module boundaries are weak and consumers have too much surface area to depend on.</div>
          <canvas id="chart-exported" width="1080" height="260"></canvas>
        </div>

        <div class="chart-block span-3">
          <div class="chart-title">Directory Coupling Matrix</div>
          <div class="chart-insight">Each row is a source directory, each column is a target — a bright cell means many edges cross from that row's folder into that column's folder.<br>Symmetrically bright off-diagonal pairs (A↔B and B↔A) reveal circular coupling between modules that should be cleanly layered.</div>
          <canvas id="chart-coupling" width="1080" height="420"></canvas>
        </div>

        <div class="chart-block span-2">
          <div class="chart-title">In-Degree vs Out-Degree Scatter</div>
          <div class="chart-insight">Top-left = Sinks (referenced a lot, calls nothing) — typical for pure data types or leaf utilities.<br>Bottom-right = Sources (calls a lot, rarely referenced) — often entry points or wiring code. Top-right = Hubs — investigate these first.</div>
          <canvas id="chart-scatter" width="720" height="320"></canvas>
        </div>

        <div class="chart-block span-1">
          <div class="chart-title">Average Degree per File</div>
          <div class="chart-insight">Files with high average degree are deeply entangled regardless of their size — even a 2-symbol file can score high.<br>This metric catches hidden complexity better than raw symbol count: a small file with a huge average is often the real coupling hotspot.</div>
          <canvas id="chart-avgdeg" width="400" height="320"></canvas>
        </div>

      </div>
    </div>
  </div>

  <div id="panel">
    <div id="panel-tabs">
      <div class="tab active" data-tab="detail">Detail</div>
      <div class="tab"        data-tab="legend">Legend</div>
      <div class="tab"        data-tab="filters">Filters</div>
    </div>
    <div id="panel-content">

      <!-- Detail tab -->
      <div id="tab-detail">
        <div id="history-nav">
          <button class="hist-btn" id="hist-back"    disabled>‹</button>
          <span   id="hist-label">no selection</span>
          <button class="hist-btn" id="hist-forward" disabled>›</button>
        </div>
        <p class="detail-empty">Click a node to inspect it.</p>
      </div>

      <!-- Legend tab -->
      <div id="tab-legend" style="display:none">
        <div class="legend-section">
          <div class="legend-title">Node kinds <span style="color:#37474f;font-size:9px">(click to toggle)</span></div>
          ${nodeLegend}
        </div>
        <div class="legend-section">
          <div class="legend-title">Edge kinds <span style="color:#37474f;font-size:9px">(click to toggle)</span></div>
          ${edgeLegend}
        </div>
      </div>

      <!-- Filters tab -->
      <div id="tab-filters" style="display:none">
        <div class="filter-section">
          <div class="filter-label">
            Min degree
            <span class="filter-value" id="degree-val">0</span>
          </div>
          <input type="range" id="degree-slider" min="0" max="${maxDegree}" value="0" step="1">
          <div class="filter-hint">Hide nodes with fewer than N connections. Use to surface the most-connected symbols.</div>
        </div>
      </div>

    </div>
  </div>
</div>

<script src="./app.js"></script>
</body>
</html>`;

  const css = buildCss();
  const js  = buildJs(visNodes, visEdges, KIND_COLOR, EDGE_COLOR);

  return { html, css, js };
}

function buildCss(): string {
  return `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #0a0a0f;
  color: #e0e0e0;
  font-family: 'SF Mono','Fira Code','Consolas',monospace;
  font-size: 13px;
  height: 100vh;
  overflow: hidden;
}

/* ── Main fills full viewport ── */
#main { display: flex; width: 100vw; height: 100vh; overflow: hidden; position: relative; }
#graph { flex: 1; background: #0a0a0f; }

/* ── Left sidebar: single stacking container ── */
#float-sidebar {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  overflow-x: visible;
}
#float-sidebar::-webkit-scrollbar { display: none; }

/* ── Brand card ── */
#float-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(8, 8, 18, 0.97);
  border: 1px solid #3a3a5e;
  border-radius: 12px;
  padding: 8px 14px 8px 8px;
  box-shadow: 0 4px 24px rgba(0,0,0,.75), 0 0 0 1px rgba(121,134,203,.08);
  flex-shrink: 0;
}
#float-brand img {
  height: 46px;
  width: auto;
  object-fit: contain;
  border-radius: 6px;
}
#float-brand h1 { font-size: 13px; font-weight: 600; color: #c792ea; letter-spacing: .05em; }
#float-brand-info { display: flex; flex-direction: column; gap: 2px; }
#proj  { color: #c792ea; font-size: 12px; font-weight: 600; white-space: nowrap; }
#stats { color: #6272a4; font-size: 10px; white-space: nowrap; }

/* ── Search + buttons column ── */
#float-left {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── Search inside left column ── */
#search {
  background: rgba(8, 8, 18, 0.97);
  border: 1px solid #3a3a5e;
  border-radius: 10px;
  color: #e8e8f0;
  padding: 8px 14px;
  font-family: inherit;
  font-size: 12px;
  width: 200px;
  outline: none;
  transition: border-color .2s, box-shadow .2s;
  box-shadow: 0 4px 24px rgba(0,0,0,.75);
}
#search:focus { border-color: #7986cb; box-shadow: 0 0 0 2px rgba(121,134,203,.3); }
#search::placeholder { color: #4a4a6a; }

/* ── Shared float group ── */
.float-group {
  display: flex;
  flex-direction: column;
  background: rgba(8, 8, 18, 0.97);
  border: 1px solid #3a3a5e;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0,0,0,.75), 0 0 0 1px rgba(121,134,203,.06);
  width: 200px;
}

/* ── Float button ── */
.fbtn {
  display: flex;
  align-items: center;
  gap: 10px;
  background: transparent;
  border: none;
  border-bottom: 1px solid #252538;
  color: #9da8cc;
  padding: 9px 14px;
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  transition: background .12s, color .12s;
  white-space: nowrap;
  text-align: left;
}
.fbtn:last-child { border-bottom: none; }
.fbtn:hover  { background: #16162a; color: #ffffff; }
.fbtn.active { background: #1e1e40; color: #c792ea; border-left: 3px solid #c792ea; padding-left: 11px; }
.fbtn.warn   { color: #e67e22; }
.fslider-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-bottom: 1px solid #252538;
}
.fslider-label { font-size: 9px; color: #7a86aa; flex-shrink: 0; letter-spacing: .03em; }
#physics-speed {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 3px;
  background: #2e2e52;
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
#physics-speed::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #7986cb;
  cursor: pointer;
  border: 2px solid #c792ea;
}
#physics-speed::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #7986cb;
  cursor: pointer;
  border: 2px solid #c792ea;
}
.fbtn-label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: .02em;
}

/* compat: keep .btn for any remaining uses */
.btn { display: none; }

/* ── Init loader (full screen, shown on page load) ── */
#init-loader {
  position: fixed;
  inset: 0;
  background: #0a0a0f;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  transition: opacity .4s ease;
}
#init-loader.fade-out { opacity: 0; pointer-events: none; }
#init-loader img { max-height: 180px; max-width: 320px; width: auto; height: auto; opacity: .95; }
#init-loader .init-title { color: #546e7a; font-size: 12px; letter-spacing: .05em; }
#init-progress-wrap {
  width: 220px;
  background: #1a1a2e;
  border-radius: 4px;
  height: 3px;
  overflow: hidden;
}
#init-progress-bar {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #7986cb, #c792ea);
  border-radius: 4px;
  transition: width .1s linear;
}
#init-status { color: #37474f; font-size: 11px; }

/* ── Operation loader (translucent overlay for filter ops) ── */
#loader {
  display: none;
  position: absolute;
  inset: 0;
  background: rgba(10,10,15,.55);
  backdrop-filter: blur(2px);
  z-index: 200;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.spinner {
  width: 26px; height: 26px;
  border: 3px solid #1e1e2e;
  border-top-color: #c792ea;
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Path mode bar ── */
#path-bar {
  display: none;
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  background: #12121a;
  border: 1px solid #7986cb;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 12px;
  color: #c792ea;
  z-index: 50;
  pointer-events: none;
  box-shadow: 0 4px 20px rgba(0,0,0,.6);
}

/* ── Side panel ── */
#panel {
  width: 280px;
  background: #12121a;
  border-left: 1px solid #1e1e2e;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  transition: width .2s;
}

#panel-tabs { display: flex; border-bottom: 1px solid #1e1e2e; flex-shrink: 0; }
.tab {
  flex: 1; padding: 8px; text-align: center;
  font-size: 11px; color: #546e7a; cursor: pointer;
  border-bottom: 2px solid transparent; transition: all .15s;
}
.tab.active { color: #c792ea; border-bottom-color: #c792ea; }
#panel-content { flex: 1; overflow-y: auto; padding: 12px; }

/* ── Detail tab ── */
.detail-empty { color: #37474f; font-size: 12px; padding: 8px 0; }
.detail-name  { font-size: 15px; font-weight: 600; color: #c792ea; margin-bottom: 4px; word-break: break-all; }
.detail-kind  {
  display: inline-block; font-size: 10px; padding: 2px 7px;
  border-radius: 10px; background: #1e1e2e; color: #7986cb; margin-bottom: 10px;
}
.detail-row   { display: flex; gap: 8px; margin-bottom: 5px; font-size: 11px; }
.detail-label { color: #37474f; min-width: 60px; flex-shrink: 0; }
.detail-val   { color: #90a4ae; word-break: break-all; }
.detail-sig   {
  margin-top: 8px; background: #0d0d1a; border: 1px solid #1e1e2e;
  border-radius: 5px; padding: 8px; font-size: 11px; color: #7986cb;
  word-break: break-all; white-space: pre-wrap;
}
.detail-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.action-btn {
  background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 4px;
  color: #7986cb; padding: 4px 8px; font-size: 11px; cursor: pointer;
  font-family: inherit; transition: all .15s;
}
.action-btn:hover { border-color: #7986cb; color: #e0e0e0; }

/* ── History breadcrumb ── */
#history-nav {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 10px; padding-bottom: 10px;
  border-bottom: 1px solid #1e1e2e;
}
.hist-btn {
  background: none; border: 1px solid #2a2a3e; border-radius: 4px;
  color: #546e7a; padding: 2px 7px; font-size: 12px; cursor: pointer;
  transition: all .15s;
}
.hist-btn:not(:disabled):hover { border-color: #7986cb; color: #e0e0e0; }
.hist-btn:disabled { opacity: 0.3; cursor: default; }
#hist-label { font-size: 10px; color: #37474f; flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── Path result ── */
.path-result { margin-top: 10px; }
.path-step {
  display: flex; align-items: flex-start; gap: 6px;
  margin-bottom: 2px; font-size: 11px;
}
.path-step-num  { color: #37474f; min-width: 18px; text-align: right; flex-shrink: 0; }
.path-step-name { color: #c792ea; font-weight: 600; cursor: pointer; }
.path-step-name:hover { text-decoration: underline; }
.path-step-kind { color: #546e7a; }
.path-connector { color: #2a2a3e; margin-left: 22px; font-size: 10px; margin-bottom: 2px; }

/* ── Path endpoint cards ── */
.path-endpoints { margin-top: 14px; border-top: 1px solid #1e1e2e; padding-top: 12px; }
.path-endpoint-label { font-size: 9px; color: #37474f; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 4px; }
.node-card {
  background: #0d0d1a; border: 1px solid #1e1e2e; border-radius: 5px;
  padding: 8px 10px; margin-bottom: 4px;
}
.node-card-name { font-size: 13px; font-weight: 600; color: #c792ea; margin-bottom: 4px; word-break: break-all; }

/* ── Legend tab ── */
.legend-section { margin-bottom: 14px; }
.legend-title   { font-size: 10px; color: #546e7a; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 7px; }
.legend-item    {
  display: flex; align-items: center; gap: 7px; margin-bottom: 3px;
  font-size: 11px; color: #90a4ae; cursor: pointer; padding: 2px 4px;
  border-radius: 4px; transition: background .1s;
}
.legend-item:hover  { background: #1a1a2e; }
.legend-item.dimmed { opacity: .3; }
.legend-dot  { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.legend-line { width: 18px; height: 2px; flex-shrink: 0; }
.legend-count{ margin-left: auto; color: #37474f; font-size: 10px; }

/* ── Filters tab ── */
.filter-section { margin-bottom: 18px; }
.filter-label   { font-size: 10px; color: #546e7a; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
.filter-value   { color: #c792ea; font-size: 12px; }
input[type=range] {
  width: 100%; accent-color: #7986cb;
  background: transparent; cursor: pointer;
}
.filter-hint { font-size: 10px; color: #37474f; margin-top: 5px; }

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #2a2a3e; border-radius: 3px; }

/* ── Tooltip ── */
.vis-tooltip {
  background: #12121a !important; border: 1px solid #2a2a3e !important;
  color: #e0e0e0 !important; font-family: 'SF Mono','Fira Code',monospace !important;
  font-size: 12px !important; border-radius: 6px !important; padding: 8px 10px !important;
}

/* ── Minimap ── */
#minimap {
  position: absolute;
  bottom: 14px;
  left: 14px;
  width: 180px;
  height: 120px;
  background: rgba(10,10,15,.85);
  border: 1px solid #2a2a3e;
  border-radius: 6px;
  overflow: hidden;
  z-index: 40;
  cursor: crosshair;
}
#minimap-canvas { display: block; width: 180px; height: 120px; }

/* ── Context menu ── */
#ctx-menu {
  display: none;
  position: fixed;
  z-index: 500;
  background: #12121a;
  border: 1px solid #2a2a3e;
  border-radius: 6px;
  padding: 4px 0;
  min-width: 180px;
  box-shadow: 0 6px 24px rgba(0,0,0,.7);
  font-size: 12px;
}
.ctx-item {
  padding: 6px 14px;
  color: #90a4ae;
  cursor: pointer;
  white-space: nowrap;
  transition: background .1s;
}
.ctx-item:hover { background: #1a1a2e; color: #e0e0e0; }
.ctx-sep { height: 1px; background: #1e1e2e; margin: 3px 0; }

/* ── Charts modal ── */
#charts-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 8, 0.88);
  backdrop-filter: blur(8px);
  z-index: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
#charts-panel {
  background: #0e0e1c;
  border: 1px solid #3a3a5e;
  border-radius: 14px;
  width: 80vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 80px rgba(0,0,0,.95), 0 0 0 1px rgba(121,134,203,.12);
  overflow: hidden;
}
#charts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #252540;
  font-size: 14px;
  font-weight: 700;
  color: #e0d0ff;
  letter-spacing: .03em;
  flex-shrink: 0;
  background: #111120;
}
#charts-close {
  background: #1a1a30;
  border: 1px solid #3a3a5e;
  border-radius: 6px;
  color: #9da8cc;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  transition: all .15s;
}
#charts-close:hover { background: #252545; border-color: #c792ea; color: #ffffff; }
#charts-body {
  overflow-y: auto;
  padding: 18px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
}
.chart-block.span-1 { grid-column: span 1; }
.chart-block.span-2 { grid-column: span 2; }
.chart-block.span-3 { grid-column: 1 / -1; }
.chart-block {
  background: #0a0a1c;
  border: 1px solid #2e2e52;
  border-radius: 10px;
  padding: 16px;
}
.chart-title {
  font-size: 13px;
  font-weight: 700;
  color: #e8eeff;
  margin-bottom: 2px;
}
.chart-sub {
  font-size: 10px;
  color: #7a82aa;
  margin-bottom: 6px;
}
.chart-insight {
  font-size: 10px;
  color: #9ba3c8;
  background: rgba(121,134,203,0.08);
  border-left: 2px solid #5b6abf;
  padding: 5px 8px;
  margin-bottom: 12px;
  border-radius: 0 4px 4px 0;
  line-height: 1.5;
}
.chart-block canvas {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 6px;
}

/* ── Heat legend (inside sidebar) ── */
#heat-legend {
  display: none;
  background: rgba(8, 8, 18, 0.97);
  border: 1px solid #3a3a5e;
  border-radius: 12px;
  padding: 12px 14px;
  box-shadow: 0 4px 24px rgba(0,0,0,.75);
  width: 200px;
}
.heat-legend-title {
  font-size: 11px;
  font-weight: 600;
  color: #9da8cc;
  margin-bottom: 10px;
}
#heat-gradient {
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(90deg, #e74c3c, #e67e22, #f1c40f, #27ae60, #2980b9);
  margin-bottom: 10px;
}
.heat-stops {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.heat-stop {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #7a86aa;
  cursor: default;
  padding: 2px 4px;
  border-radius: 4px;
  transition: background .1s, color .1s;
}
.heat-stop:hover { background: #16162a; color: #e0e0e0; }
.heat-stop-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
#heat-tip {
  margin-top: 8px;
  font-size: 10px;
  color: #4a4a6a;
  min-height: 14px;
  font-style: italic;
}
`;
}

function buildJs(
  visNodes: any[], visEdges: any[],
  kindColors: Record<string, string>, edgeColors: Record<string, string>,
): string {
  return `// ── Data ─────────────────────────────────────────────────────────────────────
const NODES_DATA  = ${JSON.stringify(visNodes)};
const EDGES_DATA  = ${JSON.stringify(visEdges)};
const KIND_COLORS = ${JSON.stringify(kindColors)};
const EDGE_COLORS = ${JSON.stringify(edgeColors)};

const nodesDS = new vis.DataSet(NODES_DATA);
const edgesDS = new vis.DataSet(EDGES_DATA);

// ── Precomputed lookups ───────────────────────────────────────────────────────
const nodeById = {};
NODES_DATA.forEach(n => { nodeById[n.id] = n; });

// Adjacency map (undirected) for focus + path BFS
const adj = {};
EDGES_DATA.forEach(e => {
  if (!adj[e.from]) adj[e.from] = new Set();
  if (!adj[e.to])   adj[e.to]   = new Set();
  adj[e.from].add(e.to);
  adj[e.to].add(e.from);
});

// Edge lookup for path edge highlighting: "fromId|toId" -> edge id
const edgeMap = {};
EDGES_DATA.forEach(e => {
  edgeMap[e.from + '|' + e.to] = e.id;
  edgeMap[e.to + '|' + e.from] = e.id;
});

// Original colors for path restore
const originalColors = {};
NODES_DATA.forEach(n => { originalColors[n.id] = n.color; });
const originalEdgeColors = {};
EDGES_DATA.forEach(e => { originalEdgeColors[e.id] = e.color; });

// ── Filter state ─────────────────────────────────────────────────────────────
const hiddenNodeKinds = new Set();
const hiddenEdgeKinds = new Set();
let minDegree   = 0;
let focusActive = false;
let focusSet    = new Set();
let searchActive = false;
let searchIds   = new Set();
let pathHighlightActive = false;

// ── Path mode state ───────────────────────────────────────────────────────────
let pathMode = false;
let pathStep = 0;
let pathFromId = null;
let pathToId   = null;

// ── History state ─────────────────────────────────────────────────────────────
const navHistory = [];
let histIdx = -1;

// ── vis.js network ────────────────────────────────────────────────────────────
const network = new vis.Network(
  document.getElementById('graph'),
  { nodes: nodesDS, edges: edgesDS },
  {
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -80, centralGravity: 0.005, springLength: 120, springConstant: 0.08, damping: 0.6, avoidOverlap: 0.6 },
      stabilization: { iterations: 150, fit: true },
    },
    interaction: { hover: true, tooltipDelay: 150, hideEdgesOnDrag: true, multiselect: false },
    nodes: { shape: 'dot', scaling: { min: 6, max: 40 }, shadow: { enabled: true, color: 'rgba(0,0,0,.6)', size: 8, x: 2, y: 2 } },
    edges: { smooth: { type: 'continuous' }, selectionWidth: 2, hoverWidth: 1.5 },
    layout: { improvedLayout: false },
  }
);

// ── Init loader — driven by stabilization progress ────────────────────────────
const initLoader  = document.getElementById('init-loader');
const progressBar = document.getElementById('init-progress-bar');
const initStatus  = document.getElementById('init-status');

network.on('stabilizationProgress', params => {
  const pct = Math.round((params.iterations / params.total) * 100);
  progressBar.style.width = pct + '%';
  initStatus.textContent  = 'Laying out graph… ' + pct + '%';
});

network.on('stabilizationIterationsDone', () => {
  progressBar.style.width = '100%';
  initStatus.textContent  = 'Done';
  // Disable physics AND future stabilization so DataSet updates never re-trigger
  // layout passes — which would cause nodes to jump/drag on the next click.
  network.setOptions({ physics: { enabled: false, stabilization: { enabled: false } } });
  physicsOn = false;
  document.getElementById('btn-physics').classList.remove('active');
  initLoader.classList.add('fade-out');
  setTimeout(() => initLoader.remove(), 420);
});

// ── Central filter ─────────────────────────────────────────────────────────────
function applyFilters(skipLoader) {
  withLoader(skipLoader, () => {
    const nodeUpdates = [];
    const edgeUpdates = [];

    NODES_DATA.forEach(n => {
      let hidden = false;
      if (hiddenNodeKinds.has(n.kind))               hidden = true;
      else if (n.degree < minDegree)                 hidden = true;
      else if (focusActive && !focusSet.has(n.id))   hidden = true;
      else if (searchActive && !searchIds.has(n.id)) hidden = true;
      nodeUpdates.push({ id: n.id, hidden });
    });

    EDGES_DATA.forEach(e => {
      const hidden = hiddenEdgeKinds.has(e.ekind);
      edgeUpdates.push({ id: e.id, hidden });
    });

    nodesDS.update(nodeUpdates);
    edgesDS.update(edgeUpdates);
  });
}

// ── Loader helper ─────────────────────────────────────────────────────────────
function withLoader(skip, fn) {
  const loader = document.getElementById('loader');
  if (skip) { fn(); return; }
  loader.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => { fn(); loader.style.display = 'none'; }));
}

// ── Panel tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const t = tab.dataset.tab;
    document.getElementById('tab-detail').style.display  = t === 'detail'  ? '' : 'none';
    document.getElementById('tab-legend').style.display  = t === 'legend'  ? '' : 'none';
    document.getElementById('tab-filters').style.display = t === 'filters' ? '' : 'none';
  });
});

// ── History ───────────────────────────────────────────────────────────────────
function pushHistory(nodeId) {
  navHistory.splice(histIdx + 1);
  navHistory.push(nodeId);
  if (navHistory.length > 50) navHistory.shift();
  histIdx = navHistory.length - 1;
  updateHistoryNav();
}

function updateHistoryNav() {
  const n     = nodeById[navHistory[histIdx]];
  const label = document.getElementById('hist-label');
  const back  = document.getElementById('hist-back');
  const fwd   = document.getElementById('hist-forward');
  if (!label) return; // elements may not exist (e.g. panel is in empty/path state)
  label.textContent = n ? n.label : 'no selection';
  back.disabled     = histIdx <= 0;
  fwd.disabled      = histIdx >= navHistory.length - 1;
}

document.getElementById('hist-back').addEventListener('click', () => {
  if (histIdx > 0) { histIdx--; updateHistoryNav(); showDetail(navHistory[histIdx], false); network.selectNodes([navHistory[histIdx]]); }
});
document.getElementById('hist-forward').addEventListener('click', () => {
  if (histIdx < navHistory.length - 1) { histIdx++; updateHistoryNav(); showDetail(navHistory[histIdx], false); network.selectNodes([navHistory[histIdx]]); }
});

// ── Detail panel ──────────────────────────────────────────────────────────────
function showDetail(nodeId, addToHistory) {
  if (addToHistory !== false) pushHistory(nodeId);
  const n = nodeById[nodeId];
  if (!n) return;

  document.getElementById('tab-detail').innerHTML =
    '<div id="history-nav">' +
      '<button class="hist-btn" id="hist-back"' + (histIdx <= 0 ? ' disabled' : '') + '>‹</button>' +
      '<span id="hist-label" title="' + esc(n.label) + '">' + esc(n.label) + '</span>' +
      '<button class="hist-btn" id="hist-forward"' + (histIdx >= navHistory.length - 1 ? ' disabled' : '') + '>›</button>' +
    '</div>' +
    '<div class="detail-name">' + esc(n.label) + '</div>' +
    '<span class="detail-kind">' + esc(n.kind) + '</span>' +
    '<div class="detail-row"><span class="detail-label">file</span><span class="detail-val">' + esc(n.filePath) + ':' + n.startLine + '</span></div>' +
    (n.qualifiedName !== n.label ? '<div class="detail-row"><span class="detail-label">qualified</span><span class="detail-val">' + esc(n.qualifiedName) + '</span></div>' : '') +
    '<div class="detail-row"><span class="detail-label">degree</span><span class="detail-val">' + n.degree + ' connections</span></div>' +
    '<div class="detail-row"><span class="detail-label">exported</span><span class="detail-val">' + (n.isExported ? '✓' : '—') + '</span></div>' +
    (n.signature ? '<div class="detail-sig">' + esc(n.signature) + '</div>' : '') +
    '<div class="detail-actions">' +
      '<button class="action-btn" data-action="copy" data-ref="' + esc(n.filePath + ':' + n.startLine) + '">⎘ Copy ref</button>' +
      '<button class="action-btn" data-action="path-from" data-nodeid="' + esc(nodeId) + '">⟶ Path from here</button>' +
    '</div>';

  // Re-attach history buttons
  document.getElementById('hist-back').addEventListener('click', () => {
    if (histIdx > 0) { histIdx--; updateHistoryNav(); showDetail(navHistory[histIdx], false); network.selectNodes([navHistory[histIdx]]); }
  });
  document.getElementById('hist-forward').addEventListener('click', () => {
    if (histIdx < navHistory.length - 1) { histIdx++; updateHistoryNav(); showDetail(navHistory[histIdx], false); network.selectNodes([navHistory[histIdx]]); }
  });
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ── Panel event delegation (replaces all inline onclick) ──────────────────────
document.getElementById('panel-content').addEventListener('click', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset.action;
  if (action === 'copy')        { copyToClipboard(el.dataset.ref); }
  if (action === 'path-from')   { setPathFrom(el.dataset.nodeid); }
  if (action === 'show-detail') { showDetail(el.dataset.nodeid, true); network.selectNodes([el.dataset.nodeid]); }
  if (action === 'reset')       { resetToEmpty(); }
});

// ── Network click handler ─────────────────────────────────────────────────────
let lastSelectedId = null;

network.on('click', params => {
  if (params.nodes.length === 0) {
    if (pathMode) exitPath(true);
    lastSelectedId = null;
    return;
  }

  const nodeId = params.nodes[0];

  if (pathMode) {
    handlePathClick(nodeId);
    return;
  }

  if (lastSelectedId && lastSelectedId !== nodeId) {
    runPathBFS(lastSelectedId, nodeId);
    lastSelectedId = null;
    return;
  }

  lastSelectedId = nodeId;
  showDetail(nodeId, true);
  network.focus(nodeId, { scale: 1.5, animation: { duration: 300, easingFunction: 'easeInOutQuad' } });

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="detail"]').classList.add('active');
  document.getElementById('tab-detail').style.display  = '';
  document.getElementById('tab-legend').style.display  = 'none';
  document.getElementById('tab-filters').style.display = 'none';
});

network.on('doubleClick', params => {
  if (focusActive && params.nodes.length === 0) exitFocus();
});

// ── Focus mode ────────────────────────────────────────────────────────────────
document.getElementById('btn-focus').addEventListener('click', () => {
  if (focusActive) { exitFocus(); return; }
  const selected = network.getSelectedNodes();
  if (selected.length === 0) {
    document.getElementById('btn-focus').classList.add('warn');
    setTimeout(() => document.getElementById('btn-focus').classList.remove('warn'), 800);
    return;
  }
  enterFocus(selected[0]);
});

function enterFocus(nodeId) {
  exitPath(false);
  focusActive = true;
  focusSet = new Set([nodeId, ...(adj[nodeId] ?? [])]);
  document.getElementById('btn-focus').classList.add('active');
  applyFilters();
}

function exitFocus() {
  focusActive = false;
  focusSet    = new Set();
  document.getElementById('btn-focus').classList.remove('active');
  applyFilters();
}

// ── Path mode ─────────────────────────────────────────────────────────────────
document.getElementById('btn-path').addEventListener('click', () => {
  if (pathMode) { exitPath(true); } else { enterPath(); }
});

function enterPath() {
  exitFocus();
  pathMode   = true;
  pathStep   = 1;
  pathFromId = null;
  pathToId   = null;
  clearPathHighlight();
  document.getElementById('btn-path').classList.add('active');
  document.getElementById('path-bar').style.display = 'block';
  document.getElementById('path-bar').textContent   = 'Click a node to set start…';
}

function exitPath(resetHighlight) {
  pathMode = false;
  pathStep = 0;
  document.getElementById('btn-path').classList.remove('active');
  document.getElementById('path-bar').style.display = 'none';
  if (resetHighlight) clearPathHighlight();
}

function setPathFrom(nodeId) {
  enterPath();
  handlePathClick(nodeId);
}

function handlePathClick(nodeId) {
  if (pathStep === 1) {
    pathFromId = nodeId;
    pathStep   = 2;
    document.getElementById('path-bar').textContent = 'From: ' + (nodeById[nodeId] && nodeById[nodeId].label || nodeId) + ' — now click destination…';
    network.selectNodes([nodeId]);
  } else if (pathStep === 2) {
    pathToId = nodeId;
    exitPath(false);
    runPathBFS(pathFromId, pathToId);
  }
}

function runPathBFS(fromId, toId) {
  if (fromId === toId) return;
  const prev  = new Map();
  const queue = [fromId];
  const visited = new Set([fromId]);

  outer: while (queue.length > 0) {
    const cur = queue.shift();
    const neighbors = adj[cur] || new Set();
    for (const nb of neighbors) {
      if (!visited.has(nb)) {
        visited.add(nb);
        prev.set(nb, cur);
        if (nb === toId) break outer;
        queue.push(nb);
      }
    }
  }

  if (!prev.has(toId)) {
    showPathResult([], fromId, toId);
    return;
  }

  const pathIds = [];
  let cur = toId;
  while (cur !== undefined) { pathIds.unshift(cur); cur = prev.get(cur); }

  highlightPath(pathIds);
  showPathResult(pathIds, fromId, toId);
}

function highlightPath(pathIds) {
  clearPathHighlight();
  pathHighlightActive = true;

  const pathSet = new Set(pathIds);
  const DIM  = { background: '#141420', border: '#1a1a2e', highlight: { background: '#1a1a2e', border: '#2a2a3e' } };
  const GOLD = { background: '#f39c12', border: '#e67e22', highlight: { background: '#ffd700', border: '#f39c12' } };

  const nodeUpdates = NODES_DATA.map(n => ({ id: n.id, color: pathSet.has(n.id) ? GOLD : DIM }));
  nodesDS.update(nodeUpdates);

  const pathEdgeIds = new Set();
  for (let i = 0; i < pathIds.length - 1; i++) {
    const eid = edgeMap[pathIds[i] + '|' + pathIds[i + 1]];
    if (eid !== undefined) pathEdgeIds.add(eid);
  }

  const edgeUpdates = EDGES_DATA.map(e => ({
    id: e.id,
    color: pathEdgeIds.has(e.id) ? { color: '#f39c12', opacity: 1 } : { color: '#1a1a2e', opacity: 0.15 },
    width: pathEdgeIds.has(e.id) ? 3 : 1,
  }));
  edgesDS.update(edgeUpdates);

  network.selectNodes(pathIds);
  network.fit({ nodes: pathIds, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
}

function clearPathHighlight() {
  if (!pathHighlightActive) return;
  pathHighlightActive = false;
  nodesDS.update(NODES_DATA.map(n => ({ id: n.id, color: originalColors[n.id], width: n.borderWidth })));
  edgesDS.update(EDGES_DATA.map(e => ({ id: e.id, color: originalEdgeColors[e.id], width: e.width })));
}

function nodeCard(n) {
  if (!n) return '';
  return '<div class="node-card">' +
    '<div class="node-card-name">' + esc(n.label) + '</div>' +
    '<span class="detail-kind">' + esc(n.kind) + '</span>' +
    '<div class="detail-row" style="margin-top:6px"><span class="detail-label">file</span><span class="detail-val">' + esc(n.filePath) + ':' + n.startLine + '</span></div>' +
    '<div class="detail-row"><span class="detail-label">degree</span><span class="detail-val">' + n.degree + ' connections</span></div>' +
    (n.signature ? '<div class="detail-sig" style="margin-top:6px">' + esc(n.signature) + '</div>' : '') +
  '</div>';
}

function showPathResult(pathIds, fromId, toId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="detail"]').classList.add('active');
  document.getElementById('tab-detail').style.display  = '';
  document.getElementById('tab-legend').style.display  = 'none';
  document.getElementById('tab-filters').style.display = 'none';

  const from = nodeById[fromId];
  const to   = nodeById[toId];

  if (pathIds.length === 0) {
    document.getElementById('tab-detail').innerHTML =
      '<div id="history-nav">' +
        '<button class="hist-btn" id="hist-back" disabled>‹</button>' +
        '<span id="hist-label">path result</span>' +
        '<button class="hist-btn" id="hist-forward" disabled>›</button>' +
      '</div>' +
      '<p style="color:#e67e22;font-size:12px;margin-top:8px">No path found between <b>' + esc(from && from.label) + '</b> and <b>' + esc(to && to.label) + '</b>.</p>' +
      nodeCard(from) +
      nodeCard(to) +
      '<button class="action-btn" style="margin-top:10px" data-action="reset">✕ Clear</button>';
    return;
  }

  const steps = pathIds.map((id, i) => {
    const n = nodeById[id];
    return (i > 0 ? '<div class="path-connector">│</div>' : '') +
      '<div class="path-step">' +
        '<span class="path-step-num">' + (i + 1) + '.</span>' +
        '<span>' +
          '<span class="path-step-name" data-action="show-detail" data-nodeid="' + esc(id) + '">' + esc(n && n.label || id) + '</span>' +
          '<span class="path-step-kind"> ' + esc(n && n.kind || '') + '</span>' +
        '</span>' +
      '</div>';
  }).join('');

  document.getElementById('tab-detail').innerHTML =
    '<div id="history-nav">' +
      '<button class="hist-btn" id="hist-back" disabled>‹</button>' +
      '<span id="hist-label">path: ' + pathIds.length + ' hops</span>' +
      '<button class="hist-btn" id="hist-forward" disabled>›</button>' +
    '</div>' +
    '<div style="font-size:11px;color:#546e7a;margin-bottom:12px">' + esc(from && from.label) + ' → ' + esc(to && to.label) + '</div>' +
    '<div class="path-result">' + steps + '</div>' +
    '<div class="path-endpoints">' +
      '<div class="path-endpoint-label">From</div>' + nodeCard(from) +
      '<div class="path-endpoint-label" style="margin-top:10px">To</div>' + nodeCard(to) +
    '</div>' +
    '<button class="action-btn" style="margin-top:12px" data-action="reset">✕ Clear</button>';
}

// ── Node kind filter ──────────────────────────────────────────────────────────
document.querySelectorAll('.legend-item[data-nkind]').forEach(item => {
  item.addEventListener('click', () => {
    const kind = item.dataset.nkind;
    hiddenNodeKinds.has(kind) ? hiddenNodeKinds.delete(kind) : hiddenNodeKinds.add(kind);
    item.classList.toggle('dimmed', hiddenNodeKinds.has(kind));
    applyFilters();
  });
});

// ── Edge kind filter ──────────────────────────────────────────────────────────
document.querySelectorAll('.legend-item[data-ekind]').forEach(item => {
  item.addEventListener('click', () => {
    const kind = item.dataset.ekind;
    hiddenEdgeKinds.has(kind) ? hiddenEdgeKinds.delete(kind) : hiddenEdgeKinds.add(kind);
    item.classList.toggle('dimmed', hiddenEdgeKinds.has(kind));
    applyFilters();
  });
});

// ── Degree slider ─────────────────────────────────────────────────────────────
document.getElementById('degree-slider').addEventListener('input', e => {
  minDegree = parseInt(e.target.value, 10);
  document.getElementById('degree-val').textContent = String(minDegree);
  applyFilters();
});

// ── Search — Feature 1: glow instead of hide ─────────────────────────────────
let searchTimer = null;
document.getElementById('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim().toLowerCase();
  searchTimer = setTimeout(() => {
    withLoader(false, () => {
      if (!q) {
        searchActive = false;
        searchIds    = new Set();
        // Restore original colors
        nodesDS.update(NODES_DATA.map(n => ({
          id: n.id, color: originalColors[n.id], size: n.size, borderWidth: n.borderWidth,
        })));
      } else {
        const matches = NODES_DATA.filter(n =>
          n.label.toLowerCase().includes(q) ||
          n.qualifiedName.toLowerCase().includes(q) ||
          n.filePath.toLowerCase().includes(q)
        );
        searchActive = true;
        searchIds    = new Set(matches.map(n => n.id));
        // Apply glow to matching, dim non-matching — no hiding
        const DIM_COLOR = { background: '#111118', border: '#1a1a2a', highlight: { background: '#111118', border: '#1a1a2a' }, hover: { background: '#111118', border: '#1a1a2a' } };
        const GLOW_BORDER = '#ffffff';
        nodesDS.update(NODES_DATA.map(n => {
          if (searchIds.has(n.id)) {
            return { id: n.id, color: { ...originalColors[n.id], border: GLOW_BORDER }, size: n.size * 1.4, borderWidth: 3 };
          } else {
            return { id: n.id, color: DIM_COLOR, size: n.size, borderWidth: n.borderWidth };
          }
        }));
      }
      // Still apply other filters (kind/degree) for hidden state
      applyFilters(true);
      if (searchActive && searchIds.size > 0) {
        network.fit({ nodes: [...searchIds], animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
      } else if (!searchActive) {
        network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
      }
    });
  }, 180);
});

// ── Toolbar buttons ───────────────────────────────────────────────────────────
document.getElementById('btn-fit').addEventListener('click', () =>
  network.fit({ animation: { duration: 600, easingFunction: 'easeInOutQuad' } })
);

let physicsOn = true;
document.getElementById('btn-physics').addEventListener('click', () => {
  physicsOn = !physicsOn;
  network.setOptions({ physics: { enabled: physicsOn } });
  document.getElementById('btn-physics').classList.toggle('active', physicsOn);
  document.getElementById('physics-speed-row').style.display = physicsOn ? 'flex' : 'none';
});

document.getElementById('physics-speed').addEventListener('input', function() {
  const v = parseInt(this.value); // 1..10
  // Damping: high value = slow (lots of friction), low value = fast (little friction)
  // Speed 1 → damping 0.9, Speed 10 → damping 0.05
  const damping = 0.9 - (v - 1) * (0.85 / 9);
  network.setOptions({ physics: { forceAtlas2Based: { damping: Math.round(damping * 100) / 100 } } });
});


document.getElementById('btn-png').addEventListener('click', () => {
  const canvas = document.querySelector('#graph canvas');
  if (!canvas) return;
  const tmp = document.createElement('canvas');
  tmp.width  = canvas.width;
  tmp.height = canvas.height;
  const ctx  = tmp.getContext('2d');
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(canvas, 0, 0);
  const a    = document.createElement('a');
  a.href     = tmp.toDataURL('image/png');
  a.download = 'kirograph-' + Date.now() + '.png';
  a.click();
});

// ── Feature 2: Cluster by directory ──────────────────────────────────────────
let clusterActive = false;
const clusterIds = [];
let savedPositions = {};

function setClusterButtonsVisible(visible) {
  ['btn-focus', 'btn-path', 'btn-heat'].forEach(id => {
    document.getElementById(id).style.display = visible ? '' : 'none';
  });
}

document.getElementById('btn-cluster').addEventListener('click', () => {
  if (clusterActive) {
    // ── Uncluster ─────────────────────────────────────────────────────────────
    clusterIds.length = 0;
    clusterActive = false;
    document.getElementById('btn-cluster').classList.remove('active');

    // Restore nodes at saved positions with physics off so they snap back exactly
    network.setOptions({ physics: { enabled: false } });
    nodesDS.clear();
    edgesDS.clear();
    nodesDS.add(NODES_DATA.map(n => ({
      ...n,
      hidden: false,
      color: originalColors[n.id],
      x: savedPositions[n.id] ? savedPositions[n.id].x : undefined,
      y: savedPositions[n.id] ? savedPositions[n.id].y : undefined,
    })));
    edgesDS.add(EDGES_DATA.map(e => ({ ...e, hidden: false, color: originalEdgeColors[e.id] })));
    network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });

    // Restore hidden buttons
    setClusterButtonsVisible(true);

  } else {
    // ── Cluster ───────────────────────────────────────────────────────────────

    // Deactivate incompatible modes before clustering
    if (heatActive) {
      heatActive = false;
      document.getElementById('btn-heat').classList.remove('active');
      document.getElementById('heat-legend').style.display = 'none';
      nodesDS.update(NODES_DATA.map(n => ({ id: n.id, color: originalColors[n.id] })));
    }
    if (focusActive) exitFocus();
    if (pathMode) exitPath(true);
    network.unselectAll();

    // Snapshot positions before clustering
    savedPositions = network.getPositions(NODES_DATA.map(n => n.id));

    // Hide incompatible buttons
    setClusterButtonsVisible(false);

    const dirs = [...new Set(NODES_DATA.map(n => n.dir).filter(Boolean))];
    dirs.forEach(dir => {
      const dirNodes = NODES_DATA.filter(n => n.dir === dir);
      if (dirNodes.length < 2) return;
      const nodeIds = new Set(dirNodes.map(n => n.id));
      const cid = 'cluster:' + dir;
      network.cluster({
        clusterNodeProperties: {
          id: cid,
          label: '\\uD83D\\uDCC1 ' + dir + ' (' + dirNodes.length + ')',
          shape: 'box',
          color: { background: '#1e1e3a', border: '#7986cb', highlight: { background: '#2a2a4e', border: '#c792ea' } },
          font: { size: 13, color: '#c792ea', face: 'monospace' },
          borderWidth: 2,
          size: 20,
        },
        clusterEdgeProperties: {
          color: { color: '#ffffff', opacity: 0.7 },
          dashes: true,
          width: 2,
          smooth: { type: 'continuous' },
        },
        joinCondition: function(nodeOptions) { return nodeIds.has(nodeOptions.id); },
      });
      clusterIds.push(cid);
    });
    clusterActive = true;
    document.getElementById('btn-cluster').classList.add('active');
  }
});

// ── Feature 3: Minimap ────────────────────────────────────────────────────────
function drawMinimap() {
  const canvas = document.getElementById('minimap-canvas');
  const ctx = canvas.getContext('2d');
  const W = 180, H = 120;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(10,10,15,0.9)';
  ctx.fillRect(0, 0, W, H);

  const positions = network.getPositions();
  const ids = Object.keys(positions);
  if (ids.length === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  ids.forEach(id => {
    minX = Math.min(minX, positions[id].x); maxX = Math.max(maxX, positions[id].x);
    minY = Math.min(minY, positions[id].y); maxY = Math.max(maxY, positions[id].y);
  });
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const pad = 10;
  const scaleX = (W - pad * 2) / rangeX, scaleY = (H - pad * 2) / rangeY;
  const scale = Math.min(scaleX, scaleY);

  function toCanvas(x, y) {
    return {
      cx: pad + (x - minX) * scale,
      cy: pad + (y - minY) * scale,
    };
  }

  // Draw edges as thin lines
  ctx.strokeStyle = 'rgba(121,134,203,0.2)';
  ctx.lineWidth = 0.5;
  EDGES_DATA.forEach(e => {
    const fp = positions[e.from], tp = positions[e.to];
    if (!fp || !tp) return;
    const f = toCanvas(fp.x, fp.y), t = toCanvas(tp.x, tp.y);
    ctx.beginPath(); ctx.moveTo(f.cx, f.cy); ctx.lineTo(t.cx, t.cy); ctx.stroke();
  });

  // Draw nodes as dots
  ids.forEach(id => {
    const p = positions[id];
    const c = toCanvas(p.x, p.y);
    const n = nodeById[id];
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = (n && n.color && n.color.background) ? n.color.background : '#546e7a';
    ctx.fill();
  });

  // Draw viewport rectangle
  const vp = network.getViewPosition();
  const vs = network.getScale();
  const graphEl = document.getElementById('graph');
  const vpW = graphEl.clientWidth / vs, vpH = graphEl.clientHeight / vs;
  const vpMinX = vp.x - vpW / 2, vpMinY = vp.y - vpH / 2;
  const tl = toCanvas(vpMinX, vpMinY);
  const br = toCanvas(vpMinX + vpW, vpMinY + vpH);
  ctx.strokeStyle = 'rgba(199,146,234,0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(tl.cx, tl.cy, br.cx - tl.cx, br.cy - tl.cy);
}

network.on('afterDrawing', drawMinimap);

document.getElementById('minimap').addEventListener('click', function(e) {
  const rect = this.getBoundingClientRect();
  const W = 180, H = 120;
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const positions = network.getPositions();
  const ids = Object.keys(positions);
  if (ids.length === 0) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  ids.forEach(id => {
    minX = Math.min(minX, positions[id].x); maxX = Math.max(maxX, positions[id].x);
    minY = Math.min(minY, positions[id].y); maxY = Math.max(maxY, positions[id].y);
  });
  const pad = 10;
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const scaleX = (W - pad * 2) / rangeX, scaleY = (H - pad * 2) / rangeY;
  const scale = Math.min(scaleX, scaleY);
  const gx = (mx - pad) / scale + minX;
  const gy = (my - pad) / scale + minY;
  network.moveTo({ position: { x: gx, y: gy }, animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
});

// ── Feature 4: Right-click context menu ───────────────────────────────────────
const ctxMenu = document.getElementById('ctx-menu');
let ctxNodeId = null;

network.on('oncontext', function(params) {
  params.event.preventDefault();
  const nodeId = network.getNodeAt(params.pointer.DOM);
  ctxNodeId = nodeId || null;
  if (!nodeId) { ctxMenu.style.display = 'none'; return; }
  ctxMenu.innerHTML =
    '<div class="ctx-item" data-ctx="focus-neighbors" data-nodeid="' + nodeId + '">◎ Focus neighbors</div>' +
    '<div class="ctx-item" data-ctx="path-from" data-nodeid="' + nodeId + '">⟶ Path from here</div>' +
    '<div class="ctx-sep"></div>' +
    '<div class="ctx-item" data-ctx="copy-id" data-nodeid="' + nodeId + '">⎘ Copy ID</div>' +
    '<div class="ctx-item" data-ctx="copy-path" data-nodeid="' + nodeId + '">⎘ Copy file path</div>' +
    '<div class="ctx-sep"></div>' +
    '<div class="ctx-item" data-ctx="highlight-kind" data-nodeid="' + nodeId + '">◈ Highlight same kind</div>';
  ctxMenu.style.display = 'block';
  ctxMenu.style.left = params.event.clientX + 'px';
  ctxMenu.style.top  = params.event.clientY + 'px';
});

document.addEventListener('click', () => { ctxMenu.style.display = 'none'; });

ctxMenu.addEventListener('click', function(e) {
  const item = e.target.closest('[data-ctx]');
  if (!item) return;
  const action = item.dataset.ctx;
  const nid = item.dataset.nodeid;
  ctxMenu.style.display = 'none';
  if (action === 'focus-neighbors') {
    enterFocus(nid);
  } else if (action === 'path-from') {
    setPathFrom(nid);
  } else if (action === 'copy-id') {
    copyToClipboard(nid);
  } else if (action === 'copy-path') {
    const n = nodeById[nid];
    copyToClipboard(n ? n.filePath : nid);
  } else if (action === 'highlight-kind') {
    const n = nodeById[nid];
    if (!n) return;
    const kind = n.kind;
    const DIM = { background: '#111118', border: '#1a1a2a', highlight: { background: '#111118', border: '#1a1a2a' }, hover: { background: '#111118', border: '#1a1a2a' } };
    pathHighlightActive = true;
    nodesDS.update(NODES_DATA.map(nd => ({
      id: nd.id,
      color: nd.kind === kind ? originalColors[nd.id] : DIM,
    })));
  }
});

// ── Feature 5: Heat map overlay ───────────────────────────────────────────────
let heatActive = false;

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); return Math.round(255 * c).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}

document.getElementById('btn-heat').addEventListener('click', () => {
  heatActive = !heatActive;
  document.getElementById('btn-heat').classList.toggle('active', heatActive);
  document.getElementById('heat-legend').style.display = heatActive ? 'block' : 'none';
  if (heatActive) {
    const times = NODES_DATA.map(n => n.lastModified).filter(t => t > 0);
    const minT = Math.min(...times), maxT = Math.max(...times);
    const range = maxT - minT || 1;
    nodesDS.update(NODES_DATA.map(n => {
      const t = n.lastModified || minT;
      const ratio = (t - minT) / range; // 1 = newest, 0 = oldest
      // newest = warm red (H=0), oldest = cool blue (H=210)
      const h = Math.round((1 - ratio) * 210);
      const bg = hslToHex(h, 70, 45);
      return { id: n.id, color: { background: bg, border: hslToHex(h, 70, 60), highlight: { background: bg, border: '#fff' }, hover: { background: hslToHex(h, 70, 55), border: '#fff' } } };
    }));
  } else {
    nodesDS.update(NODES_DATA.map(n => ({ id: n.id, color: originalColors[n.id] })));
  }
});

// Heat stop hover tooltips
document.querySelectorAll('.heat-stop').forEach(function(el) {
  var tip = document.getElementById('heat-tip');
  el.addEventListener('mouseenter', function() { if (tip) tip.textContent = el.dataset.tip || ''; });
  el.addEventListener('mouseleave', function() { if (tip) tip.textContent = ''; });
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (pathMode)    { exitPath(true); }
    if (focusActive) { exitFocus(); }
  }
  if (e.key === 'f' && !e.metaKey && !e.ctrlKey && e.target.tagName !== 'INPUT') {
    network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  }
});

// ── Reset to initial state ────────────────────────────────────────────────────
function resetToEmpty() {
  // 1. Restore every node and edge to its original color and make all visible
  pathHighlightActive = false;
  nodesDS.update(NODES_DATA.map(n => ({ id: n.id, hidden: false, color: originalColors[n.id] })));
  edgesDS.update(EDGES_DATA.map(e => ({ id: e.id, hidden: false, color: originalEdgeColors[e.id] })));

  // 2. Clear network selection and zoom back to full graph
  network.unselectAll();
  network.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } });

  // 3. Reset all state variables
  lastSelectedId  = null;
  pathMode        = false;
  pathStep        = 0;
  pathFromId      = null;
  pathToId        = null;
  focusActive     = false;
  focusSet        = new Set();
  searchActive    = false;
  searchIds       = new Set();
  minDegree       = 0;
  hiddenNodeKinds.clear();
  hiddenEdgeKinds.clear();

  // 4. Reset UI controls
  document.getElementById('btn-path').classList.remove('active');
  document.getElementById('btn-focus').classList.remove('active');
  document.getElementById('path-bar').style.display = 'none';
  document.getElementById('search').value = '';
  document.getElementById('degree-slider').value = '0';
  document.getElementById('degree-val').textContent = '0';
  document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('dimmed'));

  // Reset heat map
  if (heatActive) {
    heatActive = false;
    document.getElementById('btn-heat').classList.remove('active');
    document.getElementById('heat-legend').style.display = 'none';
  }

  // Reset context menu
  document.getElementById('ctx-menu').style.display = 'none';
  ctxNodeId = null;

  // 5. Restore detail panel (must keep hist-nav in DOM so next showDetail doesn't crash)
  document.getElementById('tab-detail').innerHTML =
    '<div id="history-nav">' +
      '<button class="hist-btn" id="hist-back" disabled>‹</button>' +
      '<span id="hist-label">no selection</span>' +
      '<button class="hist-btn" id="hist-forward" disabled>›</button>' +
    '</div>' +
    '<p class="detail-empty">Click a node to inspect it.</p>';
  document.getElementById('hist-back').addEventListener('click', () => {
    if (histIdx > 0) { histIdx--; updateHistoryNav(); showDetail(navHistory[histIdx], false); network.selectNodes([navHistory[histIdx]]); }
  });
  document.getElementById('hist-forward').addEventListener('click', () => {
    if (histIdx < navHistory.length - 1) { histIdx++; updateHistoryNav(); showDetail(navHistory[histIdx], false); network.selectNodes([navHistory[histIdx]]); }
  });
}

// ── In/out degree precomputation ──────────────────────────────────────────────
var _inDeg = null, _outDeg = null;
function ensureInOutDeg() {
  if (_inDeg) return;
  _inDeg = {}; _outDeg = {};
  NODES_DATA.forEach(function(n) { _inDeg[n.id] = 0; _outDeg[n.id] = 0; });
  EDGES_DATA.forEach(function(e) {
    _outDeg[e.from] = (_outDeg[e.from] || 0) + 1;
    _inDeg[e.to]    = (_inDeg[e.to]    || 0) + 1;
  });
}

// ── Shared horizontal bar renderer ────────────────────────────────────────────
// rows: [{label, sublabel, value, color}], sorted descending, already sliced
function drawHBar(canvasId, rows) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!rows.length) {
    ctx.fillStyle = '#5a6280'; ctx.font = '12px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No data', W / 2, H / 2); return;
  }
  var maxVal = Math.max.apply(null, rows.map(function(r) { return r.value; })) || 1;
  var PAD_L = 210, PAD_R = 60, PAD_T = 14, PAD_B = 14;
  var barH = Math.floor((H - PAD_T - PAD_B) / rows.length);
  var barGap = Math.max(2, Math.floor(barH * 0.2));
  var barThick = barH - barGap;
  var barMaxW = W - PAD_L - PAD_R;

  ctx.strokeStyle = 'rgba(80,80,120,0.6)'; ctx.lineWidth = 1;
  for (var g = 0; g <= 4; g++) {
    var gx = PAD_L + Math.round((g / 4) * barMaxW);
    ctx.beginPath(); ctx.moveTo(gx, PAD_T); ctx.lineTo(gx, H - PAD_B); ctx.stroke();
  }

  rows.forEach(function(row, i) {
    var y = PAD_T + i * barH + Math.floor(barGap / 2);
    var w = Math.max(4, Math.round((row.value / maxVal) * barMaxW));
    var grad = ctx.createLinearGradient(PAD_L, 0, PAD_L + w, 0);
    grad.addColorStop(0, row.color); grad.addColorStop(1, row.color + '88');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(PAD_L, y, w, barThick, 3); ctx.fill();

    var lbl = row.label.length > 28 ? row.label.slice(0, 26) + '\u2026' : row.label;
    ctx.fillStyle = '#c8d4f0'; ctx.font = '11px monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(lbl, PAD_L - 8, y + barThick / 2);
    ctx.fillStyle = '#c792ea'; ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(String(row.value), PAD_L + w + 6, y + barThick / 2);
  });
}

// ── Shared vertical bar renderer ──────────────────────────────────────────────
// entries: [[label, value]], sorted descending, already sliced; colorFn(label,i)->color
function drawVBar(canvasId, entries, colorFn) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!entries.length) {
    ctx.fillStyle = '#5a6280'; ctx.font = '12px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No data', W / 2, H / 2); return;
  }
  var maxVal = Math.max.apply(null, entries.map(function(e) { return e[1]; })) || 1;
  var N = entries.length;
  var PAD_L = 32, PAD_R = 14, PAD_T = 14, PAD_B = 56;
  var plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  var barW = Math.floor(plotW / N), barGap = Math.max(3, Math.floor(barW * 0.2));
  var barThick = barW - barGap;

  ctx.strokeStyle = 'rgba(80,80,120,0.6)'; ctx.lineWidth = 1;
  for (var g = 1; g <= 4; g++) {
    var gy = PAD_T + Math.round((1 - g / 4) * plotH);
    ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(W - PAD_R, gy); ctx.stroke();
    ctx.fillStyle = '#7a86aa'; ctx.font = '9px monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(maxVal * g / 4)), PAD_L - 3, gy);
  }

  entries.forEach(function(entry, i) {
    var lbl = entry[0], val = entry[1];
    var x = PAD_L + i * barW + Math.floor(barGap / 2);
    var bh = Math.max(2, Math.round((val / maxVal) * plotH));
    var color = colorFn(lbl, i);
    var grad = ctx.createLinearGradient(0, PAD_T + plotH - bh, 0, PAD_T + plotH);
    grad.addColorStop(0, color); grad.addColorStop(1, color + '88');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(x, PAD_T + plotH - bh, barThick, bh, 3); ctx.fill();
    ctx.fillStyle = '#c792ea'; ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(String(val), x + barThick / 2, PAD_T + plotH - bh - 2);
    var short = lbl.length > 10 ? lbl.slice(0, 9) + '\u2026' : lbl;
    ctx.save(); ctx.translate(x + barThick / 2, PAD_T + plotH + 6); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#9ba3c8'; ctx.font = '9px monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(short, 0, 0); ctx.restore();
  });
}

// ── 4. Top callers ────────────────────────────────────────────────────────────
function drawTopCallers() {
  ensureInOutDeg();
  var rows = NODES_DATA.slice()
    .sort(function(a, b) { return (_outDeg[b.id] || 0) - (_outDeg[a.id] || 0); })
    .slice(0, 15).filter(function(n) { return (_outDeg[n.id] || 0) > 0; })
    .map(function(n) { return { label: n.label, sublabel: n.kind, value: _outDeg[n.id] || 0, color: KIND_COLORS[n.kind] || '#546e7a' }; });
  drawHBar('chart-callers', rows);
}

// ── 5. Top callees ────────────────────────────────────────────────────────────
function drawTopCallees() {
  ensureInOutDeg();
  var rows = NODES_DATA.slice()
    .sort(function(a, b) { return (_inDeg[b.id] || 0) - (_inDeg[a.id] || 0); })
    .slice(0, 15).filter(function(n) { return (_inDeg[n.id] || 0) > 0; })
    .map(function(n) { return { label: n.label, sublabel: n.kind, value: _inDeg[n.id] || 0, color: KIND_COLORS[n.kind] || '#546e7a' }; });
  drawHBar('chart-callees', rows);
}

// ── 6. Files by symbol count ──────────────────────────────────────────────────
function drawFilesBySymbolCount() {
  var counts = {};
  NODES_DATA.forEach(function(n) { counts[n.filePath] = (counts[n.filePath] || 0) + 1; });
  var rows = Object.entries(counts)
    .sort(function(a, b) { return b[1] - a[1]; }).slice(0, 15)
    .map(function(e) {
      var parts = e[0].split('/');
      var short = parts.length > 2 ? '\u2026/' + parts.slice(-2).join('/') : e[0];
      return { label: short, sublabel: e[0], value: e[1], color: '#7986cb' };
    });
  drawHBar('chart-files', rows);
}

// ── 7. Edge kind distribution ─────────────────────────────────────────────────
function drawEdgeKindDistribution() {
  var canvas = document.getElementById('chart-edgekinds');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  var counts = {};
  EDGES_DATA.forEach(function(e) { counts[e.ekind] = (counts[e.ekind] || 0) + 1; });
  var entries = Object.entries(counts).sort(function(a, b) { return b[1] - a[1]; });
  var total = EDGES_DATA.length || 1;
  var cx = Math.round(W * 0.35), cy = H / 2;
  var outerR = Math.min(cx, cy) - 16, innerR = outerR * 0.5;
  var startAngle = -Math.PI / 2;

  entries.forEach(function(entry) {
    var kind = entry[0], count = entry[1];
    var angle = (count / total) * 2 * Math.PI;
    var color = EDGE_COLORS[kind] || '#546e7a';
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, startAngle + angle);
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#0d0d1a'; ctx.lineWidth = 2; ctx.stroke();
    startAngle += angle;
  });

  ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, 2 * Math.PI);
  ctx.fillStyle = '#0d0d1a'; ctx.fill();
  ctx.fillStyle = '#c792ea'; ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(EDGES_DATA.length), cx, cy - 7);
  ctx.fillStyle = '#7a86aa'; ctx.font = '10px monospace';
  ctx.fillText('edges', cx, cy + 9);

  var LEG_X = Math.round(W * 0.64), rowH = Math.floor((H - 28) / Math.min(entries.length, 12));
  entries.slice(0, 12).forEach(function(entry, i) {
    var kind = entry[0], count = entry[1];
    var y = 14 + i * rowH;
    var color = EDGE_COLORS[kind] || '#546e7a';
    ctx.fillStyle = color; ctx.fillRect(LEG_X, y + Math.floor(rowH / 2) - 2, 14, 3);
    ctx.fillStyle = '#b0c4d8'; ctx.font = '11px monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(kind, LEG_X + 18, y + rowH / 2);
    ctx.fillStyle = '#7a86aa'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText(count + '  ' + ((count / total) * 100).toFixed(1) + '%', W - 6, y + rowH / 2);
  });
}

// ── 8. Dead code by kind ──────────────────────────────────────────────────────
function drawDeadCodeByKind() {
  ensureInOutDeg();
  var canvas = document.getElementById('chart-deadcode');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  var counts = {};
  NODES_DATA.forEach(function(n) {
    if (!n.isExported && (_inDeg[n.id] || 0) === 0)
      counts[n.kind] = (counts[n.kind] || 0) + 1;
  });
  var entries = Object.entries(counts).sort(function(a, b) { return b[1] - a[1]; });
  if (!entries.length) {
    ctx.fillStyle = '#27ae60'; ctx.font = '13px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('\u2713 No dead code detected', W / 2, H / 2); return;
  }
  drawVBar('chart-deadcode', entries, function(kind) { return KIND_COLORS[kind] || '#546e7a'; });
}

// ── 9. Exported vs unexported by kind ─────────────────────────────────────────
function drawExportedRatio() {
  var canvas = document.getElementById('chart-exported');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  var kindData = {};
  NODES_DATA.forEach(function(n) {
    if (!kindData[n.kind]) kindData[n.kind] = { exp: 0, unexp: 0 };
    if (n.isExported) kindData[n.kind].exp++; else kindData[n.kind].unexp++;
  });
  var entries = Object.entries(kindData)
    .sort(function(a, b) { return (b[1].exp + b[1].unexp) - (a[1].exp + a[1].unexp); })
    .slice(0, 16);
  var N = entries.length;
  if (!N) return;

  var PAD_L = 96, PAD_R = 100, PAD_T = 32, PAD_B = 14;
  var rowH = Math.floor((H - PAD_T - PAD_B) / N);
  var rowGap = Math.max(2, Math.floor(rowH * 0.25));
  var barThick = rowH - rowGap;
  var barMaxW = W - PAD_L - PAD_R;

  // Legend
  ctx.fillStyle = '#c792ea'; ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('\u25A0 Exported', PAD_L, 10);
  ctx.fillStyle = '#7a86aa'; ctx.fillText('\u25A0 Unexported', PAD_L + 88, 10);

  entries.forEach(function(entry, i) {
    var kind = entry[0], d = entry[1];
    var total = d.exp + d.unexp;
    var y = PAD_T + i * rowH + Math.floor(rowGap / 2);
    var expW = Math.round((d.exp / total) * barMaxW);
    var color = KIND_COLORS[kind] || '#546e7a';

    if (expW > 0) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.roundRect(PAD_L, y, expW, barThick, [3, 0, 0, 3]); ctx.fill();
    }
    if (expW < barMaxW) {
      ctx.fillStyle = color + '44';
      ctx.beginPath(); ctx.roundRect(PAD_L + expW, y, barMaxW - expW, barThick, [0, 3, 3, 0]); ctx.fill();
    }

    ctx.fillStyle = '#b0c4d8'; ctx.font = '11px monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(kind, PAD_L - 8, y + barThick / 2);
    ctx.fillStyle = '#7a86aa'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
    ctx.fillText(d.exp + ' / ' + total, W - PAD_R + 8, y + barThick / 2);
  });
}

// ── 10. Directory coupling matrix ─────────────────────────────────────────────
function drawDirectoryCoupling() {
  var canvas = document.getElementById('chart-coupling');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  var dirCounts = {};
  NODES_DATA.forEach(function(n) { if (n.dir) dirCounts[n.dir] = (dirCounts[n.dir] || 0) + 1; });
  var dirs = Object.keys(dirCounts).sort(function(a, b) { return dirCounts[b] - dirCounts[a]; }).slice(0, 12);
  var N = dirs.length;
  if (N < 2) {
    ctx.fillStyle = '#5a6280'; ctx.font = '12px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Not enough directories', W / 2, H / 2); return;
  }

  var dirIdx = {};
  dirs.forEach(function(d, i) { dirIdx[d] = i; });
  var nodeDir = {};
  NODES_DATA.forEach(function(n) { if (n.dir) nodeDir[n.id] = n.dir; });

  var matrix = [];
  for (var i = 0; i < N; i++) { matrix.push([]); for (var j = 0; j < N; j++) matrix[i].push(0); }
  EDGES_DATA.forEach(function(e) {
    var fd = nodeDir[e.from], td = nodeDir[e.to];
    if (fd && td && fd !== td && dirIdx[fd] !== undefined && dirIdx[td] !== undefined)
      matrix[dirIdx[fd]][dirIdx[td]]++;
  });
  var maxVal = 0;
  for (var i = 0; i < N; i++) for (var j = 0; j < N; j++) if (matrix[i][j] > maxVal) maxVal = matrix[i][j];

  // Layout: row labels on the left, column labels at the bottom
  var PAD_TOP = 10, PAD_RIGHT = 14;
  var LABEL_W = 150;   // left margin for row labels
  var LABEL_BOT = 100; // bottom margin for column labels (rotated 45°)

  var matrixW = W - LABEL_W - PAD_RIGHT;
  var matrixH = H - PAD_TOP - LABEL_BOT;
  var cellW = Math.floor(matrixW / N);
  var cellH = Math.floor(matrixH / N);
  var matrixTop = PAD_TOP;
  var matrixLeft = LABEL_W;

  // ── Matrix cells ──────────────────────────────────────────────────────────────
  dirs.forEach(function(d, i) {
    var y = matrixTop + i * cellH;
    dirs.forEach(function(d2, j) {
      var x = matrixLeft + j * cellW;
      var val = matrix[i][j];
      var intensity = maxVal > 0 ? val / maxVal : 0;
      ctx.fillStyle = i === j
        ? 'rgba(20,20,48,0.8)'
        : 'rgba(121,134,203,' + (0.07 + intensity * 0.88).toFixed(2) + ')';
      ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
      if (val > 0 && i !== j) {
        ctx.fillStyle = intensity > 0.45 ? '#ffffff' : '#b0badd';
        ctx.font = 'bold ' + (cellW > 42 ? '11' : '9') + 'px monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(val), x + cellW / 2, y + cellH / 2);
      }
    });
  });

  // ── Row labels (left, right-aligned, white) ───────────────────────────────────
  dirs.forEach(function(d, i) {
    var y = matrixTop + i * cellH + cellH / 2;
    var short = d.length > 18 ? d.slice(0, 16) + '\u2026' : d;
    ctx.fillStyle = '#ffffff'; ctx.font = '11px monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(short, matrixLeft - 8, y);
  });

  // ── Column labels (bottom, rotated -45°, white) ───────────────────────────────
  dirs.forEach(function(d, j) {
    var x = matrixLeft + j * cellW + cellW / 2;
    var y = matrixTop + matrixH + 8;
    var short = d.length > 18 ? d.slice(0, 16) + '\u2026' : d;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4); // 45° downward-right → reads bottom-left to top-right
    ctx.fillStyle = '#ffffff'; ctx.font = '9px monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(short, 0, 0);
    ctx.restore();
  });
}

// ── 11. Symbol count per directory ────────────────────────────────────────────
function drawSymbolCountPerDir() {
  var counts = {};
  NODES_DATA.forEach(function(n) { if (n.dir) counts[n.dir] = (counts[n.dir] || 0) + 1; });
  var entries = Object.entries(counts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 15);
  drawVBar('chart-dirs', entries, function(lbl, i) {
    var hue = (i * 37) % 360;
    return 'hsl(' + hue + ',55%,45%)';
  });
}

// ── 12. In/out scatter ────────────────────────────────────────────────────────
function drawInOutScatter() {
  ensureInOutDeg();
  var canvas = document.getElementById('chart-scatter');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  var PAD_L = 46, PAD_R = 14, PAD_T = 14, PAD_B = 46;
  var plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  var maxOut = 1, maxIn = 1;
  NODES_DATA.forEach(function(n) {
    if ((_outDeg[n.id] || 0) > maxOut) maxOut = _outDeg[n.id];
    if ((_inDeg[n.id]  || 0) > maxIn)  maxIn  = _inDeg[n.id];
  });

  // Grid + axis labels
  ctx.strokeStyle = 'rgba(80,80,120,0.6)'; ctx.lineWidth = 1;
  for (var g = 0; g <= 4; g++) {
    var gx = PAD_L + Math.round((g / 4) * plotW);
    var gy = PAD_T + Math.round((g / 4) * plotH);
    ctx.beginPath(); ctx.moveTo(gx, PAD_T); ctx.lineTo(gx, PAD_T + plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(PAD_L + plotW, gy); ctx.stroke();
    if (g > 0) {
      ctx.fillStyle = '#7a86aa'; ctx.font = '9px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(Math.round(maxOut * g / 4), gx, PAD_T + plotH + 4);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(maxIn * (1 - g / 4)), PAD_L - 3, PAD_T + Math.round((g / 4) * plotH));
    }
  }

  // Quadrant labels
  ctx.fillStyle = 'rgba(121,134,203,0.35)'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Hubs',    PAD_L + plotW * 0.75, PAD_T + plotH * 0.12);
  ctx.fillText('Sources', PAD_L + plotW * 0.75, PAD_T + plotH * 0.88);
  ctx.fillText('Sinks',   PAD_L + plotW * 0.25, PAD_T + plotH * 0.12);
  ctx.fillText('Isolated',PAD_L + plotW * 0.25, PAD_T + plotH * 0.88);

  // Dots
  ctx.globalAlpha = 0.72;
  NODES_DATA.forEach(function(n) {
    var ox = _outDeg[n.id] || 0, iy = _inDeg[n.id] || 0;
    var x = PAD_L + Math.round((ox / maxOut) * plotW);
    var y = PAD_T + Math.round((1 - iy / maxIn) * plotH);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI);
    ctx.fillStyle = KIND_COLORS[n.kind] || '#546e7a'; ctx.fill();
  });
  ctx.globalAlpha = 1;

  // Axis labels
  ctx.fillStyle = '#7a86aa'; ctx.font = '10px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('out-degree (calls made)', PAD_L + plotW / 2, H);
  ctx.save(); ctx.translate(11, PAD_T + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('in-degree (times referenced)', 0, 0); ctx.restore();
}

// ── 13. Average degree per file ───────────────────────────────────────────────
function drawAvgDegreePerFile() {
  var fileDeg = {}, fileCount = {};
  NODES_DATA.forEach(function(n) {
    fileDeg[n.filePath]   = (fileDeg[n.filePath]   || 0) + n.degree;
    fileCount[n.filePath] = (fileCount[n.filePath] || 0) + 1;
  });
  var rows = Object.keys(fileDeg).map(function(fp) {
    var avg = fileDeg[fp] / fileCount[fp];
    var parts = fp.split('/');
    var short = parts.length > 2 ? '\u2026/' + parts.slice(-2).join('/') : fp;
    return { label: short, sublabel: fileCount[fp] + ' symbols', value: Math.round(avg * 10) / 10, color: '#00838f' };
  }).sort(function(a, b) { return b.value - a.value; }).slice(0, 15);
  drawHBar('chart-avgdeg', rows);
}

// ── Charts modal ─────────────────────────────────────────────────────────────
document.getElementById('btn-charts').addEventListener('click', function() {
  document.getElementById('charts-modal').style.display = 'flex';
  drawCharts();
});
document.getElementById('charts-close').addEventListener('click', function() {
  document.getElementById('charts-modal').style.display = 'none';
});
document.getElementById('charts-modal').addEventListener('click', function(e) {
  if (e.target === this) this.style.display = 'none';
});

function drawCharts() {
  [
    drawBarChart, drawPieChart, drawLineChart,
    drawTopCallers, drawTopCallees, drawFilesBySymbolCount,
    drawEdgeKindDistribution, drawDeadCodeByKind, drawExportedRatio,
    drawDirectoryCoupling, drawSymbolCountPerDir, drawInOutScatter,
    drawAvgDegreePerFile,
  ].forEach(function(fn) {
    try { fn(); } catch(e) { console.warn('[kirograph chart] ' + fn.name + ':', e); }
  });
}

// ── Bar chart: Top 15 most connected symbols ──────────────────────────────────
function drawBarChart() {
  var canvas = document.getElementById('chart-bar');
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  var top = NODES_DATA.slice().sort(function(a, b) { return b.degree - a.degree; }).slice(0, 15);
  if (top.length === 0) return;

  var maxDeg = top[0].degree || 1;
  var PAD_L = 170, PAD_R = 54, PAD_T = 14, PAD_B = 14;
  var barH = Math.floor((H - PAD_T - PAD_B) / top.length);
  var barGap = Math.max(2, Math.floor(barH * 0.22));
  var barThick = barH - barGap;
  var barMaxW = W - PAD_L - PAD_R;

  // Grid lines
  ctx.strokeStyle = 'rgba(80,80,120,0.6)';
  ctx.lineWidth = 1;
  for (var g = 0; g <= 4; g++) {
    var gx = PAD_L + Math.round((g / 4) * barMaxW);
    ctx.beginPath(); ctx.moveTo(gx, PAD_T); ctx.lineTo(gx, H - PAD_B); ctx.stroke();
  }

  top.forEach(function(n, i) {
    var y = PAD_T + i * barH + Math.floor(barGap / 2);
    var w = Math.max(4, Math.round((n.degree / maxDeg) * barMaxW));
    var color = KIND_COLORS[n.kind] || '#546e7a';

    // Gradient bar
    var grad = ctx.createLinearGradient(PAD_L, 0, PAD_L + w, 0);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color + '88');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(PAD_L, y, w, barThick, 3);
    ctx.fill();

    // Node label
    var label = n.label.length > 22 ? n.label.slice(0, 20) + '\\u2026' : n.label;
    ctx.fillStyle = '#c8d4f0';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, PAD_L - 8, y + barThick / 2);

    // Degree value
    ctx.fillStyle = '#c792ea';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n.degree), PAD_L + w + 6, y + barThick / 2);
  });
}

// ── Pie chart: Node count by kind ─────────────────────────────────────────────
function drawPieChart() {
  var canvas = document.getElementById('chart-pie');
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  var counts = {};
  NODES_DATA.forEach(function(n) { counts[n.kind] = (counts[n.kind] || 0) + 1; });
  var entries = Object.entries(counts).sort(function(a, b) { return b[1] - a[1]; });
  var total = NODES_DATA.length || 1;

  var cx = Math.round(W * 0.36), cy = H / 2;
  var outerR = Math.min(cx, cy) - 16;
  var innerR = outerR * 0.52;

  var startAngle = -Math.PI / 2;

  entries.forEach(function(entry) {
    var kind = entry[0], count = entry[1];
    var angle = (count / total) * 2 * Math.PI;
    var color = KIND_COLORS[kind] || '#546e7a';

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, startAngle + angle);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Gap stroke
    ctx.strokeStyle = '#0d0d1a';
    ctx.lineWidth = 2;
    ctx.stroke();

    startAngle += angle;
  });

  // Donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, 2 * Math.PI);
  ctx.fillStyle = '#0d0d1a';
  ctx.fill();

  // Center label
  ctx.fillStyle = '#c792ea';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(total), cx, cy - 7);
  ctx.fillStyle = '#7a86aa';
  ctx.font = '10px monospace';
  ctx.fillText('nodes', cx, cy + 10);

  // Legend
  var LEG_X = Math.round(W * 0.68);
  var LEG_Y_START = 16;
  var rowH = Math.floor((H - LEG_Y_START * 2) / Math.min(entries.length, 14));

  entries.slice(0, 14).forEach(function(entry, i) {
    var kind = entry[0], count = entry[1];
    var y = LEG_Y_START + i * rowH;
    var color = KIND_COLORS[kind] || '#546e7a';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(LEG_X, y + Math.floor(rowH / 2) - 5, 10, 10, 2);
    ctx.fill();
    ctx.fillStyle = '#c8d4f0';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(kind, LEG_X + 14, y + rowH / 2);
    var pct = ((count / total) * 100).toFixed(1);
    ctx.fillStyle = '#7a86aa';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(count + '  ' + pct + '%', W - 8, y + rowH / 2);
  });
}

// ── Line chart: Degree distribution ──────────────────────────────────────────
function drawLineChart() {
  var canvas = document.getElementById('chart-line');
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  var degMap = {};
  NODES_DATA.forEach(function(n) { degMap[n.degree] = (degMap[n.degree] || 0) + 1; });
  var maxDegVal = 0;
  Object.keys(degMap).forEach(function(k) { var v = Number(k); if (v > maxDegVal) maxDegVal = v; });
  if (maxDegVal === 0) return;

  var BINS = Math.min(40, maxDegVal + 1);
  var binSize = Math.ceil((maxDegVal + 1) / BINS);
  var bins = [];
  for (var b = 0; b < BINS; b++) {
    var cnt = 0;
    for (var d = b * binSize; d < (b + 1) * binSize; d++) cnt += degMap[d] || 0;
    bins.push({ deg: b * binSize, count: cnt });
  }
  var maxCount = 1;
  bins.forEach(function(b) { if (b.count > maxCount) maxCount = b.count; });

  var PAD_L = 44, PAD_R = 14, PAD_T = 14, PAD_B = 36;
  var plotW = W - PAD_L - PAD_R;
  var plotH = H - PAD_T - PAD_B;

  // Grid
  ctx.strokeStyle = 'rgba(80,80,120,0.6)';
  ctx.lineWidth = 1;
  for (var g = 0; g <= 4; g++) {
    var gy = PAD_T + Math.round((g / 4) * plotH);
    ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(W - PAD_R, gy); ctx.stroke();
    var gval = Math.round(maxCount * (1 - g / 4));
    ctx.fillStyle = '#7a86aa';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(gval), PAD_L - 5, gy);
  }

  var pts = bins.map(function(bin, i) {
    return {
      x: PAD_L + Math.round((i / (BINS - 1 || 1)) * plotW),
      y: PAD_T + Math.round((1 - bin.count / maxCount) * plotH),
    };
  });

  // Area fill
  var areaGrad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
  areaGrad.addColorStop(0, 'rgba(121,134,203,0.55)');
  areaGrad.addColorStop(1, 'rgba(121,134,203,0.04)');

  ctx.beginPath();
  ctx.moveTo(pts[0].x, PAD_T + plotH);
  pts.forEach(function(p) { ctx.lineTo(p.x, p.y); });
  ctx.lineTo(pts[pts.length - 1].x, PAD_T + plotH);
  ctx.closePath();
  ctx.fillStyle = areaGrad;
  ctx.fill();

  // Line
  ctx.beginPath();
  pts.forEach(function(p, i) { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
  ctx.strokeStyle = '#9fa8da';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Peak dot
  var peakIdx = 0;
  bins.forEach(function(bin, i) { if (bin.count > bins[peakIdx].count) peakIdx = i; });
  ctx.beginPath();
  ctx.arc(pts[peakIdx].x, pts[peakIdx].y, 4, 0, 2 * Math.PI);
  ctx.fillStyle = '#c792ea';
  ctx.fill();

  // X axis labels
  var labelStep = Math.ceil(BINS / 8);
  ctx.fillStyle = '#7a86aa';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  bins.forEach(function(bin, i) {
    if (i % labelStep !== 0 && i !== bins.length - 1) return;
    ctx.fillText(String(bin.deg), pts[i].x, PAD_T + plotH + 6);
  });

  // X axis label
  ctx.fillStyle = '#9ba3c8';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('connections', PAD_L + plotW / 2, H);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

`;
}

function printExportHelp(): void {
  const c = {
    reset:        '\x1b[0m',
    bold:         '\x1b[1m',
    dim:          '\x1b[2m',
    violet:       '\x1b[38;5;99m',
    lavender:     '\x1b[38;5;141m',
    paleLavender: '\x1b[38;5;183m',
    purple:       '\x1b[38;5;135m',
    gray:         '\x1b[90m',
  };

  console.log(`\n${c.bold}${c.paleLavender}USAGE${c.reset}`);
  console.log(`  ${c.lavender}kirograph export${c.reset} ${c.gray}<command>${c.reset} ${c.dim}[options] [path]${c.reset}\n`);

  console.log(`${c.bold}${c.paleLavender}COMMANDS${c.reset}\n`);

  const cmds = [
    { name: 'build', args: '[path]', desc: 'Generate the dashboard in .kirograph/export/' },
    { name: 'start', args: '[path]', desc: 'Generate the dashboard and open it in the browser' },
  ];
  const nameWidth = Math.max(...cmds.map(c => (c.name + ' ' + c.args).length)) + 2;
  for (const cmd of cmds) {
    const sig = cmd.name + ' ' + cmd.args;
    const pad = ' '.repeat(Math.max(0, nameWidth - sig.length));
    console.log(`  ${c.lavender}${cmd.name}${c.reset} ${c.dim}${cmd.args}${c.reset}${pad}${c.gray}${cmd.desc}${c.reset}`);
  }

  console.log(`\n${c.bold}${c.paleLavender}OPTIONS${c.reset}\n`);
  console.log(`  ${c.purple}-o, --output <dir>${c.reset}   ${c.gray}Custom output directory${c.reset}`);
  console.log(`  ${c.purple}--include-contains${c.reset}   ${c.gray}Include structural contains edges (adds noise, off by default)${c.reset}`);
  console.log(`  ${c.purple}-h, --help${c.reset}           ${c.gray}Show this help${c.reset}\n`);

  console.log(`${c.bold}${c.paleLavender}EXAMPLES${c.reset}\n`);
  const examples: [string, string][] = [
    ['kirograph export start',                  'Generate and open the dashboard in the browser'],
    ['kirograph export build',                  'Generate only (no browser)'],
    ['kirograph export build -o /tmp/graph',    'Write dashboard files to a custom directory'],
    ['kirograph export start --include-contains', 'Include structural contains edges'],
  ];
  for (const [ex, desc] of examples) {
    console.log(`  ${c.violet}$${c.reset} ${c.lavender}${ex}${c.reset}`);
    console.log(`    ${c.dim}${desc}${c.reset}`);
  }
  console.log();
}

export function register(program: Command): void {
  const exportCmd = program
    .command('export')
    .description('Export the graph as an interactive dashboard');

  exportCmd.configureHelp({ formatHelp: () => '' });
  exportCmd.helpInformation = () => { printExportHelp(); return ''; };

  exportCmd
    .command('build [projectPath]')
    .description('Generate the dashboard files in .kirograph/export/')
    .option('-o, --output <dir>', 'Output directory path')
    .option('--include-contains', 'Include structural contains edges (adds noise, off by default)', false)
    .action(async (projectPath, opts) => {
      await generateExport(projectPath, opts);
    });

  exportCmd
    .command('start [projectPath]')
    .description('Generate the dashboard files and open in the browser')
    .option('-o, --output <dir>', 'Output directory path')
    .option('--include-contains', 'Include structural contains edges (adds noise, off by default)', false)
    .action(async (projectPath, opts) => {
      const indexPath = await generateExport(projectPath, opts);
      console.log(`  ${dim}Opening in browser…${reset}\n`);
      openBrowser(indexPath);
    });

  exportCmd
    .command('graphml [projectPath]')
    .description('Export graph as GraphML (for Gephi, yEd)')
    .option('-o, --output <file>', 'Output file path')
    .action(async (projectPath, opts) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);
      const nodes = cg.getAllNodes();
      const edges = cg.getAllEdges();
      cg.close();

      const outPath = opts.output ?? path.join(target, '.kirograph', 'export', 'graph.graphml');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<graphml xmlns="http://graphml.graphstruct.org/graphml">',
        '  <key id="kind" for="node" attr.name="kind" attr.type="string"/>',
        '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
        '  <key id="file" for="node" attr.name="file" attr.type="string"/>',
        '  <key id="line" for="node" attr.name="line" attr.type="int"/>',
        '  <key id="edgeKind" for="edge" attr.name="kind" attr.type="string"/>',
        '  <graph id="G" edgedefault="directed">',
      ];

      for (const n of nodes) {
        lines.push(`    <node id="${escHtml(n.id)}">`);
        lines.push(`      <data key="kind">${escHtml(n.kind)}</data>`);
        lines.push(`      <data key="name">${escHtml(n.name)}</data>`);
        lines.push(`      <data key="file">${escHtml(n.filePath)}</data>`);
        lines.push(`      <data key="line">${n.startLine}</data>`);
        lines.push(`    </node>`);
      }

      for (const e of edges) {
        lines.push(`    <edge source="${escHtml(e.source)}" target="${escHtml(e.target)}">`);
        lines.push(`      <data key="edgeKind">${escHtml(e.kind)}</data>`);
        lines.push(`    </edge>`);
      }

      lines.push('  </graph>', '</graphml>');
      fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
      console.log(`\n  ${green}GraphML exported${reset}: ${outPath}`);
      console.log(`  ${dim}${nodes.length} nodes, ${edges.length} edges${reset}\n`);
    });

  exportCmd
    .command('cypher [projectPath]')
    .description('Export graph as Neo4j Cypher statements')
    .option('-o, --output <file>', 'Output file path')
    .action(async (projectPath, opts) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);
      const nodes = cg.getAllNodes();
      const edges = cg.getAllEdges();
      cg.close();

      const outPath = opts.output ?? path.join(target, '.kirograph', 'export', 'graph.cypher');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      const lines: string[] = ['// Generated by KiroGraph', '// Import with: cat graph.cypher | cypher-shell', ''];

      for (const n of nodes) {
        const label = n.kind.charAt(0).toUpperCase() + n.kind.slice(1);
        const props = `{id: "${n.id.replace(/"/g, '\\"')}", name: "${n.name.replace(/"/g, '\\"')}", file: "${n.filePath.replace(/"/g, '\\"')}", line: ${n.startLine}}`;
        lines.push(`CREATE (:${label} ${props});`);
      }

      lines.push('');

      for (const e of edges) {
        const relType = e.kind.toUpperCase();
        lines.push(`MATCH (a {id: "${e.source.replace(/"/g, '\\"')}"}), (b {id: "${e.target.replace(/"/g, '\\"')}"}) CREATE (a)-[:${relType}]->(b);`);
      }

      fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
      console.log(`\n  ${green}Neo4j Cypher exported${reset}: ${outPath}`);
      console.log(`  ${dim}${nodes.length} nodes, ${edges.length} edges${reset}\n`);
    });

  exportCmd
    .command('obsidian [projectPath]')
    .description('Export graph as an Obsidian vault with wikilinks')
    .option('-o, --output <dir>', 'Output directory path')
    .action(async (projectPath, opts) => {
      const KiroGraph = (await import('../../index')).default;
      const target = path.resolve(projectPath ?? process.cwd());
      const cg = await KiroGraph.open(target);
      const nodes = cg.getAllNodes();
      const edges = cg.getAllEdges();
      cg.close();

      const outDir = opts.output ?? path.join(target, '.kirograph', 'export', 'obsidian');
      fs.mkdirSync(outDir, { recursive: true });

      // Build edge maps for wikilinks
      const callersMap = new Map<string, string[]>();
      const calleesMap = new Map<string, string[]>();
      const nodeById = new Map(nodes.map(n => [n.id, n]));

      for (const e of edges) {
        if (e.kind === 'calls') {
          const targetNode = nodeById.get(e.target);
          const sourceNode = nodeById.get(e.source);
          if (targetNode) {
            if (!calleesMap.has(e.source)) calleesMap.set(e.source, []);
            calleesMap.get(e.source)!.push(targetNode.name);
          }
          if (sourceNode) {
            if (!callersMap.has(e.target)) callersMap.set(e.target, []);
            callersMap.get(e.target)!.push(sourceNode.name);
          }
        }
      }

      let fileCount = 0;
      for (const n of nodes) {
        if (n.kind === 'variable' || n.kind === 'parameter') continue; // Skip noise

        const callers = callersMap.get(n.id) ?? [];
        const callees = calleesMap.get(n.id) ?? [];

        const lines = [
          `# ${n.name}`,
          '',
          `- **Kind**: ${n.kind}`,
          `- **File**: \`${n.filePath}:${n.startLine}\``,
        ];

        if (n.signature) lines.push(`- **Signature**: \`${n.signature}\``);
        if (n.isExported) lines.push(`- **Exported**: yes`);

        if (callees.length > 0) {
          lines.push('', '## Calls', '');
          for (const c of [...new Set(callees)].slice(0, 20)) {
            lines.push(`- [[${c}]]`);
          }
        }

        if (callers.length > 0) {
          lines.push('', '## Called by', '');
          for (const c of [...new Set(callers)].slice(0, 20)) {
            lines.push(`- [[${c}]]`);
          }
        }

        // Sanitize filename
        const safeName = n.name.replace(/[<>:"/\\|?*]/g, '_');
        fs.writeFileSync(path.join(outDir, `${safeName}.md`), lines.join('\n'), 'utf8');
        fileCount++;
      }

      console.log(`\n  ${green}Obsidian vault exported${reset}: ${outDir}`);
      console.log(`  ${dim}${fileCount} markdown files with wikilinks${reset}\n`);
    });
}
