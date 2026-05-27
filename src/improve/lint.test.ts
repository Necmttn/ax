import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { existsSync as fsExists } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { discoverFiles, lintFiles, type LintTarget, type LintReport } from "./lint.ts";

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
});
