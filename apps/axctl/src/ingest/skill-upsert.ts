import type { SkillName } from "@ax/lib/brands";
import { skillRowId } from "@ax/lib/stable-id";
import { cacheRow } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import { Effect, Option, Schema } from "effect";

export interface SkillContent {
    readonly name: SkillName;
    readonly scope: string;
    readonly dir_path: string;
    readonly description: string | null | undefined;
    readonly content_hash: string;
    readonly bytes: number | undefined;
}

const SkillLookupRow = Schema.Struct({
    id: Schema.String,
    content_hash: Schema.NullOr(Schema.String),
    bytes: Schema.NullOr(Schema.BigInt),
});

export function upsertSkillByName(
    write: CacheWriteService,
    content: SkillContent,
): Effect.Effect<string, CacheWriteError> {
    return Effect.gen(function* () {
        const existingOption = yield* write.first(
            SkillLookupRow,
            "SELECT id, content_hash, bytes FROM skill WHERE name = ? LIMIT 1",
            [content.name],
        );
        const existing = Option.getOrNull(existingOption);
        const id = existing?.id ?? skillRowId(content.name);

        // Drift log: append a skill_revision ONLY on a real content change (the
        // hash flipped) or the first sighting of a new skill. The current `skill`
        // row is the baseline; this is the append-only trail to diff against.
        // Fails open - the audit write must never break ingest.
        const prevHash = existing?.content_hash ?? undefined;
        const isNew = existing == null;
        const changed = prevHash != null && prevHash !== content.content_hash;
        if ((isNew || changed) && content.content_hash) {
            yield* write.put("skill_revision", cacheRow({
                id: stableId("skill_revision", [id, content.content_hash]),
                skill: id,
                name: content.name,
                scope: content.scope,
                content_hash: content.content_hash,
                prev_hash: prevHash ?? null,
                bytes: content.bytes ?? null,
                prev_bytes: existing?.bytes ?? null,
                change: isNew ? "added" : "changed",
            })).pipe(Effect.ignore);
        }

        yield* write.put("skill", cacheRow({
            id,
            name: content.name,
            scope: content.scope,
            dir_path: content.dir_path,
            description: content.description ?? null,
            content_hash: content.content_hash,
            bytes: content.bytes ?? null,
            last_seen_at: null,
            deleted_at: null,
        }));
        return id;
    });
}
