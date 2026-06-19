import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { SurrealClient } from "@ax/lib/db";
import { DbError } from "@ax/lib/errors";
import { QuotaEnvTest } from "../quota/quota-env.ts";
import { writeDraft } from "./outbox.ts";
import { gatherReport, renderReport } from "./report.ts";
import type { ReportData } from "./report.ts";

const data: ReportData = {
    date: "2026-06-13",
    since: "2026-06-13T02:00:00.000Z",
    generated_at: "2026-06-13T05:00:00.000Z",
    budgetLine: "12% spendable (7d window, 27% left) [quota]",
    verdicts: [{ verdict: "confirmed", title: "Stop bare bun test", sig: "stop-bare-bun" }],
    proposals: [{ id: "proposal:p1", title: "Guard merges", form: "hook", dedupe_sig: "guard-merges" }],
    drafts: [{ file: "fix-x-deadbeef.md", path: "/o/fix-x-deadbeef.md", title: "Fix X", kind: "bug", created_at: "2026-06-13T04:00:00.000Z", session: null }],
    notes: "ran 4 laps",
};

describe("renderReport", () => {
    test("renders all sections with counts", () => {
        const md = renderReport(data);
        expect(md).toContain("# Dojo report - 2026-06-13");
        expect(md).toContain("ending budget: 12% spendable");
        expect(md).toContain("## Verdicts locked (1)");
        expect(md).toContain("- confirmed");
        expect(md).toContain("## Proposals created (1)");
        expect(md).toContain("## Outbox drafts pending review (1)");
        expect(md).toContain("## Notes\nran 4 laps");
        expect(md).toContain("Generated with [ax]");
        expect(md.trimEnd().endsWith("._")).toBe(true);
    });
    test("empty sections render '- (none)' and no Notes header when notes empty", () => {
        const md = renderReport({ ...data, verdicts: [], proposals: [], drafts: [], notes: "" });
        expect(md).toContain("## Verdicts locked (0)\n- (none)");
        expect(md).not.toContain("## Notes");
    });
});

// Fake SurrealClient: serves verdict-query rows then proposal-query rows.
const fakeDb = (...fixtures: unknown[][]) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(_: string) => Effect.succeed([(fixtures[i++] ?? [])] as unknown as T),
    } as never);
};

describe("gatherReport", () => {
    test("composes queries + outbox + quota under soft isolation", async () => {
        const outboxDir = mkdtempSync(`${tmpdir()}/dojo-report-`);
        const nowMs = Date.parse("2026-06-13T05:00:00.000Z");
        const sinceMs = Date.parse("2026-06-13T02:00:00.000Z");

        // gatherReport queries verdicts first, then proposals.
        const layer = Layer.mergeAll(
            fakeDb(
                [{ verdict: "confirmed", title: "Stop bare bun test", sig: "stop-bare-bun", observed_at: "2026-06-13T03:00:00Z" }],
                [{ id: "proposal:p1", title: "Guard merges", form: "hook", dedupe_sig: "guard-merges", created_at: "2026-06-13T03:00:00Z" }],
            ),
            BunFileSystem.layer,
            QuotaEnvTest({ token: null }).layer, // no token -> budget degrades, never aborts
        );

        const out = await Effect.runPromise(
            Effect.gen(function* () {
                yield* writeDraft({ title: "Fix X", kind: "bug", body: "repro", session: null, nowMs, outboxDir });
                return yield* gatherReport({ sinceMs, nowMs, notes: "ran 4 laps", outboxDir });
            }).pipe(Effect.provide(layer)) as Effect.Effect<ReportData, unknown, never>,
        );

        expect(out.date).toBe("2026-06-13");
        expect(out.since).toBe(new Date(sinceMs).toISOString());
        expect(out.notes).toBe("ran 4 laps");
        expect(out.verdicts).toEqual([{ verdict: "confirmed", title: "Stop bare bun test", sig: "stop-bare-bun" }]);
        expect(out.proposals).toEqual([{ id: "proposal:p1", title: "Guard merges", form: "hook", dedupe_sig: "guard-merges" }]);
        expect(out.drafts).toHaveLength(1);
        expect(out.drafts[0]).toMatchObject({ title: "Fix X", kind: "bug" });
        expect(out.budgetLine).toContain("spendable");
    });

	test("DB failure degrades to empty verdicts/proposals, never aborts", async () => {
	    const failDb = Layer.succeed(SurrealClient, {
	        query: <T>(_: string) =>
	            Effect.fail(new DbError({ operation: "query", message: "db down" })) as Effect.Effect<T, DbError>,
	    } as never);
        const nowMs = Date.parse("2026-06-13T05:00:00.000Z");
        const out = await Effect.runPromise(
            gatherReport({ sinceMs: nowMs - 3_600_000, nowMs, notes: "", outboxDir: "/no/such/dir" }).pipe(
                Effect.provide(Layer.mergeAll(failDb, BunFileSystem.layer, QuotaEnvTest({ token: null }).layer)),
            ) as Effect.Effect<ReportData, unknown, never>,
        );
        expect(out.verdicts).toEqual([]);
        expect(out.proposals).toEqual([]);
        expect(out.drafts).toEqual([]);
    });
});
