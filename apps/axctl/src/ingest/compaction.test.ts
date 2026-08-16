import { describe, expect, test } from "bun:test";
import {
    compactionRecordKey,
    extractClaudeCompaction,
    extractCodexCompaction,
    extractCursorCompaction,
    extractPiCompaction,
} from "./compaction.ts";

describe("compactionRecordKey", () => {
    test("is deterministic and sanitized", () => {
        expect(compactionRecordKey("codex", "sess-1:abc", 3)).toBe("codex_sess_1_abc_cmp_3");
    });
});


describe("extractPiCompaction", () => {
    test("maps a Pi CompactionEntry", () => {
        const entry = {
            type: "compaction",
            id: "c1",
            summary: "Goal: ship X",
            firstKeptEntryId: "entry-7",
            tokensBefore: 90000,
            fromHook: false,
            details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
        };
        const w = extractPiCompaction(entry, {
            sessionId: "s",
            providerSessionId: "ps",
            seq: 4,
            ts: new Date("2026-05-29T06:05:38.132Z"),
            agentEventKey: "pi_ps_seq_000004",
        });
        expect(w).not.toBeNull();
        expect(w!.strategy).toBe("summarize");
        expect(w!.summary).toBe("Goal: ship X");
        expect(w!.tokensBefore).toBe(90000);
        expect(w!.boundaryRef).toBe("entry-7");
        expect(w!.trigger).toBe("auto");
        expect(w!.readFiles).toEqual(["a.ts"]);
        expect(w!.modifiedFiles).toEqual(["b.ts"]);
    });

    test("fromHook=true => trigger hook", () => {
        const w = extractPiCompaction(
            { type: "compaction", summary: "s", fromHook: true },
            { sessionId: "s", providerSessionId: "ps", seq: 1, ts: new Date(0), agentEventKey: null },
        );
        expect(w!.trigger).toBe("hook");
    });
});

describe("extractCodexCompaction", () => {
    test("history-replacement with kept_count", () => {
        const payload = {
            message: "",
            replacement_history: [{ type: "message" }, { type: "message" }, { type: "message" }],
        };
        const w = extractCodexCompaction(payload, {
            sessionId: "s",
            providerSessionId: "ps",
            seq: 10,
            ts: new Date("2026-05-14T15:34:42.663Z"),
            agentEventKey: "codex_ps_seq_000010",
            tokensBefore: 120000,
            boundaryRef: "seq_10",
        });
        expect(w!.strategy).toBe("history_replacement");
        expect(w!.summary).toBeNull();
        expect(w!.keptCount).toBe(3);
        expect(w!.tokensBefore).toBe(120000);
        expect(w!.trigger).toBe("auto");
    });

    test("non-empty message => manual trigger + summary", () => {
        const w = extractCodexCompaction(
            { message: "focus on auth", replacement_history: [] },
            { sessionId: "s", providerSessionId: "ps", seq: 1, ts: new Date(0), agentEventKey: null, tokensBefore: null, boundaryRef: "seq_1" },
        );
        expect(w!.trigger).toBe("manual");
        expect(w!.summary).toBe("focus on auth");
    });
});

describe("extractCursorCompaction", () => {
    test("encrypted strategy, null summary", () => {
        const w = extractCursorCompaction({
            sessionId: "s",
            providerSessionId: "ps",
            seq: 2,
            ts: new Date("2026-05-29T00:00:00.000Z"),
            agentEventKey: "cursor_ps_seq_000002",
            boundaryRef: "bubble-9",
            summarizedComposers: ["comp-1"],
        });
        expect(w.strategy).toBe("encrypted");
        expect(w.summary).toBeNull();
        expect(w.boundaryRef).toBe("bubble-9");
    });
});

describe("extractClaudeCompaction", () => {
    test("summarize strategy from ctx.summary", () => {
        const w = extractClaudeCompaction({
            sessionId: "s",
            providerSessionId: "ps",
            seq: 5,
            ts: new Date("2026-06-01T10:05:00.000Z"),
            agentEventKey: "claude_ps_seq_000005",
            summary: "## Summary\nGoal: ship X",
            boundaryRef: "u2",
        });
        expect(w.strategy).toBe("summarize");
        expect(w.trigger).toBe("auto");
        expect(w.summary).toContain("Goal: ship X");
        expect(w.boundaryRef).toBe("u2");
        expect(w.sourceConfidence).toBe("explicit");
    });
});
