import { RecordId } from "../lib/db.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import type { DbError } from "../lib/errors.ts";
import type { SurrealClientShape } from "../lib/db.ts";
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
): Effect.Effect<void, DbError> {
    return Effect.gen(function* () {
        const result = yield* db.query<[SkillLookupRow[]]>(
            "SELECT id FROM skill WHERE name = $name LIMIT 1;",
            { name: content.name },
        );
        const existingId = result?.[0]?.[0]?.id;
        const id = skillRecordIdFromLookup(existingId, content.name);
        yield* db.upsert(id, { ...content });
    }).pipe(Effect.asVoid);
}
