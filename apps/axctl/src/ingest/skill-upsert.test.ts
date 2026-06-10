import { describe, expect, it, test } from "bun:test";
import { Effect, Schema } from "effect";
import { RecordId } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { skillRecordKey } from "@ax/lib/skill-id";
import { skillRecordIdFromLookup, upsertSkillByName } from "./skill-upsert.ts";
import { SkillsKey, SkillsStats, skillsStage } from "./skills.ts";

describe("skill upsert", () => {
    test("reuses a legacy skill id returned by name lookup", () => {
        const legacy = new RecordId("skill", "batch-read-upfront");
        expect(skillRecordIdFromLookup(legacy, "batch-read-upfront")).toBe(legacy);
        expect(String(skillRecordIdFromLookup("skill:`batch-read-upfront`", "batch-read-upfront"))).toBe(String(legacy));
    });

    test("falls back to modern v2 id when no existing skill has the name", async () => {
        const tc = makeTestSurrealClient();

        await Effect.runPromise(upsertSkillByName(tc.client, {
            name: "new:skill",
            scope: "test",
            dir_path: "/tmp/new-skill",
            description: undefined,
            content_hash: "hash",
            bytes: 1,
        }));

        expect(tc.upserts.map((u) => String(u.id))).toEqual([`skill:${skillRecordKey("new:skill")}`]);
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
        const s = SkillsStats.make({ durationMs: 1, summary: "x", skillsUpserted: 2 });
        expect(s.skillsUpserted).toBe(2);
    });
});
