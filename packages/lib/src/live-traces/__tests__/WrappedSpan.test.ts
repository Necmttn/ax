/**
 * WrappedSpan unit tests.
 *
 * Regression guard for NICE-TO-HAVE #11: `WrappedSpan.end()` used to read
 * `inner.status.startTime` AFTER calling `inner.end(...)`. Native Effect
 * spans synchronously transition `status` from `Started -> Ended` during
 * `end()`, but non-native spans (e.g. OTel-bridged) may leave `status` in
 * `Started` -- which made the old code fall back to `BigInt(0)` and produce
 * a nonsense ~1.7e15ms duration. We now snapshot `startTime` at
 * construction so `end()` no longer depends on post-end status mutation.
 */
import { describe, expect, it } from "bun:test";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { Span, SpanKind, SpanStatus } from "effect/Tracer";

import type { TraceSinkHandle } from "../Sink.ts";
import type { TraceEvent } from "../types.ts";
import { WrappedSpan } from "../WrappedSpan.ts";

/** Build a fake inner span whose `end()` does NOT mutate `status`. */
const makeFrozenInnerSpan = (startTimeNs: bigint): Span => {
    const status: SpanStatus = { _tag: "Started", startTime: startTimeNs };
    const inner: Span = {
        _tag: "Span",
        name: "fake",
        spanId: "span-frozen-1",
        traceId: "trace-frozen-1",
        parent: Option.none(),
        annotations: Context.empty(),
        // `status` getter intentionally returns the same `Started` object even
        // after `end()` is called -- this is the OTel-bridge regression case.
        status,
        attributes: new Map(),
        links: [],
        sampled: true,
        kind: "internal" as SpanKind,
        attribute: () => {},
        event: () => {},
        end: () => {
            // No-op: deliberately do NOT transition status to Ended.
        },
        addLinks: () => {},
    };
    return inner;
};

const collectingSink = (): { sink: TraceSinkHandle; events: TraceEvent[] } => {
    const events: TraceEvent[] = [];
    return {
        sink: { emit: (event) => { events.push(event); } },
        events,
    };
};

describe("WrappedSpan.end (regression: NICE-TO-HAVE #11)", () => {
    it("computes durationMs from constructor-snapshotted startTime when inner.status never transitions to Ended", () => {
        // Pick a recent realistic startTime in nanoseconds (Date.now() * 1e6).
        const nowMs = Date.now();
        const startNs = BigInt(nowMs) * 1_000_000n;
        const endNs = startNs + 42_000_000n; // +42ms

        const inner = makeFrozenInnerSpan(startNs);
        const { sink, events } = collectingSink();

        const wrapped = new WrappedSpan(inner, sink, "trace:test-11", { type: "user", id: "u1" });

        // Sanity: inner.status is still Started before end() too.
        expect(inner.status._tag).toBe("Started");

        wrapped.end(endNs, Exit.succeed(undefined));

        // Inner span deliberately did NOT mutate to Ended -- if `end()` still
        // reads `inner.status` post-end, we'd see status._tag === "Started"
        // here AND the old code path returning startTime = 0n.
        expect(inner.status._tag).toBe("Started");

        const spanEnd = events.find((e): e is Extract<TraceEvent, { _tag: "SpanEnd" }> => e._tag === "SpanEnd");
        expect(spanEnd).toBeDefined();
        expect(spanEnd!.status).toBe("ok");

        // Should be exactly 42ms (within float epsilon), NOT ~1.7e15ms.
        expect(spanEnd!.durationMs).toBeCloseTo(42, 5);
        expect(spanEnd!.durationMs).toBeLessThan(1_000); // sanity ceiling
    });

    it("still emits error status on failed Exit", () => {
        const startNs = BigInt(Date.now()) * 1_000_000n;
        const endNs = startNs + 5_000_000n; // +5ms

        const inner = makeFrozenInnerSpan(startNs);
        const { sink, events } = collectingSink();
        const wrapped = new WrappedSpan(inner, sink, "trace:test-11-err", { type: "user", id: "u1" });

        wrapped.end(endNs, Exit.fail("boom"));

        const spanEnd = events.find((e): e is Extract<TraceEvent, { _tag: "SpanEnd" }> => e._tag === "SpanEnd");
        expect(spanEnd).toBeDefined();
        expect(spanEnd!.status).toBe("error");
        expect(spanEnd!.durationMs).toBeCloseTo(5, 5);
    });
});
