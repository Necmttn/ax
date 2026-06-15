# OTLP receiver - manual smoke

Boot daemon (needs SurrealDB on 127.0.0.1:8521 + ax from source):

    bun apps/axctl/bin/axctl serve --port=1738

POST a Claude-Code-shaped metrics payload:

    curl -sS -X POST http://127.0.0.1:1738/v1/metrics \
      -H 'content-type: application/json' \
      -d '{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}]},"scopeMetrics":[{"metrics":[{"name":"claude_code.cost.usage","unit":"USD","sum":{"dataPoints":[{"asDouble":0.5,"timeUnixNano":"1718409600000000000","attributes":[{"key":"session.id","value":{"stringValue":"smoke1"}}]}]}}]}]}]}'
    # expect: {"partialSuccess":{}}

Verify the row landed:

    bun apps/axctl/bin/axctl query "SELECT * FROM otel_metric_point WHERE session_id = 'smoke1'"
    # expect one row: value 0.5, harness 'claude', metric 'claude_code.cost.usage'

POST a Codex-shaped trace, verify otel_span similarly. Confirm /api/version shows otlp_receiver:true:

    curl -sS http://127.0.0.1:1738/api/version | grep otlp_receiver
