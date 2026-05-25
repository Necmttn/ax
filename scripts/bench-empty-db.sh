#!/usr/bin/env bash
# Benchmark a fresh SurrealDB database without touching axctl/main.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="bench_$(date +%Y%m%d_%H%M%S)"
SINCE=""
DASHBOARD_LIMIT="25"

for arg in "$@"; do
  case "$arg" in
    --db=*)
      DB="${arg#--db=}"
      ;;
    --since=*)
      SINCE="${arg#--since=}"
      ;;
    --dashboard-limit=*)
      DASHBOARD_LIMIT="${arg#--dashboard-limit=}"
      ;;
    *)
      echo "bench-empty-db.sh: unknown argument: $arg" >&2
      echo "usage: scripts/bench-empty-db.sh [--db=NAME] [--since=DAYS] [--dashboard-limit=N]" >&2
      exit 2
      ;;
  esac
done

OUT_DIR="${AX_BENCH_DIR:-$HOME/.local/share/ax/benchmarks/$DB}"
mkdir -p "$OUT_DIR"

run_step() {
  local name="$1"
  shift
  local start
  local end
  local seconds
  start="$(date +%s)"
  echo "[bench] START $name"
  "$@"
  end="$(date +%s)"
  seconds=$((end - start))
  echo "[bench] DONE  $name ${seconds}s" | tee -a "$OUT_DIR/timings.txt"
}

export AX_DB_DB="$DB"

echo "[bench] db=$AX_DB_DB"
echo "[bench] output=$OUT_DIR"
echo "[bench] axctl/main is not modified; this run uses AX_DB_DB=$AX_DB_DB"
: >"$OUT_DIR/timings.txt"

run_step "schema" bash "$ROOT/scripts/apply-schema.sh"

INGEST_ARGS=()
if [[ -n "$SINCE" ]]; then
  INGEST_ARGS+=("--since=$SINCE")
fi

run_step "ingest${SINCE:+ --since=$SINCE}" bun "$ROOT/src/cli/index.ts" ingest "${INGEST_ARGS[@]}"
run_step "ingest-insights" bun "$ROOT/src/cli/index.ts" ingest --insights-only
run_step "schema-counts" bash -lc "bun '$ROOT/src/cli/index.ts' insights schema > '$OUT_DIR/schema.json'"
run_step "checkout-activity" bash -lc "bun '$ROOT/src/cli/index.ts' insights checkouts --limit=100 > '$OUT_DIR/checkouts.json'"
run_step "git-correlation" bash -lc "bun '$ROOT/src/cli/index.ts' insights git --limit=100 > '$OUT_DIR/git.json'"
run_step "dashboard" bun "$ROOT/src/cli/index.ts" dashboard "--limit=$DASHBOARD_LIMIT" "--out=$OUT_DIR/dashboard.html"

echo "[bench] artifacts:"
echo "  timings:  $OUT_DIR/timings.txt"
echo "  schema:   $OUT_DIR/schema.json"
echo "  checkouts:$OUT_DIR/checkouts.json"
echo "  git:      $OUT_DIR/git.json"
echo "  dashboard:file://$OUT_DIR/dashboard.html"
