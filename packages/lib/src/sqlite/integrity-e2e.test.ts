// packages/lib/src/sqlite/integrity-e2e.test.ts
//
// Both engines, wired together, with nothing mocked: a REAL published DuckDB
// cache and a REAL SQLite sidecar in the same temp directory. integrity.test.ts
// covers the ref logic against a hand-built id index and needs no dylib; this
// suite proves the two seams actually meet - that a `SELECT id FROM skill`
// through `CacheRead` produces ids a judgment row can be checked against.
import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { join } from "node:path";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { publishCacheFixture } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { CacheRead, CacheReadLayer } from "../duckdb/seam.ts";
import { roleRowId } from "../stable-id.ts";
import { Judgment, JudgmentLayer, type JudgmentService } from "./index.ts";
import { checkSidecarRefs, collectSidecarRefs, fetchCacheIds } from "./integrity.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("judgment integrity e2e", { requireFts: true });

const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(Platform)) as Effect.Effect<A, E>);

/** The dylib the suite resolved, so the seam opens the same build. */
const dylibEnv = <A>(body: () => Promise<A>): Promise<A> => {
    const previous = process.env.AX_DUCKDB_DYLIB;
    if (dylibPath !== null) process.env.AX_DUCKDB_DYLIB = dylibPath;
    return body().finally(() => {
        if (previous === undefined) delete process.env.AX_DUCKDB_DYLIB;
        else process.env.AX_DUCKDB_DYLIB = previous;
    });
};

/** A cache `skill` row - every NOT NULL column the real DDL declares. */
const skillRow = (id: string) => ({
    id,
    name: "tdd",
    scope: "user",
    dir_path: "/tmp/skills/tdd",
    content_hash: "hash",
});

/** A role tag on `skillId`, plus the role it points at. */
const tagSkill = (j: JudgmentService, skillId: string) =>
    Effect.gen(function* () {
        yield* j.put("role", { id: roleRowId("reviewer"), name: "reviewer", weight: 2 });
        yield* j.put("plays_role", {
            id: "pr1",
            in_id: skillId,
            out_id: roleRowId("reviewer"),
            source: "user",
        });
    });

const checkAgainst = (snapshotPath: string, sidecarPath: string) =>
    Effect.gen(function* () {
        const j = yield* Judgment;
        const read = yield* CacheRead;
        const refs = yield* collectSidecarRefs(j);
        const ids = yield* fetchCacheIds(read);
        return checkSidecarRefs(refs, ids);
    }).pipe(
        Effect.scoped,
        Effect.provide(
            Layer.mergeAll(
                JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL }),
                CacheReadLayer({ snapshotPath, ...(dylibPath === null ? {} : { assetPath: dylibPath }) }),
            ),
        ),
    );

describe("judgment refs against a real published cache", () => {
    dtest("reports zero dangling refs when the cache still holds the tagged skill", async () => {
        const dir = tempDir("ax-integrity-clean-");
        const report = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const cache = yield* publishCacheFixture(dir, dylibPath, (write) =>
                        write.put("skill", skillRow("skill:tdd")),
                    );
                    const sidecarPath = join(dir, "judgment.sqlite");
                    yield* Effect.gen(function* () {
                        const j = yield* Judgment;
                        yield* tagSkill(j, "skill:tdd");
                    }).pipe(
                        Effect.scoped,
                        Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL })),
                    );
                    return yield* checkAgainst(cache.snapshotPath, sidecarPath);
                }),
            ),
        );
        expect(report.checked).toBe(1);
        expect(report.dangling).toBe(0);
        expect(report.ok).toBe(true);
    });

    dtest("names the surviving judgment row when a re-derive dropped the skill it tagged", async () => {
        // This is the failure the whole content-hash id contract exists to
        // prevent, so the check has to be able to SEE it: the sidecar keeps the
        // tag (it must - it is the user's decision), and the skill it named is
        // no longer in the rebuilt cache.
        const dir = tempDir("ax-integrity-dangling-");
        const report = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const cache = yield* publishCacheFixture(dir, dylibPath, (write) =>
                        write.put("skill", skillRow("skill:renamed-by-a-rederive")),
                    );
                    const sidecarPath = join(dir, "judgment.sqlite");
                    yield* Effect.gen(function* () {
                        const j = yield* Judgment;
                        yield* tagSkill(j, "skill:tdd");
                    }).pipe(
                        Effect.scoped,
                        Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL })),
                    );
                    return yield* checkAgainst(cache.snapshotPath, sidecarPath);
                }),
            ),
        );
        expect(report.ok).toBe(false);
        expect(report.dangling).toBe(1);
        expect(report.byTargetTable).toEqual({ skill: 1 });
        expect(report.samples[0]?.sidecarTable).toBe("plays_role");
        expect(report.samples[0]?.sidecarId).toBe("pr1");
        expect(report.samples[0]?.reason).toBe("missing_id");
    });
});
