/**
 * Role reads across BOTH v2 engines, with nothing stubbed.
 *
 * These three fetchers are the first read surface whose answer is a JOIN ACROSS
 * ENGINES: the tags live in the SQLite sidecar (a user's decision), the skill
 * names and invocation counts live in the DuckDB cache (derived from disk). A
 * stub-based test - which is what this file used to be - can assert the SQL text
 * of either half and still not notice that the two halves no longer meet, which
 * is the only interesting way this code can now break. So every case here builds
 * a real published cache and a real sidecar in a temp directory.
 */
import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { join } from "node:path";
import { CacheReadLayer } from "@ax/lib/duckdb/seam";
import { Judgment, JudgmentLayer, type JudgmentService } from "@ax/lib/sqlite";
import { roleRowId } from "@ax/lib/stable-id";
import { publishCacheFixture } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { fetchAllRoles, fetchRolesForSkill, fetchSkillsByRole } from "./role-queries.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("role queries", { requireFts: true });

const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(Platform)) as Effect.Effect<A, E>);

const dylibEnv = <A>(body: () => Promise<A>): Promise<A> => {
    const previous = process.env.AX_DUCKDB_DYLIB;
    if (dylibPath !== null) process.env.AX_DUCKDB_DYLIB = dylibPath;
    return body().finally(() => {
        if (previous === undefined) delete process.env.AX_DUCKDB_DYLIB;
        else process.env.AX_DUCKDB_DYLIB = previous;
    });
};

const skillRow = (id: string, name: string) => ({
    id,
    name,
    scope: "user",
    dir_path: `/tmp/skills/${name}`,
    content_hash: `hash-${name}`,
});

/**
 * Two skills in the cache, one invoked twice and one never; role tags on both in
 * the sidecar. Returns the layers a fetcher needs.
 */
const fixture = (dir: string) =>
    Effect.gen(function* () {
        const cache = yield* publishCacheFixture(dir, dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("skill", [
                    skillRow("skill:tdd", "tdd"),
                    skillRow("skill:brainstorming", "brainstorming"),
                ]);
                // `invoked` is turn -> skill; only the counts matter here.
                yield* write.putMany("invoked", [
                    { id: "inv1", in_id: "turn:1", out_id: "skill:tdd", ts: new Date() },
                    { id: "inv2", in_id: "turn:2", out_id: "skill:tdd", ts: new Date() },
                ]);
            }),
        );
        const sidecarPath = join(dir, "judgment.sqlite");
        const judgmentLayer = JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL });
        yield* Effect.gen(function* () {
            const j: JudgmentService = yield* Judgment;
            yield* j.putMany("role", [
                { id: roleRowId("verification"), name: "verification", weight: 2 },
                { id: roleRowId("framing"), name: "framing", weight: 1 },
            ]);
            yield* j.putMany("plays_role", [
                {
                    id: "pr1",
                    in_id: "skill:tdd",
                    out_id: roleRowId("verification"),
                    source: "user",
                    confidence: 0.9,
                    rationale: "the whole point of it",
                    weight: null,
                },
                {
                    id: "pr2",
                    in_id: "skill:brainstorming",
                    out_id: roleRowId("verification"),
                    source: "frontmatter",
                    confidence: 0.4,
                    rationale: null,
                    weight: 3,
                },
                {
                    id: "pr3",
                    in_id: "skill:brainstorming",
                    out_id: roleRowId("framing"),
                    source: "user",
                    confidence: 1,
                    rationale: null,
                    weight: null,
                },
            ]);
        }).pipe(Effect.scoped, Effect.provide(judgmentLayer));

        return Layer.mergeAll(
            judgmentLayer,
            CacheReadLayer({
                snapshotPath: cache.snapshotPath,
                ...(dylibPath === null ? {} : { assetPath: dylibPath }),
            }),
        );
    });

