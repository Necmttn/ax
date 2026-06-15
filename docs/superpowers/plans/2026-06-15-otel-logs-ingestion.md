# OTLP Logs Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the no-op `POST /v1/logs` to ingest OTLP log events (Codex events; CC events) into a new `otel_log_event` table with typed token columns, curated by an allowlist, correlated to sessions.

**Architecture:** Extends the existing `apps/axctl/src/otel/` pipeline (built in PR #423) - add a logs decoder + normalizer (allowlist + per-harness attr lifting) + writer method, implement the logs branch in the contract handler, register a new table, and extend the correlation pass. Mirrors the metrics/spans path exactly.

**Tech Stack:** Bun ≥1.3, TypeScript strict, `effect@beta` (Schema/Layer), SurrealDB 3.x via `@ax/lib/db`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-15-otel-logs-ingestion-design.md`
**Fixture:** `apps/axctl/src/otel/__fixtures__/codex-logs.json` (already committed).

**effect@beta facts (from PR #423, reuse):** `Schema.Date` (not DateFromSelf), `Schema.decodeUnknownEffect` (not decodeUnknown), `Schema.TaggedErrorClass`, `Effect.orElseSucceed`/`Effect.ignore` (no Effect.catchAll). surql helpers `surrealString`/`surrealDate`/`surrealOptionString`/`recordRef`/`executeStatements` in `@ax/lib/shared/surreal.ts`. Numeric option helper: check `@ax/lib/shared/surreal.ts` for `surrealOptionInt`/`surrealOptionNumber` (use the real name; for a nullable number render the number or `NONE`).

---

## Task 1: `otel_log_event` table + registration

**Files:**
- Modify: `packages/schema/src/schema.surql` (near the other `otel_*` tables)
- Modify: `apps/axctl/src/queries/insights.ts` (`SCHEMA_TABLES`)
- Test: `apps/axctl/src/queries/insights.test.ts` (existing mirror guard)

- [ ] **Step 1: Add DDL** to `schema.surql` (place beside `otel_span`):

```surql
DEFINE TABLE otel_log_event SCHEMAFULL;
DEFINE FIELD harness          ON otel_log_event TYPE string;
DEFINE FIELD event_name       ON otel_log_event TYPE string;
DEFINE FIELD session_id       ON otel_log_event TYPE option<string>;
DEFINE FIELD model            ON otel_log_event TYPE option<string>;
DEFINE FIELD input_tokens     ON otel_log_event TYPE option<number>;
DEFINE FIELD output_tokens    ON otel_log_event TYPE option<number>;
DEFINE FIELD reasoning_tokens ON otel_log_event TYPE option<number>;
DEFINE FIELD cached_tokens    ON otel_log_event TYPE option<number>;
DEFINE FIELD tool_tokens      ON otel_log_event TYPE option<number>;
DEFINE FIELD duration_ms      ON otel_log_event TYPE option<number>;
DEFINE FIELD status_code      ON otel_log_event TYPE option<number>;
DEFINE FIELD attrs            ON otel_log_event TYPE option<string>;
DEFINE FIELD observed_at      ON otel_log_event TYPE datetime;
DEFINE INDEX IF NOT EXISTS otel_log_event_session ON otel_log_event FIELDS session_id;
```

- [ ] **Step 2: Register** in `SCHEMA_TABLES` (match neighboring entry shape):

```ts
    { table: "otel_log_event", stage: "active", note: "Harness OTLP log events (codex events incl. token usage)." },
```

- [ ] **Step 3: Run mirror test** - `bun test apps/axctl/src/queries/insights.test.ts` → PASS. (Run `bun install` in the worktree first if `@ax/schema` resolution fails.)

- [ ] **Step 4: Commit**
```bash
git add packages/schema/src/schema.surql apps/axctl/src/queries/insights.ts
git commit -m "feat(otel): otel_log_event table"
```

---

## Task 2: `OtelLogEventRow` + `logEventKey`

**Files:**
- Modify: `apps/axctl/src/otel/rows.ts`
- Test: `apps/axctl/src/otel/rows.test.ts` (extend)

- [ ] **Step 1: Write failing test** - append to `rows.test.ts`:

```ts
import { logEventKey, type OtelLogEventRow } from "./rows.ts";

describe("otel log event keys", () => {
    const base: OtelLogEventRow = {
        harness: "codex", event_name: "codex.sse_event", session_id: "c1",
        model: "gpt-5.5", input_tokens: 9994, output_tokens: 0, reasoning_tokens: 0,
        cached_tokens: 0, tool_tokens: 9994, duration_ms: null, status_code: null,
        attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
    };
    test("deterministic for same event+index", () => {
        expect(logEventKey(base, 0)).toBe(logEventKey(base, 0));
    });
    test("differs by index (distinct same-name events at same ts)", () => {
        expect(logEventKey(base, 0)).not.toBe(logEventKey(base, 1));
    });
    test("differs by event_name", () => {
        expect(logEventKey(base, 0)).not.toBe(logEventKey({ ...base, event_name: "x" }, 0));
    });
});
```

- [ ] **Step 2: Run** - `bun test apps/axctl/src/otel/rows.test.ts` → FAIL (logEventKey/type missing).

- [ ] **Step 3: Implement** - append to `rows.ts`:

```ts
export const OtelLogEventRow = Schema.Struct({
    harness: Schema.String,
    event_name: Schema.String,
    session_id: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    input_tokens: Schema.NullOr(Schema.Number),
    output_tokens: Schema.NullOr(Schema.Number),
    reasoning_tokens: Schema.NullOr(Schema.Number),
    cached_tokens: Schema.NullOr(Schema.Number),
    tool_tokens: Schema.NullOr(Schema.Number),
    duration_ms: Schema.NullOr(Schema.Number),
    status_code: Schema.NullOr(Schema.Number),
    attrs: Schema.NullOr(Schema.String),
    observed_at: Schema.Date,
});
export type OtelLogEventRow = Schema.Schema.Type<typeof OtelLogEventRow>;

/**
 * Deterministic id. Log events repeat by name within a session/second, so the
 * per-payload record `index` is folded in to keep distinct events distinct
 * (idempotent across re-delivery of the SAME payload).
 */
export const logEventKey = (r: OtelLogEventRow, index: number): string => {
    const ts = r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at);
    return `${r.harness}|${r.event_name}|${r.session_id ?? ""}|${ts}|${index}`;
};
```

(`Schema` is already imported at the top of rows.ts - confirm; if not, add `import { Schema } from "effect";`.)

- [ ] **Step 4: Run** → PASS. **Step 5: Typecheck** `bun run typecheck` (no new errors).
- [ ] **Step 6: Commit**
```bash
git add apps/axctl/src/otel/rows.ts apps/axctl/src/otel/rows.test.ts
git commit -m "feat(otel): OtelLogEventRow + logEventKey"
```

---

## Task 3: `LogsPayload` schema

**Files:**
- Modify: `apps/axctl/src/otel/otlp-schema.ts`
- Test: `apps/axctl/src/otel/otlp-schema.test.ts` (extend)

- [ ] **Step 1: Write failing test** - append:

```ts
import { LogsPayload } from "./otlp-schema.ts";

