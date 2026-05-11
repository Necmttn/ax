import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RecordId, type SurrealClientShape } from "../lib/db.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { skillRecordIdFromLookup, upsertSkillByName } from "./skill-upsert.ts";

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
