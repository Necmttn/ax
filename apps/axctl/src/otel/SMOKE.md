# OTLP receiver - manual smoke

The receiver is **spool-first**: a POST is appended to a spool file and a later
`ax ingest` drains it into the `otel_*` tables. So a payload that returns 200 has
NOT landed in the store yet, and checking for the row before you ingest will
correctly find nothing. Do the steps in order.

Two processes accept OTLP, and they append to the same spool:

- `ax otlpd` - the durable endpoint, and the only LaunchAgent ax installs. This
  is what `ax install` points the harnesses at, and what you should use here.
- `ax studio` - mounts the same three routes while a browser client is attached.
  On-demand, so never an exporter target.

## 1. Boot the receiver

    bun apps/axctl/bin/axctl otlpd

Default port 1738. Spool dir is `~/.ax/otlp/spool`, overridable with
`AX_OTLP_SPOOL_DIR` (deliberately its OWN knob, not `AX_DATA_DIR`).

If the port is busy, `ax studio` may already hold it:

    lsof -nP -iTCP:1738 -sTCP:LISTEN

## 2. POST a Claude-Code-shaped metrics payload

    curl -sS -X POST http://127.0.0.1:1738/v1/metrics \
      -H 'content-type: application/json' \
      -d '{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}]},"scopeMetrics":[{"metrics":[{"name":"claude_code.cost.usage","unit":"USD","sum":{"dataPoints":[{"asDouble":0.5,"timeUnixNano":"1718409600000000000","attributes":[{"key":"session.id","value":{"stringValue":"smoke1"}}]}]}}]}]}]}'
    # expect: {"partialSuccess":{}}

The receiver is **fail-open on purpose** - it answers 2xx even for a body it
could not use, so a misconfigured exporter never retry-storms. A 200 therefore
proves the endpoint is reachable, NOT that the payload was understood. Step 4 is
what proves that.

Confirm the spool grew:

    ls -la ~/.ax/otlp/spool

## 3. Drain the spool

    bun apps/axctl/bin/axctl ingest --since=1

## 4. Verify the row landed

There is no `axctl query` subcommand - use the read surface:

    bun apps/axctl/bin/axctl otel --json

Expect the `claude`/`metric` signal to show a non-zero count and fresh
`last_seen`. For the specific row, `ax otel` reports OTLP
`claude_code.cost.usage` against transcript cost over the window.

## 5. Repeat for a Codex-shaped trace

POST to `/v1/traces` and re-check `ax otel --json` for the `span` signal. Note
Codex itself emits OTLP **logs**, not spans, so its real config targets
`/v1/logs`.

## 6. Confirm the capability is advertised

Only `ax studio` serves the dashboard API:

    bun apps/axctl/bin/axctl studio --port=1738
    curl -sS http://127.0.0.1:1738/api/version | grep -E 'otlp'

`otlp_receiver` is DERIVED from the capability list. It was once hardcoded
`false` while `POST /v1/logs` on that same port returned 200 - if you ever see
those two disagree again, that is the bug, not a quirk.