test("decodes a minimal logs payload", () => {
    const payload = {
        resourceLogs: [{
            resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_exec" } }] },
            scopeLogs: [{ logRecords: [{
                observedTimeUnixNano: "1718409600000000000",
                attributes: [{ key: "event.name", value: { stringValue: "codex.user_prompt" } }],
            }] }],
        }],
    };
    const d = Schema.decodeUnknownSync(LogsPayload)(payload);
    expect(d.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes?.[0]?.key).toBe("event.name");
});
```

- [ ] **Step 2: Run** → FAIL. 

- [ ] **Step 3: Implement** - append to `otlp-schema.ts` (reuses `KeyValue`/`Resource` already defined there; if `Resource` is module-private and not exported, redefine inline):

```ts
const LogRecord = Schema.Struct({
    timeUnixNano: Schema.optional(Schema.String),
    observedTimeUnixNano: Schema.optional(Schema.String),
    attributes: Schema.optional(Schema.Array(KeyValue)),
    body: Schema.optional(Schema.Unknown),
});

export const LogsPayload = Schema.Struct({
    resourceLogs: Schema.Array(Schema.Struct({
        resource: Schema.optional(Schema.Struct({ attributes: Schema.optional(Schema.Array(KeyValue)) })),
        scopeLogs: Schema.Array(Schema.Struct({
            logRecords: Schema.Array(LogRecord),
        })),
    })),
});
export type LogsPayload = Schema.Schema.Type<typeof LogsPayload>;
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**
```bash
git add apps/axctl/src/otel/otlp-schema.ts apps/axctl/src/otel/otlp-schema.test.ts
git commit -m "feat(otel): OTLP logs envelope schema"
```

