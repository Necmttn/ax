import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { existsSync as fsExists } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { DbError } from "../lib/errors.ts";
import { discoverFiles, lintFiles, type LintTarget } from "./lint.ts";

const make = () => {
    const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
    mkdirSync(join(root, "skills", "foo"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# user file");
    writeFileSync(join(root, "AGENTS.md"), "# agents file");
    writeFileSync(join(root, "skills", "foo", "SKILL.md"), "---\n---\nbody");
    writeFileSync(join(root, "agents", "bar.md"), "---\n---\nprompt");
    return root;
};

describe("discoverFiles", () => {
    test("walks the given roots and returns categorized targets", () => {
        const root = make();
        const out = discoverFiles({ roots: [root] });
        const paths = out.map((t: LintTarget) => t.path).sort();
        expect(paths).toContain(join(root, "CLAUDE.md"));
        expect(paths).toContain(join(root, "AGENTS.md"));
        expect(paths).toContain(join(root, "skills", "foo", "SKILL.md"));
    });

    test("tags each target with form=guidance/skill/subagent", () => {
        const root = make();
        const out = discoverFiles({ roots: [root] });
        const claude = out.find((t) => t.path.endsWith("CLAUDE.md"));
        expect(claude?.form).toBe("guidance");
        const skill = out.find((t) => t.path.endsWith("SKILL.md"));
        expect(skill?.form).toBe("skill");
    });
});

interface QueryRecorder { calls: string[]; }
const recordingLayer = (recorder: QueryRecorder, fixtures: ReadonlyArray<unknown[]>) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => Effect.sync(() => {
            recorder.calls.push(sql);
            return [(fixtures[i++] ?? [])] as unknown as T;
        }),
    } as never);
};

/** Layer that succeeds for the first N queries, then fails for queries matching `failPattern`. */
const recordingLayerWithFailure = (
    recorder: QueryRecorder,
    fixtures: ReadonlyArray<unknown[]>,
    failPattern: RegExp,
) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(sql: string): Effect.Effect<T, DbError> => {
            recorder.calls.push(sql);
            if (failPattern.test(sql)) {
                return Effect.fail(new DbError({ operation: "query", message: "simulated DB failure", sql }));
            }
            return Effect.sync(() => [(fixtures[i++] ?? [])] as unknown as T);
        },
    } as never);
};

