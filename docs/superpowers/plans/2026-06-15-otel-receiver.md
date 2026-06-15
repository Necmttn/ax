# OTLP Receiver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ax serve` accepts harness-emitted OTLP/JSON usage telemetry (Claude Code metrics + Codex traces) on port 1738, lands it in dedicated `otel_*` tables, and graph-correlates it to sessions when transcripts ingest.

**Architecture:** New `apps/axctl/src/otel/` module: curated Effect `Schema` decoders for OTLP/JSON metrics + traces → per-harness normalizers → `OtelWriter` service writing `otel_metric_point` / `otel_span` rows. Three POST endpoints (`/v1/metrics`, `/v1/traces`, `/v1/logs`) mount on the existing contract HttpRouter (ADR-0013). A correlation pass RELATEs orphan otel rows to sessions by `session.id` at ingest finish. `ax install` writes harness telemetry config with ax-ownership markers. Cost from OTLP stays separate from file-parsed cost - no double-count.

**Tech Stack:** Bun ≥1.3, TypeScript strict, `effect@beta` (Schema + Layer + HttpApi), SurrealDB 3.0 via `@ax/lib/db`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-15-otel-receiver-design.md`

---

## File Structure

- Create `apps/axctl/src/otel/rows.ts` - row Schemas (`OtelMetricPointRow`, `OtelSpanRow`) + deterministic record-key helpers.
- Create `apps/axctl/src/otel/otlp-schema.ts` - curated OTLP/JSON envelope Schemas (metrics + traces) with AnyValue union + nano-string handling.
- Create `apps/axctl/src/otel/decode.ts` - `decodeMetricsPayload`, `decodeTracePayload`: raw JSON → typed envelope.
- Create `apps/axctl/src/otel/normalize.ts` - envelope → rows; harness routing by resource attrs.
- Create `apps/axctl/src/otel/writer.ts` - `OtelWriter` service (Live + Test), batch SQL via `executeStatements`.
- Create `apps/axctl/src/otel/correlate.ts` - `correlateOrphanOtel()` RELATE pass.
- Create `apps/axctl/src/dashboard/contract/otel.ts` - `OtelGroupLive` HttpApi handlers (raw body, gunzip, decode→normalize→write).
- Modify `packages/schema/src/schema.surql` - 2 tables + 1 relation.
- Modify `apps/axctl/src/queries/insights.ts` - `SCHEMA_TABLES` entries.
- Modify `packages/lib/src/shared/api-contract.ts` - `OtelGroup` + add to `AxApi`.
- Modify `apps/axctl/src/dashboard/contract/web-handler.ts` - register routes + group.
- Modify `apps/axctl/src/ingest/provider-events.ts` - add `"otel"` provider name.
- Modify ingest finish (`apps/axctl/src/cli/index.ts` `withIngest`) - call correlation.
- Modify `ax install` (`apps/axctl/src/.../install.ts` + hooks provider helpers) - telemetry config writes.
- Modify `apps/axctl/src/dashboard/capabilities.ts` + version payload - advertise `otlp_receiver`.
- Modify `CLAUDE.md` - document the receiver + `ax install` telemetry behavior.

Tests live beside each `*.ts` as `*.test.ts` (bun:test).

---

## Task 1: Schema - otel tables + correlation edge

**Files:**
- Modify: `packages/schema/src/schema.surql` (append near other tables)
- Modify: `apps/axctl/src/queries/insights.ts:45` (SCHEMA_TABLES)
- Test: `apps/axctl/src/queries/insights.test.ts` (existing mirror test guards this)

- [ ] **Step 1: Add DDL to schema.surql**

Append:

```surql
DEFINE TABLE otel_metric_point SCHEMAFULL;
DEFINE FIELD harness     ON otel_metric_point TYPE string;
DEFINE FIELD metric      ON otel_metric_point TYPE string;
DEFINE FIELD value       ON otel_metric_point TYPE number;
DEFINE FIELD unit        ON otel_metric_point TYPE option<string>;
DEFINE FIELD session_id  ON otel_metric_point TYPE option<string>;
DEFINE FIELD model       ON otel_metric_point TYPE option<string>;
DEFINE FIELD skill_name  ON otel_metric_point TYPE option<string>;
DEFINE FIELD agent_name  ON otel_metric_point TYPE option<string>;
DEFINE FIELD attrs       ON otel_metric_point TYPE option<string>;   -- JSON-encoded
DEFINE FIELD observed_at ON otel_metric_point TYPE datetime;
DEFINE INDEX otel_metric_session ON otel_metric_point FIELDS session_id;

DEFINE TABLE otel_span SCHEMAFULL;
DEFINE FIELD harness        ON otel_span TYPE string;
DEFINE FIELD name           ON otel_span TYPE string;
DEFINE FIELD trace_id       ON otel_span TYPE string;
DEFINE FIELD span_id        ON otel_span TYPE string;
DEFINE FIELD parent_span_id ON otel_span TYPE option<string>;
DEFINE FIELD session_id     ON otel_span TYPE option<string>;
DEFINE FIELD started_at     ON otel_span TYPE datetime;
DEFINE FIELD ended_at       ON otel_span TYPE datetime;
DEFINE FIELD duration_ms    ON otel_span TYPE number;
DEFINE FIELD attrs          ON otel_span TYPE option<string>;        -- JSON-encoded
DEFINE FIELD observed_at    ON otel_span TYPE datetime;
DEFINE INDEX otel_span_session ON otel_span FIELDS session_id;

DEFINE TABLE telemetry_of TYPE RELATION FROM session TO otel_metric_point | otel_span;
DEFINE FIELD linked_at ON telemetry_of TYPE datetime DEFAULT time::now();
```

- [ ] **Step 2: Add SCHEMA_TABLES entries**

In `apps/axctl/src/queries/insights.ts`, add to the `SCHEMA_TABLES` array:

```ts
    { table: "otel_metric_point", stage: "active", note: "Harness OTLP metric data points (cost/token/usage)." },
    { table: "otel_span", stage: "active", note: "Harness OTLP trace spans (Codex session_loop + children)." },
    { table: "telemetry_of", stage: "active", note: "Edge: session -> otel telemetry row (drawn at ingest)." },