---

## Task 4: `decodeLogsPayload` + `normalizeLogs` (allowlist + token lifting)

**Files:**
- Modify: `apps/axctl/src/otel/decode.ts`
- Modify: `apps/axctl/src/otel/normalize.ts`
- Test: `apps/axctl/src/otel/normalize.test.ts` (extend, uses the committed fixture)

- [ ] **Step 1: Write failing test** - append to `normalize.test.ts`:

```ts
import { normalizeLogs } from "./normalize.ts";
import codexLogs from "./__fixtures__/codex-logs.json" with { type: "json" };

describe("normalizeLogs", () => {
    test("allowlist drops transport noise, keeps signal events", () => {
        const rows = normalizeLogs(codexLogs as never);
        const names = rows.map((r) => r.event_name).sort();
        // fixture has sse_event(tokens) + user_prompt + conversation_starts + websocket_event(noise)
        expect(names).not.toContain("codex.websocket_event");
        expect(names).toContain("codex.user_prompt");
        expect(names).toContain("codex.conversation_starts");
        expect(rows.every((r) => r.harness === "codex")).toBe(true);
    });

    test("sse_event row lifts token columns + session from conversation.id", () => {
        const rows = normalizeLogs(codexLogs as never);
        const sse = rows.find((r) => r.event_name === "codex.sse_event");
        expect(sse).toBeDefined();
        expect(sse!.input_tokens).toBe(9994);
        expect(sse!.model).toBe("gpt-5.5");
        expect(sse!.session_id).toBe("019ecba3-1618-7c63-8e2e-e2eaf13075f3");
    });

    test("non-allowlisted-only payload → 0 rows", () => {
        const noise = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_exec" } }] },
            scopeLogs: [{ logRecords: [{ attributes: [{ key: "event.name", value: { stringValue: "codex.websocket_event" } }] }] }] }] };
        expect(normalizeLogs(noise as never)).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement decode** - append to `decode.ts`:

```ts
import { LogsPayload } from "./otlp-schema.ts"; // add to existing import if same module
export const decodeLogsPayload = (json: unknown) =>
    Schema.decodeUnknownEffect(LogsPayload)(json).pipe(
        Effect.mapError((e) => new OtelDecodeError({ signal: "logs", message: String(e) })),
    );
```
(Merge the `LogsPayload` import into the existing `./otlp-schema.ts` import line. `Schema`/`Effect`/`OtelDecodeError` already in scope.)

- [ ] **Step 4: Implement normalize** - append to `normalize.ts` (reuse existing `attrMap`/`nanoToDate`/`str`/`harnessOf`):

First, EXTEND `harnessOf` so codex log service names map (the existing one checks `codex_cli_rs`; logs use `codex_exec`):
```ts
// in harnessOf, before the final return:
    if (typeof serviceName === "string" && serviceName.startsWith("codex")) return "codex";
```
(Place this AFTER the existing `=== "codex_cli_rs"` check; the startsWith covers codex_exec/codex_tui too.)

Then add the allowlist + normalizer:
```ts
import { type LogsPayload } from "./otlp-schema.ts"; // merge into existing import
import type { OtelLogEventRow } from "./rows.ts";    // merge into existing import

