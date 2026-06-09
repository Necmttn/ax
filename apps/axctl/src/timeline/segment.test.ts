import { describe, expect, it } from "bun:test";
import { buildBoundaries, segmentize } from "./segment.ts";
import type { TimelineEvent } from "./types.ts";

const ev = (kind: TimelineEvent["kind"], seq: number, secs: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
    kind, seq, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, secs)).toISOString(), title: `${kind}-${seq}`, refs: [], ...over,
});

describe("buildBoundaries", () => {
    it("merges asks/commits/compactions ts-sorted with a session_start anchor", () => {
        const bs = buildBoundaries(
            {
                asks: [{ seq: 1, ts: "2026-01-01T00:00:05Z", text: "do the thing" }],
                commits: [{ ts: "2026-01-01T00:00:10Z", sha: "abc1234def", message: "ship it" }],
                compactions: [{ ts: "2026-01-01T00:00:08Z" }],
            },
            "2026-01-01T00:00:00Z",
        );
        expect(bs.map((b) => b.kind)).toEqual(["session_start", "ask", "compaction", "commit"]);
        expect(bs[3]?.label).toContain("abc1234");
    });
});

describe("segmentize", () => {
    it("buckets events into segments and keeps FULL rollup counts", () => {
        const events = [
            ev("tool_call", 1, 1), ev("file_edit", 2, 2, { refs: [{ type: "file", id: "a.ts" }] }),
            ev("failure", 3, 11, { recovered_by_seq: 4 }), ev("tool_call", 4, 12),
        ];
        const { segments } = segmentize(
            events,
            { asks: [{ seq: 3, ts: "2026-01-01T00:00:10Z", text: "fix it" }], commits: [], compactions: [] },
            "2026-01-01T00:00:00Z",
        );
        expect(segments).toHaveLength(2); // session_start + the ask
        expect(segments[0]?.rollup.tool_calls).toBe(1);
        expect(segments[0]?.rollup.file_edits).toBe(1);
        expect(segments[0]?.rollup.files).toBe(1);
        expect(segments[1]?.rollup.failures).toBe(1);
        expect(segments[1]?.rollup.recovered).toBe(1);
        expect(segments[1]?.title).toBe("fix it");
    });

    it("caps kept events per segment but the rollup still reflects everything", () => {
        const events = Array.from({ length: 100 }, (_, i) => ev("tool_call", i, i));
        const { segments, events: kept } = segmentize(
            events, { asks: [], commits: [], compactions: [] }, "2026-01-01T00:00:00Z",
            { perSegmentCap: 10, globalBudget: 1000 },
        );
        expect(segments[0]?.event_count).toBe(100); // full
        expect(kept.length).toBe(10); // capped
        expect(kept.every((e) => e.segment_id === "seg-0")).toBe(true);
    });

    it("hard-caps total segments by sampling structural boundaries", () => {
        const commits = Array.from({ length: 200 }, (_, i) => ({
            ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), sha: `sha${i}`, message: `c${i}`,
        }));
        const events = commits.map((c, i) => ev("checkpoint", i, i));
        const { segments } = segmentize(events, { asks: [], commits, compactions: [] }, "2026-01-01T00:00:00Z", { maxSegments: 30 });
        expect(segments.length).toBeLessThanOrEqual(30);
    });

    it("respects the global budget across segments", () => {
        const asks = Array.from({ length: 5 }, (_, i) => ({ seq: i * 100, ts: new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString(), text: `ask ${i}` }));
        const events = Array.from({ length: 500 }, (_, i) => ev("tool_call", i, i * 2));
        const { events: kept } = segmentize(events, { asks, commits: [], compactions: [] }, "2026-01-01T00:00:00Z",
            { perSegmentCap: 1000, globalBudget: 50 });
        expect(kept.length).toBe(50);
    });
});