```

- [ ] **Step 3: Run the mirror test, expect PASS**

Run: `bun test apps/axctl/src/queries/insights.test.ts`
Expected: PASS (the test parses `DEFINE TABLE` lines from schema.surql and compares to SCHEMA_TABLES; both now include the three new tables).

- [ ] **Step 4: Commit**

```bash
git add packages/schema/src/schema.surql apps/axctl/src/queries/insights.ts
git commit -m "feat(otel): otel_metric_point/otel_span tables + telemetry_of edge"
```

---

## Task 2: Row schemas + record-key helpers

**Files:**
- Create: `apps/axctl/src/otel/rows.ts`
- Test: `apps/axctl/src/otel/rows.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { metricPointKey, spanKey, type OtelMetricPointRow } from "./rows.ts";

describe("otel record keys", () => {
    test("metricPointKey is deterministic for same point", () => {
        const row: OtelMetricPointRow = {
            harness: "claude", metric: "claude_code.cost.usage", value: 0.12,
            unit: "USD", session_id: "s1", model: "opus", skill_name: null,
            agent_name: null, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
        };
        expect(metricPointKey(row)).toBe(metricPointKey(row));
    });

    test("metricPointKey differs when metric or ts differs", () => {
        const base: OtelMetricPointRow = {
            harness: "claude", metric: "claude_code.cost.usage", value: 0.12,
            unit: "USD", session_id: "s1", model: null, skill_name: null,
            agent_name: null, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
        };
        expect(metricPointKey(base)).not.toBe(metricPointKey({ ...base, metric: "x" }));
    });

    test("spanKey is the span_id", () => {
        expect(spanKey({ trace_id: "t", span_id: "abc" } as never)).toBe("abc");
    });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/axctl/src/otel/rows.test.ts`
Expected: FAIL - `Cannot find module './rows.ts'`.

- [ ] **Step 3: Implement rows.ts**

```ts
import { Schema } from "effect";

/** A normalized OTLP metric data point as stored in otel_metric_point. */
export const OtelMetricPointRow = Schema.Struct({
    harness: Schema.String,
    metric: Schema.String,
    value: Schema.Number,
    unit: Schema.NullOr(Schema.String),
    session_id: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    skill_name: Schema.NullOr(Schema.String),
    agent_name: Schema.NullOr(Schema.String),
    attrs: Schema.NullOr(Schema.String),
    observed_at: Schema.DateTimeUtc,
});
export type OtelMetricPointRow = Schema.Schema.Type<typeof OtelMetricPointRow>;

export const OtelSpanRow = Schema.Struct({
    harness: Schema.String,
    name: Schema.String,
    trace_id: Schema.String,
    span_id: Schema.String,
    parent_span_id: Schema.NullOr(Schema.String),
    session_id: Schema.NullOr(Schema.String),
    started_at: Schema.DateTimeUtc,
    ended_at: Schema.DateTimeUtc,
    duration_ms: Schema.Number,
    attrs: Schema.NullOr(Schema.String),
    observed_at: Schema.DateTimeUtc,
});
export type OtelSpanRow = Schema.Schema.Type<typeof OtelSpanRow>;

/** Deterministic id so re-delivered points UPSERT instead of duplicating. */
export const metricPointKey = (r: OtelMetricPointRow): string => {
    const ts = r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at);
    return `${r.harness}|${r.metric}|${r.session_id ?? ""}|${r.model ?? ""}|${r.skill_name ?? ""}|${ts}`;
};

/** Spans carry a globally-unique span_id; use it directly. */
export const spanKey = (r: Pick<OtelSpanRow, "span_id">): string => r.span_id;
```

Note: `observed_at` typed as `DateTimeUtc` in the Schema; the row objects pass JS `Date` (compatible). If a typecheck mismatch appears, use `Schema.Any` for the date field and keep the TS type as `Date` via a manual interface - prefer keeping `Date`.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test apps/axctl/src/otel/rows.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no new errors in `apps/axctl/src/otel/`.

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/otel/rows.ts apps/axctl/src/otel/rows.test.ts
git commit -m "feat(otel): row schemas + deterministic record keys"
```

---

## Task 3: OTLP/JSON envelope schemas

**Files:**
- Create: `apps/axctl/src/otel/otlp-schema.ts`
- Test: `apps/axctl/src/otel/otlp-schema.test.ts`

OTLP/JSON proto3 quirks: `*UnixNano` integers are **strings**; attribute values are an `AnyValue` union `{ stringValue | intValue | doubleValue | boolValue }` where `intValue` is also a **string**.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AnyValue, KeyValue, MetricsPayload, TracePayload, attrValueToScalar } from "./otlp-schema.ts";

describe("otlp envelope schemas", () => {
    test("decodes an AnyValue stringValue", () => {
        const v = Schema.decodeUnknownSync(AnyValue)({ stringValue: "opus" });
        expect(attrValueToScalar(v)).toBe("opus");
    });

    test("decodes intValue as string and yields number", () => {
        const v = Schema.decodeUnknownSync(AnyValue)({ intValue: "42" });
        expect(attrValueToScalar(v)).toBe(42);
    });

    test("decodes a minimal metrics payload", () => {
        const payload = {
            resourceMetrics: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
                scopeMetrics: [{
                    metrics: [{
                        name: "claude_code.cost.usage", unit: "USD",
                        sum: { dataPoints: [{
                            asDouble: 0.12, timeUnixNano: "1718409600000000000",
                            attributes: [
                                { key: "session.id", value: { stringValue: "s1" } },
                                { key: "model", value: { stringValue: "opus" } },
                            ],
                        }] },
                    }],
                }],
            }],
        };
        const decoded = Schema.decodeUnknownSync(MetricsPayload)(payload);
        expect(decoded.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.name).toBe("claude_code.cost.usage");
    });

    test("decodes a minimal trace payload", () => {
        const payload = {
            resourceSpans: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_cli_rs" } }] },
                scopeSpans: [{
                    spans: [{
                        name: "session_loop", traceId: "aa", spanId: "bb",
                        startTimeUnixNano: "1718409600000000000", endTimeUnixNano: "1718409601000000000",
                        attributes: [],
                    }],
                }],
            }],
        };
        const decoded = Schema.decodeUnknownSync(TracePayload)(payload);
        expect(decoded.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe("session_loop");
    });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/axctl/src/otel/otlp-schema.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement otlp-schema.ts**

