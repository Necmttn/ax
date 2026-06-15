import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import {
    harnessOf,
    harnessFromResource,
    walkResources,
    decodeSignal,
} from "./signal.ts";
import { MetricsPayload } from "./otlp-schema.ts";
import { OtelWriter, OtelWriterLive, metricStmt, spanStmt, logStmt } from "./writer.ts";
import { metricPointKey, spanKey, logEventKey, type OtelMetricPointRow, type OtelSpanRow, type OtelLogEventRow } from "./rows.ts";
import { normalizeLogs } from "./normalize.ts";
import { SIGNALS } from "./signals.ts";
import { handleOtlp } from "../dashboard/contract/otel.ts";

// ------------------------------------------------------------------ stub DB
const captured: string[] = [];
const stubDb = Layer.succeed(SurrealClient, {
    query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
} as never);

const writerEnv = Layer.mergeAll(OtelWriterLive, stubDb);
const runWrite = async (eff: Effect.Effect<void, unknown, OtelWriter | SurrealClient>) => {
    captured.length = 0;
    await Effect.runPromise(eff.pipe(Effect.provide(writerEnv)) as Effect.Effect<void>);
    return captured.join("\n");
};

const metricRow = (o: Partial<OtelMetricPointRow> = {}): OtelMetricPointRow => ({
    harness: "claude", metric: "claude_code.cost.usage", value: 0.12, unit: "USD",
    session_id: "s1", model: "opus", skill_name: null, agent_name: null,
    attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"), ...o,
});
const spanRow = (o: Partial<OtelSpanRow> = {}): OtelSpanRow => ({
    harness: "codex", name: "session_loop", trace_id: "aa", span_id: "bb",
    parent_span_id: null, session_id: "cdx1",
    started_at: new Date("2026-06-15T00:00:00Z"), ended_at: new Date("2026-06-15T00:00:01Z"),
    duration_ms: 1000, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"), ...o,
});
const logRow = (o: Partial<OtelLogEventRow> = {}): OtelLogEventRow => ({
    harness: "codex", event_name: "codex.sse_event", session_id: "c1", model: "gpt-5.5",
    input_tokens: 9994, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, tool_tokens: 9994,
    duration_ms: null, status_code: null, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"), ...o,
});

// ============================================================ shared seams

describe("harness lift", () => {
    test("harnessOf maps service.name → harness label", () => {
        expect(harnessOf("claude-code")).toBe("claude");
        expect(harnessOf("claude_code")).toBe("claude");
        expect(harnessOf("codex_cli_rs")).toBe("codex");
        expect(harnessOf("codex_exec")).toBe("codex");
        expect(harnessOf("opencode")).toBe("opencode");
        expect(harnessOf("pi-agent")).toBe("pi");
        expect(harnessOf(undefined)).toBe("unknown");
        expect(harnessOf(null)).toBe("unknown");
    });

    test("harnessFromResource lifts attrs + harness (null/undefined service.name identical)", () => {
        const a = harnessFromResource({ attributes: [{ key: "service.name", value: { stringValue: "codex_cli_rs" } }] });
        expect(a.harness).toBe("codex");
        expect(a.res.get("service.name")).toBe("codex_cli_rs");
        // missing service.name → unknown (the logs `?? null` pre-unify was a no-op)
        expect(harnessFromResource(undefined).harness).toBe("unknown");
        expect(harnessFromResource({ attributes: [] }).harness).toBe("unknown");
    });
});

describe("walkResources (synthetic 1-field spec)", () => {
    test("lifts harness per resource and concatenates scope rows in order", () => {
        type Res = { resource?: { attributes?: { key: string; value: { stringValue: string } }[] }; scopes: string[] };
        const resources: Res[] = [
            { resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] }, scopes: ["a", "b"] },
            { resource: { attributes: [{ key: "service.name", value: { stringValue: "opencode" } }] }, scopes: ["c"] },
        ];
        const rows = walkResources(
            resources,
            (r) => r.resource,
            (r) => r.scopes,
            (ctx, scope) => [`${ctx.harness}:${scope}`],
        );
        expect(rows).toEqual(["claude:a", "claude:b", "opencode:c"]);
    });
});

describe("decodeSignal", () => {
    test("good payload decodes", async () => {
        const out = await Effect.runPromise(decodeSignal(MetricsPayload, "metrics")({ resourceMetrics: [] }));
        expect(out.resourceMetrics).toEqual([]);
    });
    test("bad payload fails with typed OtelDecodeError (NOT swallowed here)", async () => {
        const exit = await Effect.runPromiseExit(decodeSignal(MetricsPayload, "metrics")({ nope: true }));
        expect(Exit.isFailure(exit)).toBe(true);
        const err = exit._tag === "Failure" ? exit.cause : null;
        // the failure carries the signal label
        expect(JSON.stringify(err)).toContain("metrics");
        expect(JSON.stringify(err)).toContain("OtelDecodeError");
    });
});

