import { describe, expect, test } from "bun:test";
import {
    computeSessionChurn,
    formatSessionChurnSummary,
    normalizeCheckFamily,
    type ChurnEvent,
} from "./session-churn.ts";

const edit = (session: string, tsMs: number, linesAdded: number, linesRemoved = 0, source = "codex"): ChurnEvent => ({
    session,
    source,
    tsMs,
    kind: "edit",
    check: null,
    linesAdded,
    linesRemoved,
});

const fail = (session: string, tsMs: number, check: string, source = "codex"): ChurnEvent => ({
    session,
    source,
    tsMs,
    kind: "verification_fail",
    check,
    linesAdded: 0,
    linesRemoved: 0,
});

const pass = (session: string, tsMs: number, check: string, source = "codex"): ChurnEvent => ({
    session,
    source,
    tsMs,
    kind: "verification_pass",
    check,
    linesAdded: 0,
    linesRemoved: 0,
});

const landed = (entries: Array<readonly [string, { readonly added: number; readonly removed: number }]>) =>
    new Map(entries);

const health = (entries: Array<readonly [string, string | null]>) =>
    new Map(entries);

describe("normalizeCheckFamily", () => {
    test("normalizes known verification families", () => {
        expect(normalizeCheckFamily("bun test apps/foo.test.ts")).toBe("test");
        expect(normalizeCheckFamily("vitest run")).toBe("test");
        expect(normalizeCheckFamily("jest")).toBe("test");
        expect(normalizeCheckFamily("playwright test")).toBe("test");
        expect(normalizeCheckFamily("bun run typecheck")).toBe("typecheck");
        expect(normalizeCheckFamily("tsc --noEmit")).toBe("typecheck");
        expect(normalizeCheckFamily("tsgo")).toBe("typecheck");
        expect(normalizeCheckFamily("oxlint --fix")).toBe("oxlint");
        expect(normalizeCheckFamily("eslint src")).toBe("eslint");
        expect(normalizeCheckFamily("bun run build")).toBe("build");
        expect(normalizeCheckFamily("cargo check")).toBe("check");
    });

    test("returns null for unknown or empty checks", () => {
        expect(normalizeCheckFamily(null)).toBeNull();
        expect(normalizeCheckFamily("")).toBeNull();
        expect(normalizeCheckFamily("date")).toBeNull();
    });
});

describe("computeSessionChurn", () => {
    test("failure before any edit does not start an episode", () => {
        const summary = computeSessionChurn([
            fail("s1", 1, "typecheck"),
            edit("s1", 2, 5, 1),
        ], landed([]), health([]));

        expect(summary.hotSessions).toHaveLength(1);
        expect(summary.hotSessions[0]).toMatchObject({
            session: "s1",
            verificationFailures: 1,
            episodes: 0,
            repairLinesAdded: 0,
            repairLinesRemoved: 0,
        });
    });

    test("counts repair churn after failure and before same-check pass", () => {
        const summary = computeSessionChurn([
            edit("s1", 1, 10, 1),
            fail("s1", 2, "tsc --noEmit"),
            edit("s1", 3, 4, 2),
            pass("s1", 4, "typecheck"),
            edit("s1", 5, 20, 8),
        ], landed([["s1", { added: 7, removed: 3 }]]), health([["s1", "fix type errors"]]));

        expect(summary.hotSessions[0]).toMatchObject({
            session: "s1",
            taskLabel: "fix type errors",
            landedLinesAdded: 7,
            landedLinesRemoved: 3,
            editLinesAdded: 34,
            editLinesRemoved: 11,
            repairLinesAdded: 4,
            repairLinesRemoved: 2,
            editEvents: 3,
            verificationFailures: 1,
            verificationPasses: 1,
            episodes: 1,
            passedEpisodes: 1,
            topCheck: "typecheck",
        });
    });

    test("repeated same-check failure increments failures but does not double-count repair edits", () => {
        const summary = computeSessionChurn([
            edit("s1", 1, 3),
            fail("s1", 2, "oxlint"),
            edit("s1", 3, 5, 2),
            fail("s1", 4, "oxlint"),
            edit("s1", 5, 7, 1),
            pass("s1", 6, "oxlint"),
        ], landed([]), health([]));

        expect(summary.hotSessions[0]).toMatchObject({
            verificationFailures: 2,
            episodes: 1,
            passedEpisodes: 1,
            repairLinesAdded: 12,
            repairLinesRemoved: 3,
            topCheck: "oxlint",
        });
    });

    test("multiple open checks do not double-count one repair edit in headline repair LOC", () => {
        const summary = computeSessionChurn([
            edit("s1", 1, 1),
            fail("s1", 2, "typecheck"),
            fail("s1", 3, "eslint"),
            edit("s1", 4, 9, 4),
            pass("s1", 5, "typecheck"),
            pass("s1", 6, "eslint"),
        ], landed([]), health([]));

        expect(summary.hotSessions[0]).toMatchObject({
            verificationFailures: 2,
            episodes: 2,
            passedEpisodes: 2,
            repairLinesAdded: 9,
            repairLinesRemoved: 4,
        });
    });

    test("source aggregate includes top check and passed episode totals", () => {
        const summary = computeSessionChurn([
            edit("s1", 1, 2, 0, "codex"),
            fail("s1", 2, "typecheck", "codex"),
            edit("s1", 3, 3, 1, "codex"),
            pass("s1", 4, "typecheck", "codex"),
            edit("s2", 1, 1, 0, "codex"),
            fail("s2", 2, "typecheck", "codex"),
            edit("s2", 3, 4, 2, "codex"),
            fail("s2", 4, "eslint", "codex"),
            edit("s2", 5, 6, 3, "codex"),
        ], landed([
            ["s1", { added: 5, removed: 1 }],
            ["s2", { added: 8, removed: 2 }],
        ]), health([]));

        expect(summary.aggregates).toEqual([{
            source: "codex",
            sessions: 2,
            sessionsWithFailures: 2,
            landedLinesAdded: 13,
            landedLinesRemoved: 3,
            editLinesAdded: 16,
            editLinesRemoved: 6,
            repairLinesAdded: 13,
            repairLinesRemoved: 6,
            verificationFailures: 3,
            episodes: 3,
            passedEpisodes: 1,
            topCheck: "typecheck",
        }]);
    });
});

describe("formatSessionChurnSummary", () => {
    test("renders the empty formatter hint", () => {
        const summary = computeSessionChurn([], landed([]), health([]));

        expect(formatSessionChurnSummary(summary)).toBe(
            "no verification churn rows matched (run `ax ingest`, or loosen --since/--source/--here).",
        );
    });
});