```ts
import { Schema } from "effect";

/** OTLP/JSON AnyValue (only the scalar variants we read). */
export const AnyValue = Schema.Struct({
    stringValue: Schema.optional(Schema.String),
    intValue: Schema.optional(Schema.String),    // proto3 JSON: int64 as string
    doubleValue: Schema.optional(Schema.Number),
    boolValue: Schema.optional(Schema.Boolean),
});
export type AnyValue = Schema.Schema.Type<typeof AnyValue>;

export const KeyValue = Schema.Struct({
    key: Schema.String,
    value: Schema.optional(AnyValue),
});
export type KeyValue = Schema.Schema.Type<typeof KeyValue>;

/** Collapse an AnyValue to a JS scalar; intValue parses to number. */
export const attrValueToScalar = (v: AnyValue | undefined): string | number | boolean | null => {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.intValue !== undefined) return Number(v.intValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.boolValue !== undefined) return v.boolValue;
    return null;
};

/** Build a flat attr lookup from a KeyValue list. */
export const attrMap = (kvs: readonly KeyValue[] | undefined): Map<string, string | number | boolean | null> => {
    const m = new Map<string, string | number | boolean | null>();
    for (const kv of kvs ?? []) m.set(kv.key, attrValueToScalar(kv.value));
    return m;
};

const Resource = Schema.Struct({ attributes: Schema.optional(Schema.Array(KeyValue)) });

const NumberDataPoint = Schema.Struct({
    asDouble: Schema.optional(Schema.Number),
    asInt: Schema.optional(Schema.String),       // proto3 JSON int64 as string
    timeUnixNano: Schema.optional(Schema.String),
    attributes: Schema.optional(Schema.Array(KeyValue)),
});

const Metric = Schema.Struct({
    name: Schema.String,
    unit: Schema.optional(Schema.String),
    sum: Schema.optional(Schema.Struct({ dataPoints: Schema.optional(Schema.Array(NumberDataPoint)) })),
    gauge: Schema.optional(Schema.Struct({ dataPoints: Schema.optional(Schema.Array(NumberDataPoint)) })),
});

export const MetricsPayload = Schema.Struct({
    resourceMetrics: Schema.Array(Schema.Struct({
        resource: Schema.optional(Resource),
        scopeMetrics: Schema.Array(Schema.Struct({
            metrics: Schema.Array(Metric),
        })),
    })),
});
export type MetricsPayload = Schema.Schema.Type<typeof MetricsPayload>;

const Span = Schema.Struct({
    name: Schema.String,
    traceId: Schema.String,
    spanId: Schema.String,
    parentSpanId: Schema.optional(Schema.String),
    startTimeUnixNano: Schema.String,
    endTimeUnixNano: Schema.String,
    attributes: Schema.optional(Schema.Array(KeyValue)),
});

export const TracePayload = Schema.Struct({
    resourceSpans: Schema.Array(Schema.Struct({
        resource: Schema.optional(Resource),
        scopeSpans: Schema.Array(Schema.Struct({
            spans: Schema.Array(Span),
        })),
    })),
});
export type TracePayload = Schema.Schema.Type<typeof TracePayload>;

/** nano-string → JS Date. */
export const nanoToDate = (nano: string | undefined): Date =>
    new Date(Number(BigInt(nano ?? "0") / 1_000_000n));
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test apps/axctl/src/otel/otlp-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/otel/otlp-schema.ts apps/axctl/src/otel/otlp-schema.test.ts
git commit -m "feat(otel): curated OTLP/JSON envelope schemas"
```

---

## Task 4: Decoders + normalizers (harness routing)

**Files:**
- Create: `apps/axctl/src/otel/decode.ts`
- Create: `apps/axctl/src/otel/normalize.ts`
- Test: `apps/axctl/src/otel/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { normalizeMetrics, normalizeTrace } from "./normalize.ts";

const CC_METRICS = {
    resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeMetrics: [{ metrics: [{
            name: "claude_code.cost.usage", unit: "USD",
            sum: { dataPoints: [{
                asDouble: 0.12, timeUnixNano: "1718409600000000000",
                attributes: [
                    { key: "session.id", value: { stringValue: "s1" } },
                    { key: "model", value: { stringValue: "opus" } },
                    { key: "skill.name", value: { stringValue: "tdd" } },
                ],
            }] },
        }] }],
    }],
};

const CODEX_TRACE = {
    resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_cli_rs" } }] },
        scopeSpans: [{ spans: [{
            name: "session_loop", traceId: "aa", spanId: "bb",
            startTimeUnixNano: "1718409600000000000", endTimeUnixNano: "1718409601000000000",
            attributes: [{ key: "session.id", value: { stringValue: "cdx1" } }],
        }] }],
    }],
};

describe("normalize", () => {
    test("CC metrics → metric point rows with attrs lifted", () => {
        const rows = normalizeMetrics(CC_METRICS);
        expect(rows).toHaveLength(1);
        const r = rows[0]!;
        expect(r.harness).toBe("claude");
        expect(r.metric).toBe("claude_code.cost.usage");
        expect(r.value).toBe(0.12);
        expect(r.unit).toBe("USD");
        expect(r.session_id).toBe("s1");
        expect(r.model).toBe("opus");
        expect(r.skill_name).toBe("tdd");
    });

    test("Codex trace → span rows with duration", () => {
        const rows = normalizeTrace(CODEX_TRACE);
        expect(rows).toHaveLength(1);
        const r = rows[0]!;
        expect(r.harness).toBe("codex");
        expect(r.name).toBe("session_loop");
        expect(r.span_id).toBe("bb");
        expect(r.session_id).toBe("cdx1");
        expect(r.duration_ms).toBe(1000);
    });

    test("unknown service.name → harness 'unknown', still ingests", () => {
        const rows = normalizeMetrics({
            ...CC_METRICS,
            resourceMetrics: [{ ...CC_METRICS.resourceMetrics[0], resource: { attributes: [] } }],
        });
        expect(rows[0]!.harness).toBe("unknown");
    });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/axctl/src/otel/normalize.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement decode.ts**

```ts
import { Effect, Schema } from "effect";
import { MetricsPayload, TracePayload } from "./otlp-schema.ts";

