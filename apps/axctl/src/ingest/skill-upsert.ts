import { RecordId } from "@ax/lib/db";
import type { SkillName } from "@ax/lib/brands";
import { skillRecordKey } from "@ax/lib/skill-id";
import type { DbError } from "@ax/lib/errors";
import type { SurrealClientShape } from "@ax/lib/db";
import { Effect } from "effect";

export interface SkillContent {
    readonly name: SkillName;
    readonly scope: string;
    readonly dir_path: string;
    readonly description: string | null | undefined;
    readonly content_hash: string;
    readonly bytes: number | undefined;
}

interface SkillLookupRow {
    readonly id?: unknown;
    readonly content_hash?: unknown;
    readonly bytes?: unknown;
}

function skillUpsertPayload(content: SkillContent): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        name: content.name,
        scope: content.scope,
        dir_path: content.dir_path,
        content_hash: content.content_hash,
    };
    if (content.description != null) payload.description = content.description;
    if (content.bytes !== undefined) payload.bytes = content.bytes;
    return payload;
}

export function skillRecordIdFromLookup(raw: unknown, fallbackName: SkillName): RecordId {
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
            "SELECT id, content_hash, bytes FROM skill WHERE name = $name LIMIT 1;",
            { name: content.name },
        );
        const existing = result?.[0]?.[0];
        const id = skillRecordIdFromLookup(existing?.id, content.name);

        // Drift log: append a skill_revision ONLY on a real content change (the
        // hash flipped) or the first sighting of a new skill. The current `skill`
        // row is the baseline; this is the append-only trail to diff against.
        // Fails open - the audit write must never break ingest.
        const prevHash = typeof existing?.content_hash === "string" ? existing.content_hash : undefined;
        const isNew = existing == null;
        const changed = prevHash != null && prevHash !== content.content_hash;
        if ((isNew || changed) && content.content_hash) {
            yield* Effect.ignore(db.query(
                "CREATE skill_revision SET skill = $skill, name = $name, scope = $scope, content_hash = $hash, prev_hash = $prev, bytes = $bytes, prev_bytes = $prevBytes, change = $change;",
                {
                    skill: id,
                    name: content.name,
                    scope: content.scope,
                    hash: content.content_hash,
                    prev: prevHash ?? undefined,
                    bytes: content.bytes ?? undefined,
                    prevBytes: typeof existing?.bytes === "number" ? existing.bytes : undefined,
                    change: isNew ? "added" : "changed",
                },
            ));
        }

        yield* db.upsert(id, skillUpsertPayload(content));
        return id;
    });
}
