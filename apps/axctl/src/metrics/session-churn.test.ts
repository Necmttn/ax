import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import {
    computeSessionChurn,
    fetchSessionChurnSummary,
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

const db = (input: {
    base: Array<Record<string, unknown>>;
    health?: Array<Record<string, unknown>>;
    produced?: Array<Record<string, unknown>>;
    touched?: Array<Record<string, unknown>>;
    edits?: Array<Record<string, unknown>>;
    outcomes?: Array<Record<string, unknown>>;
    hooks?: Array<Record<string, unknown>>;
    seenSql?: string[];
    respectBaseLimit?: boolean;
}) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            input.seenSql?.push(sql);
            if (sql.includes("FROM session_health")) return Effect.succeed([input.health ?? []] as unknown as T);
            if (sql.includes("FROM produced")) return Effect.succeed([input.produced ?? []] as unknown as T);
            if (sql.includes("FROM touched")) return Effect.succeed([input.touched ?? []] as unknown as T);
            if (sql.includes("FROM tool_call")) return Effect.succeed([input.edits ?? []] as unknown as T);
            if (sql.includes("FROM command_outcome")) return Effect.succeed([input.outcomes ?? []] as unknown as T);
            if (sql.includes("FROM hook_command_invocation")) return Effect.succeed([input.hooks ?? []] as unknown as T);
            const limit = input.respectBaseLimit ? Number(sql.match(/\bLIMIT\s+(\d+)/)?.[1] ?? NaN) : NaN;
            const base = Number.isFinite(limit) ? input.base.slice(0, limit) : input.base;
            return Effect.succeed([base] as unknown as T);
        },
    } as never);

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
        expect(normalizeCheckFamily("bun run lint")).toBe("lint");
        expect(normalizeCheckFamily("pnpm lint")).toBe("lint");
        expect(normalizeCheckFamily("npm run lint")).toBe("lint");
        expect(normalizeCheckFamily("lint")).toBe("lint");
        expect(normalizeCheckFamily("bun run build")).toBe("build");
        expect(normalizeCheckFamily("cargo check")).toBe("check");
    });

    test("returns null for unknown or empty checks", () => {
        expect(normalizeCheckFamily(null)).toBeNull();
        expect(normalizeCheckFamily("")).toBeNull();
        expect(normalizeCheckFamily("date")).toBeNull();
    });

    test("does not classify commands that merely mention check keywords", () => {
        expect(normalizeCheckFamily("ls test/")).toBeNull();
        expect(normalizeCheckFamily("rg foo test/ -l")).toBeNull();
        expect(normalizeCheckFamily("cat build.log")).toBeNull();
        expect(normalizeCheckFamily("git checkout build")).toBeNull();
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

    test("filters edit-only, pass-only, and metadata-only sessions from output rows", () => {
        const summary = computeSessionChurn([
            edit("quiet-edit", 1, 5, 1),
            pass("quiet-pass", 1, "typecheck"),
            edit("noisy", 1, 1),
            fail("noisy", 2, "typecheck"),
        ], landed([
            ["metadata-only", { added: 20, removed: 4 }],
            ["noisy", { added: 3, removed: 1 }],
        ]), health([
            ["metadata-only", "quiet metadata"],
            ["quiet-edit", "quiet edit"],
            ["quiet-pass", "quiet pass"],
            ["noisy", "has verification signal"],
        ]));

        expect(summary.hotSessions.map((row) => row.session)).toEqual(["noisy"]);
        expect(summary.aggregates).toHaveLength(1);
        expect(summary.aggregates[0]).toMatchObject({
            sessions: 1,
            landedLinesAdded: 3,
            editLinesAdded: 1,
            verificationFailures: 1,
        });
    });

    test("returns empty output when all sessions are quiet", () => {
        const summary = computeSessionChurn([
            edit("quiet-edit", 1, 5, 1),
            pass("quiet-pass", 1, "typecheck"),
        ], landed([["metadata-only", { added: 20, removed: 4 }]]), health([["metadata-only", "quiet metadata"]]));

        expect(summary.hotSessions).toEqual([]);
        expect(summary.aggregates).toEqual([]);
        expect(formatSessionChurnSummary(summary)).toBe(
            "no verification churn rows matched (run `ax ingest`, or loosen --since/--source/--here).",
        );
    });

    test("normalizes DB-shaped and bare session ids across events and metadata maps", () => {
        const summary = computeSessionChurn([
            edit("session:`mixed-1`", 1, 6, 2),
            fail("session:`mixed-1`", 2, "typecheck"),
            edit("session:`mixed-1`", 3, 4, 1),
        ], landed([["mixed-1", { added: 9, removed: 3 }]]), health([["session:⟨mixed-1⟩", "mixed task"]]));

        expect(summary.hotSessions).toHaveLength(1);
        expect(summary.hotSessions[0]).toMatchObject({
            session: "mixed-1",
            taskLabel: "mixed task",
            landedLinesAdded: 9,
            landedLinesRemoved: 3,
            editLinesAdded: 10,
            editLinesRemoved: 3,
            repairLinesAdded: 4,
            repairLinesRemoved: 1,
            verificationFailures: 1,
        });
    });
});