const LOG_ALLOWLIST: Record<string, ReadonlySet<string>> = {
    codex: new Set([
        "codex.sse_event", "codex.api_request", "codex.user_prompt",
        "codex.turn_ttft", "codex.conversation_starts",
    ]),
    claude: new Set([
        "claude_code.tool_decision", "claude_code.skill_activated",
        "claude_code.user_prompt", "claude_code.api_error",
    ]),
};

const num = (v: string | number | boolean | null | undefined): number | null =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;

const eventTime = (a: Map<string, string | number | boolean | null>, observedNano: string | undefined, nano: string | undefined): Date => {
    const ts = a.get("event.timestamp");
    if (typeof ts === "string") { const d = new Date(ts); if (!Number.isNaN(d.getTime())) return d; }
    return nanoToDate(observedNano ?? nano);
};

export const normalizeLogs = (payload: LogsPayload): OtelLogEventRow[] => {
    const out: OtelLogEventRow[] = [];
    for (const rl of payload.resourceLogs) {
        const res = attrMap(rl.resource?.attributes);
        const harness = harnessOf(res.get("service.name") ?? null);
        const allow = LOG_ALLOWLIST[harness];
        for (const sl of rl.scopeLogs) {
            for (const rec of sl.logRecords) {
                const a = attrMap(rec.attributes);
                const eventName = a.get("event.name");
                if (typeof eventName !== "string") continue;
                if (!allow || !allow.has(eventName)) continue;
                out.push({
                    harness,
                    event_name: eventName,
                    session_id: str(a.get("conversation.id") ?? a.get("session.id") ?? res.get("session.id")),
                    model: str(a.get("model")),
                    input_tokens: num(a.get("input_token_count")),
                    output_tokens: num(a.get("output_token_count")),
                    reasoning_tokens: num(a.get("reasoning_token_count")),
                    cached_tokens: num(a.get("cached_token_count")),
                    tool_tokens: num(a.get("tool_token_count")),
                    duration_ms: num(a.get("duration_ms")),
                    status_code: num(a.get("http.response.status_code")),
                    attrs: a.size ? JSON.stringify(Object.fromEntries(a)) : null,
                    observed_at: eventTime(a, rec.observedTimeUnixNano, rec.timeUnixNano),
                });
            }
        }
    }
    return out;
};
```

- [ ] **Step 5: Run** → PASS (3 tests). **Step 6: Typecheck.**
- [ ] **Step 7: Commit**
```bash
git add apps/axctl/src/otel/decode.ts apps/axctl/src/otel/normalize.ts apps/axctl/src/otel/normalize.test.ts
git commit -m "feat(otel): logs decoder + normalizer (allowlist + token lifting)"
```

---

## Task 5: `OtelWriter.writeLogs`

**Files:**
- Modify: `apps/axctl/src/otel/writer.ts`
- Test: `apps/axctl/src/otel/writer.test.ts` (extend)

- [ ] **Step 1: Write failing test** - append:

```ts
import type { OtelLogEventRow } from "./rows.ts";

test("writeLogs issues an UPSERT into otel_log_event with token cols", async () => {
    captured.length = 0;
    const row: OtelLogEventRow = {
        harness: "codex", event_name: "codex.sse_event", session_id: "c1", model: "gpt-5.5",
        input_tokens: 9994, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, tool_tokens: 9994,
        duration_ms: null, status_code: null, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
    };
    await Effect.runPromise(Effect.gen(function* () {
        const w = yield* OtelWriter; yield* w.writeLogs([row]);
    }).pipe(Effect.provide(OtelWriterLive), Effect.provide(stubDb)));
    const sql = captured.join("\n");
    expect(sql).toContain("UPSERT otel_log_event:");
    expect(sql).toContain("input_tokens = 9994");
});

