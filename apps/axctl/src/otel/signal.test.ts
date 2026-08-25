import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
    harnessOf,
    harnessFromResource,
    walkResources,
    decodeSignal,
} from "./signal.ts";
import { MetricsPayload } from "./otlp-schema.ts";
import { metricPointKey, spanKey, logEventKey, type OtelMetricPointRow, type OtelSpanRow } from "./rows.ts";
import { normalizeLogs } from "./normalize.ts";
import { SIGNALS } from "./signals.ts";
import { handleOtlp } from "../dashboard/contract/otel.ts";
import { FixturePlatform } from "@ax/lib/testing/cache-fixture";

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

    test("FIXED (#1011): metricPointKey now discriminates agent_name too", () => {
        // Previously a PRE-EXISTING gap (rows.ts:36): two points identical except
        // agent_name collapsed to ONE record id. metricPointKey now folds
        // agent_name (and the full canonicalized attrs blob) into the key, so
        // distinct agents no longer alias.
        expect(metricPointKey(metricRow({ agent_name: "a" }))).not.toBe(metricPointKey(metricRow({ agent_name: "b" })));
        // value/unit are STILL not part of the key (the measurement, not identity) -
        // this remains intentional, not a gap.
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
    test("dispatch keys cover exactly the 3 signals", () => {
        expect(Object.keys(SIGNALS).sort()).toEqual(["logs", "metrics", "traces"]);
    });

    test("each signal maps to its DuckDB table and writer function", () => {
        expect(Object.values(SIGNALS).map((spec) => spec.table).sort()).toEqual([
            "otel_log_event", "otel_metric_point", "otel_span",
        ]);
        for (const spec of Object.values(SIGNALS)) expect(typeof spec.write).toBe("function");
    });
});

// =================================================== malformed-gzip fail-open

describe("malformed-gzip path (gunzip is OUTSIDE the JSON-parse fail-open try)", () => {
    test("gzip-flagged non-gzip body does not write; characterizes current behavior", async () => {
        const notGzip = new TextEncoder().encode("not gzip at all");
        const buf = notGzip.buffer.slice(notGzip.byteOffset, notGzip.byteOffset + notGzip.byteLength) as ArrayBuffer;
        const exit = await Effect.runPromiseExit(
            handleOtlp("metrics", buf, "gzip").pipe(Effect.provide(FixturePlatform)),
        );
        // CHARACTERIZATION: gunzip throws OUTSIDE the fail-open try, so it surfaces
        // as a defect (NOT the ACK fail-open the JSON/decode paths give). Pinned so
        // the registry refactor cannot silently change it; gap documented in the PR.
        expect(Exit.isFailure(exit)).toBe(true);
    });
});
