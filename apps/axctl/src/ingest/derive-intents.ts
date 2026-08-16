import { Effect, Schema } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { classifyTurnIntent, type TurnIntentKind } from "./intent-kind.ts";

export interface TurnIntentRow {
    readonly id: string;
    readonly role: string;
    readonly message_kind: string | undefined;
    readonly text_excerpt: string | undefined;
    readonly intent_kind: string | undefined;
    readonly source: string | undefined;
}
export interface IntentChange { readonly id: string; readonly from: string; readonly to: TurnIntentKind }
export interface DeriveIntentSummary {
    readonly considered: number;
    readonly changed: number;
    readonly byTransition: Record<string, number>;
    readonly changes: readonly IntentChange[];
}

export function computeIntentChanges(rows: readonly TurnIntentRow[]): DeriveIntentSummary {
    const changes: IntentChange[] = [];
    const byTransition: Record<string, number> = {};
    for (const row of rows) {
        const next = classifyTurnIntent({
            role: row.role,
            messageKind: row.message_kind ?? null,
            text: row.text_excerpt ?? null,
            source: row.source ?? null,
        });
        const prev = row.intent_kind ?? "(unset)";
        if (next === prev) continue;
        changes.push({ id: row.id, from: prev, to: next });
        const key = `${prev} -> ${next}`;
        byTransition[key] = (byTransition[key] ?? 0) + 1;
    }
    return { considered: rows.length, changed: changes.length, byTransition, changes };
}

const TurnIntentDbRow = Schema.Struct({
    id: Schema.String,
    role: Schema.String,
    message_kind: Schema.NullOr(Schema.String),
    text_excerpt: Schema.NullOr(Schema.String),
    intent_kind: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
});

export const deriveTurnIntents = (
    write: CacheWriteService,
    opts: { readonly dryRun: boolean; readonly batchSize?: number },
): Effect.Effect<DeriveIntentSummary, CacheWriteError> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(TurnIntentDbRow, `
            SELECT t.id, t.role, t.message_kind, t.text_excerpt, t.intent_kind, s.source
            FROM turn t JOIN session s ON s.id = t.session
        `);
        const summary = computeIntentChanges(rows.map((row) => ({
            id: row.id,
            role: row.role,
            message_kind: row.message_kind ?? undefined,
            text_excerpt: row.text_excerpt ?? undefined,
            intent_kind: row.intent_kind ?? undefined,
            source: row.source ?? undefined,
        })));
        if (opts.dryRun) return summary;
        for (const change of summary.changes) {
            yield* write.exec("UPDATE turn SET intent_kind = ? WHERE id = ?", [change.to, change.id]);
        }
        return summary;
    });