export class OtelDecodeError extends Schema.TaggedError<OtelDecodeError>()("OtelDecodeError", {
    signal: Schema.String,
    message: Schema.String,
}) {}

export const decodeMetricsPayload = (json: unknown) =>
    Schema.decodeUnknown(MetricsPayload)(json).pipe(
        Effect.mapError((e) => new OtelDecodeError({ signal: "metrics", message: String(e) })),
    );

export const decodeTracePayload = (json: unknown) =>
    Schema.decodeUnknown(TracePayload)(json).pipe(
        Effect.mapError((e) => new OtelDecodeError({ signal: "traces", message: String(e) })),
    );
```

- [ ] **Step 4: Implement normalize.ts**

```ts
import { attrMap, nanoToDate, type MetricsPayload, type TracePayload } from "./otlp-schema.ts";
import type { OtelMetricPointRow, OtelSpanRow } from "./rows.ts";

/** Map an OTLP service.name to ax's harness label. */
const harnessOf = (serviceName: string | number | boolean | null): string => {
    if (serviceName === "claude-code" || serviceName === "claude_code") return "claude";
    if (serviceName === "codex_cli_rs") return "codex";
    if (serviceName === "opencode") return "opencode";
    if (typeof serviceName === "string" && serviceName.startsWith("pi")) return "pi";
    return "unknown";
};

const str = (v: string | number | boolean | null | undefined): string | null =>
    typeof v === "string" ? v : v == null ? null : String(v);

export const normalizeMetrics = (payload: MetricsPayload): OtelMetricPointRow[] => {
    const out: OtelMetricPointRow[] = [];
    for (const rm of payload.resourceMetrics) {
        const res = attrMap(rm.resource?.attributes);
        const harness = harnessOf(res.get("service.name") ?? null);
        for (const sm of rm.scopeMetrics) {
            for (const metric of sm.metrics) {
                const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
                for (const dp of points) {
                    const a = attrMap(dp.attributes);
                    const value = dp.asDouble ?? (dp.asInt !== undefined ? Number(dp.asInt) : 0);
                    out.push({
                        harness,
                        metric: metric.name,
                        value,
                        unit: metric.unit ?? null,
                        session_id: str(a.get("session.id") ?? res.get("session.id")),
                        model: str(a.get("model")),
                        skill_name: str(a.get("skill.name")),
                        agent_name: str(a.get("agent.name")),
                        attrs: a.size ? JSON.stringify(Object.fromEntries(a)) : null,
                        observed_at: nanoToDate(dp.timeUnixNano),
                    });
                }
            }
        }
    }
    return out;
};

export const normalizeTrace = (payload: TracePayload): OtelSpanRow[] => {
    const out: OtelSpanRow[] = [];
    for (const rs of payload.resourceSpans) {
        const res = attrMap(rs.resource?.attributes);
        const harness = harnessOf(res.get("service.name") ?? null);
        for (const ss of rs.scopeSpans) {
            for (const span of ss.spans) {
                const a = attrMap(span.attributes);
                const started = nanoToDate(span.startTimeUnixNano);
                const ended = nanoToDate(span.endTimeUnixNano);
                out.push({
                    harness,
                    name: span.name,
                    trace_id: span.traceId,
                    span_id: span.spanId,
                    parent_span_id: span.parentSpanId ?? null,
                    session_id: str(a.get("session.id") ?? res.get("session.id")),
                    started_at: started,
                    ended_at: ended,
                    duration_ms: ended.getTime() - started.getTime(),
                    attrs: a.size ? JSON.stringify(Object.fromEntries(a)) : null,
                    observed_at: started,
                });
            }
        }
    }
    return out;
};
```

- [ ] **Step 5: Run, expect PASS**

Run: `bun test apps/axctl/src/otel/normalize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/otel/decode.ts apps/axctl/src/otel/normalize.ts apps/axctl/src/otel/normalize.test.ts
git commit -m "feat(otel): JSON decoders + per-harness normalizers"
```

---

## Task 5: OtelWriter service

**Files:**
- Create: `apps/axctl/src/otel/writer.ts`
- Test: `apps/axctl/src/otel/writer.test.ts`

The writer builds SurrealQL UPSERT statements (deterministic ids → idempotent) and runs them via `executeStatements`. Use `@ax/lib/shared/surql` helpers for literals.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { OtelWriter, OtelWriterLive } from "./writer.ts";
import type { OtelMetricPointRow } from "./rows.ts";

const captured: string[] = [];
const stubDb = Layer.succeed(SurrealClient, {
    query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
} as never);

const row: OtelMetricPointRow = {
    harness: "claude", metric: "claude_code.cost.usage", value: 0.12, unit: "USD",
    session_id: "s1", model: "opus", skill_name: null, agent_name: null,
    attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
};

describe("OtelWriter", () => {
    test("writeMetrics issues an UPSERT into otel_metric_point", async () => {
        captured.length = 0;
        await Effect.runPromise(
            Effect.gen(function* () {
                const w = yield* OtelWriter;
                yield* w.writeMetrics([row]);
            }).pipe(Effect.provide(OtelWriterLive), Effect.provide(stubDb)),
        );
        const sql = captured.join("\n");
        expect(sql).toContain("UPSERT otel_metric_point:");
        expect(sql).toContain("claude_code.cost.usage");
        expect(sql).toContain("value = 0.12");
    });

    test("empty input issues no query", async () => {
        captured.length = 0;
        await Effect.runPromise(
            Effect.gen(function* () {
                const w = yield* OtelWriter;
                yield* w.writeMetrics([]);
            }).pipe(Effect.provide(OtelWriterLive), Effect.provide(stubDb)),
        );
        expect(captured).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/axctl/src/otel/writer.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement writer.ts**

```ts
import { Context, Effect, Layer } from "effect";
import { executeStatements } from "@ax/lib/shared/surreal";
import { surrealDate, surrealString, surrealStringOption } from "@ax/lib/shared/surql";
import { metricPointKey, spanKey, type OtelMetricPointRow, type OtelSpanRow } from "./rows.ts";
import type { DbError } from "@ax/lib/db";
import { SurrealClient } from "@ax/lib/db";