test("writeLogs empty → no query", async () => {
    captured.length = 0;
    await Effect.runPromise(Effect.gen(function* () {
        const w = yield* OtelWriter; yield* w.writeLogs([]);
    }).pipe(Effect.provide(OtelWriterLive), Effect.provide(stubDb)));
    expect(captured).toHaveLength(0);
});
```
(`captured`/`stubDb`/`OtelWriter`/`OtelWriterLive`/`Effect` already set up in this test file.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** - in `writer.ts`:

Add to `OtelWriterShape`:
```ts
    readonly writeLogs: (rows: readonly OtelLogEventRow[]) => Effect.Effect<void, DbError, SurrealClient>;
```
Import `OtelLogEventRow` + `logEventKey` from `./rows.ts` (merge into existing import). Add a statement builder + wire into the Live layer. For nullable numbers, render the number or `NONE` (use the real surql numeric-option helper from `@ax/lib/shared/surreal.ts`; if none exists, inline `const optNum = (n: number | null) => n === null ? "NONE" : String(n);`):

```ts
const logStmt = (r: OtelLogEventRow, i: number): string =>
    `UPSERT ${recordRef("otel_log_event", logEventKey(r, i))} SET ` +
    `harness = ${surrealString(r.harness)}, ` +
    `event_name = ${surrealString(r.event_name)}, ` +
    `session_id = ${surrealOptionString(r.session_id)}, ` +
    `model = ${surrealOptionString(r.model)}, ` +
    `input_tokens = ${optNum(r.input_tokens)}, ` +
    `output_tokens = ${optNum(r.output_tokens)}, ` +
    `reasoning_tokens = ${optNum(r.reasoning_tokens)}, ` +
    `cached_tokens = ${optNum(r.cached_tokens)}, ` +
    `tool_tokens = ${optNum(r.tool_tokens)}, ` +
    `duration_ms = ${optNum(r.duration_ms)}, ` +
    `status_code = ${optNum(r.status_code)}, ` +
    `attrs = ${surrealOptionString(r.attrs)}, ` +
    `observed_at = ${surrealDate(r.observed_at)};`;
```
In `OtelWriterLive`:
```ts
    writeLogs: (rows) => rows.length === 0 ? Effect.void : executeStatements(rows.map((r, i) => logStmt(r, i))),
```

- [ ] **Step 4: Run** → PASS. **Step 5: Typecheck.**
- [ ] **Step 6: Commit**
```bash
git add apps/axctl/src/otel/writer.ts apps/axctl/src/otel/writer.test.ts
git commit -m "feat(otel): OtelWriter.writeLogs"
```

---

## Task 6: Implement the `/v1/logs` handler branch

**Files:**
- Modify: `apps/axctl/src/dashboard/contract/otel.ts`
- Test: `apps/axctl/src/dashboard/contract/otel.test.ts` (extend)

- [ ] **Step 1: Write failing test** - append (mirror the metrics test):

```ts
import codexLogs from "../../otel/__fixtures__/codex-logs.json" with { type: "json" };

test("logs body → writer UPSERT into otel_log_event, returns ack", async () => {
    captured.length = 0;
    const ack = await Effect.runPromise(
        handleOtlp("logs", toBuf(JSON.stringify(codexLogs)), undefined).pipe(Effect.provide(stubDb)),
    );
    expect(captured.join("\n")).toContain("UPSERT otel_log_event:");
    expect(ack).toEqual({ partialSuccess: {} });
});
```
(`captured`/`stubDb`/`toBuf`/`handleOtlp`/`Effect` already in this test file.)

- [ ] **Step 2: Run** → FAIL (currently logs is a no-op, no UPSERT).

- [ ] **Step 3: Implement** - in `otel.ts`, replace the `if (signal === "logs") return ACK;` early return. The handler currently branches metrics/traces; add a logs branch that decodes→normalizes→writes. Import `decodeLogsPayload` + `normalizeLogs`. Inside the gen, after `json` is parsed and `writer` obtained, structure as:

```ts
        if (signal === "logs") {
            const payload = yield* decodeLogsPayload(json).pipe(
                Effect.orElseSucceed(() => null),
            );
            if (payload) yield* writer.writeLogs(normalizeLogs(payload));
        } else if (signal === "metrics") {
            // ...existing...
        } else {
            // ...existing traces...
        }