describe("lintFiles", () => {
    test("clean file → no findings", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        writeFileSync(join(root, "CLAUDE.md"), "no markers here");
        const rec: QueryRecorder = { calls: [] };
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, []))),
        );
        expect(report.errors).toHaveLength(0);
        expect(report.warnings).toHaveLength(0);
    });

    test("orphan marker → warning", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        writeFileSync(join(root, "CLAUDE.md"), "<!--ax:orphan-->body<!--/ax:orphan-->");
        const rec: QueryRecorder = { calls: [] };
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [[]]))),
        );
        expect(report.warnings.some((w) => w.rule === "orphan_id")).toBe(true);
    });

    test("marker matches pending task → cleanup deletes task, DB updates status", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        const taskDir = join(root, ".ax", "tasks");
        mkdirSync(taskDir, { recursive: true });
        const taskFile = join(taskDir, "e7f3.md");
        writeFileSync(taskFile, "# pending task");
        writeFileSync(
            join(root, "CLAUDE.md"),
            "<!--ax:e7f3-->Use ripgrep, not grep.<!--/ax:e7f3-->",
        );
        const rec: QueryRecorder = { calls: [] };
        const experimentFixture = [{
            id: "experiment:abc",
            short_id: "e7f3",
            status: "task_emitted",
            task_path: taskFile,
            locked_verdict: null,
        }];
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [experimentFixture, []]))),
        );
        expect(report.reconciled.some((r) => r.shortId === "e7f3")).toBe(true);
        expect(fsExists(taskFile)).toBe(false);
        expect(rec.calls.some((c) => /status\s*=\s*'scaffolded'/.test(c))).toBe(true);
    });

    test("regressed verdict → info-level note (not error)", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        writeFileSync(
            join(root, "CLAUDE.md"),
            "<!--ax:abc-->stale rule<!--/ax:abc-->",
        );
        const rec: QueryRecorder = { calls: [] };
        const experimentFixture = [{
            id: "experiment:abc",
            short_id: "abc",
            status: "scaffolded",
            task_path: null,
            locked_verdict: "regressed",
        }];
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [experimentFixture]))),
        );
        expect(report.infos.some((i) => i.rule === "regressed_verdict")).toBe(true);
        expect(report.errors).toHaveLength(0);
    });

    test("stale task (no marker found, task file >7 days old) → warning", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        const taskDir = join(root, ".ax", "tasks");
        mkdirSync(taskDir, { recursive: true });
        const taskFile = join(taskDir, "stale.md");
        writeFileSync(taskFile, "# old task");
        const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
        require("node:fs").utimesSync(taskFile, eightDaysAgo, eightDaysAgo);

        const rec: QueryRecorder = { calls: [] };
        const experimentFixture = [{
            id: "experiment:stale",
            short_id: "stale",
            status: "task_emitted",
            task_path: taskFile,
            locked_verdict: null,
            created_at: "2026-01-01T00:00:00.000Z",
        }];
        const program = lintFiles({ roots: [root], staleDays: 7 });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [experimentFixture]))),
        );
        expect(report.warnings.some((w) => w.rule === "stale_task")).toBe(true);
    });

    test("stale-task scan SQL filters by date cutoff (not JS-side only)", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        const rec: QueryRecorder = { calls: [] };
        const program = lintFiles({ roots: [root], staleDays: 7 });
        await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [[]]))),
        );
        // The stale-task SQL must include a date predicate pushed into SurrealQL
        const staleQuery = rec.calls.find((c) => /task_emitted/.test(c) && /task_path/.test(c));
        expect(staleQuery).toBeDefined();
        expect(staleQuery).toMatch(/created_at\s*<\s*d"/);
    });

    test("frontmatter ax_experiment routes reconcile to the exact experiment row", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        mkdirSync(join(root, "skills", "explicit"), { recursive: true });
        const skillFile = join(root, "skills", "explicit", "SKILL.md");
        writeFileSync(skillFile, `---\nname: x\nax_id: explicit\nax_experiment: experiment:explicit__v2\n---\nbody`);

        const rec: QueryRecorder = { calls: [] };
        // Query order: (1) explicit-experiment lookup, (2) stale-task scan.
        // No dedupe_sig batch is issued because the single target has ax_experiment set.
        const experimentRowsByExperimentId = [{
            id: "experiment:explicit__v2",
            short_id: "explicit",
            status: "task_emitted",
            task_path: null,
            locked_verdict: null,
        }];
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [experimentRowsByExperimentId, []]))),
        );
        expect(report.reconciled.some((r) => r.shortId === "explicit" && r.experimentId === "experiment:explicit__v2")).toBe(true);
    });

    test("inline guidance marker with multiple matching experiments → multi_experiment_ambiguous warning, no reconcile", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        writeFileSync(join(root, "CLAUDE.md"), "<!--ax:dup-->stuff<!--/ax:dup-->");
        const rec: QueryRecorder = { calls: [] };
        // Query order: (1) dedupe_sig batch (no explicit entries), (2) stale-task scan.
        const ambiguousRows = [
            { id: "experiment:dup__a", short_id: "dup", status: "task_emitted", task_path: null, locked_verdict: null },
            { id: "experiment:dup__b", short_id: "dup", status: "task_emitted", task_path: null, locked_verdict: null },
        ];
        const program = lintFiles({ roots: [root] });
        const report = await Effect.runPromise(
            program.pipe(Effect.provide(recordingLayer(rec, [ambiguousRows]))),
        );
        expect(report.warnings.some((w) => w.rule === "multi_experiment_ambiguous")).toBe(true);
        expect(report.reconciled.some((r) => r.shortId === "dup")).toBe(false);
    });

    test("DB update failure → task file survives and reconciled is empty", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
        const taskDir = join(root, ".ax", "tasks");
        mkdirSync(taskDir, { recursive: true });
        const taskFile = join(taskDir, "f1b2.md");
        writeFileSync(taskFile, "# pending task");
        writeFileSync(
            join(root, "CLAUDE.md"),
            "<!--ax:f1b2-->Use fd, not find.<!--/ax:f1b2-->",
        );
        const rec: QueryRecorder = { calls: [] };
        const experimentFixture = [{
            id: "experiment:xyz",
            short_id: "f1b2",
            status: "task_emitted",
            task_path: taskFile,
            locked_verdict: null,
        }];
        // SELECT query returns the fixture; the UPDATE query (containing 'scaffolded') fails
        const program = lintFiles({ roots: [root] });
        const result = await Effect.runPromise(
            program.pipe(
                Effect.provide(recordingLayerWithFailure(rec, [experimentFixture, []], /scaffolded/)),
                Effect.exit,
            ),
        );
        // The effect should have failed
        expect(result._tag).toBe("Failure");
        // Task file must still exist - unlink must NOT have been called before the DB update
        expect(fsExists(taskFile)).toBe(true);
    });
});
