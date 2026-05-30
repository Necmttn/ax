# Effect JSON Boundaries

JSON that crosses an IO boundary should decode through Effect Schema before the
rest of the code reads it. Use the helpers in `src/lib/decode.ts`:

- `decodeJsonOrNull` for best-effort unknown JSON from JSONL/file payloads.
- `decodeJsonOrNullAs(schema, text)` when the caller knows the payload shape.
- `decodeJsonRecordOrNull` for JSON object maps such as DB `labels`.
- `encodeJsonOrNull` for machine-boundary JSON strings.

Direct `JSON.parse` remains acceptable only inside a central boundary helper or
legacy adapter that immediately normalizes and validates the value. Direct
`JSON.stringify` remains acceptable for human pretty printing, test fixtures,
and SurrealQL string-literal helpers where the value is already in-process and
not an external payload.

The remaining Effect language-service advisories are intentionally split this
way:

- `Effect.void` in fake `SurrealClient` test doubles: concise no-op service
  methods, not production control flow.
- `JSON.stringify` in `src/lib/json.ts` pretty printing: human CLI output.
- `JSON.stringify` in `src/lib/shared/surql.ts`: SurrealQL literal escaping.
- JSON fixture construction in tests: test data, not runtime IO.

New runtime JSON readers should not add raw `JSON.parse` call sites. Add a
schema and route through `src/lib/decode.ts` instead.
