import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { relateSkillRoles } from "./skill-role.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skill roles", { requireFts: true });

describe("relateSkillRoles on real DuckDB", () => {
    dtest("deduplicates roles and writes frontmatter edges", async () => {
        let result: unknown;
        let counts: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-skill-role-"), dylibPath, (write) =>
            Effect.gen(function* () {
                result = yield* relateSkillRoles(write, {
                    skillId: "skill-a", roles: ["framing", "Framing", " framing ", "execution"],
                });
                counts = (yield* write.rows(Schema.Struct({
                    roles: Schema.BigInt, edges: Schema.BigInt,
                }), `SELECT (SELECT count(*) FROM role) AS roles,
                    (SELECT count(*) FROM plays_role) AS edges`))[0];
            }),
        ));
        expect(result).toEqual({ rolesUpserted: 2, edgesWritten: 2, rolesSkipped: 0 });
        expect(counts).toEqual({ roles: 2n, edges: 2n });
    });

    dtest("skips invalid names and removes stale edges when roles shrink", async () => {
        let results: unknown[] = [];
        let names: string[] = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-skill-role-shrink-"), dylibPath, (write) =>
            Effect.gen(function* () {
                results = [
                    yield* relateSkillRoles(write, { skillId: "skill-a", roles: ["framing", "execution"] }),
                    yield* relateSkillRoles(write, { skillId: "skill-a", roles: ["framing", "bad;role"] }),
                ];
                names = (yield* write.rows(Schema.Struct({ name: Schema.String }), `
                    SELECT r.name FROM plays_role p JOIN role r ON r.id = p.out_id ORDER BY r.name
                `)).map((row) => row.name);
            }),
        ));
        expect(results[1]).toEqual({ rolesUpserted: 1, edgesWritten: 1, rolesSkipped: 1 });
        expect(names).toEqual(["framing"]);
    });

    dtest("empty roles clear all frontmatter edges", async () => {
        let edges = -1n;
        await runWithPlatform(publishCacheFixture(tempDir("ax-skill-role-empty-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* relateSkillRoles(write, { skillId: "skill-a", roles: ["framing"] });
                expect(yield* relateSkillRoles(write, { skillId: "skill-a", roles: [] }))
                    .toEqual({ rolesUpserted: 0, edgesWritten: 0, rolesSkipped: 0 });
                edges = (yield* write.rows(
                    Schema.Struct({ n: Schema.BigInt }), "SELECT count(*) AS n FROM plays_role",
                ))[0]!.n;
            }),
        ));
        expect(edges).toBe(0n);
    });
});
