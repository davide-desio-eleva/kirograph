#!/usr/bin/env bash
# Builds kirograph-rust for every platform on this machine, checks the binaries, and lays out
# the npm packages to publish in npm/ (generated, not committed).
#
#   native/kirograph-rust/scripts/build-release.sh <version>
#
# macOS (arm64, x64) is built here with the Rust toolchain; Linux (x64, arm64) and Windows (x64)
# in a Docker container (release/Dockerfile), so nothing but Docker and rustup is needed.
# Run on a Mac. Called by scripts/release.sh.
set -euo pipefail

VERSION="${1:?usage: build-release.sh <version>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
OUT="$DIR/npm"
BIN="$DIR/target/release-bin"
IMAGE=kirograph-rust-builder

GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; RESET='\033[0m'
info()  { echo -e "  ${GREEN}✓${RESET} $1"; }
fail()  { echo -e "  ${RED}✗${RESET} $1" >&2; exit 1; }

# platform suffix | rust target | npm os | npm cpu | libc
PLATFORMS=(
  "darwin-arm64|aarch64-apple-darwin|darwin|arm64|"
  "darwin-x64|x86_64-apple-darwin|darwin|x64|"
  "linux-x64-gnu|x86_64-unknown-linux-gnu|linux|x64|glibc"
  "linux-arm64-gnu|aarch64-unknown-linux-gnu|linux|arm64|glibc"
  "win32-x64-msvc|x86_64-pc-windows-msvc|win32|x64|"
)

[ "$(uname -s)" = "Darwin" ] || fail "run on macOS (the macOS binaries are built natively)"
command -v cargo >/dev/null || export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || fail "Rust toolchain not found (https://rustup.rs)"
docker info >/dev/null 2>&1 || fail "Docker is not running (needed for the Linux and Windows builds)"

rm -rf "$BIN" "$OUT"
mkdir -p "$BIN" "$OUT"

node scripts/fetch-grammars.mjs
[ -x node_modules/.bin/napi ] || npm install --silent

# ── macOS ─────────────────────────────────────────────────────────────────────
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target add "$target" >/dev/null 2>&1 || true
  npx napi build --platform --release --target "$target" --no-js --dts target/napi.d.ts --output-dir "$BIN" >/dev/null
  info "built $target"
done

# ── Linux and Windows, in Docker ──────────────────────────────────────────────
docker build -q -t "$IMAGE" release >/dev/null
docker run --rm \
  -v "$DIR":/src -w /src \
  -v kirograph-rust-cargo:/usr/local/cargo/registry \
  -v kirograph-rust-xwin:/root/.cache/cargo-xwin \
  "$IMAGE" bash -c '
    set -e
    cargo build --quiet --release --target x86_64-unknown-linux-gnu --target-dir target/docker
    cargo build --quiet --release --target aarch64-unknown-linux-gnu --target-dir target/docker
    cargo xwin build --quiet --release --target x86_64-pc-windows-msvc --target-dir target/docker
  '
cp target/docker/x86_64-unknown-linux-gnu/release/libkirograph_rust.so "$BIN/kirograph_rust.linux-x64-gnu.node"
cp target/docker/aarch64-unknown-linux-gnu/release/libkirograph_rust.so "$BIN/kirograph_rust.linux-arm64-gnu.node"
cp target/docker/x86_64-pc-windows-msvc/release/kirograph_rust.dll "$BIN/kirograph_rust.win32-x64-msvc.node"
info "built x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, x86_64-pc-windows-msvc"

# ── Checks ────────────────────────────────────────────────────────────────────
# Each binary that can run here loads and extracts a file; the others are checked by format.
SMOKE='
const m = require(process.argv[1]);
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-"));
fs.writeFileSync(path.join(dir, "a.ts"), "export function f() { return g(); }\n");
const r = JSON.parse(m.extractFileJson(path.join(dir, "a.ts"), dir, "typescript", false));
if (r.nodes[0]?.name !== "f" || m.nativeLanguages().length < 20) { console.error("unexpected output"); process.exit(1); }
'
node -e "$SMOKE" "$BIN/kirograph_rust.darwin-arm64.node" || fail "darwin-arm64 does not load"
info "darwin-arm64 loads and extracts"
for p in "linux/amd64|linux-x64-gnu" "linux/arm64|linux-arm64-gnu"; do
  docker_platform="${p%%|*}"; suffix="${p##*|}"
  docker run --rm --platform "$docker_platform" -v "$BIN":/bin-kg:ro node:22-bullseye-slim \
    node -e "$SMOKE" "/bin-kg/kirograph_rust.$suffix.node" || fail "$suffix does not load"
  info "$suffix loads and extracts (Debian bullseye, glibc 2.31)"
done
file "$BIN/kirograph_rust.darwin-x64.node" | grep -q "x86_64" || fail "darwin-x64 is not an x86_64 binary"
info "darwin-x64 is an x86_64 Mach-O binary"
file "$BIN/kirograph_rust.win32-x64-msvc.node" | grep -q "PE32+.*DLL.*x86-64" || fail "win32-x64-msvc is not an x86-64 DLL"
info "win32-x64-msvc is an x86-64 DLL"

# ── npm packages ──────────────────────────────────────────────────────────────
OPTIONAL="{}"
for entry in "${PLATFORMS[@]}"; do
  IFS='|' read -r suffix target os cpu libc <<< "$entry"
  pkg="$OUT/kirograph-rust-$suffix"
  mkdir -p "$pkg"
  cp "$BIN/kirograph_rust.$suffix.node" "$pkg/"
  node -e '
    const [dir, suffix, version, os, cpu, libc] = process.argv.slice(1);
    const pkg = {
      name: `kirograph-rust-${suffix}`, version,
      description: `kirograph-rust native binary for ${suffix}`,
      main: `kirograph_rust.${suffix}.node`, files: [`kirograph_rust.${suffix}.node`],
      os: [os], cpu: [cpu], ...(libc ? { libc: [libc] } : {}),
      license: "MIT", repository: { type: "git", url: "https://github.com/davide-desio-eleva/kirograph" },
    };
    require("fs").writeFileSync(`${dir}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
  ' "$pkg" "$suffix" "$VERSION" "$os" "$cpu" "$libc"
  OPTIONAL=$(node -e 'const o = JSON.parse(process.argv[1]); o[process.argv[2]] = process.argv[3]; console.log(JSON.stringify(o))' "$OPTIONAL" "kirograph-rust-$suffix" "$VERSION")
done

main="$OUT/kirograph-rust"
mkdir -p "$main"
cp index.js index.d.ts README.md "$main/"
node -e '
  const [dir, version, optional] = process.argv.slice(1);
  const src = require("./package.json");
  const pkg = {
    name: "kirograph-rust", version, description: src.description,
    main: "index.js", types: "index.d.ts", files: ["index.js", "index.d.ts", "README.md"],
    optionalDependencies: JSON.parse(optional),
    license: "MIT", repository: { type: "git", url: "https://github.com/davide-desio-eleva/kirograph" },
  };
  require("fs").writeFileSync(`${dir}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
' "$main" "$VERSION" "$OPTIONAL"
info "npm packages ready in ${DIM}native/kirograph-rust/npm/${RESET}"