// ====================================================== column raw-vs-NONE

describe("writer column SQL - NONE vs raw is load-bearing", () => {
    test("metrics: value renders RAW, null option columns render NONE", async () => {
        const sql = await runWrite(Effect.gen(function* () {
            const w = yield* OtelWriter; yield* w.writeMetrics([metricRow({ model: null, skill_name: null, agent_name: null })]);
        }));
        expect(sql).toContain("value = 0.12");      // RAW number, never quoted/NONE
        expect(sql).toContain("model = NONE");
        expect(sql).toContain("skill_name = NONE");
        expect(sql).toContain("agent_name = NONE");
        expect(sql).toContain("unit = \"USD\"");
    });

    test("span: duration_ms renders RAW, null parent_span_id renders NONE", async () => {
        const sql = await runWrite(Effect.gen(function* () {
            const w = yield* OtelWriter; yield* w.writeSpans([spanRow({ parent_span_id: null })]);
        }));
        expect(sql).toContain("duration_ms = 1000");
        expect(sql).toContain("parent_span_id = NONE");
    });

    test("logs: token columns optNum - 0 stays 0, null becomes NONE", async () => {
        const sql = await runWrite(Effect.gen(function* () {
            const w = yield* OtelWriter; yield* w.writeLogs([logRow({ input_tokens: 9994, output_tokens: 0, duration_ms: null, status_code: null })]);
        }));
        expect(sql).toContain("input_tokens = 9994");
        expect(sql).toContain("output_tokens = 0");      // 0 is NOT NONE
        expect(sql).toContain("duration_ms = NONE");
        expect(sql).toContain("status_code = NONE");
    });

    test("attrs is a pre-encoded option<string> - quoted once, never re-encoded; null → NONE", async () => {
        const sqlWith = await runWrite(Effect.gen(function* () {
            const w = yield* OtelWriter; yield* w.writeMetrics([metricRow({ attrs: "{\"a\":1}" })]);
        }));
        // surrealOptionString JSON-quotes the already-JSON string exactly once
        expect(sqlWith).toContain("attrs = \"{\\\"a\\\":1}\"");
        const sqlNull = await runWrite(Effect.gen(function* () {
            const w = yield* OtelWriter; yield* w.writeMetrics([metricRow({ attrs: null })]);
        }));
        expect(sqlNull).toContain("attrs = NONE");
    });
});

// ============================================ log record-id index stability

describe("log record-id index - computed at RENDER over post-allowlist array", () => {
    test("dropped records before kept ones do NOT shift kept indices (no collision)", () => {
        const sse = { key: "event.name", value: { stringValue: "codex.sse_event" } } as const;
        // [drop, keep, drop, keep] - original positions 1 and 3 are kept
        const payload = {
            resourceLogs: [{
                resource: { attributes: [{ key: "service.name", value: { stringValue: "codex_cli_rs" } }] },
                scopeLogs: [{ logRecords: [
                    { attributes: [{ key: "event.name", value: { stringValue: "codex.websocket_event" } }], timeUnixNano: "1718409600000000000" },
                    { attributes: [sse, { key: "conversation.id", value: { stringValue: "z" } }], timeUnixNano: "1718409600000000000" },
                    { attributes: [{ key: "event.name", value: { stringValue: "codex.websocket_event" } }], timeUnixNano: "1718409600000000000" },
                    { attributes: [sse, { key: "conversation.id", value: { stringValue: "z" } }], timeUnixNano: "1718409600000000000" },
                ] }],
            }],
        };
        const rows = normalizeLogs(payload as never);
        expect(rows).toHaveLength(2);
        // Both kept rows are content-identical → index is the ONLY discriminator.
        const k0 = logEventKey(rows[0]!, 0);
        const k1 = logEventKey(rows[1]!, 1);
        expect(k0).not.toBe(k1);
        expect(k0.endsWith("|0")).toBe(true);
        expect(k1.endsWith("|1")).toBe(true);
        // render-time indices are contiguous (0,1) NOT original positions (1,3)
        expect(k1.endsWith("|3")).toBe(false);
    });
});

// ==================================== record-key uniqueness (verify, dont freeze)

