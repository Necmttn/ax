import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Judgment, JudgmentLayer } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { acceptProposal, rejectProposal, setVerdict } from "./actions.ts";
import { lintFiles } from "./lint.ts";

describe("grounded files SQLite flow", () => {
    test("accepts, reconciles, and locks a verdict without SurrealDB", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-grounded-"));
        const layer = Layer.mergeAll(
            JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: SIDECAR_SCHEMA_SQL }),
            BunFileSystem.layer,
            BunPath.layer,
        );
        const result = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            const now = new Date("2026-01-01T00:00:00Z");
            yield* judgment.put("proposal", {
                id: "p1", form: "guidance", title: "Use rg", hypothesis: "grep is slow",
                dedupe_sig: "use-rg", frequency: 2, confidence: "high", status: "open", origin: "agent",
                hypothesis_template: null, evidence_query: null, reject_reason: null, baseline: null,
                created_at: now, updated_at: now,
            });
            yield* judgment.put("guidance_proposal", {
                id: "gp1", proposal: "p1", file_target: "CLAUDE.md", section: "tools", suggested_text: "Use rg.",
            });
            const accepted = yield* acceptProposal({ sigOrId: "use-rg", taskDir: root });
            writeFileSync(join(root, "CLAUDE.md"), "<!--ax:use-rg-->Use rg.<!--/ax:use-rg-->");
            const lint = yield* lintFiles({ roots: [root] });
            const experimentId = accepted.experiment_id!.replace(/^experiment:/, "");
            yield* judgment.put("checkpoint", {
                id: "cp1", experiment: experimentId, kind: "+3s", measured: "{}",
                suggested: "adopted", user_verdict: null, observed_at: now,
            });
            const verdict = yield* setVerdict({ sigOrId: "use-rg", verdict: "adopted" });
            return { accepted, lint, verdict };
        }).pipe(Effect.provide(layer), Effect.scoped));
        expect(result.accepted.status).toBe("ok");
        expect(result.lint.reconciled).toHaveLength(1);
        expect(existsSync(result.accepted.task_path!)).toBe(false);
        expect(result.verdict).toMatchObject({ status: "ok", verdict: "adopted" });
    });

    test("rejects an open proposal in SQLite", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-reject-"));
        const layer = JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: SIDECAR_SCHEMA_SQL });
        const result = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            const now = new Date();
            yield* judgment.put("proposal", {
                id: "p2", form: "guidance", title: "T", hypothesis: "H", dedupe_sig: "reject-me",
                frequency: 1, confidence: "low", status: "open", origin: "agent",
                hypothesis_template: null, evidence_query: null, reject_reason: null, baseline: null,
                created_at: now, updated_at: now,
            });
            return yield* rejectProposal({ sigOrId: "reject-me", reason: "not useful" });
        }).pipe(Effect.provide(layer), Effect.scoped));
        expect(result).toMatchObject({ status: "ok", reason: "not useful" });
    });
});
