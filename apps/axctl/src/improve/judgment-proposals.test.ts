import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Judgment, JudgmentLayer } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { listStoredProposals } from "./judgment-proposals.ts";

describe("listStoredProposals", () => {
    test("applies workflow filters before the SQL limit", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-proposal-reader-"));
        const layer = JudgmentLayer({
            sidecarPath: join(root, "judgment.sqlite"),
            schemaSql: SIDECAR_SCHEMA_SQL,
        });
        const rows = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            const old = new Date("2026-01-01T00:00:00Z");
            const recent = new Date("2026-02-01T00:00:00Z");
            for (let index = 0; index < 3; index += 1) {
                yield* judgment.put("proposal", {
                    id: `other-${index}`, form: "guidance", title: `Other ${index}`,
                    hypothesis: "unrelated", dedupe_sig: `other_${index}`, frequency: 10,
                    confidence: "high", status: "open", origin: "agent",
                    hypothesis_template: null, evidence_query: null, reject_reason: null,
                    baseline: null, created_at: recent, updated_at: recent,
                });
            }
            yield* judgment.put("proposal", {
                id: "workflow-one", form: "guidance", title: "Applied classifier result",
                hypothesis: "workflow evidence", dedupe_sig: "workflow_candidate__one", frequency: 1,
                confidence: "high", status: "open", origin: "agent",
                hypothesis_template: null, evidence_query: null, reject_reason: null,
                baseline: null, created_at: old, updated_at: null,
            });
            return yield* listStoredProposals({
                status: "open",
                dedupePrefixes: ["workflow_candidate__"],
                search: "classifier",
                limit: 1,
            });
        }).pipe(Effect.provide(layer), Effect.scoped));

        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe("workflow-one");
        expect(rows[0]?.updated_at).toBeNull();
    });
});
