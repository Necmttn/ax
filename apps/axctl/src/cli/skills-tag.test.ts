/**
 * `ax skills tag <skill> <role>` across both v2 engines, with nothing stubbed.
 *
 * The old version of this file asserted the SQL TEXT of the statements the
 * command issued against a stub. That could tell a working DELETE from a
 * misspelled one and nothing else - in particular it could not tell whether the
 * command was IDEMPOTENT, which is the whole contract of `skills tag`, because
 * "issued a DELETE then a RELATE" is what you observe whether or not the row
 * ends up singular. Every case here reads the rows back.
 */
import { describe, expect, mock } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { join } from "node:path";
import { CacheReadLayer } from "@ax/lib/duckdb/seam";
import { Judgment, JudgmentLayer, type JudgmentService } from "@ax/lib/sqlite";
import { publishCacheFixture } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { cmdSkillsTag } from "./skills-tag.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skills tag", { requireFts: true });

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

const TagRow = Schema.Struct({
    in_id: Schema.String,
    role_name: Schema.String,
    source: Schema.String,
    confidence: Schema.Number,
    rationale: Schema.NullOr(Schema.String),
});

/** Every plays_role row in the sidecar, joined to its role's name. */
const readTags = (j: JudgmentService) =>
    j.rows(
        TagRow,
        `SELECT pr.in_id AS in_id, r.name AS role_name, pr.source AS source,
                pr.confidence AS confidence, pr.rationale AS rationale
         FROM plays_role pr JOIN role r ON r.id = pr.out_id
         ORDER BY r.name`,
    );

interface Harness {
    readonly tag: (opts: Parameters<typeof cmdSkillsTag>[0]) => Effect.Effect<void, unknown>;
    readonly tags: Effect.Effect<ReadonlyArray<typeof TagRow.Type>, unknown>;
}

/** A cache holding one installed skill, plus an empty sidecar. */
const harness = (dir: string) =>
    Effect.gen(function* () {
        const cache = yield* publishCacheFixture(dir, dylibPath, (write) =>
            write.put("skill", {
                id: "skill:content-hashed-id",
                name: "composto",
                scope: "user",
                dir_path: "/tmp/skills/composto",
                content_hash: "hash",
            }),
        );
        const layers = Layer.mergeAll(
            JudgmentLayer({ sidecarPath: join(dir, "judgment.sqlite"), schemaSql: SIDECAR_SCHEMA_SQL }),
            CacheReadLayer({
                snapshotPath: cache.snapshotPath,
                ...(dylibPath === null ? {} : { assetPath: dylibPath }),
            }),
        );
        return {
            tag: (opts) => cmdSkillsTag(opts).pipe(Effect.scoped, Effect.provide(layers)),
            tags: Effect.gen(function* () {
                const j = yield* Judgment;
                return yield* readTags(j);
            }).pipe(Effect.scoped, Effect.provide(layers)),
        } satisfies Harness;
    });

/** `fail()` calls `process.exit`, which returns `never` and so must THROW here
 *  for the effect to stop - otherwise the command would carry on and write. */
const withExitSpy = () => {
    const spy = mock(() => {
        throw new Error("process.exit(2)");
    });
    const original = process.exit;
    (process as { exit: unknown }).exit = spy;
    return {
        spy,
        restore: () => {
            (process as { exit: unknown }).exit = original;
        },
    };
};

const baseOpts = {
    skillName: "composto",
    roleName: "verification",
    confidence: 1,
    rationale: undefined,
    remove: false,
};