```
IMPORTANT: the existing handler returns ACK early for "logs" BEFORE obtaining `writer`/parsing `json`. Move the logs handling to AFTER the json-parse + `const writer = yield* OtelWriter;` lines, alongside metrics/traces. Read the current file structure and integrate cleanly (keep the fail-open: bad json → ACK no write; provide OtelWriterLive as today). Do NOT remove the metrics/traces branches.

- [ ] **Step 4: Run** → PASS. Also run `bun test apps/axctl/src/dashboard/contract/otel.test.ts` (all prior tests still green). **Step 5: Typecheck.**
- [ ] **Step 6: Commit**
```bash
git add apps/axctl/src/dashboard/contract/otel.ts apps/axctl/src/dashboard/contract/otel.test.ts
git commit -m "feat(otel): implement /v1/logs ingestion handler"
```

---

## Task 7: Correlate log events + docs + full verification

**Files:**
- Modify: `apps/axctl/src/otel/correlate.ts`
- Modify: `CLAUDE.md`
- Test: `apps/axctl/src/otel/correlate.test.ts` (already passes; add otel_log_event coverage)

- [ ] **Step 1: Extend RELATABLE** in `correlate.ts`:
```ts
const RELATABLE = ["otel_metric_point", "otel_span", "otel_log_event"] as const;
```

- [ ] **Step 2: Add a correlation test** - append to `correlate.test.ts` a stub returning an orphan `otel_log_event` row and assert a `RELATE ...->telemetry_of->otel_log_event:` statement is issued (mirror the existing metric-row test; the stub's SELECT regex should also match `otel_log_event`).

- [ ] **Step 3: Run** - `bun test apps/axctl/src/otel/correlate.test.ts` → PASS.

- [ ] **Step 4: Update CLAUDE.md** OTLP receiver section - change the `/v1/logs` line from "accepted and dropped (v1 no-op)" to: ingests OTLP log events → `otel_log_event` (codex events incl. token usage on `codex.sse_event`; curated allowlist; session key `conversation.id`). Keep it to ~3 sentences.

- [ ] **Step 5: Full suite + typecheck** - `bun test` (repo-wide) + `bun run typecheck`. Fix any otel-caused breakage; list pre-existing unrelated failures. Expect green.

- [ ] **Step 6: Commit**
```bash
git add apps/axctl/src/otel/correlate.ts apps/axctl/src/otel/correlate.test.ts CLAUDE.md
git commit -m "feat(otel): correlate log events + docs"
```

---

## Task 8: Live smoke (controller-run; document steps)

**Files:** Create `apps/axctl/src/otel/SMOKE.md` addition (or note in PR).

- [ ] **Step 1:** Document the smoke (the controller will run it against a live daemon):
```bash
# daemon on merged code, then POST the fixture as a logs body:
curl -sS -X POST http://127.0.0.1:1738/v1/logs -H 'content-type: application/json' \
  --data @apps/axctl/src/otel/__fixtures__/codex-logs.json
# expect {"partialSuccess":{}}, then:
#   SELECT event_name, input_tokens, model, session_id FROM otel_log_event;
# expect 3 rows (websocket_event dropped); sse_event row with input_tokens=9994.
```
- [ ] **Step 2: Commit** any doc note.

---

## Verification (whole-plan)
- [ ] `bun test` green; `bun run typecheck` clean.
- [ ] SCHEMA_TABLES mirror green (Task 1).
- [ ] Live: posting the fixture to `/v1/logs` lands 3 rows incl. token columns.
- [ ] Allowlist drops `codex.websocket_event` (verified in normalize test + live).

## Open items (from spec)
1. Does codex transcript `session` id == `conversation.id`? Verify with a real ingested codex session; if not, log rows stay orphan (still useful). Correlation is best-effort.
2. CC events need `OTEL_LOGS_EXPORTER=otlp` in install config to flow - deferred follow-up (claude allowlist entries are wired, untested live).
