import { Effect, Schema } from "effect";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableDigest } from "./record-keys.ts";
import { type ContentDocumentWrite, writeContentDocument } from "./content-blocks/persist.ts";
import { parseProviderTurn } from "./content-blocks/parse-turn.ts";
import type { ContentDocumentInput } from "./content-blocks/types.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

/**
 * How many turns one `fetchTurnRowBatch` round-trip pulls.
 * A single unbounded `SELECT ... FROM turn` (with the full `text` column, not
 * just `text_excerpt`) materialised the whole turn corpus in the Bun VM heap
 * at once and was one of the fetches behind the ~14 GB RSS segfault on a full
 * `--reparse=claude` backfill (#917, same root cause as #1021). Mirrors
 * Turn content has no cross-turn state, so a fixed row limit also splits one
 * very large session. The real corpus has a session with more than 49k turns.
 */
export const TURN_BATCH_SIZE = 5_000;

export const TurnContentBlocksKey = Schema.Literal("turn-content-blocks");
export type TurnContentBlocksKey = typeof TurnContentBlocksKey.Type;

export interface TurnContentBlockRow {
    readonly id: string;
    readonly session?: string | null;
    readonly agent_event?: string | null;
    readonly seq?: number;
    readonly role?: string | null;
    readonly message_kind?: string | null;
    readonly intent_kind?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
    readonly has_tool_use?: boolean | null;
    readonly has_error?: boolean | null;
    readonly ts?: Date | null;
}

export interface TurnContentBlocksStats {
    readonly turns: number;
    readonly documents: number;
    readonly blocks: number;
    readonly atoms: number;
}

const turnKeyForRow = (row: TurnContentBlockRow): string =>
    row.id;

const sessionKeyForRow = (row: TurnContentBlockRow): string | null =>
    row.session ?? null;

const agentEventKeyForRow = (row: TurnContentBlockRow): string | null =>
    row.agent_event ?? null;

export function turnRowToContentDocumentWrite(row: TurnContentBlockRow): ContentDocumentWrite | null {
    const text = row.text ?? "";
    if (text.trim().length === 0) return null;

    const turnKey = turnKeyForRow(row);
    const sessionKey = sessionKeyForRow(row);
    const agentEventKey = agentEventKeyForRow(row);
    const role = row.role ?? null;
    const messageKind = row.message_kind ?? null;
    const title = role === null ? `turn ${row.seq ?? "?"}` : `${role} turn ${row.seq ?? "?"}`;
    const input: ContentDocumentInput = {
        sourceKind: "turn",
        sourceRef: turnKey,
        title,
        text,
        labels: {
            role,
            messageKind,
            intentKind: row.intent_kind ?? null,
            hasToolUse: row.has_tool_use ?? false,
            hasError: row.has_error ?? false,
        },
    };

    return {
        sourceKind: "turn",
        sourceRef: turnKey,
        turnId: turnKey,
        sessionId: sessionKey,
        agentEventId: agentEventKey,
        title,
        contentHash: stableDigest(text),
        rawText: text,
        labels: input.labels,
        metrics: { textLength: text.length, textExcerptLength: row.text_excerpt?.length ?? 0 },
        parsed: parseProviderTurn(input),
    };
}

export function buildTurnContentDocumentWrites(
    rows: readonly TurnContentBlockRow[],
): readonly ContentDocumentWrite[] {
    return rows
        .map(turnRowToContentDocumentWrite)
        .filter((write): write is ContentDocumentWrite => write !== null);
}

const TurnContentBlockRowSchema = Schema.Struct({
    id: Schema.String, session: Schema.String, agent_event: Schema.NullOr(Schema.String),
    seq: Schema.Number, role: Schema.NullOr(Schema.String), message_kind: Schema.NullOr(Schema.String),
    intent_kind: Schema.NullOr(Schema.String), text: Schema.NullOr(Schema.String),
    text_excerpt: Schema.NullOr(Schema.String), has_tool_use: Schema.NullOr(Schema.Boolean),
    has_error: Schema.NullOr(Schema.Boolean), ts: TimestampColumn,
});
type FetchedTurnContentBlockRow = typeof TurnContentBlockRowSchema.Type;

