#!/usr/bin/env bash
# test/benchmark-jev-strands/run.sh
#
# Convenience wrapper around benchmark.mjs. Starts whatever mock servers are
# needed (so the zero-setup path works out of the box), runs the benchmark,
# and tears the mocks down.
#
# Configuration — reads a .env file in THIS directory (if present), then the
# environment (a var already set in the shell wins over the .env file). All
# keys are optional:
#   JEV_API_KEY=sk-...        → real jev cloud API (no jev mock started)
#   JEV_BASE_URL=...          → override jev URL (default: real API when key set, else mock)
#   STRANDS_BASE_URL=http://127.0.0.1:8000  → the strands server to benchmark
#   STRANDS_MODEL=...         → checkpoint/model id for auto-start
#                               (default: StrandsAgents/strands-decider-2B-hobson-v19)
#   STRANDS_AUTOSTART=1       → if STRANDS_BASE_URL is local and nothing is
#                               listening, start `strands-decider serve` here
#                               and stop it on exit (default: 1)
#
# With nothing set: mock jev (:8842) + mock strands (:8843), both started here.
#
# Any extra args are forwarded to benchmark.mjs, e.g.:
#   ./run.sh --iterations 100
#   ./run.sh --only strands --json
#   ./run.sh --no-build
#
# NOTE: the bundled mocks return instantly, so mock-vs-mock numbers measure
# client + HTTP + event-loop overhead, NOT model inference. For a real
# latency comparison, point STRANDS_BASE_URL at a real server (or let this
# script auto-start one) and set JEV_API_KEY for the cloud side.

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

# ── Load .env from this directory ───────────────────────────────────────────────
# Simple KEY=VALUE parser (no shell execution). A variable already set in the
# real environment is NEVER overridden — the shell wins over the file, matching
# how KiroGraph's own loadConfig() treats .kirograph/.env.
ENV_FILE="$SCRIPT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  info_pre() { echo -e "  \033[0;36m›\033[0m  $1"; }
  info_pre "Loading $ENV_FILE"
  while IFS= read -r line || [ -n "$line" ]; do
    # strip comments and surrounding whitespace; skip blanks
    line="${line%%#*}"
    line="$(echo "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [ -z "$line" ] && continue
    case "$line" in
      *=*)
        key="${line%%=*}"
        val="${line#*=}"
        key="$(echo "$key" | sed -E 's/[[:space:]]+$//')"
        # strip optional surrounding quotes from the value
        val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
        # only set if not already present in the environment
        if [ -z "${!key:-}" ]; then export "$key=$val"; fi
        ;;
    esac
  done < "$ENV_FILE"
fi

# strands auto-start settings (overridable via .env / environment)
STRANDS_MODEL="${STRANDS_MODEL:-StrandsAgents/strands-decider-2B-hobson-v19}"
STRANDS_AUTOSTART="${STRANDS_AUTOSTART:-1}"
# Seconds to wait for an auto-started server to answer /health. The first run
# downloads ~4.5GB of model weights, which on a normal connection takes several
# minutes — hence the generous default. Raise it on a slow link.
STRANDS_READY_TIMEOUT="${STRANDS_READY_TIMEOUT:-900}"

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

wait_up() { # <url> [max_seconds]  — poll a mock/quick server (fast, sub-second)
  local tries=$(( ${2:-5} * 5 ))
  for _ in $(seq 1 "$tries"); do curl -s -o /dev/null -m 2 "$1" && return 0; sleep 0.2; done
  return 1
}

# Wait for a server that may take minutes (model download + load). Polls once a
# second up to <max_seconds>, prints a heartbeat, and bails out early if the
# watched process <pid> dies. Returns 0 when /health answers, 1 otherwise.
wait_up_server() { # <url> <pid> <max_seconds>
  local url="$1" pid="$2" max="$3" i=0
  while [ "$i" -lt "$max" ]; do
    if curl -s -o /dev/null -m 2 "$url"; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then return 2; fi  # process died
    i=$((i + 1))
    if [ $((i % 15)) -eq 0 ]; then info "  … still waiting for the server (${i}s elapsed, first-run weight download can take minutes)"; fi
    sleep 1
  done
  return 1
}

# Extract host and port from a URL like http://127.0.0.1:8000 (sets $URL_HOST/$URL_PORT).
parse_url() { # <url>
  local u="${1#*://}"; u="${u%%/*}"
  URL_HOST="${u%%:*}"
  URL_PORT="${u##*:}"
  if [ "$URL_PORT" = "$URL_HOST" ]; then URL_PORT=80; fi  # no explicit port
  return 0
}

is_local_host() { # <host>
  case "$1" in 127.0.0.1|localhost|0.0.0.0|::1) return 0 ;; *) return 1 ;; esac
}

