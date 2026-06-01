import { describe, expect, it, test } from "bun:test";
import { Effect, Schema } from "effect";
import { RecordId, type SurrealClientShape } from "@ax/lib/db";
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
        const upserts: string[] = [];
        const db = {
            query: <T extends unknown[]>() => Effect.succeed([[]] as unknown as T),
            upsert: (id: RecordId) => Effect.sync(() => {
                upserts.push(String(id));
            }),
        } as unknown as SurrealClientShape;

        await Effect.runPromise(upsertSkillByName(db, {
            name: "new:skill",
            scope: "test",
            dir_path: "/tmp/new-skill",
            description: undefined,
            content_hash: "hash",
            bytes: 1,
        }));

        expect(upserts).toEqual([`skill:${skillRecordKey("new:skill")}`]);
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
