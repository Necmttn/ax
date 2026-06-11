import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { formatReport, replayRows, summarize } from "./backtest.ts";
import { GitEnvTest } from "@ax/hooks-sdk/git-env";
import enforceWorktree from "@ax/hooks-sdk/hooks/enforce-worktree";

const rows = [
    {
        name: "Bash",
        input: { command: "git checkout main" },
        cwd: "/repo",
        source: "claude",
        project: "/repo",
        ts: new Date("2026-06-01"),
    },
    {
        name: "Bash",
        input: { command: "bun test" },
        cwd: "/repo",
        source: "claude",
        project: "/repo",
        ts: new Date("2026-06-01"),
    },
    {
        name: "Bash",
        input: { command: "git switch x" },
        cwd: "/other",
        source: "codex",
        project: "/other",
        ts: new Date("2026-06-02"),
    },
];

describe("replayRows", () => {
    test("verdict per row; summary aggregates correctly", async () => {
        const layer = GitEnvTest({
            primary: ["/repo"],
            branches: { "/repo": "main" },
            roots: { "/repo": "/repo" },
        });
        const results = await Effect.runPromise(
            replayRows(enforceWorktree, rows).pipe(Effect.provide(layer)),
        );

        // row 0: git checkout main, cwd=/repo (primary) -> Block
        // row 1: bun test (no git checkout verb) -> Allow
        // row 2: git switch x, cwd=/other (not primary per layer) -> Allow
        expect(results).toHaveLength(3);
        expect(results[0]?.verdict._tag).toBe("Block");
        expect(results[1]?.verdict._tag).toBe("Allow");
        expect(results[2]?.verdict._tag).toBe("Allow");

        const s = summarize(results);
        expect(s.total).toBe(3);
        expect(s.wouldBlock).toBe(1);
        expect(s.wouldWarn).toBe(0);
        expect(s.skippedRows).toBe(0);
        expect(s.providers).toEqual(["claude", "codex"]);
        expect(s.byProject["/repo"]).toEqual({ total: 2, blocked: 1 });
        expect(s.byProject["/other"]).toEqual({ total: 1, blocked: 0 });
    });

    test("non-matching tool name -> Allow without running predicate", async () => {
        const layer = GitEnvTest({ primary: ["/repo"] });
        const editRows = [
            {
                name: "Edit",
                input: { file_path: "/repo/src/a.ts" },
                cwd: "/repo",
                source: "claude",
                project: "/repo",
                ts: new Date("2026-06-01"),
            },
        ];
        // enforceWorktree only matches Bash; Edit should pass through as Allow
        const results = await Effect.runPromise(
            replayRows(enforceWorktree, editRows).pipe(Effect.provide(layer)),
        );
        expect(results[0]?.verdict._tag).toBe("Allow");
    });

    test("empty rows -> empty results", async () => {
        const layer = GitEnvTest({});
        const results = await Effect.runPromise(
            replayRows(enforceWorktree, []).pipe(Effect.provide(layer)),
        );
        expect(results).toHaveLength(0);
    });
});

