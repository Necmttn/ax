import { describe, expect, test } from "bun:test";
import {
    fillDefaults,
    formatSessionMetrics,
    isoMs,
    metricMs,
    metricPct,
    SESSION_METRICS_LEGEND,
    sessionRefList,
} from "./util.ts";
import type { SessionMetricsRow } from "./session-metrics-query.ts";

describe("sessionRefList", () => {
    test("builds a comma-joined record-literal IN-list body", () => {
        // Already-formed `session:`key`` ids round-trip to themselves.
        expect(sessionRefList(["session:`a`", "session:`b`"])).toBe("session:`a`, session:`b`");
    });
    test("empty input → empty string", () => {
        expect(sessionRefList([])).toBe("");
    });
});

describe("fillDefaults", () => {
    test("sets only absent ids, leaves present ones untouched, returns the same map", () => {
        const map = new Map<string, number>([["x", 5]]);
        const out = fillDefaults(map, ["x", "y", "z"], 0);
        expect(out).toBe(map);
        expect(out.get("x")).toBe(5);
        expect(out.get("y")).toBe(0);
        expect(out.get("z")).toBe(0);
    });
    test("no-op when all ids present", () => {
        const map = new Map<string, number>([["a", 1], ["b", 2]]);
        fillDefaults(map, ["a", "b"], 99);
        expect(map.get("a")).toBe(1);
        expect(map.get("b")).toBe(2);
    });
});

describe("isoMs", () => {
    test("parses an ISO datetime to epoch ms", () => {
        expect(isoMs("1970-01-01T00:00:00.000Z")).toBe(0);
        expect(isoMs("2020-01-01T00:00:00.000Z")).toBe(Date.UTC(2020, 0, 1));
    });
    test("non-string → null", () => {
        expect(isoMs(null)).toBeNull();
        expect(isoMs(undefined)).toBeNull();
        expect(isoMs(123)).toBeNull();
    });
    test("empty string → null", () => {
        expect(isoMs("")).toBeNull();
    });
    test("unparseable string → null", () => {
        expect(isoMs("not-a-date")).toBeNull();
    });
});

describe("metricPct", () => {
    test("null → padded dash", () => {
        expect(metricPct(null)).toBe("  -");
    });
    test("ratios render as right-aligned whole percents", () => {
        expect(metricPct(0)).toBe("  0%");
        expect(metricPct(0.5)).toBe(" 50%");
        expect(metricPct(1)).toBe("100%");
        expect(metricPct(0.666)).toBe(" 67%");
    });
});

describe("metricMs", () => {
    test("null → dash", () => {
        expect(metricMs(null)).toBe("-");
    });
    test("sub-minute values render as \"<1m\", not a floored \"1m\"", () => {
        // squash-merge commits legitimately land at ~0ms (merge_sha IS the commit)
        expect(metricMs(0)).toBe("<1m");
        expect(metricMs(1)).toBe("<1m");
        expect(metricMs(59999)).toBe("<1m");
    });
    test("minutes under an hour", () => {
        expect(metricMs(60000)).toBe("1m");
        expect(metricMs(90000)).toBe("2m"); // rounds
        expect(metricMs(3599999)).toBe("60m");
    });
    test("hours at one decimal from 1h up", () => {
        expect(metricMs(3600000)).toBe("1.0h");
        expect(metricMs(5400000)).toBe("1.5h");
    });
});

describe("SESSION_METRICS_LEGEND", () => {
    test("documents every cryptic column incl. durability denominator + squash note", () => {
        for (const term of ["durab", "land", "1st-edit", "reads", "deleg%"]) {
            expect(SESSION_METRICS_LEGEND).toContain(term);
        }
        expect(SESSION_METRICS_LEGEND).toContain("commits produced"); // denominator
        expect(SESSION_METRICS_LEGEND).toContain("squash");
        expect(SESSION_METRICS_LEGEND).toContain("<1m");
    });
});

describe("formatSessionMetrics", () => {
    const row = (overrides: Partial<SessionMetricsRow>): SessionMetricsRow => ({
        session: "session:`abc`",
        taskLabel: null,
        source: "claude",
        durabilityRatio: null,
        producedCommits: 0,
        timeToLandMs: null,
        linesAdded: 0,
        linesRemoved: 0,
        timeToFirstEditMs: null,
        coldStartReads: 0,
        delegationRatio: null,
        estimatedCostUsd: null,
        costPricingSource: null,
        userCorrections: null,
        ...overrides,
    });

    test("empty rows → ingest hint", () => {
        expect(formatSessionMetrics([])).toContain("run `ax ingest`");
    });

    test("default truncates session ids to 20 chars", () => {
        const id = "claude-subagent-0123456789abcdef0123456789abcdef";
        const out = formatSessionMetrics([row({ session: `session:\`${id}\`` })]);
        const body = out.split("\n")[1]!;
        expect(body.startsWith(`${id.slice(0, 20)} `)).toBe(true);
        expect(body).not.toContain(id);
    });

    test("fullIds prints the untruncated id and widens the column", () => {
        const id = "claude-subagent-0123456789abcdef0123456789abcdef";
        const out = formatSessionMetrics(
            [row({ session: `session:\`${id}\`` }), row({ session: "session:`short`" })],
            { fullIds: true },
        );
        const [header, first, second] = out.split("\n") as [string, string, string];
        expect(first).toContain(id);
        // header + short row pad to the widest id so columns stay aligned
        expect(header.startsWith(`${"session".padEnd(id.length)} `)).toBe(true);
        expect(second.startsWith(`${"short".padEnd(id.length)} `)).toBe(true);
    });

    test("does not cap rows (limit is the caller's job)", () => {
        const rows = Array.from({ length: 60 }, (_, i) => row({ session: `session:\`s${i}\`` }));
        expect(formatSessionMetrics(rows).split("\n")).toHaveLength(61);
    });

    test("renders metric columns through metricPct/metricMs", () => {
        const out = formatSessionMetrics([
            row({
                durabilityRatio: 0.5,
                producedCommits: 4,
                timeToLandMs: 30000,
                linesAdded: 10,
                linesRemoved: 2,
                timeToFirstEditMs: 120000,
                coldStartReads: 7,
                delegationRatio: 1,
                taskLabel: "fix  the\nthing",
            }),
        ]);
        const body = out.split("\n")[1]!;
        expect(body).toContain(" 50%");
        expect(body).toContain("<1m");
        expect(body).toContain("+10/-2");
        expect(body).toContain("2m");
        expect(body).toContain("100%");
        expect(body).toContain("fix the thing"); // whitespace collapsed
    });
});