# ── Start jev mock unless a real key is set ─────────────────────────────────────
if [ -z "${JEV_API_KEY:-}" ]; then
  info "Starting jev mock on :$JEV_PORT..."
  node "$JEV_MOCK" "$JEV_PORT" "mock-jev-key" > /tmp/bench-jev-mock.log 2>&1 &
  PIDS+=($!)
  # jev mock has no /health; a POST with a bad body still returns a response.
  wait_up "http://127.0.0.1:$JEV_PORT/v1/systemone" || warn "jev mock did not respond on :$JEV_PORT"
else
  info "JEV_API_KEY set — using the real jev API at ${JEV_BASE_URL:-https://api.typesafe.ai} (no mock)."
fi

# ── strands: mock, auto-started real server, or an already-running one ──────────
if [ -z "${STRANDS_BASE_URL:-}" ]; then
  # No URL → bundled mock.
  info "Starting strands-decider mock on :$STRANDS_PORT..."
  node "$STRANDS_MOCK" "$STRANDS_PORT" > /tmp/bench-strands-mock.log 2>&1 &
  PIDS+=($!)
  wait_up "http://127.0.0.1:$STRANDS_PORT/health" || warn "strands mock did not respond on :$STRANDS_PORT"
else
  parse_url "$STRANDS_BASE_URL"
  if curl -s -o /dev/null "$STRANDS_BASE_URL/health"; then
    # Something is already answering there — use it as-is.
    info "STRANDS_BASE_URL set ($STRANDS_BASE_URL) — server already running, using it."
  elif is_local_host "$URL_HOST" && [ "$STRANDS_AUTOSTART" != "0" ]; then
    # Local URL, nothing listening → start a real strands-decider server here.
    if ! command -v strands-decider > /dev/null 2>&1; then
      warn "strands-decider not found on PATH. Install it with: pip install strands-decider"
      warn "(or set STRANDS_AUTOSTART=0 to skip auto-start, or point STRANDS_BASE_URL at a running server)"
    else
      info "No server on $STRANDS_BASE_URL — starting 'strands-decider serve $STRANDS_MODEL --port $URL_PORT'..."
      info "First run downloads ~4.5GB of model weights, then loads the model — this can take several minutes."
      info "Progress is logged to /tmp/bench-strands-serve.log (waiting up to ${STRANDS_READY_TIMEOUT}s)."
      strands-decider serve "$STRANDS_MODEL" --port "$URL_PORT" > /tmp/bench-strands-serve.log 2>&1 &
      STRANDS_SERVE_PID=$!
      PIDS+=("$STRANDS_SERVE_PID")
      wait_up_server "$STRANDS_BASE_URL/health" "$STRANDS_SERVE_PID" "$STRANDS_READY_TIMEOUT"
      case $? in
        0) info "strands-decider server is up on $STRANDS_BASE_URL." ;;
        2) warn "strands-decider server exited before becoming ready — see /tmp/bench-strands-serve.log" ;;
        *) warn "strands-decider server not ready after ${STRANDS_READY_TIMEOUT}s. It may still be downloading — raise STRANDS_READY_TIMEOUT, or start it yourself and re-run. See /tmp/bench-strands-serve.log" ;;
      esac
    fi
  else
    warn "STRANDS_BASE_URL set ($STRANDS_BASE_URL) but nothing is listening and it is not auto-startable (remote host, or STRANDS_AUTOSTART=0)."
  fi
fi

echo ""
node "$SCRIPT_DIR/benchmark.mjs" "${PASS_ARGS[@]:-}"