describe("cmdSkillsTag", () => {
    dtest("records the tag against the skill's CACHE id, not its name", async () => {
        // The name is the user's handle for the skill; the id is what survives a
        // rename in the catalogue, and what the read side joins on.
        const dir = tempDir("ax-tag-basic-");
        const tags = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const h = yield* harness(dir);
                    yield* h.tag(baseOpts);
                    return yield* h.tags;
                }),
            ),
        );
        expect(tags).toHaveLength(1);
        expect(tags[0]?.in_id).toBe("skill:content-hashed-id");
        expect(tags[0]?.role_name).toBe("verification");
        expect(tags[0]?.source).toBe("user");
    });

    dtest("is idempotent - tagging the same pair twice leaves ONE row", async () => {
        const dir = tempDir("ax-tag-idempotent-");
        const tags = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const h = yield* harness(dir);
                    yield* h.tag({ ...baseOpts, confidence: 0.5 });
                    yield* h.tag({ ...baseOpts, confidence: 0.9, rationale: "second thoughts" });
                    return yield* h.tags;
                }),
            ),
        );
        expect(tags).toHaveLength(1);
        expect(tags[0]?.confidence).toBeCloseTo(0.9);
        expect(tags[0]?.rationale).toBe("second thoughts");
    });

    dtest("adds a second role without disturbing the first", async () => {
        const dir = tempDir("ax-tag-two-roles-");
        const tags = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const h = yield* harness(dir);
                    yield* h.tag(baseOpts);
                    yield* h.tag({ ...baseOpts, roleName: "framing" });
                    return yield* h.tags;
                }),
            ),
        );
        expect(tags.map((t) => t.role_name)).toEqual(["framing", "verification"]);
    });

    dtest("--remove deletes the tag and leaves nothing behind", async () => {
        const dir = tempDir("ax-tag-remove-");
        const tags = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const h = yield* harness(dir);
                    yield* h.tag(baseOpts);
                    yield* h.tag({ ...baseOpts, remove: true });
                    return yield* h.tags;
                }),
            ),
        );
        expect(tags).toEqual([]);
    });

    dtest("removes only the USER's tag, never a mined one", async () => {
        // A user removing their own tag must not silently delete the classifier's
        // opinion of the same skill; v1 scoped its DELETE with `source = "user"`
        // and losing that in the port would quietly erase mined classifications.
        const dir = tempDir("ax-tag-remove-scope-");
        const tags = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const h = yield* harness(dir);
                    const layers = JudgmentLayer({
                        sidecarPath: join(dir, "judgment.sqlite"),
                        schemaSql: SIDECAR_SCHEMA_SQL,
                    });
                    yield* Effect.gen(function* () {
                        const j = yield* Judgment;
                        yield* j.put("role", { id: "role:framing", name: "framing" });
                        yield* j.put("plays_role", {
                            id: "mined-1",
                            in_id: "skill:content-hashed-id",
                            out_id: "role:framing",
                            source: "frontmatter",
                            confidence: 0.7,
                        });
                    }).pipe(Effect.scoped, Effect.provide(layers));

                    yield* h.tag({ ...baseOpts, roleName: "framing", remove: true });
                    return yield* h.tags;
                }),
            ),
        );
        expect(tags).toHaveLength(1);
        expect(tags[0]?.source).toBe("frontmatter");
    });

    dtest("adds a user tag without replacing a mined tag for the same skill and role", async () => {
        const dir = tempDir("ax-tag-source-coexistence-");
        const tags = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const h = yield* harness(dir);
                    const layers = JudgmentLayer({
                        sidecarPath: join(dir, "judgment.sqlite"),
                        schemaSql: SIDECAR_SCHEMA_SQL,
                    });
                    yield* Effect.gen(function* () {
                        const j = yield* Judgment;
                        yield* j.put("role", {
                            id: "role:verification",
                            name: "verification",
                        });
                        yield* j.put("plays_role", {
                            id: "mined-verification",
                            in_id: "skill:content-hashed-id",
                            out_id: "role:verification",
                            source: "frontmatter",
                            confidence: 0.7,
                        });
                    }).pipe(Effect.scoped, Effect.provide(layers));

                    yield* h.tag(baseOpts);
                    return yield* h.tags;
                }),
            ),
        );

        expect(tags.map((tag) => tag.source).sort()).toEqual(["frontmatter", "user"]);
    });

    dtest("keeps the role's own weight when a second skill is tagged with it", async () => {
        // A regression pin, not a bug report: the current write already preserves
        // the weight (the seam's upsert writes only the columns it is given, and
        // this one gives id + name). What it pins is that tagging a skill is not
        // a statement about the ROLE - a future write that started naming
        // `weight` would reset a user's tuning and silently re-rank every
        // weighted view, and nothing else in the suite would notice.
        const dir = tempDir("ax-tag-role-weight-");
        const weight = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const h = yield* harness(dir);
                    const layers = JudgmentLayer({
                        sidecarPath: join(dir, "judgment.sqlite"),
                        schemaSql: SIDECAR_SCHEMA_SQL,
                    });
                    yield* Effect.gen(function* () {
                        const j = yield* Judgment;
                        yield* j.put("role", { id: "role:verification", name: "verification", weight: 3 });
                    }).pipe(Effect.scoped, Effect.provide(layers));

                    yield* h.tag(baseOpts);

                    return yield* Effect.gen(function* () {
                        const j = yield* Judgment;
                        return yield* j.first(
                            Schema.Struct({ weight: Schema.Number }),
                            "SELECT weight FROM role WHERE name = 'verification'",
                        );
                    }).pipe(Effect.scoped, Effect.provide(layers));
                }),
            ),
        );
        expect(weight._tag === "Some" ? weight.value.weight : null).toBe(3);
    });

    dtest("lowercases and trims the role name", async () => {
        const dir = tempDir("ax-tag-normalize-");
        const tags = await dylibEnv(() =>
            run(
                Effect.gen(function* () {
                    const h = yield* harness(dir);
                    yield* h.tag({ ...baseOpts, roleName: "  VERIFICATION  " });
                    return yield* h.tags;
                }),
            ),
        );
        expect(tags[0]?.role_name).toBe("verification");
    });

    dtest("exits on a skill the cache has never seen, writing nothing", async () => {
        const dir = tempDir("ax-tag-unknown-");
        const h = await dylibEnv(() => run(harness(dir)));
        const exitSpy = withExitSpy();
        try {
            await expect(run(h.tag({ ...baseOpts, skillName: "nope" }))).rejects.toThrow();
        } finally {
            exitSpy.restore();
        }
        expect(exitSpy.spy).toHaveBeenCalled();
        expect(await run(h.tags)).toEqual([]);
    });

    for (const [label, opts] of [
        ["a backticked role name", { ...baseOpts, roleName: "verif`ication" }],
        ["a semicolon-injected role name", { ...baseOpts, roleName: "verification; DROP TABLE role" }],
        ["a backticked skill name", { ...baseOpts, skillName: "comp`osto" }],
        ["a spaced skill name", { ...baseOpts, skillName: "com posto" }],
    ] as const) {
        dtest(`refuses ${label} before touching either engine`, async () => {
            const dir = tempDir("ax-tag-invalid-");
            const h = await dylibEnv(() => run(harness(dir)));
            const exitSpy = withExitSpy();
            try {
                await expect(run(h.tag(opts))).rejects.toThrow();
            } finally {
                exitSpy.restore();
            }
            expect(exitSpy.spy).toHaveBeenCalled();
            expect(await run(h.tags)).toEqual([]);
        });
    }
});
