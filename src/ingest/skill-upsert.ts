import { RecordId } from "@ax/lib/db";
import { skillRecordKey } from "@ax/lib/skill-id";
import type { DbError } from "@ax/lib/errors";
import type { SurrealClientShape } from "@ax/lib/db";
import { Effect } from "effect";

export interface SkillContent {
    readonly name: string;
    readonly scope: string;
    readonly dir_path: string;
    readonly description: string | null | undefined;
    readonly content_hash: string;
    readonly bytes: number | undefined;
}

interface SkillLookupRow {
    readonly id?: unknown;
}

export function skillRecordIdFromLookup(raw: unknown, fallbackName: string): RecordId {
    if (raw instanceof RecordId) return raw;
    if (typeof raw === "string") {
        const backticked = raw.match(/^skill:`(.+)`$/);
        if (backticked) return new RecordId("skill", backticked[1]);
        if (raw.startsWith("skill:")) return new RecordId("skill", raw.slice("skill:".length));
    }
    return new RecordId("skill", skillRecordKey(fallbackName));
}

export function upsertSkillByName(
    db: SurrealClientShape,
    content: SkillContent,
): Effect.Effect<RecordId, DbError> {
    return Effect.gen(function* () {
        const result = yield* db.query<[SkillLookupRow[]]>(
            "SELECT id FROM skill WHERE name = $name LIMIT 1;",
            { name: content.name },
        );
        const existingId = result?.[0]?.[0]?.id;
        const id = skillRecordIdFromLookup(existingId, content.name);
        yield* db.upsert(id, { ...content });
        return id;
    });
}