export interface OtelWriterShape {
    readonly writeMetrics: (rows: readonly OtelMetricPointRow[]) => Effect.Effect<void, DbError, SurrealClient>;
    readonly writeSpans: (rows: readonly OtelSpanRow[]) => Effect.Effect<void, DbError, SurrealClient>;
}

export class OtelWriter extends Context.Service<OtelWriter, OtelWriterShape>()("ax/otel/OtelWriter") {}

// `key` is escaped with backticks; helpers from @ax/lib/shared/surql emit
// typed literals (s"...", d"...", NONE for null option fields).
const metricStmt = (r: OtelMetricPointRow): string => {
    const id = metricPointKey(r).replace(/`/g, "");
    return `UPSERT otel_metric_point:\`${id}\` SET ` +
        `harness = ${surrealString(r.harness)}, ` +
        `metric = ${surrealString(r.metric)}, ` +
        `value = ${r.value}, ` +
        `unit = ${surrealStringOption(r.unit)}, ` +
        `session_id = ${surrealStringOption(r.session_id)}, ` +
        `model = ${surrealStringOption(r.model)}, ` +
        `skill_name = ${surrealStringOption(r.skill_name)}, ` +
        `agent_name = ${surrealStringOption(r.agent_name)}, ` +
        `attrs = ${surrealStringOption(r.attrs)}, ` +
        `observed_at = ${surrealDate(r.observed_at)};`;
};

const spanStmt = (r: OtelSpanRow): string => {
    const id = spanKey(r).replace(/`/g, "");
    return `UPSERT otel_span:\`${id}\` SET ` +
        `harness = ${surrealString(r.harness)}, ` +
        `name = ${surrealString(r.name)}, ` +
        `trace_id = ${surrealString(r.trace_id)}, ` +
        `span_id = ${surrealString(r.span_id)}, ` +
        `parent_span_id = ${surrealStringOption(r.parent_span_id)}, ` +
        `session_id = ${surrealStringOption(r.session_id)}, ` +
        `started_at = ${surrealDate(r.started_at)}, ` +
        `ended_at = ${surrealDate(r.ended_at)}, ` +
        `duration_ms = ${r.duration_ms}, ` +
        `attrs = ${surrealStringOption(r.attrs)}, ` +
        `observed_at = ${surrealDate(r.observed_at)};`;
};

export const OtelWriterLive: Layer.Layer<OtelWriter> = Layer.succeed(OtelWriter, {
    writeMetrics: (rows) =>
        rows.length === 0 ? Effect.void : executeStatements(rows.map(metricStmt)),
    writeSpans: (rows) =>
        rows.length === 0 ? Effect.void : executeStatements(rows.map(spanStmt)),
});
```

Note: confirm the exact helper names in `@ax/lib/shared/surql` (the Explore report cited `surrealDate`, `surrealString`, and a JSON/option variant). If `surrealStringOption` is named differently (e.g. `surrealStringOrNone`), use the real export and keep the same call sites. The test asserts substrings, so any helper producing `s"..."` / `d"..."` / `NONE` passes.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test apps/axctl/src/otel/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/otel/writer.ts apps/axctl/src/otel/writer.test.ts
git commit -m "feat(otel): OtelWriter service (idempotent UPSERT)"
```

---

## Task 6: Contract endpoints - POST /v1/metrics, /v1/traces, /v1/logs

**Files:**
- Modify: `packages/lib/src/shared/api-contract.ts` (add `OtelGroup`, add to `AxApi`)
- Create: `apps/axctl/src/dashboard/contract/otel.ts` (`OtelGroupLive`)
- Modify: `apps/axctl/src/dashboard/contract/web-handler.ts` (CONTRACT_ROUTES + Layer.provide)
- Test: `apps/axctl/src/dashboard/contract/otel.test.ts`

OTLP exporters POST to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics` etc, so paths are `/v1/metrics`, `/v1/traces`, `/v1/logs` (NOT under `/api/`). The handler reads the raw body (gzip-aware) from `HttpServerRequest`, `JSON.parse`s, decodes, normalizes, writes - fail-open (always 2xx once reachable, to avoid exporter retry storms).

- [ ] **Step 1: Add OtelGroup to api-contract.ts**

After the other groups, before `AxApi`:

```ts
/** OTLP/HTTP receiver. Bodies are raw OTLP-JSON; handlers parse them from
 *  HttpServerRequest, so the success schema is just an ack. */
export const OtlpAck = Schema.Struct({ partialSuccess: Schema.optional(Schema.Struct({})) });

export const OtelGroup = HttpApiGroup.make("otel")
    .add(HttpApiEndpoint.post("otlpMetrics", "/v1/metrics", { success: OtlpAck, error: InternalError }))
    .add(HttpApiEndpoint.post("otlpTraces", "/v1/traces", { success: OtlpAck, error: InternalError }))
    .add(HttpApiEndpoint.post("otlpLogs", "/v1/logs", { success: OtlpAck, error: InternalError }));
```

Add to the `AxApi` builder chain:

```ts
export const AxApi = HttpApi.make("ax")
    .add(SystemGroup)
    .add(InsightsGroup)
    .add(SessionsGroup)
    .add(SkillsGroup)
    .add(ImproveGroup)
    .add(LiveGroup)
    .add(OtelGroup)                       // <-- new
    .annotate(OpenApi.Title, "ax daemon API");
```

(`InternalError` already exists in this file; reuse it.)

- [ ] **Step 2: Write the failing handler test**

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { handleOtlp } from "./otel.ts";

const captured: string[] = [];
const stubDb = Layer.succeed(SurrealClient, {
    query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
} as never);

const ccMetrics = JSON.stringify({
    resourceMetrics: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeMetrics: [{ metrics: [{
            name: "claude_code.cost.usage", unit: "USD",
            sum: { dataPoints: [{ asDouble: 0.5, timeUnixNano: "1718409600000000000",
                attributes: [{ key: "session.id", value: { stringValue: "s1" } }] }] },
        }] }],
    }],
});

describe("handleOtlp", () => {
    test("metrics body → writer UPSERT, returns ack", async () => {
        captured.length = 0;
        const ack = await Effect.runPromise(
            handleOtlp("metrics", new TextEncoder().encode(ccMetrics).buffer, undefined)
                .pipe(Effect.provide(stubDb)),
        );
        expect(captured.join("\n")).toContain("UPSERT otel_metric_point:");
        expect(ack).toEqual({ partialSuccess: {} });
    });

    test("malformed JSON → ack, no write (fail-open)", async () => {
        captured.length = 0;
        const ack = await Effect.runPromise(
            handleOtlp("metrics", new TextEncoder().encode("not json").buffer, undefined)
                .pipe(Effect.provide(stubDb)),
        );
        expect(captured).toHaveLength(0);
        expect(ack).toEqual({ partialSuccess: {} });
    });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `bun test apps/axctl/src/dashboard/contract/otel.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 4: Implement otel.ts**

```ts
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest } from "effect/unstable/http";
import { AxApi } from "@ax/lib/shared/api-contract";
import { OtelWriter, OtelWriterLive } from "../../otel/writer.ts";
import { decodeMetricsPayload, decodeTracePayload } from "../../otel/decode.ts";
import { normalizeMetrics, normalizeTrace } from "../../otel/normalize.ts";

type Signal = "metrics" | "traces" | "logs";

/** Gunzip if needed, JSON.parse, decode, normalize, write. Fail-open:
 *  any decode/parse failure is swallowed (logged) and still ack'd, so
 *  OTLP exporters never see a non-2xx and never retry-storm on shape drift. */
export const handleOtlp = (signal: Signal, body: ArrayBuffer, contentEncoding: string | undefined) =>
    Effect.gen(function* () {
        if (signal === "logs") return { partialSuccess: {} } as const;

        const bytes = new Uint8Array(body);
        const raw = contentEncoding === "gzip" ? Bun.gunzipSync(bytes) : bytes;
        const json = yield* Effect.try(() => JSON.parse(new TextDecoder().decode(raw))).pipe(
            Effect.catchAll((e) => Effect.logWarning(`otlp ${signal} parse failed: ${e}`).pipe(Effect.as(null))),
        );
        if (json === null) return { partialSuccess: {} } as const;

        const writer = yield* OtelWriter;
        if (signal === "metrics") {
            const payload = yield* decodeMetricsPayload(json).pipe(
                Effect.catchAll((e) => Effect.logWarning(`otlp metrics decode: ${e}`).pipe(Effect.as(null))),
            );
            if (payload) yield* writer.writeMetrics(normalizeMetrics(payload));
        } else {
            const payload = yield* decodeTracePayload(json).pipe(
                Effect.catchAll((e) => Effect.logWarning(`otlp traces decode: ${e}`).pipe(Effect.as(null))),
            );
            if (payload) yield* writer.writeSpans(normalizeTrace(payload));
        }
        return { partialSuccess: {} } as const;
    }).pipe(Effect.provide(OtelWriterLive));

const bodyHandler = (signal: Signal) =>
    Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* req.arrayBuffer;
        const enc = req.headers["content-encoding"];
        return yield* handleOtlp(signal, body, enc);
    });

export const OtelGroupLive = HttpApiBuilder.group(AxApi, "otel", (handlers) =>
    handlers
        .handle("otlpMetrics", () => bodyHandler("metrics"))
        .handle("otlpTraces", () => bodyHandler("traces"))
        .handle("otlpLogs", () => bodyHandler("logs")));
```

Note: confirm the `HttpServerRequest` import path and the `arrayBuffer`/`headers` accessors against `effect/unstable/http` (consult `effect-solutions show cli` / search `.references/effect-smol` for `HttpServerRequest`). The `handleOtlp` function is independently tested and does not depend on the HTTP layer, so the test passes regardless; only `bodyHandler` wiring needs the real request API.

- [ ] **Step 5: Register routes in web-handler.ts**

Add to `CONTRACT_ROUTES`:

```ts
    // otlp receiver
    "POST /v1/metrics",
    "POST /v1/traces",
    "POST /v1/logs",
```

Add `OtelGroupLive` to the `Layer.provide([...])` group list (import it at top):

```ts
import { OtelGroupLive } from "./otel.ts";
// ...
        Layer.provide([
            SystemGroupLive,
            InsightsGroupLive,
            SessionsGroupLive,
            SkillsGroupLive,
            ImproveGroupLive,
            LiveGroupLive,
            OtelGroupLive,
        ]),
```

- [ ] **Step 6: Run tests, expect PASS**

Run: `bun test apps/axctl/src/dashboard/contract/otel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add packages/lib/src/shared/api-contract.ts apps/axctl/src/dashboard/contract/otel.ts apps/axctl/src/dashboard/contract/otel.test.ts apps/axctl/src/dashboard/contract/web-handler.ts
git commit -m "feat(otel): POST /v1/{metrics,traces,logs} receiver endpoints"
```

---

## Task 7: Correlation pass + ingest wiring

**Files:**
- Create: `apps/axctl/src/otel/correlate.ts`
- Test: `apps/axctl/src/otel/correlate.test.ts`
- Modify: `apps/axctl/src/cli/index.ts` (`withIngest` - call after ingest completes)

Correlation runs over ALL orphan otel rows (no per-session-write coupling): find `otel_*` rows whose `session_id` matches an existing `session` and that have no `telemetry_of` edge yet, then RELATE them. Idempotent - safe under the re-ingest watcher race.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { correlateOrphanOtel } from "./correlate.ts";

const sql: string[] = [];
const stubDb = Layer.succeed(SurrealClient, {
    query: <T>(q: string) => {
        sql.push(q);
        // First query returns orphan rows to link; RELATE returns empty.
        if (/SELECT.*otel_metric_point/.test(q)) {
            return Effect.succeed([[{ id: "otel_metric_point:m1", session_id: "s1" }]] as unknown as T);
        }
        if (/SELECT.*otel_span/.test(q)) return Effect.succeed([[]] as unknown as T);
        return Effect.succeed([[]] as unknown as T);
    },
} as never);

describe("correlateOrphanOtel", () => {
    test("RELATEs an orphan metric row to its session", async () => {
        sql.length = 0;
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(stubDb)));
        const all = sql.join("\n");
        expect(all).toContain("RELATE session:");
        expect(all).toContain("->telemetry_of->otel_metric_point:");
    });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/axctl/src/otel/correlate.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement correlate.ts**

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { executeStatements } from "@ax/lib/shared/surreal";

interface Orphan { readonly id: string; readonly session_id: string }

const RELATABLE = ["otel_metric_point", "otel_span"] as const;

/** Link every otel row whose session_id matches a session and that has no
 *  telemetry_of edge yet. Runs at ingest finish; idempotent. */
export const correlateOrphanOtel = () =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const stmts: string[] = [];
        for (const table of RELATABLE) {
            // Orphan = has session_id, that session exists, no inbound telemetry_of.
            const q =
                `SELECT id, session_id FROM ${table} ` +
                `WHERE session_id != NONE ` +
                `AND type::thing("session", session_id) IN (SELECT VALUE id FROM session) ` +
                `AND count(<-telemetry_of) = 0;`;
            const res = yield* db.query<Orphan[][]>(q);
            const orphans = res[0] ?? [];
            for (const o of orphans) {
                const recId = o.id.includes(":") ? o.id.split(":").slice(1).join(":") : o.id;
                stmts.push(
                    `RELATE session:\`${o.session_id}\`->telemetry_of->${table}:\`${recId.replace(/`/g, "")}\`;`,
                );
            }
        }
        if (stmts.length > 0) yield* executeStatements(stmts);
    });
