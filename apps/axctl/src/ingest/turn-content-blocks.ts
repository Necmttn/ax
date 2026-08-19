import { Effect, Schema } from "effect";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableDigest } from "./record-keys.ts";
import { type ContentDocumentWrite, writeContentDocument } from "./content-blocks/persist.ts";
import { parseProviderTurn } from "./content-blocks/parse-turn.ts";
import type { ContentDocumentInput } from "./content-blocks/types.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

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

const fetchTurnRows = (
    write: CacheWriteService,
    sinceDays: number | undefined,
): Effect.Effect<readonly TurnContentBlockRow[], CacheReadError> =>
    Effect.gen(function* () {
        const Row = Schema.Struct({
            id: Schema.String, session: Schema.NullOr(Schema.String), agent_event: Schema.NullOr(Schema.String),
            seq: Schema.Number, role: Schema.NullOr(Schema.String), message_kind: Schema.NullOr(Schema.String),
            intent_kind: Schema.NullOr(Schema.String), text: Schema.NullOr(Schema.String),
            text_excerpt: Schema.NullOr(Schema.String), has_tool_use: Schema.NullOr(Schema.Boolean),
            has_error: Schema.NullOr(Schema.Boolean), ts: TimestampColumn,
        });
        return yield* write.rows(Row, `
SELECT id, session, agent_event, CAST(seq AS DOUBLE) AS seq, role, message_kind, intent_kind, text, text_excerpt, has_tool_use, has_error, ts
FROM turn
${sinceDays === undefined ? "" : "WHERE ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')"}
ORDER BY session, seq`, sinceDays === undefined ? [] : [sinceDays]);
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
    opts: { readonly sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<TurnContentBlocksStats, CacheReadError | CacheWriteError> =>
    Effect.gen(function* () {
        // Escape hatch: when the derivation logic itself changes, force a full
        // reset + re-derive of every turn content document.
        const full = process.env.AX_REDERIVE_CONTENT === "1";
        const rows = yield* fetchTurnRows(write, opts.sinceDays);

        if (full) {
            const writes = buildTurnContentDocumentWrites(rows);
            yield* write.exec("DELETE FROM content_atom WHERE source_kind = 'turn'");
            yield* write.exec("DELETE FROM content_block WHERE source_kind = 'turn'");
            yield* write.exec("DELETE FROM content_document WHERE source_kind = 'turn'");
            for (const document of writes) yield* writeContentDocument(write, document);
            const blocks = writes.reduce((sum, write) => sum + write.parsed.blocks.length, 0);
            const atoms = writes.reduce((sum, write) => sum + write.parsed.atoms.length, 0);
            return { turns: rows.length, documents: writes.length, blocks, atoms };
        }

        // Incremental: only (re)derive turns whose content hash is new or changed
        // vs. what is already stored. Content-document/block/atom ids are
        // deterministic per turn, so each UPSERT lands in place (no blanket
        // DELETE). Turns whose hash matches are skipped - already derived and
        // output-equivalent. Turns are append-only, so changes are rare; this is
        // a near-no-op on warm runs.
        const existing = yield* loadExistingTurnContentHashes(write);
        const writes = buildTurnContentDocumentWrites(rows).filter(
            (write) => existing.get(write.sourceRef) !== write.contentHash,
        );
        for (const document of writes) yield* writeContentDocument(write, document);
        const blocks = writes.reduce((sum, write) => sum + write.parsed.blocks.length, 0);
        const atoms = writes.reduce((sum, write) => sum + write.parsed.atoms.length, 0);
        return {
            turns: rows.length,
            documents: writes.length,
            blocks,
            atoms,
        };
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
