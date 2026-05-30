import { Effect, Schema } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { recordKeyPart } from "../lib/shared/derive-keys.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { surrealString } from "../lib/shared/surql.ts";
import { stableDigest } from "./record-keys.ts";
import { buildContentDocumentStatements, type ContentDocumentWrite } from "./content-blocks/persist.ts";
import { parseProviderTurn } from "./content-blocks/parse-turn.ts";
import type { ContentDocumentInput } from "./content-blocks/types.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const TurnContentBlocksKey = Schema.Literal("turn-content-blocks");
export type TurnContentBlocksKey = typeof TurnContentBlocksKey.Type;

export interface TurnContentBlockRow {
    readonly id: unknown;
    readonly session?: unknown;
    readonly agent_event?: unknown;
    readonly seq?: number;
    readonly role?: string | null;
    readonly message_kind?: string | null;
    readonly intent_kind?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
    readonly has_tool_use?: boolean | null;
    readonly has_error?: boolean | null;
    readonly ts?: string | null;
}

export interface TurnContentBlocksStats {
    readonly turns: number;
    readonly documents: number;
    readonly blocks: number;
    readonly atoms: number;
}

const turnKeyForRow = (row: TurnContentBlockRow): string =>
    recordKeyPart(row.id, "turn") ?? String(row.id);

const sessionKeyForRow = (row: TurnContentBlockRow): string | null =>
    recordKeyPart(row.session, "session");

const agentEventKeyForRow = (row: TurnContentBlockRow): string | null =>
    recordKeyPart(row.agent_event, "agent_event");

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

export function buildTurnContentBlockStatements(
    rows: readonly TurnContentBlockRow[],
    opts: { readonly reset: boolean } = { reset: false },
): string[] {
    const reset = opts.reset
        ? [
            `DELETE content_atom WHERE source_kind = ${surrealString("turn")};`,
            `DELETE content_block WHERE source_kind = ${surrealString("turn")};`,
            `DELETE content_document WHERE source_kind = ${surrealString("turn")};`,
        ]
        : [];
    return [
        ...reset,
        ...buildTurnContentDocumentWrites(rows).flatMap(buildContentDocumentStatements),
    ];
}

const fetchTurnRows = (
    sinceDays: number | undefined,
): Effect.Effect<TurnContentBlockRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const since = sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays}d` : "";
        const [rows] = yield* db.query<[TurnContentBlockRow[]]>(`
SELECT id, session, agent_event, seq, role, message_kind, intent_kind, text, text_excerpt, has_tool_use, has_error, type::string(ts) AS ts
FROM turn
${since}
ORDER BY session, seq;`);
        return rows ?? [];
    });

export const deriveAndPersistTurnContentBlocks = (
    opts: { readonly sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<TurnContentBlocksStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* fetchTurnRows(opts.sinceDays);
        const writes = buildTurnContentDocumentWrites(rows);
        const statements = buildTurnContentBlockStatements(rows, { reset: opts.sinceDays === undefined });
        yield* executeStatementsWith(db, statements, { chunkSize: 250 });
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

export const turnContentBlocksStage: StageDef<TurnContentBlocksStageStats, SurrealClient> = {
    meta: StageMeta.make({
        key: "turn-content-blocks",
        deps: ["claude", "codex", "pi", "opencode", "cursor"],
        tags: ["derive"],
    }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveAndPersistTurnContentBlocks({ sinceDays: sinceDaysFromCtx(ctx) });
            return TurnContentBlocksStageStats.make({
                durationMs: Date.now() - t0,
                summary: `parsed ${result.documents} turn content documents into ${result.blocks} blocks and ${result.atoms} atoms`,
                ...result,
            });
        }),
};
