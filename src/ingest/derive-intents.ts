/**
 * Re-derive `turn.intent_kind` for existing rows using the current classifier.
 *
 * The classifier in `src/ingest/intent-kind.ts` evolves; previously ingested
 * turns carry their original (often looser) classification. This pass walks
 * stored turns, re-runs the classifier, and updates rows whose label changed.
 * Idempotent - running twice produces no further updates.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { classifyTurnIntent, type TurnIntentKind } from "./intent-kind.ts";

export interface TurnIntentRow {
    readonly id: string;
    readonly role: string;
    readonly message_kind: string | null;
    readonly text_excerpt: string | null;
    readonly intent_kind: string | null;
    readonly source: string | null;
}

export interface IntentChange {
    readonly id: string;
    readonly from: string;
    readonly to: TurnIntentKind;
}

export interface DeriveIntentSummary {
    readonly considered: number;
    readonly changed: number;
    readonly byTransition: Record<string, number>;
    readonly changes: readonly IntentChange[];
}

/** Pure: compute the changes that would be made. No DB writes. */
export function computeIntentChanges(rows: readonly TurnIntentRow[]): DeriveIntentSummary {
    const changes: IntentChange[] = [];
    const byTransition: Record<string, number> = {};
    for (const row of rows) {
        const next = classifyTurnIntent({
            role: row.role,
            messageKind: row.message_kind,
            text: row.text_excerpt,
            source: row.source,
        });
        const prev = row.intent_kind ?? "(unset)";
        if (next === prev) continue;
        changes.push({ id: row.id, from: prev, to: next });
        const key = `${prev} -> ${next}`;
        byTransition[key] = (byTransition[key] ?? 0) + 1;
    }
    return {
        considered: rows.length,
        changed: changes.length,
        byTransition,
        changes,
    };
}

const escapeRid = (id: string): string => {
    // SurrealDB record-id literal: `table:identifier`. Identifiers with special
    // chars (UUID hyphens, dots) must be backtick-wrapped. Strip backticks
    // already present so we don't double-wrap.
    const idx = id.indexOf(":");
    if (idx < 0) return `\`${id}\``;
    const table = id.slice(0, idx);
    const key = id.slice(idx + 1).replace(/^[`⟨]|[`⟩]$/g, "");
    if (/^[A-Za-z0-9_]+$/.test(key)) return `${table}:${key}`;
    return `${table}:\`${key.replace(/`/g, "")}\``;
};

/**
 * Stream all turn rows in pages, classify, batch-update only the ones that
 * changed. Returns a summary regardless of whether the caller is doing a dry
 * run (the caller decides whether to skip writes).
 */
export const deriveTurnIntents = (opts: {
    readonly dryRun: boolean;
    readonly batchSize?: number;
}): Effect.Effect<DeriveIntentSummary, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[TurnIntentRow[]]>(`
            SELECT
                <string>id AS id,
                role,
                message_kind,
                text_excerpt,
                intent_kind,
                session.source AS source
            FROM turn;
        `);
        const summary = computeIntentChanges(rows);
        if (opts.dryRun || summary.changes.length === 0) return summary;

        const batchSize = opts.batchSize ?? 500;
        for (let i = 0; i < summary.changes.length; i += batchSize) {
            const slice = summary.changes.slice(i, i + batchSize);
            const stmts = slice
                .map((c) => `UPDATE ${escapeRid(c.id)} SET intent_kind = "${c.to}" RETURN NONE;`)
                .join("\n");
            yield* db.query(stmts);
        }
        return summary;
    });