```

Note: verify the SurrealDB v3 syntax for "session exists" and "no inbound edge" against a live DB during the integration check (Step 5). If `count(<-telemetry_of)` is rejected, fall back to `WHERE id NOTINSIDE (SELECT VALUE out FROM telemetry_of)`. The test asserts on the RELATE output, which is independent of the SELECT dialect.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test apps/axctl/src/otel/correlate.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into ingest finish**

In `apps/axctl/src/cli/index.ts`, find `withIngest` (the ingest command gate). After the ingest run completes successfully, run correlation (best-effort, never fails the ingest):

```ts
import { correlateOrphanOtel } from "../otel/correlate.ts";
// ... after the ingest effect succeeds, within the same SurrealClient scope:
yield* correlateOrphanOtel().pipe(Effect.catchAll(() => Effect.void));
```

If `withIngest` is not an `Effect.gen`, adapt: append `.pipe(Effect.tap(() => correlateOrphanOtel().pipe(Effect.catchAll(() => Effect.void))))` to the ingest effect. Confirm `SurrealClient` is in scope at that point (it is - ingest writes to the DB).

- [ ] **Step 6: Run the otel suite + typecheck**

Run: `bun test apps/axctl/src/otel/ && bun run typecheck`
Expected: PASS, no new type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/axctl/src/otel/correlate.ts apps/axctl/src/otel/correlate.test.ts apps/axctl/src/cli/index.ts
git commit -m "feat(otel): orphan→session correlation at ingest finish"
```

