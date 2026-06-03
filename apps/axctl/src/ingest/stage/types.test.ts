import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { BaseStageStats, IngestContext, sinceAndClause, sinceDaysFromCtx, sinceWhereClause, StageMeta } from "./types.ts";
import { IngestStageTag } from "./tags.ts";

class ExampleStats extends BaseStageStats.extend<ExampleStats>("ExampleStats")({
    rowsWritten: Schema.Number,
}) {}

describe("BaseStageStats", () => {
    it("extends with stage-specific fields", () => {
        const stats = ExampleStats.make({
            durationMs: 12,
            summary: "wrote 3 rows",
            rowsWritten: 3,
        });
        expect(stats.rowsWritten).toBe(3);
        expect(stats.summary).toBe("wrote 3 rows");
    });
});

describe("StageMeta", () => {
    it("decodes a valid meta record", () => {
        const decoded = Schema.decodeUnknownSync(StageMeta)({
            key: "signals",
            deps: ["claude", "codex"],
            tags: ["derive"],
        });
        expect(decoded.key).toBe("signals");
    });
});

describe("IngestContext", () => {
    it("constructs with the required fields", () => {
        const ctx = IngestContext.make({
            cwd: "/tmp",
            since: new Date(0),
            debug: false,
        });
        expect(ctx.debug).toBe(false);
    });
});

describe("sinceDaysFromCtx", () => {
    it("returns undefined for epoch-zero (default 'all time' sentinel)", () => {
        const ctx = IngestContext.make({ cwd: "/tmp", since: new Date(0), debug: false });
        expect(sinceDaysFromCtx(ctx)).toBeUndefined();
    });

    it("returns a small positive int for a recent date", () => {
        const fiveDaysAgo = new Date(Date.now() - 5 * 86400000);
        const ctx = IngestContext.make({ cwd: "/tmp", since: fiveDaysAgo, debug: false });
        const days = sinceDaysFromCtx(ctx);
        expect(days).toBeGreaterThanOrEqual(5);
        expect(days).toBeLessThanOrEqual(6);
    });

    it("returns undefined for a future date (negative diff)", () => {
        const tomorrow = new Date(Date.now() + 86400000);
        const ctx = IngestContext.make({ cwd: "/tmp", since: tomorrow, debug: false });
        expect(sinceDaysFromCtx(ctx)).toBeUndefined();
    });
});

describe("sinceWhereClause", () => {
    it("returns empty string for undefined (no time filter)", () => {
        expect(sinceWhereClause(undefined)).toBe("");
    });

    it("returns empty string for 0", () => {
        expect(sinceWhereClause(0)).toBe("");
    });

    it("returns empty string for a negative day count", () => {
        expect(sinceWhereClause(-3)).toBe("");
    });

    it("builds a WHERE clause for a positive day count", () => {
        expect(sinceWhereClause(7)).toBe("WHERE ts > time::now() - 7d");
    });
});

describe("sinceAndClause", () => {
    it("returns empty string for undefined (no time filter)", () => {
        expect(sinceAndClause(undefined)).toBe("");
    });

    it("returns empty string for 0", () => {
        expect(sinceAndClause(0)).toBe("");
    });

    it("returns empty string for a negative day count", () => {
        expect(sinceAndClause(-3)).toBe("");
    });

    it("builds an AND clause for a positive day count", () => {
        expect(sinceAndClause(7)).toBe("AND ts > time::now() - 7d");
    });
});

describe("IngestStageTag", () => {
    it("includes ingest and derive", () => {
        expect(Schema.decodeUnknownSync(IngestStageTag)("ingest")).toBe("ingest");
        expect(Schema.decodeUnknownSync(IngestStageTag)("derive")).toBe("derive");
    });
});