describe("summarize", () => {
    test("aggregates block/warn counts and byProject", () => {
        const blockVerdict = { _tag: "Block" as const, reason: "BLOCKED: line1\nmore detail" };
        const allowVerdict = { _tag: "Allow" as const };
        const warnVerdict = { _tag: "Warn" as const, message: "careful" };

        const makeRow = (project: string, input: Record<string, unknown>) => ({
            name: "Bash",
            input,
            cwd: project,
            source: "claude",
            project,
            ts: new Date(),
        });

        const results = [
            { row: makeRow("/proj-a", { command: "git checkout main" }), verdict: blockVerdict },
            { row: makeRow("/proj-a", { command: "bun test" }), verdict: allowVerdict },
            { row: makeRow("/proj-b", { command: "git merge x" }), verdict: warnVerdict },
            { row: makeRow("/proj-b", { command: "ls" }), verdict: allowVerdict },
        ];

        const s = summarize(results);
        expect(s.total).toBe(4);
        expect(s.wouldBlock).toBe(1);
        expect(s.wouldWarn).toBe(1);
        expect(s.byProject["/proj-a"]).toEqual({ total: 2, blocked: 1 });
        expect(s.byProject["/proj-b"]).toEqual({ total: 2, blocked: 0 });
        // Sample should have first line of reason only
        expect(s.samples).toHaveLength(1);
        expect(s.samples[0]?.reason).toBe("BLOCKED: line1");
        expect(s.samples[0]?.command).toBe("git checkout main");
    });

    test("samples capped at 10", () => {
        const blockVerdict = { _tag: "Block" as const, reason: "BLOCKED: x" };
        const results = Array.from({ length: 15 }, (_, i) => ({
            row: {
                name: "Bash",
                input: { command: `git checkout branch-${i}` },
                cwd: "/repo",
                source: "claude",
                project: "/repo",
                ts: new Date(),
            },
            verdict: blockVerdict,
        }));
        const s = summarize(results);
        expect(s.total).toBe(15);
        expect(s.wouldBlock).toBe(15);
        expect(s.samples).toHaveLength(10);
    });

    test("unknown project falls back to (unknown) key", () => {
        const results = [
            {
                row: {
                    name: "Bash",
                    input: { command: "bun test" },
                    cwd: "/some/dir",
                    source: "claude",
                    project: null,
                    ts: new Date(),
                },
                verdict: { _tag: "Allow" as const },
            },
        ];
        const s = summarize(results);
        expect(s.byProject["(unknown)"]).toEqual({ total: 1, blocked: 0 });
    });

    test("skippedRows passthrough + distinct providers from rows", () => {
        const makeResult = (source: string) => ({
            row: {
                name: "Bash",
                input: { command: "ls" },
                cwd: "/repo",
                source,
                project: "/repo",
                ts: new Date(),
            },
            verdict: { _tag: "Allow" as const },
        });
        const s = summarize([makeResult("claude"), makeResult("claude")], 7);
        expect(s.skippedRows).toBe(7);
        expect(s.providers).toEqual(["claude"]);

        const s2 = summarize([makeResult("claude"), makeResult("codex")]);
        expect(s2.skippedRows).toBe(0);
        expect(s2.providers).toEqual(["claude", "codex"]);
    });

    test("raw source 'pi' surfaces in providers; replay encodes as claude harness", async () => {
        // BacktestRow.source is the raw session.source string. Pi is not a hook
        // harness (no hooks fire from it), but if it appears in the DB it should
        // appear in BacktestSummary.providers as "pi", not collapsed to "claude".
        const piRow = {
            name: "Bash",
            input: { command: "echo pi-tool" },
            cwd: "/repo",
            source: "pi",  // raw source, not a Harness value
            project: "/repo",
            ts: new Date("2026-06-01"),
        };
        const layer = GitEnvTest({ primary: ["/repo"], branches: { "/repo": "main" }, roots: { "/repo": "/repo" } });
        const results = await Effect.runPromise(
            replayRows(enforceWorktree, [piRow]).pipe(Effect.provide(layer)),
        );
        // "echo pi-tool" doesn't match git checkout/switch -> Allow
        expect(results).toHaveLength(1);
        expect(results[0]?.verdict._tag).toBe("Allow");

        const s = summarize(results);
        // providers should contain the raw "pi" string, not "claude"
        expect(s.providers).toEqual(["pi"]);
    });
});

describe("formatReport", () => {
    const baseSummary = {
        total: 100,
        wouldBlock: 5,
        wouldWarn: 0,
        skippedRows: 0,
        providers: ["claude"],
        byProject: { "/repo": { total: 100, blocked: 5 } },
        samples: [],
    };

    test("provider count derived from summary, not hardcoded", () => {
        const one = formatReport("my-hook", 7, baseSummary);
        expect(one).toContain("(last 7d, 1 provider)");

        const two = formatReport("my-hook", 7, {
            ...baseSummary,
            providers: ["claude", "codex"],
        });
        expect(two).toContain("(last 7d, 2 providers)");
    });

    test("skipped line only when skippedRows > 0; caveat always present", () => {
        const clean = formatReport("my-hook", 7, baseSummary);
        expect(clean).not.toContain("skipped");
        expect(clean).toContain(
            "caveat: state-dependent checks (branch, dirty) used CURRENT repo state.",
        );

        const withSkips = formatReport("my-hook", 7, {
            ...baseSummary,
            skippedRows: 12,
        });
        expect(withSkips).toContain("skipped 12 rows (unparseable input)");
        expect(withSkips).toContain(
            "caveat: state-dependent checks (branch, dirty) used CURRENT repo state.",
        );
    });
});