---

## Task 8: Provider name + version/capabilities advertise

**Files:**
- Modify: `apps/axctl/src/ingest/provider-events.ts:18` (add `"otel"`)
- Modify: `apps/axctl/src/dashboard/capabilities.ts` (add `"otlp"` capability)
- Modify: version payload source (`/api/version`) to include `otlp_receiver: true`
- Test: existing capability/version tests; add an assertion

- [ ] **Step 1: Extend AgentProviderName**

```ts
export type AgentProviderName = "claude" | "codex" | "pi" | "opencode" | "cursor" | "otel";
```

- [ ] **Step 2: Add the capability + version flag**

In `capabilities.ts`, add `"otlp"` to the capabilities list (mirrors how `"ingest"` is listed at line 33). In the `/api/version` payload (search for `live_ingest` in the contract `system.ts` / version source), add a sibling boolean:

```ts
otlp_receiver: true,
```

Unlike `live_ingest`, the OTLP receiver is pure HTTP/JSON/Surreal with no native dep, so it is `true` in BOTH source and compiled-binary runs.

- [ ] **Step 3: Update/extend the version test**

Find the test asserting the `/api/version` shape (`server.test.ts:122` or `system.test.ts`) and add:

```ts
expect(body.otlp_receiver).toBe(true);
```

- [ ] **Step 4: Run, expect PASS**

Run: `bun test apps/axctl/src/dashboard/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/ingest/provider-events.ts apps/axctl/src/dashboard/capabilities.ts apps/axctl/src/dashboard/contract/system.ts apps/axctl/src/dashboard/server.test.ts
git commit -m "feat(otel): advertise otlp_receiver capability + otel provider"
```

---

## Task 9: ax install - harness telemetry config writes

**Files:**
- Modify: install flow (`apps/axctl/src/.../install.ts`) + a new helper `apps/axctl/src/otel/install-config.ts`
- Test: `apps/axctl/src/otel/install-config.test.ts`

Write Claude Code `settings.json` env + Codex `config.toml` `[otel]`, idempotent, ax-ownership-marked. Reuse the settings-path resolver from `hooks/providers/claude.ts` (global scope = `~/.claude/settings.json`).

- [ ] **Step 1: Write the failing test (pure transform, no FS)**

```ts
import { describe, expect, test } from "bun:test";
import { applyClaudeOtelEnv, applyCodexOtelToml } from "./install-config.ts";

const ENDPOINT = "http://127.0.0.1:1738";

describe("install-config", () => {
    test("adds CC telemetry env to empty settings", () => {
        const next = applyClaudeOtelEnv({}, ENDPOINT);
        expect(next.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
        expect(next.env.OTEL_METRICS_EXPORTER).toBe("otlp");
        expect(next.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
        expect(next.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(ENDPOINT);
    });

    test("is idempotent - re-apply yields equal object", () => {
        const once = applyClaudeOtelEnv({}, ENDPOINT);
        const twice = applyClaudeOtelEnv(once, ENDPOINT);
        expect(twice).toEqual(once);
    });

    test("preserves unrelated existing env", () => {
        const next = applyClaudeOtelEnv({ env: { FOO: "bar" } }, ENDPOINT);
        expect(next.env.FOO).toBe("bar");
    });

    test("codex toml gains an [otel] block with the endpoint", () => {
        const toml = applyCodexOtelToml("", ENDPOINT);
        expect(toml).toContain("[otel]");
        expect(toml).toContain(ENDPOINT);
        expect(toml).toContain("http/json");
    });

    test("codex toml is idempotent", () => {
        const once = applyCodexOtelToml("", ENDPOINT);
        expect(applyCodexOtelToml(once, ENDPOINT)).toBe(once);
    });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test apps/axctl/src/otel/install-config.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement install-config.ts**

```ts
interface ClaudeSettings { env?: Record<string, string>; [k: string]: unknown }