/** One stable keyset page. This bounds rows even when one session is very large. */
const fetchTurnRowBatch = (
    write: CacheWriteService,
    cursor: { readonly session: string; readonly seq: number; readonly id: string } | undefined,
    sinceDays: number | undefined,
    batchSize: number,
): Effect.Effect<readonly FetchedTurnContentBlockRow[], CacheReadError> =>
    Effect.gen(function* () {
        const predicates: string[] = [];
        const params: Array<string | number> = [];
        if (cursor !== undefined) {
            predicates.push(`(
                session > ?
                OR (session = ? AND seq > CAST(? AS BIGINT))
                OR (session = ? AND seq = CAST(? AS BIGINT) AND id > ?)
            )`);
            params.push(cursor.session, cursor.session, cursor.seq, cursor.session, cursor.seq, cursor.id);
        }
        if (sinceDays !== undefined) {
            predicates.push("ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')");
            params.push(sinceDays);
        }
        params.push(batchSize);
        const sql = `
SELECT id, session, agent_event, CAST(seq AS DOUBLE) AS seq, role, message_kind, intent_kind, text, text_excerpt, has_tool_use, has_error, ts
FROM turn
${predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`}
ORDER BY session, seq, id
LIMIT CAST(? AS INTEGER)`;
        return yield* write.rows(
            TurnContentBlockRowSchema,
            sql,
            params,
        );
    });

/**
 * Load the existing `(turn record key → content_hash)` map for already-derived
 * turn content documents. Uses the indexed `content_document_source` index
 * (FIELDS source_kind, source_ref) so this is a single fast lookup, not a scan.
 * The map key is the document's `source_ref`, which is exactly the turn record
 * key produced by `turnKeyForRow` - so it lines up with the writer convention.
 */
const loadExistingTurnContentHashes = (write: CacheWriteService): Effect.Effect<
    Map<string, string>,
    CacheReadError
> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(
            Schema.Struct({ source_ref: Schema.String, content_hash: Schema.String }),
            "SELECT source_ref, content_hash FROM content_document WHERE source_kind = 'turn'",
        );
        const map = new Map<string, string>();
        for (const row of rows ?? []) {
            if (row.source_ref != null && row.content_hash != null) {
                map.set(row.source_ref, row.content_hash);
            }
        }
        return map;
    });

export const deriveAndPersistTurnContentBlocks = (
    write: CacheWriteService,
    opts: { readonly sinceDays: number | undefined; readonly batchSize?: number } = { sinceDays: undefined },
): Effect.Effect<TurnContentBlocksStats, CacheReadError | CacheWriteError> =>
    Effect.gen(function* () {
        // Escape hatch: when the derivation logic itself changes, force a full
        // reset + re-derive of every turn content document.
        const full = process.env.AX_REDERIVE_CONTENT === "1";
        const batchSize = Math.max(1, Math.floor(opts.batchSize ?? TURN_BATCH_SIZE));

        if (full) {
            yield* write.exec("DELETE FROM content_atom WHERE source_kind = 'turn'");
            yield* write.exec("DELETE FROM content_block WHERE source_kind = 'turn'");
            yield* write.exec("DELETE FROM content_document WHERE source_kind = 'turn'");
        }
        // Incremental: only (re)derive turns whose content hash is new or
        // changed vs. what is already stored. Content-document/block/atom ids
        // are deterministic per turn, so each UPSERT lands in place (no
        // blanket DELETE). Turns whose hash matches are skipped - already
        // derived and output-equivalent. Turns are append-only, so changes
        // are rare; this is a near-no-op on warm runs. In `full` mode every
        // turn is rederived, so the hash map is never consulted.
        const existing = full ? undefined : yield* loadExistingTurnContentHashes(write);

        let turns = 0;
        let documents = 0;
        let blocks = 0;
        let atoms = 0;
        let batches = 0;
        let cursor: { readonly session: string; readonly seq: number; readonly id: string } | undefined;
        while (true) {
            const rows = yield* fetchTurnRowBatch(write, cursor, opts.sinceDays, batchSize);
            if (rows.length === 0) break;
            turns += rows.length;
            const candidates = buildTurnContentDocumentWrites(rows);
            const writes = existing === undefined
                ? candidates
                : candidates.filter((doc) => existing.get(doc.sourceRef) !== doc.contentHash);
            for (const document of writes) yield* writeContentDocument(write, document);
            documents += writes.length;
            blocks += writes.reduce((sum, doc) => sum + doc.parsed.blocks.length, 0);
            atoms += writes.reduce((sum, doc) => sum + doc.parsed.atoms.length, 0);
            const last = rows[rows.length - 1]!;
            cursor = { session: last.session, seq: last.seq, id: last.id };
            batches += 1;
            // DuckDB result objects become unreachable after each page, but a
            // tight million-row scan can finish before JSC collects them.
            // A periodic full collection keeps the page limit effective.
            if (batches % 5 === 0) yield* Effect.sync(() => Bun.gc(true));
        }
        return { turns, documents, blocks, atoms };
    });

export class TurnContentBlocksStageStats extends BaseStageStats.extend<TurnContentBlocksStageStats>("TurnContentBlocksStageStats")({
    turns: Schema.Number,
    documents: Schema.Number,
    blocks: Schema.Number,
    atoms: Schema.Number,
}) {}

export const turnContentBlocksStage: StageDef<TurnContentBlocksStageStats, never, import("./stage/registry.ts").IngestStageError> = {
    meta: StageMeta.make({
        key: "turn-content-blocks",
        deps: ["claude", "codex", "pi", "omp", "opencode", "cursor"],
        tags: ["derive"],
        writes: [
            { table: "content_document", mode: "derive" },
            { table: "content_block", mode: "derive" },
            { table: "content_atom", mode: "derive" },
        ],
    }),
    run: (ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveAndPersistTurnContentBlocks(write, { sinceDays: sinceDaysFromCtx(ctx) });
            return TurnContentBlocksStageStats.make({
                durationMs: Date.now() - t0,
                summary: `parsed ${result.documents} turn content documents into ${result.blocks} blocks and ${result.atoms} atoms`,
                ...result,
            });
        }),
};
