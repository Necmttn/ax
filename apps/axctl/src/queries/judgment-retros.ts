import { Effect, Schema } from "effect";
import { Judgment, TextColumn, TimestampColumn, type JudgmentError } from "@ax/lib/sqlite";

const RetroRow = Schema.Struct({
    id: TextColumn,
    session: TextColumn,
    source: TextColumn,
    tried: TextColumn,
    worked: Schema.NullOr(TextColumn),
    failed: Schema.NullOr(TextColumn),
    next: Schema.NullOr(TextColumn),
    raw: Schema.NullOr(TextColumn),
    repository: Schema.NullOr(TextColumn),
    created_at: TimestampColumn,
});

export type StoredRetro = typeof RetroRow.Type;

export const listStoredRetros = (input: {
    readonly since?: Date;
    readonly limit?: number;
} = {}): Effect.Effect<ReadonlyArray<StoredRetro>, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const since = input.since;
        return yield* judgment.rows(
            RetroRow,
            `SELECT id, session, source, tried, worked, failed, next, raw, repository, created_at
             FROM retro ${since ? "WHERE created_at > ?" : ""}
             ORDER BY created_at DESC LIMIT ?`,
            [...(since ? [since] : []), input.limit ?? 50],
        );
    });
