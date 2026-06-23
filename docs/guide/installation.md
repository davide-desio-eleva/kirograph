# Installation

## From npm (not yet available on npm registry)

```bash
npm install -g kirograph
```

## From source

```bash
git clone https://github.com/davide-desio-eleva/kirograph.git
cd kirograph
npm install
npm run build
sudo npm install -g .
```

After building, the `kirograph` and `kg` commands are available globally.

## Verify

```bash
kirograph --version
```

## Uninstallation

### Remove from a project

```bash
kirograph uninit [path]                  # Prompts to remove Kiro integration files and .kirograph/ data separately
kirograph uninit --force                 # Remove Kiro integration files + .kirograph/ data without confirmation
kirograph uninit --target all --force    # Remove all integration files (Kiro + Claude + Codex) + .kirograph/ data
```

`kirograph uninstall` is an alias for `kirograph uninit`.

Without `--force`, KiroGraph asks separately whether to remove the selected tool integration files and whether to remove the shared `.kirograph/` data. With `--force`, both are removed unconditionally.

This can remove:
- `.kirograph/`: index database, snapshots, and export directory
- Kiro target: `.kiro/hooks/kirograph-*.json`, `.kiro/steering/kirograph.md`, `.kiro/agents/kirograph.json`
- Claude target (experimental): `kirograph` from `.mcp.json`, plus the KiroGraph import from `CLAUDE.md`
- Codex target (experimental): the generated KiroGraph block from `AGENTS.md`

### Remove the CLI globally

If installed from npm:

```bash
npm uninstall -g kirograph
```

If installed from source:

```bash
cd kirograph
npm uninstall -g .
```

---

## Visual PDF Search — Hardware Requirements {#visual-pdf-search-hardware-requirements}

> **⚠ Experimental.** This feature may change or be removed in future releases.

Visual PDF search (`enableVisualPDF: true`) runs a local PixelRAG server that loads **Qwen3-VL-Embedding-2B** into memory. Requirements are significantly higher than the rest of KiroGraph.

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 8 GB | 16 GB |
| Free disk | 6 GB | 10 GB+ |
| CPU | any x64 / ARM64 | — |
| GPU / NPU | not required | Apple Silicon MPS, CUDA ≥ 8 GB VRAM |
| Python | 3.10+ | 3.11+ |
| OS | macOS 12, Linux (glibc 2.31+) | — |

**Windows native is not supported.** PixelRAG uses Unix-style paths and subprocess forking. Use WSL2 for Windows.

**WSL2 notes:**
- The project must live on the Linux filesystem (`/home/...`), not on a Windows mount (`/mnt/c/...`) — I/O over the mount degrades PDF rendering significantly.
- Allocate at least 8 GB to WSL2 in `%USERPROFILE%\.wslconfig` (`[wsl2]\nmemory=8GB`).
- CUDA in WSL2 requires an updated NVIDIA driver with WSL2 support (`CUDA on WSL`).

**What gets downloaded at `kirograph install` time:**
- PixelRAG Python package (`pip install pixelrag[index,serve]`) — fast
- Qwen3-VL-Embedding-2B model via PixelRAG — **~4 GB**, one-time download