describe("fetchSkillsByRole", () => {
    dtest("names each tagged skill from the CACHE and ranks by its invocations", async () => {
        const dir = tempDir("ax-roles-by-role-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const layers = yield* fixture(dir);
                    return yield* fetchSkillsByRole({ role: "verification", limit: 50 }).pipe(
                        Effect.scoped,
                        Effect.provide(layers),
                    );
                }),
            ),
        );
        expect(result.found).toBe(true);
        // The name comes from the cache: the sidecar only stores the skill ID.
        expect(result.rows.map((r) => r.skill_name)).toEqual(["tdd", "brainstorming"]);
        expect(result.rows[0]?.invocations).toBe(2);
        expect(result.rows[1]?.invocations).toBe(0);
        expect(result.rows[0]?.source).toBe("user");
        expect(result.rows[0]?.confidence).toBeCloseTo(0.9);
        expect(result.rows[0]?.rationale).toBe("the whole point of it");
        expect(result.rows[1]?.rationale).toBeNull();
    });

    dtest("honours the limit", async () => {
        const dir = tempDir("ax-roles-limit-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const layers = yield* fixture(dir);
                    return yield* fetchSkillsByRole({ role: "verification", limit: 1 }).pipe(
                        Effect.scoped,
                        Effect.provide(layers),
                    );
                }),
            ),
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.skill_name).toBe("tdd");
    });

    dtest("reports not-found for a role nobody tagged", async () => {
        const dir = tempDir("ax-roles-empty-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const layers = yield* fixture(dir);
                    return yield* fetchSkillsByRole({ role: "nonesuch", limit: 50 }).pipe(
                        Effect.scoped,
                        Effect.provide(layers),
                    );
                }),
            ),
        );
        expect(result.rows).toEqual([]);
        expect(result.found).toBe(false);
    });

    dtest("keeps a tag whose skill the cache no longer has, and says so", async () => {
        // The dangling case is a REAL state (a re-derive dropped the skill), and
        // the tag survives it by design. Dropping the row would hide a decision
        // the user made; inventing a name would be a lie. The id is what is
        // known, so the id is what is shown.
        const dir = tempDir("ax-roles-dangling-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const cache = yield* publishCacheFixture(dir, dylibPath, (write) =>
                        write.put("skill", skillRow("skill:something-else", "something-else")),
                    );
                    const sidecarPath = join(dir, "judgment.sqlite");
                    const judgmentLayer = JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL });
                    yield* Effect.gen(function* () {
                        const j: JudgmentService = yield* Judgment;
                        yield* j.put("role", { id: roleRowId("verification"), name: "verification" });
                        yield* j.put("plays_role", {
                            id: "pr1",
                            in_id: "skill:gone",
                            out_id: roleRowId("verification"),
                            source: "user",
                        });
                    }).pipe(Effect.scoped, Effect.provide(judgmentLayer));

                    return yield* fetchSkillsByRole({ role: "verification", limit: 50 }).pipe(
                        Effect.scoped,
                        Effect.provide(
                            Layer.mergeAll(
                                judgmentLayer,
                                CacheReadLayer({
                                    snapshotPath: cache.snapshotPath,
                                    ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                                }),
                            ),
                        ),
                    );
                }),
            ),
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.skill_id).toBe("skill:gone");
        expect(result.rows[0]?.skill_name).toBe("");
    });
});

describe("fetchRolesForSkill", () => {
    dtest("lists a skill's roles with the role's own weight and the edge override", async () => {
        const dir = tempDir("ax-roles-for-skill-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const layers = yield* fixture(dir);
                    return yield* fetchRolesForSkill({ skill: "brainstorming" }).pipe(
                        Effect.scoped,
                        Effect.provide(layers),
                    );
                }),
            ),
        );
        expect(result.skillExists).toBe(true);
        expect(result.rows.map((r) => r.role_name)).toEqual(["framing", "verification"]);
        const verification = result.rows.find((r) => r.role_name === "verification");
        expect(verification?.role_weight).toBe(2);
        expect(verification?.edge_weight_override).toBe(3);
        expect(verification?.since).not.toBeNull();
        expect(result.rows.find((r) => r.role_name === "framing")?.edge_weight_override).toBeNull();
    });

    dtest("reports a skill the CACHE has never heard of as absent", async () => {
        const dir = tempDir("ax-roles-unknown-skill-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const layers = yield* fixture(dir);
                    return yield* fetchRolesForSkill({ skill: "never-installed" }).pipe(
                        Effect.scoped,
                        Effect.provide(layers),
                    );
                }),
            ),
        );
        expect(result.skillExists).toBe(false);
        expect(result.rows).toEqual([]);
    });
});

describe("fetchAllRoles", () => {
    dtest("counts tagged skills per role, busiest first, WITHOUT touching the cache", async () => {
        // Both halves of this answer are judgment, so it needs no cache at all -
        // which is what lets `ax roles` run on a machine with no snapshot and no
        // SurrealDB (see roles-no-surreal.test.ts).
        const dir = tempDir("ax-roles-all-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const layers = yield* fixture(dir);
                    return yield* fetchAllRoles().pipe(Effect.scoped, Effect.provide(layers));
                }),
            ),
        );
        expect(result.rows.map((r) => [r.name, r.skill_count])).toEqual([
            ["verification", 2],
            ["framing", 1],
        ]);
        expect(result.rows[0]?.weight).toBe(2);
    });

    dtest("lists a role nobody has tagged yet with a zero count", async () => {
        const dir = tempDir("ax-roles-zero-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const sidecarPath = join(dir, "judgment.sqlite");
                    const judgmentLayer = JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL });
                    return yield* Effect.gen(function* () {
                        const j: JudgmentService = yield* Judgment;
                        yield* j.put("role", { id: roleRowId("orphan"), name: "orphan", weight: 1.5 });
                        return yield* fetchAllRoles();
                    }).pipe(Effect.scoped, Effect.provide(judgmentLayer));
                }),
            ),
        );
        expect(result.rows).toEqual([{ name: "orphan", weight: 1.5, skill_count: 0 }]);
    });

    dtest("counts one skill once when two sources assign the same role", async () => {
        const dir = tempDir("ax-roles-distinct-count-");
        const result = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const layers = yield* fixture(dir);
                    yield* Effect.gen(function* () {
                        const judgment = yield* Judgment;
                        yield* judgment.put("plays_role", {
                            id: "pr-user-and-mined",
                            in_id: "skill:tdd",
                            out_id: roleRowId("verification"),
                            source: "frontmatter",
                            confidence: 0.8,
                        });
                    }).pipe(Effect.scoped, Effect.provide(layers));
                    return yield* fetchAllRoles().pipe(Effect.scoped, Effect.provide(layers));
                }),
            ),
        );

        expect(result.rows.find((r) => r.name === "verification")?.skill_count).toBe(2);
    });
});