const CC_ENV = (endpoint: string): Record<string, string> => ({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
});

/** Merge ax's telemetry env into Claude settings, preserving everything else. */
export const applyClaudeOtelEnv = (settings: ClaudeSettings, endpoint: string): ClaudeSettings & { env: Record<string, string> } => {
    const env = { ...(settings.env ?? {}), ...CC_ENV(endpoint) };
    return { ...settings, env };
};

const CODEX_MARKER = "# ax:otel";
const codexBlock = (endpoint: string): string =>
    `${CODEX_MARKER}\n[otel]\nexporter = "otlp-http"\nendpoint = "${endpoint}"\nprotocol = "http/json"\n`;

/** Append/replace the ax-owned [otel] block in codex config.toml. */
export const applyCodexOtelToml = (toml: string, endpoint: string): string => {
    const block = codexBlock(endpoint);
    if (toml.includes(block.trim())) return toml;             // already exact → idempotent
    // Strip any prior ax-owned block, then append fresh.
    const stripped = toml.replace(new RegExp(`${CODEX_MARKER}[\\s\\S]*?(?=\\n\\[|$)`, "g"), "").trimEnd();
    return (stripped ? `${stripped}\n\n` : "") + block;
};
```

Verify the Codex `[otel]` key names (`exporter`/`endpoint`/`protocol`) against the Codex docs during integration; the test only asserts presence of `[otel]`, the endpoint, and `http/json`, so naming refinements stay green.

- [ ] **Step 4: Run, expect PASS**

Run: `bun test apps/axctl/src/otel/install-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into install**

In the install flow, after the hooks fan-out, read+merge+write the two config files using the existing FS helpers (`fs.writeFileString` / atomic writer) and the claude settings-path resolver. Read existing JSON (default `{}`), `applyClaudeOtelEnv`, write back pretty JSON; read existing codex `~/.codex/config.toml` (default `""`), `applyCodexOtelToml`, write back. Print what was written (absolute paths). Guard behind the normal install (no extra flag - this is the chip-win default), but skip silently if the target dir does not exist (harness not installed).

- [ ] **Step 6: Run install-related tests + typecheck**

Run: `bun test apps/axctl/src/otel/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/axctl/src/otel/install-config.ts apps/axctl/src/otel/install-config.test.ts apps/axctl/src/**/install.ts
git commit -m "feat(otel): ax install writes harness OTLP telemetry config"
```

---

## Task 10: Integration smoke + docs

**Files:**
- Create: `apps/axctl/src/otel/integration.test.ts` (optional, gated)
- Modify: `CLAUDE.md` (document the receiver - new-surface docs gate)

- [ ] **Step 1: End-to-end smoke against a live daemon (manual/integration)**

Boot the daemon, POST a fixture, assert a row landed:

```bash
# terminal A
bun apps/axctl/bin/axctl serve --port=1738
# terminal B
curl -sS -X POST http://127.0.0.1:1738/v1/metrics \
  -H 'content-type: application/json' \
  -d '{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}]},"scopeMetrics":[{"metrics":[{"name":"claude_code.cost.usage","unit":"USD","sum":{"dataPoints":[{"asDouble":0.5,"timeUnixNano":"1718409600000000000","attributes":[{"key":"session.id","value":{"stringValue":"smoke1"}}]}]}}]}]}]}'
# expect: {"partialSuccess":{}}
bun apps/axctl/bin/axctl query "SELECT * FROM otel_metric_point WHERE session_id = 'smoke1'"
# expect: one row, value 0.5, harness 'claude'
```

Document the result in the PR description (evidence before assertions).

- [ ] **Step 2: Document in CLAUDE.md**

Add a subsection under Reactivity / a new "OTLP receiver" heading:

```md
### OTLP receiver (ax serve)

`ax serve` accepts harness OTLP/JSON telemetry on the daemon port:
`POST /v1/metrics` (Claude Code usage metrics) + `POST /v1/traces` (Codex
spans); `/v1/logs` is accepted and dropped (v1 no-op). Bodies land in
`otel_metric_point` / `otel_span`; a correlation pass at ingest finish draws
`session -> telemetry_of -> otel_*` edges by `session.id`. OTLP cost is stored
separately from file-parsed cost (no double-count). `ax install` writes the
harness telemetry config (`CLAUDE_CODE_ENABLE_TELEMETRY`, OTLP endpoint→1738,
`http/json`; Codex `[otel]`). Works in the compiled binary (no native dep).
Module: `apps/axctl/src/otel/`. Spec:
docs/superpowers/specs/2026-06-15-otel-receiver-design.md.
```

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md apps/axctl/src/otel/integration.test.ts
git commit -m "docs(otel): document OTLP receiver + smoke test"
```

---

## Verification (whole-plan)

- [ ] `bun test` repo-wide green.
- [ ] `bun run typecheck` clean.
- [ ] Manual smoke (Task 10 Step 1) lands a row and ack returns `{partialSuccess:{}}`.
- [ ] `SCHEMA_TABLES` mirror test green (Task 1).
- [ ] No file-parsed cost double-counted: OTLP cost only in `otel_metric_point`, never summed into `session`/cost queries.

## Open items to verify during build (from spec risks)

1. Real captured OTLP/JSON from CC (`OTEL_METRICS_EXPORTER=otlp` + `http/json`) and Codex - replace synthetic fixtures in Tasks 3/4 with captures if shapes differ (especially CC `sum` vs `gauge`, Codex attr key for session id).
2. `HttpServerRequest` raw-body + header API in `effect/unstable/http` (Task 6 Step 4).
3. SurrealDB v3 dialect for the correlation SELECT (Task 7 Step 3).
4. `@ax/lib/shared/surql` exact helper export names (Task 5 Step 3).
5. Codex `[otel]` exact key names (Task 9 Step 3).
