import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Judgment, JudgmentLayer } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { discoverFiles, lintFiles } from "./lint.ts";

const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
    mkdirSync(join(root, "skills", "foo"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# guidance");
    writeFileSync(join(root, "skills", "foo", "SKILL.md"), "---\n---\nbody");
    return root;
};

const sidecarLayer = (root: string) => Layer.mergeAll(
    JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: SIDECAR_SCHEMA_SQL }),
    BunFileSystem.layer,
    BunPath.layer,
);

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
});
