import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Judgment, JudgmentLayer, type JudgmentService } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { discoverFiles, lintFiles } from "./lint.ts";

const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
    mkdirSync(join(root, "skills", "foo"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# guidance");
    writeFileSync(join(root, "skills", "foo", "SKILL.md"), "---\n---\nbody");
    return root;
};

const sidecarLayer = (root: string, schemaSuffix = "") => Layer.mergeAll(
    JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: `${SIDECAR_SCHEMA_SQL}\n${schemaSuffix}` }),
    BunFileSystem.layer,
    BunPath.layer,
);

const seedExperiment = (
    judgment: JudgmentService,
    input: {
        readonly proposalId?: string;
        readonly experimentId?: string;
        readonly sig: string;
        readonly status?: string;
        readonly taskPath?: string | null;
        readonly lockedVerdict?: string | null;
        readonly createdAt?: Date;
    },
) => Effect.gen(function* () {
    const proposalId = input.proposalId ?? `proposal-${input.sig}`;
    const now = input.createdAt ?? new Date("2026-01-01T00:00:00Z");
    yield* judgment.put("proposal", {
        id: proposalId,
        form: "guidance",
        title: input.sig,
        hypothesis: "test",
        dedupe_sig: input.sig,
        frequency: 1,
        confidence: "high",
        status: "accepted",
        origin: "agent",
        hypothesis_template: null,
        evidence_query: null,
        reject_reason: null,
        baseline: null,
        created_at: now,
        updated_at: now,
    });
    yield* judgment.put("experiment", {
        id: input.experimentId ?? `experiment-${input.sig}`,
        proposal: proposalId,
        artifact: null,
        artifact_path: null,
        scaffolded_at: null,
        created_at: now,
        locked_verdict: input.lockedVerdict ?? null,
        status: input.status ?? "task_emitted",
        task_path: input.taskPath ?? null,
    });
});

describe("discoverFiles", () => {
    test("finds guidance and skill files", async () => {
        const root = makeRoot();
        const rows = await Effect.runPromise(discoverFiles({ roots: [root] }).pipe(
            Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
        ));
        expect(rows.map((row) => row.form)).toContain("guidance");
        expect(rows.map((row) => row.form)).toContain("skill");
    });
});

