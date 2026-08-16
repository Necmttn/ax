// packages/lib/src/sqlite/integrity.test.ts
//
// The cross-engine half of the integrity check, against a REAL sidecar. The
// cache side is supplied as a plain id index here, so this suite needs no dylib
// and runs everywhere; the two engines are wired together end-to-end in
// integrity-e2e.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { buildCacheIdIndex } from "../cache-integrity.ts";
import { roleRowId } from "../stable-id.ts";
import { Judgment, JudgmentLayer, type JudgmentService } from "./index.ts";
import { collectSidecarRefs, SIDECAR_CACHE_REFS, checkSidecarRefs } from "./integrity.ts";

let dir: string;
let sidecarPath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ax-judgment-refs-"));
    sidecarPath = join(dir, "judgment.sqlite");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

const run = <A, E>(body: (j: JudgmentService) => Effect.Effect<A, E, never>): Promise<A> =>
    Effect.runPromise(
        Effect.gen(function* () {
            const j = yield* Judgment;
            return yield* body(j);
        }).pipe(
            Effect.scoped,
            Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL })),
        ) as Effect.Effect<A, E>,
    );

/** One row in each table that carries a ref into the cache. */
const seedJudgment = (j: JudgmentService) =>
    Effect.gen(function* () {
        yield* j.put("proposal", {
            id: "p1",
            form: "skill",
            title: "t",
            hypothesis: "h",
            dedupe_sig: "sig",
            confidence: "high",
        });
        yield* j.put("experiment", { id: "e1", proposal: "p1", artifact: "skill:tdd" });
        yield* j.put("role", { id: roleRowId("reviewer"), name: "reviewer" });
        yield* j.put("plays_role", {
            id: "pr1",
            in_id: "skill:tdd",
            out_id: roleRowId("reviewer"),
            source: "user",
        });
        yield* j.put("retro", {
            id: "r1",
            session: "session:abc",
            source: "manual",
            tried: "the port",
            repository: "repository:ax",
        });
        yield* j.put("dogfood_run", {
            id: "d1",
            run_id: "run-1",
            scenario: "install",
            driver: "wterm",
            status: "passed",
            transcript_artifact: "artifact:log",
            started_at: new Date("2026-08-15T00:00:00.000Z"),
            ended_at: new Date("2026-08-15T00:01:00.000Z"),
        });
        yield* j.put("session_label", { id: "sl1", session_id: "session:abc", label: "spar" });
    });

describe("SIDECAR_CACHE_REFS", () => {
    test("declares only refs the v1 schema actually TYPED as record<T>", () => {
        // `transcript_label_review.candidate_id` and `.graph_fact_id` LOOK like
        // refs and are plain `string` in schema.surql - a mined candidate id, not
        // a row id in any cache table. Declaring a target table for them would be
        // an inference, and every review row would then read as dangling.
        const declared = SIDECAR_CACHE_REFS.flatMap((r) => `${r.sidecarTable}.${r.column}`);
        expect(declared.sort()).toEqual(
            [
                "dogfood_run.transcript_artifact",
                "experiment.artifact",
                "plays_role.in_id",
                "retro.repository",
                "retro.session",
                "session_label.session_id",
            ].sort(),
        );
    });

    test("names no sidecar table as a ref target - these are CROSS-engine refs only", () => {
        // `experiment.proposal` and `checkpoint.experiment` are refs too, but
        // both endpoints live in the sidecar, so a cache rebuild cannot break
        // them and this check would report every one as an unknown table.
        for (const ref of SIDECAR_CACHE_REFS) {
            expect(["skill", "session", "repository", "artifact"]).toContain(ref.targetTable);
        }
    });
});

describe("collectSidecarRefs", () => {
    test("reads one ref per non-null value, across every declared table", async () => {
        const refs = await run((j) => Effect.andThen(seedJudgment(j), collectSidecarRefs(j)));
        expect(
            refs.map((r) => `${r.sidecarTable}.${r.column}->${r.targetTable}:${r.targetId}`).sort(),
        ).toEqual(
            [
                "dogfood_run.transcript_artifact->artifact:artifact:log",
                "experiment.artifact->skill:skill:tdd",
                "plays_role.in_id->skill:skill:tdd",
                "retro.repository->repository:repository:ax",
                "retro.session->session:session:abc",
                "session_label.session_id->session:session:abc",
            ].sort(),
        );
    });

    test("skips a NULL optional ref instead of reporting it as dangling", async () => {
        const refs = await run((j) =>
            Effect.gen(function* () {
                yield* j.put("proposal", {
                    id: "p1",
                    form: "hook",
                    title: "t",
                    hypothesis: "h",
                    dedupe_sig: "sig",
                    confidence: "low",
                });
                // A hook-form experiment has no skill artifact at all.
                yield* j.put("experiment", { id: "e1", proposal: "p1", artifact: null });
                return yield* collectSidecarRefs(j);
            }),
        );
        expect(refs).toEqual([]);
    });

    test("carries the sidecar row's own id, so a dangling ref names the decision that broke", async () => {
        const refs = await run((j) => Effect.andThen(seedJudgment(j), collectSidecarRefs(j)));
        const tag = refs.find((r) => r.sidecarTable === "plays_role");
        expect(tag?.sidecarId).toBe("pr1");
    });
});

describe("checkSidecarRefs", () => {
    test("reports a clean sidecar when every ref resolves in the cache", async () => {
        const report = await run((j) =>
            Effect.andThen(
                seedJudgment(j),
                Effect.map(collectSidecarRefs(j), (refs) =>
                    checkSidecarRefs(
                        refs,
                        buildCacheIdIndex([
                            { table: "skill", id: "skill:tdd" },
                            { table: "session", id: "session:abc" },
                            { table: "repository", id: "repository:ax" },
                            { table: "artifact", id: "artifact:log" },
                        ]),
                    ),
                ),
            ),
        );
        expect(report.ok).toBe(true);
        expect(report.checked).toBe(6);
        expect(report.dangling).toBe(0);
    });

    test("counts a re-derive that dropped a skill as a missing id, not an unknown table", async () => {
        // The distinction matters: `missing_id` means "the cache no longer holds
        // that row" (the re-derive dropped it, or the id contract changed);
        // `unknown_table` means "ax does not have that table at all", which is a
        // schema bug, not a data one. A cache whose `skill` table happens to be
        // EMPTY must still report missing_id - which is what knownTables buys.
        const report = await run((j) =>
            Effect.andThen(
                seedJudgment(j),
                Effect.map(collectSidecarRefs(j), (refs) =>
                    checkSidecarRefs(
                        refs,
                        buildCacheIdIndex([
                            { table: "session", id: "session:abc" },
                            { table: "repository", id: "repository:ax" },
                            { table: "artifact", id: "artifact:log" },
                        ]),
                    ),
                ),
            ),
        );
        expect(report.ok).toBe(false);
        expect(report.dangling).toBe(2); // experiment.artifact + plays_role.in_id
        expect(report.byTargetTable).toEqual({ skill: 2 });
        expect(report.samples.every((s) => s.reason === "missing_id")).toBe(true);
    });
});
