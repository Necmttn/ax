# Dogfood: live ingest over Durable Streams (2026-06-02)

End-to-end verification of the live-ingest-over-Durable-Streams feature
(`POST /api/ingest` on `ax serve` -> per-run Durable Stream -> dashboard Live
view with replay-from-start rehydration on refresh).

## Setup

- Built `dist/axctl` (`bun run build`) and the dashboard SPA
  (`bun run dashboard:build`) - both succeeded.
- `ax serve` ran from source on **port 1738** (API-only daemon; the dashboard
  SPA lives at the hosted studio / a local `vite dev` and CORS-fetches the
  daemon). SurrealDB on `127.0.0.1:8521`.
- Browser dogfood used `vite dev` (port **1739**) which proxies `/api/*` to the
  daemon on 1738, serving the freshly-built SPA with the new `/ingest-live`
  route against the running local daemon.

> Note on the compiled binary: `bun build --compile` produces `dist/axctl`, but
> running the compiled binary fails at startup with
> `No native build was found for platform=darwin arch=arm64` - a native module
> cannot be bundled into a single-file `--compile` binary. This is a packaging
> limitation unrelated to this feature; `ax serve` runs cleanly from source.

## What was verified

### 1. `POST /api/ingest` returns a runId + stream descriptor

See [`post-api-ingest-response.json`](./post-api-ingest-response.json):

```json
{"runId":"...","stream":"http://127.0.0.1:<sidecarPort>/ingest:<runId>","streamName":"ingest:<runId>","streamBaseUrl":"http://127.0.0.1:<sidecarPort>"}
```

### 2. The per-run Durable Stream serves the full lifecycle + survives reconnect

[`stream-events.txt`](./stream-events.txt) is the durable proof. It POSTs a
run, then subscribes with the **same `@durable-streams/client` the dashboard
uses** (offset `-1` = replay-from-start, then live). A **second subscriber
attaches mid-run** - exactly what a browser page refresh does - and **replays
every prior event from offset 0** before continuing live:

```
A         run_started
A         stage_started
# --- subscriber B attaches mid-run (== a browser page REFRESH) ---
B(replay) run_started        <- B replays history from offset 0
B(replay) stage_started
A         stage_finished {status:ok, durationMs:206854}
B(replay) stage_finished
A         run_finished {status:completed}
# run_finished seen (count=1) -> stream terminates
B(replay) run_finished
# terminal run_finished count = 1 (expect exactly 1)
```

Key results:
- Full ordered lifecycle: `run_started -> stage_started -> stage_finished ->
  run_finished`.
- **Exactly one** terminal `run_finished` event (the backend guarantee).
- Subscriber B (the refresh/reconnect case) rehydrated the entire history from
  offset 0, then received the live tail - the Durable Streams offset-resume
  payoff vs raw SSE.
- A full corpus re-ingest takes ~207s (`durationMs:206854`), which is why the
  dashboard sits on `RUNNING…` for a few minutes per run.
- Race note: subscribing the instant after `POST` can briefly 404
  ("Stream not found") because the per-run stream is materialized lazily by the
  forked producer; the capture (and a robust client) retry until it exists.

### 3. Browser dashboard Live view (observed states)

Captured live in Chrome at `http://localhost:1739/ingest-live` (proxying to the
daemon). The browser tool in this environment could not persist screenshots to
disk (`save_to_disk` returned no path), so the observed states are recorded
here; the `stream-events.txt` above is the byte-exact backing evidence for the
same behavior.

- **Loaded** - "LIVE INGEST" header, green **LIVE** badge, **Live** nav tab
  active, **Run ingest** button, count tiles (Skills, Sessions=3156, Tool
  failures=200), and "No active run. Hit **Run ingest** to stream a live ingest
  pass…".
- **Mid-run** - button flips to **RUNNING…**, the run header shows the stage
  label with a `· running…` suffix, the stage row renders.
- **After a full page refresh, mid-run** - the SPA reloads from scratch and the
  view **immediately rehydrates** to the **RUNNING…** state (run header + stage
  restored from the Durable Stream replay), then continues live: the count
  tiles re-populate (e.g. Skills `-` -> `185`, Tool failures back to `200`) as
  fresh deltas arrive. This is the refresh-mid-run rehydration payoff.

## CLI regression

`axctl ingest --since 1` was run repeatedly against the healthy DB and exited
**0** every time (~203–240s for a full corpus pass). The feature does **not**
touch `apps/axctl/src/cli/ingest-trace-progress.ts` or
`apps/axctl/src/cli/progress.ts` - confirmed via `git diff cde4331..HEAD` - so
the terminal step animation and `AX_PROGRESS=off` silencing are unchanged. (The
animation renders only to an interactive TTY's stderr; it could not be captured
to a file in this non-interactive sandbox, but the clean exit-0 confirms the
path runs.)

See [the research doc](../../superpowers/research/durable-streams-api.md) for
the embed-vs-sidecar decision behind running the Durable Streams backing as a
sidecar inside the serve process.