describe("lintFiles", () => {
    test("reconciles a marker with a real SQLite experiment", async () => {
        const root = makeRoot();
        const taskPath = join(root, "task.md");
        writeFileSync(taskPath, "pending");
        writeFileSync(join(root, "CLAUDE.md"), "<!--ax:e7f3-->Use ripgrep.<!--/ax:e7f3-->");
        const layer = sidecarLayer(root);
        const report = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            const now = new Date("2026-01-01T00:00:00Z");
            yield* judgment.put("proposal", {
                id: "p1", form: "guidance", title: "T", hypothesis: "H", dedupe_sig: "e7f3",
                frequency: 1, confidence: "high", status: "accepted", origin: "agent",
                hypothesis_template: null, evidence_query: null, reject_reason: null, baseline: null,
                created_at: now, updated_at: now,
            });
            yield* judgment.put("experiment", {
                id: "e1", proposal: "p1", artifact: null, artifact_path: null,
                scaffolded_at: null, created_at: now, locked_verdict: null,
                status: "task_emitted", task_path: taskPath,
            });
            return yield* lintFiles({ roots: [root] });
        }).pipe(Effect.provide(layer), Effect.scoped));
        expect(report.reconciled).toHaveLength(1);
        expect(existsSync(taskPath)).toBe(false);
        expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("ax:e7f3");
    });

    test("reports an orphan marker", async () => {
        const root = makeRoot();
        writeFileSync(join(root, "CLAUDE.md"), "<!--ax:missing-->Text<!--/ax:missing-->");
        const report = await Effect.runPromise(lintFiles({ roots: [root] }).pipe(
            Effect.provide(sidecarLayer(root)), Effect.scoped,
        ));
        expect(report.warnings.some((item) => item.rule === "orphan_id")).toBe(true);
    });

    test("keeps the task file when the SQLite update fails", async () => {
        const root = makeRoot();
        const taskPath = join(root, "pending.md");
        writeFileSync(taskPath, "pending");
        writeFileSync(join(root, "CLAUDE.md"), "<!--ax:failure-->Text<!--/ax:failure-->");
        const result = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* seedExperiment(judgment, { sig: "failure", taskPath });
            return yield* lintFiles({ roots: [root] }).pipe(Effect.exit);
        }).pipe(Effect.provide(sidecarLayer(root, `CREATE TRIGGER fail_scaffold BEFORE UPDATE ON experiment
            BEGIN SELECT RAISE(FAIL, 'simulated SQLite failure'); END;`)), Effect.scoped));
        expect(result._tag).toBe("Failure");
        expect(existsSync(taskPath)).toBe(true);
    });

    test("reports a stale task from SQLite", async () => {
        const root = makeRoot();
        const taskPath = join(root, "stale.md");
        writeFileSync(taskPath, "pending");
        const old = new Date(Date.now() - 8 * 86_400_000);
        utimesSync(taskPath, old, old);
        const report = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* seedExperiment(judgment, { sig: "stale", taskPath, createdAt: old });
            return yield* lintFiles({ roots: [root], staleDays: 7 });
        }).pipe(Effect.provide(sidecarLayer(root)), Effect.scoped));
        expect(report.warnings.some((item) => item.rule === "stale_task")).toBe(true);
    });

    test("uses the explicit experiment ID in skill frontmatter", async () => {
        const root = makeRoot();
        mkdirSync(join(root, "skills", "explicit"), { recursive: true });
        writeFileSync(
            join(root, "skills", "explicit", "SKILL.md"),
            "---\nname: explicit\nax_id: explicit\nax_experiment: experiment:exact-id\n---\nbody",
        );
        const report = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* seedExperiment(judgment, { sig: "explicit", experimentId: "exact-id" });
            return yield* lintFiles({ roots: [root] });
        }).pipe(Effect.provide(sidecarLayer(root)), Effect.scoped));
        expect(report.reconciled).toContainEqual(expect.objectContaining({
            shortId: "explicit",
            experimentId: "exact-id",
        }));
    });

    test("reconciles hook and automation marker forms", async () => {
        const root = makeRoot();
        mkdirSync(join(root, "LaunchAgents"), { recursive: true });
        writeFileSync(join(root, "settings.json"), JSON.stringify({
            hooks: { PreToolUse: [{ command: "echo 'ax:hook_sig'" }] },
        }));
        writeFileSync(
            join(root, "LaunchAgents", "com.ax.test.plist"),
            "<!-- ax:auto_sig experiment:experiment:auto-id -->",
        );
        const report = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* seedExperiment(judgment, { sig: "hook_sig", experimentId: "hook-id" });
            yield* seedExperiment(judgment, { sig: "auto_sig", experimentId: "auto-id" });
            return yield* lintFiles({ roots: [root] });
        }).pipe(Effect.provide(sidecarLayer(root)), Effect.scoped));
        expect(report.reconciled.map((item) => item.shortId).sort()).toEqual(["auto_sig", "hook_sig"]);
    });

    test("prevents ambiguous experiments for one proposal", async () => {
        const root = makeRoot();
        const result = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* seedExperiment(judgment, { sig: "unique", experimentId: "first" });
            return yield* judgment.put("experiment", {
                id: "second",
                proposal: "proposal-unique",
                artifact: null,
                artifact_path: null,
                scaffolded_at: null,
                created_at: new Date(),
                locked_verdict: null,
                status: "task_emitted",
                task_path: null,
            }).pipe(Effect.exit);
        }).pipe(Effect.provide(sidecarLayer(root)), Effect.scoped));
        expect(result._tag).toBe("Failure");
    });
});