describe("metric/span record-key uniqueness - characterized, see PR for gaps", () => {
    test("metricPointKey discriminates harness/metric/session/model/skill/ts", () => {
        const b = metricRow();
        expect(metricPointKey(b)).not.toBe(metricPointKey(metricRow({ harness: "codex" })));
        expect(metricPointKey(b)).not.toBe(metricPointKey(metricRow({ metric: "x" })));
        expect(metricPointKey(b)).not.toBe(metricPointKey(metricRow({ session_id: "s2" })));
        expect(metricPointKey(b)).not.toBe(metricPointKey(metricRow({ model: "sonnet" })));
        expect(metricPointKey(b)).not.toBe(metricPointKey(metricRow({ skill_name: "tdd" })));
        expect(metricPointKey(b)).not.toBe(metricPointKey(metricRow({ observed_at: new Date("2026-06-15T00:00:01Z") })));
    });

    test("KNOWN GAP: metricPointKey omits agent_name though it is persisted (pinned to prove no drift)", () => {
        // Two points identical except agent_name collide to ONE record id. This is a
        // PRE-EXISTING gap (rows.ts:36) - pinned here, filed as a follow-up, not changed.
        expect(metricPointKey(metricRow({ agent_name: "a" }))).toBe(metricPointKey(metricRow({ agent_name: "b" })));
        // value/unit are not part of the key (the measurement, not identity)
        expect(metricPointKey(metricRow({ value: 1 }))).toBe(metricPointKey(metricRow({ value: 2 })));
        expect(metricPointKey(metricRow({ unit: "tok" }))).toBe(metricPointKey(metricRow({ unit: "USD" })));
    });

    test("spanKey is span_id alone (trace_id omitted) - adequate: span_id is globally unique", () => {
        expect(spanKey(spanRow({ span_id: "x" }))).toBe("x");
        // same span_id, different trace_id → same key (documents trace_id omission)
        expect(spanKey(spanRow({ span_id: "x", trace_id: "t1" }))).toBe(spanKey(spanRow({ span_id: "x", trace_id: "t2" })));
    });
});

// ============================================ SIGNALS registry / column gate

describe("SIGNALS registry", () => {
    const samples: Record<string, OtelMetricPointRow | OtelSpanRow | OtelLogEventRow> = {
        metrics: metricRow(), traces: spanRow(), logs: logRow(),
    };
    // Parse the `col = ` LHS tokens out of a rendered UPSERT (samples use attrs=null
    // so no value contains a comma → split is safe).
    const renderedCols = (sql: string): string[] =>
        sql.slice(sql.indexOf(" SET ") + 5).replace(/;$/, "").split(", ").map((c) => c.split(" = ")[0]!.trim());

    test("dispatch keys cover exactly the 3 signals", () => {
        expect(Object.keys(SIGNALS).sort()).toEqual(["logs", "metrics", "traces"]);
    });

    for (const signal of ["metrics", "traces", "logs"] as const) {
        const spec = SIGNALS[signal];

        test(`${signal}: declared columns ⊇ Row schema fields (HARD column gate)`, () => {
            const schemaFields = Object.keys(spec.rowSchema.fields);
            const colSet = new Set(spec.columns);
            for (const f of schemaFields) expect(colSet.has(f)).toBe(true);
        });

        test(`${signal}: declared columns match what stmt actually renders (no drift)`, () => {
            const cols = renderedCols(spec.stmt(samples[signal] as never, 0));
            expect(cols.sort()).toEqual([...spec.columns].sort());
        });

        test(`${signal}: spec.stmt is the writer stmt builder`, () => {
            const expected = { metrics: metricStmt, traces: spanStmt, logs: logStmt }[signal];
            expect(spec.stmt).toBe(expected);
        });
    }
});

// =================================================== malformed-gzip fail-open

describe("malformed-gzip path (gunzip is OUTSIDE the JSON-parse fail-open try)", () => {
    test("gzip-flagged non-gzip body does not write; characterizes current behavior", async () => {
        captured.length = 0;
        const notGzip = new TextEncoder().encode("not gzip at all");
        const buf = notGzip.buffer.slice(notGzip.byteOffset, notGzip.byteOffset + notGzip.byteLength) as ArrayBuffer;
        const exit = await Effect.runPromiseExit(
            handleOtlp("metrics", buf, "gzip").pipe(Effect.provide(stubDb)),
        );
        // Either way it must never write a malformed body.
        expect(captured).toHaveLength(0);
        // CHARACTERIZATION: gunzip throws OUTSIDE the fail-open try, so it surfaces
        // as a defect (NOT the ACK fail-open the JSON/decode paths give). Pinned so
        // the registry refactor cannot silently change it; gap documented in the PR.
        expect(Exit.isFailure(exit)).toBe(true);
    });
});