describe("fetchSessionChurnSummary", () => {
    test("base query includes since, project, and source filters", async () => {
        const seenSql: string[] = [];
        await Effect.runPromise(fetchSessionChurnSummary({
            since: new Date("2026-06-01T00:00:00.000Z"),
            project: "/repo/ax",
            source: "codex",
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({ base: [], seenSql }))));

        const baseSql = seenSql.find((s) => s.includes("FROM session_metrics"))!;
        expect(baseSql).toContain("session.started_at AS started_at");
        expect(baseSql).toContain('session.started_at >= d"2026-06-01T00:00:00.000Z"');
        expect(baseSql).toContain('(session.project = "/repo/ax" OR session.cwd = "/repo/ax")');
        expect(baseSql).toContain('session.source = "codex"');
    });

    test("empty base sessions skip secondary scans", async () => {
        const seenSql: string[] = [];
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({ base: [], seenSql }))));

        expect(summary.hotSessions).toEqual([]);
        expect(summary.aggregates).toEqual([]);
        expect(seenSql).toHaveLength(1);
        expect(seenSql[0]).toContain("FROM session_metrics");
    });

    test("limit only caps hot sessions after ranking, not the base session scan", async () => {
        const seenSql: string[] = [];
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 1,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({
            respectBaseLimit: true,
            seenSql,
            base: [
                { session: "session:`newer-quiet`", source: "codex" },
                { session: "session:`older-hot`", source: "codex" },
                { session: "session:`older-warm`", source: "codex" },
            ],
            edits: [
                { session: "session:`older-hot`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) },
                { session: "session:`older-warm`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) },
            ],
            outcomes: [
                { session: "session:`older-hot`", ts: "2026-06-11T00:02:00.000Z", status: "error", command_norm: "tsc" },
                { session: "session:`older-hot`", ts: "2026-06-11T00:03:00.000Z", status: "error", command_norm: "eslint" },
                { session: "session:`older-warm`", ts: "2026-06-11T00:02:00.000Z", status: "error", command_norm: "tsc" },
            ],
        }))));

        const baseSql = seenSql.find((s) => s.includes("FROM session_metrics"))!;
        expect(baseSql).not.toContain("LIMIT 1");
        expect(summary.hotSessions.map((row) => row.session)).toEqual(["older-hot"]);
        expect(summary.aggregates).toHaveLength(1);
        expect(summary.aggregates[0]).toMatchObject({
            sessions: 2,
            verificationFailures: 3,
        });
    });

    test("landed LOC joins produced commits to touched files in JS", async () => {
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({
            base: [{ session: "session:`s1`", source: "codex" }],
            health: [{ session: "session:`s1`", task_label: "landed loc" }],
            produced: [{ session: "session:`s1`", commit: "commit:`c1`" }],
            touched: [
                { commit: "commit:`c1`", file: "file:`f1`", path: "src/a.ts", additions: 10, deletions: 2 },
                { commit: "commit:`c1`", file: "file:`f1`", path: "src/a.ts", additions: 10, deletions: 2 },
                { commit: "commit:`c1`", file: "file:`f2`", path: "src/b.ts", additions: 3, deletions: 1 },
            ],
            edits: [{ session: "session:`s1`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) }],
            outcomes: [{ session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", status: "error", command_norm: "tsc" }],
        }))));

        expect(summary.hotSessions[0]).toMatchObject({
            session: "s1",
            taskLabel: "landed loc",
            landedLinesAdded: 13,
            landedLinesRemoved: 3,
            verificationFailures: 1,
        });
    });

    test("edit tool rows produce line-delta edit events", async () => {
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({
            base: [{ session: "session:`s1`", source: "claude" }],
            edits: [
                { session: "session:`s1`", ts: "2026-06-11T00:01:00.000Z", name: "Write", input_json: JSON.stringify({ content: "a\nb\nc" }) },
                { session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", name: "exec_command", command_norm: "apply_patch", input_json: JSON.stringify({ patch: "+new\n-old\n+++ b/file\n--- a/file" }) },
            ],
            outcomes: [{ session: "session:`s1`", ts: "2026-06-11T00:03:00.000Z", status: "error", command_norm: "bun test" }],
        }))));

        expect(summary.hotSessions[0]).toMatchObject({
            session: "s1",
            editEvents: 2,
            editLinesAdded: 4,
            editLinesRemoved: 1,
            repairLinesAdded: 0,
            repairLinesRemoved: 0,
            verificationFailures: 1,
            topCheck: "test",
        });
    });

    test("command_outcome and hook rows produce verification fail/pass events", async () => {
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({
            base: [{ session: "session:`s1`", source: "codex" }],
            edits: [{ session: "session:`s1`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) }],
            outcomes: [
                { session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", kind: "expected_feedback", status: "ok", command_norm: "eslint" },
                { session: "session:`s1`", ts: "2026-06-11T00:04:00.000Z", kind: "check", status: "ok", command_norm: "eslint" },
                { session: "session:`s1`", ts: "2026-06-11T00:05:00.000Z", kind: "check", status: "ok", command_norm: "deploy" },
            ],
            hooks: [
                { session: "session:`s1`", ts: "2026-06-11T00:03:00.000Z", provider_status: "blocking_error", effect: "blocked", exit_code: 1, command: "bun test" },
                { session: "session:`s1`", ts: "2026-06-11T00:06:00.000Z", provider_status: "success", effect: "allowed", exit_code: null, command: "bun test" },
            ],
        }))));

        expect(summary.hotSessions[0]).toMatchObject({
            session: "s1",
            verificationFailures: 2,
            verificationPasses: 2,
            episodes: 2,
            passedEpisodes: 2,
        });
        expect(summary.hotSessions[0].topCheck).toBe("eslint");
    });

    test("successful command_outcome text does not classify or close verification episodes", async () => {
        const seenSql: string[] = [];
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({
            seenSql,
            base: [{ session: "session:`s1`", source: "codex" }],
            edits: [
                { session: "session:`s1`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) },
                { session: "session:`s1`", ts: "2026-06-11T00:03:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "b", new_string: "b\nc" }) },
            ],
            outcomes: [
                { session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", kind: "expected_feedback", status: "error", command_norm: "tsc" },
                { session: "session:`s1`", ts: "2026-06-11T00:04:00.000Z", kind: "success", status: "ok", command_norm: "cat", text: "README mentions bun test and build" },
                { session: "session:`s1`", ts: "2026-06-11T00:05:00.000Z", kind: "success", status: "ok", command_norm: "bun test" },
            ],
        }))));

        const outcomeSql = seenSql.find((s) => s.includes("FROM command_outcome"))!;
        expect(outcomeSql).toContain("tool_call.command_text AS command_text");
        expect(outcomeSql).toContain('AND (kind = "expected_feedback" OR status = "ok")');
        expect(summary.hotSessions[0]).toMatchObject({
            session: "s1",
            verificationFailures: 1,
            verificationPasses: 1,
            episodes: 1,
            passedEpisodes: 0,
            repairLinesAdded: 2,
        });
    });

    test("incidental keyword successes and hook names do not close episodes", async () => {
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({
            base: [{ session: "session:`s1`", source: "claude" }],
            edits: [{ session: "session:`s1`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) }],
            outcomes: [
                { session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", kind: "expected_feedback", status: "error", command_text: "bun test" },
                { session: "session:`s1`", ts: "2026-06-11T00:03:00.000Z", kind: "success", status: "ok", command_text: "ls test/" },
            ],
            hooks: [
                { session: "session:`s1`", ts: "2026-06-11T00:04:00.000Z", provider_status: "success", effect: "allowed", exit_code: 0, command: "bun /Users/x/.ax/hooks/guard.ts", hook_name: "bun-test-blocking" },
            ],
        }))));

        expect(summary.hotSessions[0]).toMatchObject({
            session: "s1",
            verificationFailures: 1,
            verificationPasses: 0,
            episodes: 1,
            passedEpisodes: 0,
        });
    });

    test("fail-side output text never infers a check family", async () => {
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({
            base: [{ session: "session:`s1`", source: "claude" }],
            edits: [{ session: "session:`s1`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) }],
            outcomes: [
                { session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", kind: "unknown", status: "error", command_text: "git push", text: "remote: check your credentials" },
            ],
        }))));

        expect(summary.hotSessions).toEqual([]);
        expect(summary.aggregates).toEqual([]);
    });

    test("command_text takes precedence over command_norm and tool names", async () => {
        const summary = await Effect.runPromise(fetchSessionChurnSummary({
            since: null,
            limit: 20,
            generatedAt: new Date("2026-06-11T00:00:00.000Z"),
        }).pipe(Effect.provide(db({
            base: [{ session: "session:`s1`", source: "codex" }],
            edits: [{ session: "session:`s1`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) }],
            outcomes: [
                { session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", kind: "expected_feedback", status: "error", command_text: "bun run typecheck", command_norm: "bun", command_tool: "test" },
                { session: "session:`s1`", ts: "2026-06-11T00:03:00.000Z", kind: "success", status: "ok", command_text: "bun run typecheck", command_norm: "bun", command_tool: "test" },
            ],
        }))));

        expect(summary.hotSessions[0]).toMatchObject({
            topCheck: "typecheck",
            verificationFailures: 1,
            verificationPasses: 1,
            passedEpisodes: 1,
        });
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
