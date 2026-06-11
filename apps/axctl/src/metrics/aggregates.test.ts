import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { SkillName } from "@ax/lib/brands";
import {
    aggregateGroups,
    aggregateRows,
    applyAggregateFilters,
    computeSkillEfficacy,
    fetchAggregateRows,
    fetchSkillSessionSet,
    formatGroupAggregates,
    formatSkillEfficacy,
    groupKeyFor,
    isoWeekKey,
    type AggregateSessionRow,
} from "./aggregates.ts";

/** Fixture row with sane defaults (override per test). */
const row = (over: Partial<AggregateSessionRow> = {}): AggregateSessionRow => ({
    session: "s1",
    source: "claude",
    repo: "/Users/me/Projects/ax",
    model: "claude-opus-4-6",
    startedAtMs: Date.UTC(2026, 5, 10),
    durabilityRatio: 0.75,
    producedCommits: 4,
    revertedCommits: 1,
    linesAdded: 100,
    linesRemoved: 20,
    userCorrections: 2,
    estimatedCostUsd: 1.5,
    costEstimated: false,
    ...over,
});

describe("isoWeekKey", () => {
    test("plain mid-year date", () => {
        expect(isoWeekKey(Date.UTC(2026, 5, 10))).toBe("2026-W24"); // Wed 2026-06-10
    });
    test("Jan 1 on a Thursday starts W01 of its own year", () => {
        expect(isoWeekKey(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    });
    test("late-December days roll FORWARD into next ISO year", () => {
        expect(isoWeekKey(Date.UTC(2025, 11, 29))).toBe("2026-W01"); // Mon 2025-12-29
    });
    test("early-January days roll BACK into previous ISO year", () => {
        expect(isoWeekKey(Date.UTC(2021, 0, 1))).toBe("2020-W53"); // Fri 2021-01-01
    });
    test("lexicographic order == chronological order (zero-padded week)", () => {
        expect(isoWeekKey(Date.UTC(2026, 1, 1)) < isoWeekKey(Date.UTC(2026, 5, 10))).toBe(true);
    });
});

describe("groupKeyFor", () => {
    test("falls back to (unknown) for missing dimension values", () => {
        const r = row({ model: null, repo: null, source: null, startedAtMs: null });
        expect(groupKeyFor(r, "model")).toBe("(unknown)");
        expect(groupKeyFor(r, "repo")).toBe("(unknown)");
        expect(groupKeyFor(r, "source")).toBe("(unknown)");
        expect(groupKeyFor(r, "week")).toBe("(unknown)");
    });
});

describe("applyAggregateFilters", () => {
    test("--source keeps only matching sessions", () => {
        const rows = [row({ source: "codex" }), row({ source: "claude" }), row({ source: null })];
        expect(applyAggregateFilters(rows, { source: "codex" })).toHaveLength(1);
    });
    test("--min-cost excludes below-threshold AND unknown-cost sessions", () => {
        const rows = [
            row({ estimatedCostUsd: 5 }),
            row({ estimatedCostUsd: 0.4 }),
            row({ estimatedCostUsd: null }),
        ];
        const out = applyAggregateFilters(rows, { minCostUsd: 1 });
        expect(out).toHaveLength(1);
        expect(out[0]!.estimatedCostUsd).toBe(5);
    });
    test("no filters = identity", () => {
        const rows = [row(), row({ source: null, estimatedCostUsd: null })];
        expect(applyAggregateFilters(rows, {})).toHaveLength(2);
    });
});

describe("aggregateRows", () => {
    test("sums counts, means ratios over sessions WITH data, tracks cost provenance", () => {
        const g = aggregateRows("k", [
            row({ durabilityRatio: 1, producedCommits: 2, revertedCommits: 0, userCorrections: 1, estimatedCostUsd: 2, costEstimated: true }),
            row({ durabilityRatio: 0.5, producedCommits: 4, revertedCommits: 2, userCorrections: 3, estimatedCostUsd: 1, costEstimated: false }),
            // no commits / no health / no cost - excluded from the respective means
            row({ durabilityRatio: null, producedCommits: 0, revertedCommits: 0, userCorrections: null, estimatedCostUsd: null }),
        ]);
        expect(g.sessions).toBe(3);
        expect(g.durabilitySessions).toBe(2);
        expect(g.meanDurability).toBeCloseTo(0.75, 8);
        expect(g.producedCommits).toBe(6);
        expect(g.revertedCommits).toBe(2);
        expect(g.correctionSessions).toBe(2);
        expect(g.totalCorrections).toBe(4);
        expect(g.meanCorrections).toBeCloseTo(2, 8);
        expect(g.costSessions).toBe(2);
        expect(g.estimatedCostSessions).toBe(1);
        expect(g.totalCostUsd).toBeCloseTo(3, 8);
    });
    test("empty group: nulls (not 0) for the ratio fields", () => {
        const g = aggregateRows("k", []);
        expect(g.meanDurability).toBe(null);
        expect(g.meanCorrections).toBe(null);
        expect(g.totalCostUsd).toBe(null);
        expect(g.sessions).toBe(0);
    });
});

describe("aggregateGroups", () => {
    test("groups by source, sorted by session count desc", () => {
        const groups = aggregateGroups(
            [row({ source: "codex" }), row({ source: "claude" }), row({ source: "claude" })],
            "source",
            50,
        );
        expect(groups.map((g) => g.key)).toEqual(["claude", "codex"]);
        expect(groups[0]!.sessions).toBe(2);
    });
    test("week groups sort chronologically ascending and keep the most recent --limit", () => {
        const groups = aggregateGroups(
            [
                row({ startedAtMs: Date.UTC(2026, 0, 5) }),  // 2026-W02
                row({ startedAtMs: Date.UTC(2026, 5, 10) }), // 2026-W24
                row({ startedAtMs: Date.UTC(2026, 5, 1) }),  // 2026-W23
            ],
            "week",
            2,
        );
        expect(groups.map((g) => g.key)).toEqual(["2026-W23", "2026-W24"]);
    });
    test("sessions without started_at land in a trailing (unknown) week bucket", () => {
        const groups = aggregateGroups(
            [row({ startedAtMs: Date.UTC(2026, 5, 10) }), row({ startedAtMs: null })],
            "week",
            50,
        );
        expect(groups.map((g) => g.key)).toEqual(["2026-W24", "(unknown)"]);
    });
    test("non-week dimensions keep the TOP --limit by sessions", () => {
        const groups = aggregateGroups(
            [row({ repo: "/a" }), row({ repo: "/a" }), row({ repo: "/b" })],
            "repo",
            1,
        );
        expect(groups.map((g) => g.key)).toEqual(["/a"]);
    });
});

describe("computeSkillEfficacy", () => {
    test("partitions on the skill session set and reports the durability delta", () => {
        const eff = computeSkillEfficacy(
            [
                row({ session: "a", durabilityRatio: 1 }),
                row({ session: "b", durabilityRatio: 0.9 }),
                row({ session: "c", durabilityRatio: 0.5 }),
                row({ session: "d", durabilityRatio: null }),
            ],
            new Set(["a", "b"]),
            "superpowers:tdd",
        );
        expect(eff.withSkill.sessions).toBe(2);
        expect(eff.withoutSkill.sessions).toBe(2);
        expect(eff.withSkill.meanDurability).toBeCloseTo(0.95, 8);
        expect(eff.withoutSkill.meanDurability).toBeCloseTo(0.5, 8);
        expect(eff.durabilityDelta).toBeCloseTo(0.45, 8);
        expect(eff.skillSessions).toBe(2);
    });
    test("empty skill set: with-side aggregates to 0 sessions, delta is null", () => {
        const eff = computeSkillEfficacy([row({ session: "a" })], new Set(), "ghost");
        expect(eff.withSkill.sessions).toBe(0);
        expect(eff.durabilityDelta).toBe(null);
    });
});

describe("formatGroupAggregates", () => {
    test("renders aligned header + one line per group", () => {
        const out = formatGroupAggregates(
            aggregateGroups([row({ source: "codex", costEstimated: true })], "source", 50),
            "source",
        );
        expect(out).toContain("source");
        expect(out).toContain("durab");
        expect(out).toContain("cost$");
        expect(out).toContain("est");
        expect(out).toContain("codex");
        expect(out).toContain("75% (1)");
        expect(out).toContain("$1.50");
        expect(out).toContain("1/1"); // estimated/priced provenance
    });
    test("empty groups produce a hint, not an empty table", () => {
        expect(formatGroupAggregates([], "week")).toContain("no session_metrics rows matched");
    });
    test("null aggregates render as dashes", () => {
        const out = formatGroupAggregates(
            aggregateGroups(
                [row({ durabilityRatio: null, userCorrections: null, estimatedCostUsd: null })],
                "source",
                50,
            ),
            "source",
        );
        const dataLine = out.split("\n")[1]!;
        expect(dataLine).toContain("-");
        expect(dataLine).not.toContain("$");
    });
    test("long repo keys are left-truncated to keep the table compact", () => {
        const longRepo = `/Users/someone/very/deep/nested/projects/dir/${"x".repeat(40)}`;
        const out = formatGroupAggregates(aggregateGroups([row({ repo: longRepo })], "repo", 50), "repo");
        expect(out).toContain("…");
        expect(out).toContain(longRepo.slice(-20));
    });
});

describe("formatSkillEfficacy", () => {
    test("with/without table + signed pp delta", () => {
        const eff = computeSkillEfficacy(
            [row({ session: "a", durabilityRatio: 1 }), row({ session: "b", durabilityRatio: 0.5 })],
            new Set(["a"]),
            "superpowers:tdd",
        );
        const out = formatSkillEfficacy(eff);
        expect(out).toContain("skill_durability_efficacy: superpowers:tdd");
        expect(out).toContain("with");
        expect(out).toContain("without");
        expect(out).toContain("Δ durability: +50pp");
    });
    test("zero-invocation skill prints the name-check hint", () => {
        const out = formatSkillEfficacy(computeSkillEfficacy([row()], new Set(), "ghost-skill"));
        expect(out).toContain("no invocations recorded");
        expect(out).toContain("Δ durability: -");
    });
});

// ---------------------------------------------------------------------------
// Fetchers (mocked db - dispatching on table name like session-metrics-query.test.ts)
// ---------------------------------------------------------------------------

const db = (input: {
    metrics?: Array<Record<string, unknown>>;
    health?: Array<Record<string, unknown>>;
    usage?: Array<Record<string, unknown>>;
    pricing?: Array<Record<string, unknown>>;
    invoked?: Array<Record<string, unknown>>;
    seenSql?: string[];
}) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            input.seenSql?.push(sql);
            if (sql.includes("FROM session_token_usage")) return Effect.succeed([input.usage ?? []] as unknown as T);
            if (sql.includes("FROM session_health")) return Effect.succeed([input.health ?? []] as unknown as T);
            if (sql.includes("agent_model")) return Effect.succeed([input.pricing ?? []] as unknown as T);
            if (sql.includes("FROM invoked")) return Effect.succeed([input.invoked ?? []] as unknown as T);
            return Effect.succeed([input.metrics ?? []] as unknown as T);
        },
    } as never);

