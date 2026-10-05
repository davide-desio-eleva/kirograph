#!/usr/bin/env bash
# test/benchmark-jev-strands/run.sh
#
# Convenience wrapper around benchmark.mjs. Starts whatever mock servers are
# needed (so the zero-setup path works out of the box), runs the benchmark,
# and tears the mocks down.
#
# Endpoint selection — same env vars benchmark.mjs reads:
#   (unset)                  → mock jev (:8842) + mock strands (:8843), both started here
#   JEV_API_KEY=sk-...       → real jev cloud API (no jev mock started)
#   STRANDS_BASE_URL=http://127.0.0.1:8000  → real strands server (no strands mock started)
#
# Any extra args are forwarded to benchmark.mjs, e.g.:
#   ./run.sh --iterations 100
#   ./run.sh --only strands --json
#   ./run.sh --no-build
#
# NOTE: the bundled mocks return instantly, so mock-vs-mock numbers measure
# client + HTTP + event-loop overhead, NOT model inference. For a real
# latency comparison, run a `strands-decider serve` locally and set
# STRANDS_BASE_URL (and JEV_API_KEY for the cloud side).

set -euo pipefail

NO_BUILD=false
PASS_ARGS=()
for arg in "$@"; do
  case $arg in
    --no-build) NO_BUILD=true ;;
    *) PASS_ARGS+=("$arg") ;;
  esac
done

DIM='\033[2m'; RESET='\033[0m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
info() { echo -e "  ${CYAN}›${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JEV_MOCK="$ROOT/test/jev/mock-server.js"
STRANDS_MOCK="$ROOT/test/strands/mock-server.js"
JEV_PORT=8842
STRANDS_PORT=8843

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# ── Build ──────────────────────────────────────────────────────────────────────
if [ "$NO_BUILD" = false ]; then
  info "Building..."
  (cd "$ROOT" && npm run build > /dev/null 2>&1)
else
  warn "--no-build: using existing dist/"
fi

wait_up() { # <url>
  for _ in $(seq 1 25); do curl -s -o /dev/null "$1" && return 0; sleep 0.2; done
  return 1
}

# ── Start jev mock unless a real key is set ─────────────────────────────────────
if [ -z "${JEV_API_KEY:-}" ]; then
  info "Starting jev mock on :$JEV_PORT..."
  node "$JEV_MOCK" "$JEV_PORT" "mock-jev-key" > /tmp/bench-jev-mock.log 2>&1 &
  PIDS+=($!)
  # jev mock has no /health; a POST with a bad body still returns a response.
  wait_up "http://127.0.0.1:$JEV_PORT/v1/systemone" || warn "jev mock did not respond on :$JEV_PORT"
else
  info "JEV_API_KEY set — using the real jev API (no mock)."
fi

# ── Start strands mock unless a real server URL is set ──────────────────────────
if [ -z "${STRANDS_BASE_URL:-}" ]; then
  info "Starting strands-decider mock on :$STRANDS_PORT..."
  node "$STRANDS_MOCK" "$STRANDS_PORT" > /tmp/bench-strands-mock.log 2>&1 &
  PIDS+=($!)
  wait_up "http://127.0.0.1:$STRANDS_PORT/health" || warn "strands mock did not respond on :$STRANDS_PORT"
else
  info "STRANDS_BASE_URL set ($STRANDS_BASE_URL) — using that server (no mock)."
fi

echo ""
node "$SCRIPT_DIR/benchmark.mjs" "${PASS_ARGS[@]:-}"
