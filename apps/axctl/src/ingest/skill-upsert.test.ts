import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { SkillName } from "@ax/lib/brands";
import { skillRowId } from "@ax/lib/stable-id";
import { upsertSkillByName } from "./skill-upsert.ts";
import { SkillsKey, SkillsStats, skillsStage } from "./skills.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skill upsert", { requireFts: true });
const sn = (value: string) => SkillName.make(value);

describe("skill upsert on real DuckDB", () => {
    dtest("creates the stable skill row and one added revision", async () => {
        let rows: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-skill-upsert-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const id = yield* upsertSkillByName(write, {
                    name: sn("new:skill"), scope: "test", dir_path: "/tmp/new-skill",
                    description: undefined, content_hash: "hash", bytes: 1,
                });
                rows = {
                    id,
                    skill: (yield* write.rows(Schema.Struct({
                        id: Schema.String, description: Schema.Null, bytes: Schema.BigInt,
                    }), "SELECT id, description, bytes FROM skill"))[0],
                    revisions: (yield* write.rows(
                        Schema.Struct({ change: Schema.String }),
                        "SELECT change FROM skill_revision",
                    )).map((row) => row.change),
                };
            }),
        ));
        expect(rows).toEqual({
            id: skillRowId(sn("new:skill")),
            skill: { id: skillRowId(sn("new:skill")), description: null, bytes: 1n },
            revisions: ["added"],
        });
    });

    dtest("reuses an existing id and records only real content changes", async () => {
        let result: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-skill-reuse-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("skill", {
                    id: "legacy-id", name: "legacy", scope: "user", dir_path: "/skills/legacy",
                    content_hash: "old", bytes: 10n,
                });
                const unchanged = yield* upsertSkillByName(write, {
                    name: sn("legacy"), scope: "user", dir_path: "/skills/legacy",
                    description: null, content_hash: "old", bytes: 10,
                });
                const changed = yield* upsertSkillByName(write, {
                    name: sn("legacy"), scope: "user", dir_path: "/skills/legacy",
                    description: null, content_hash: "new", bytes: 12,
                });
                result = {
                    ids: [unchanged, changed],
                    revisions: (yield* write.rows(
                        Schema.Struct({ change: Schema.String, prev_hash: Schema.String }),
                        "SELECT change, prev_hash FROM skill_revision",
                    )),
                };
            }),
        ));
        expect(result).toEqual({
            ids: ["legacy-id", "legacy-id"],
            revisions: [{ change: "changed", prev_hash: "old" }],
        });
    });
});

describe("skillsStage", () => {
    it("declares the canonical key and tag", () => {
        expect(Schema.decodeUnknownSync(SkillsKey)("skills")).toBe("skills");
        expect(skillsStage.meta.key).toBe("skills");
        expect(skillsStage.meta.tags).toEqual(["ingest"]);
        expect(skillsStage.meta.deps).toEqual([]);
    });

    it("produces a SkillsStats class instance shape", () => {
        const stats = SkillsStats.make({ durationMs: 1, summary: "x", skillsUpserted: 2 });
        expect(stats.skillsUpserted).toBe(2);
    });
});