describe("fetchAggregateRows", () => {
    test("joins metrics + health + usage on the normalized session key", async () => {
        const out = await Effect.runPromise(fetchAggregateRows({ since: null, project: null }).pipe(Effect.provide(db({
            metrics: [{
                session: "session:`s1`", source: "claude", project: "/repo/a", cwd: "/cwd/a",
                started_at: "2026-06-10T12:00:00Z",
                durability_ratio: 0.5, produced_commits: 2, reverted_commits: 1,
                lines_added: 10, lines_removed: 5,
            }],
            health: [{ session: "session:`s1`", user_corrections: 3 }],
            usage: [{
                session: "session:⟨s1⟩", model: "Claude-Opus-4-6",
                prompt_tokens: 1, completion_tokens: 1, estimated_tokens: 2,
                estimated_cost_usd: 0.42, pricing_source: "litellm",
            }],
        }))));
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            session: "s1", source: "claude", repo: "/repo/a",
            model: "claude-opus-4-6", // normalized
            durabilityRatio: 0.5, producedCommits: 2, revertedCommits: 1,
            linesAdded: 10, linesRemoved: 5,
            userCorrections: 3, estimatedCostUsd: 0.42, costEstimated: false,
        });
        expect(out[0]!.startedAtMs).toBe(Date.parse("2026-06-10T12:00:00Z"));
    });

    test("repo falls back to cwd; missing joins stay null; estimated provenance flagged (#175)", async () => {
        const out = await Effect.runPromise(fetchAggregateRows({ since: null, project: null }).pipe(Effect.provide(db({
            metrics: [
                { session: "session:`s1`", source: "claude", project: null, cwd: "/cwd/only", produced_commits: 0, lines_added: 0, lines_removed: 0 },
                { session: "session:`s2`", source: "codex", produced_commits: 1, lines_added: 1, lines_removed: 0 },
            ],
            usage: [{
                session: "session:`s2`", model: "claude-haiku-4-5-20251001",
                prompt_tokens: null, completion_tokens: null,
                estimated_tokens: 1_000_000, estimated_cost_usd: null, pricing_source: null,
            }],
            pricing: [{ name: "claude-haiku-4-5-20251001", provider: "anthropic", input_per_million_usd: 1, output_per_million_usd: 5, pricing_source: "litellm" }],
        }))));
        const s1 = out.find((r) => r.session === "s1")!;
        expect(s1.repo).toBe("/cwd/only");
        expect(s1.userCorrections).toBe(null);
        expect(s1.estimatedCostUsd).toBe(null);
        expect(s1.costEstimated).toBe(false);
        expect(s1.startedAtMs).toBe(null);
        const s2 = out.find((r) => r.session === "s2")!;
        expect(s2.estimatedCostUsd).toBeCloseTo(1.0, 8); // 1M tokens × $1/M
        expect(s2.costEstimated).toBe(true);
    });

    test("health + usage joins are bounded by the metrics session-id set (indexed IN, not full scans)", async () => {
        const seenSql: string[] = [];
        await Effect.runPromise(fetchAggregateRows({ since: null, project: null }).pipe(Effect.provide(db({
            metrics: [
                { session: "session:`s1`", produced_commits: 0, lines_added: 0, lines_removed: 0 },
                { session: "session:`s2`", produced_commits: 1, lines_added: 1, lines_removed: 0 },
            ],
            seenSql,
        }))));
        const healthSql = seenSql.find((s) => s.includes("FROM session_health"))!;
        expect(healthSql).toContain("WHERE session IN [session:`s1`, session:`s2`]");
        const usageSql = seenSql.find((s) => s.includes("FROM session_token_usage"))!;
        expect(usageSql).toContain("WHERE session IN [session:`s1`, session:`s2`]");
    });

    test("empty metrics scan skips the secondary scans entirely", async () => {
        const seenSql: string[] = [];
        const out = await Effect.runPromise(fetchAggregateRows({ since: null, project: null }).pipe(
            Effect.provide(db({ metrics: [], seenSql })),
        ));
        expect(out).toEqual([]);
        expect(seenSql.some((s) => s.includes("FROM session_health"))).toBe(false);
        expect(seenSql.some((s) => s.includes("FROM session_token_usage"))).toBe(false);
    });

    test("since/project narrow the session_metrics WHERE clause (single scan, no edge derefs)", async () => {
        const seenSql: string[] = [];
        await Effect.runPromise(fetchAggregateRows({ since: new Date("2026-06-01T00:00:00Z"), project: "/repo/a" }).pipe(
            Effect.provide(db({ seenSql })),
        ));
        const metricsSql = seenSql.find((s) => s.includes("FROM session_metrics"))!;
        expect(metricsSql).toContain("session.started_at >=");
        expect(metricsSql).toContain("session.project =");
        expect(metricsSql).not.toContain("FROM invoked");
        expect(metricsSql).not.toContain("FROM edited");
    });
});

describe("fetchSkillSessionSet", () => {
    test("indexed out-anchored lookup over the denormalised invoked.session column", async () => {
        const seenSql: string[] = [];
        const out = await Effect.runPromise(fetchSkillSessionSet(SkillName.make("superpowers:tdd")).pipe(Effect.provide(db({
            invoked: [
                { session: "session:`s1`" },
                { session: "session:⟨s1⟩" }, // dupes collapse
                { session: "session:`s2`" },
            ],
            seenSql,
        }))));
        expect(out).toEqual(new Set(["s1", "s2"]));
        const sql = seenSql.find((s) => s.includes("FROM invoked"))!;
        expect(sql).toContain("WHERE out IN [");
        expect(sql).toContain("session != NONE");
        expect(sql).not.toContain("in.session"); // the documented hang shape
    });

    test("no invocations -> empty set", async () => {
        const out = await Effect.runPromise(fetchSkillSessionSet(SkillName.make("ghost")).pipe(Effect.provide(db({}))));
        expect(out.size).toBe(0);
    });
});
