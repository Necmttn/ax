import { Effect } from "effect";
import type { SurrealClient } from "@ax/lib/db";
import type {
    InspectContentAtomDto,
    InspectContentBlockDto,
    InspectTurnContentDto,
} from "@ax/lib/shared/dashboard-types";
import { interpolateRid, queryMany } from "@ax/lib/shared/graph-query";
import { toBareSessionId } from "@ax/lib/shared/session-id";

const TURN_CONTENT_DOCUMENTS_SQL = `
    SELECT
        type::string(id) AS document_id,
        parser_id,
        parser_version,
        blockset_hash,
        turn.seq AS turn_seq
    FROM content_document
    WHERE source_kind = "turn" AND session = $sid
    ORDER BY turn_seq;
`;

const TURN_CONTENT_BLOCKS_SQL = `
    SELECT
        type::string(id) AS id,
        type::string(document) AS document_id,
        seq,
        parent_seq,
        kind,
        role,
        heading,
        text,
        text_excerpt,
        start_offset,
        end_offset,
        confidence
    FROM content_block
    WHERE source_kind = "turn"
      AND document IN $documents
    ORDER BY document_id, seq;
`;

const TURN_CONTENT_ATOMS_SQL = `
    SELECT
        type::string(document) AS document_id,
        block.seq AS block_seq,
        kind,
        value,
        normalized,
        confidence,
        raw
    FROM content_atom
    WHERE source_kind = "turn"
      AND document IN $documents
    ORDER BY document_id, block_seq, kind, value;
`;

interface TurnContentDocumentRow {
    readonly document_id: string;
    readonly parser_id: string;
    readonly parser_version: string;
    readonly blockset_hash: string | null;
    readonly turn_seq: number | null;
}

interface TurnContentBlockRow {
    readonly document_id: string;
    readonly seq: number;
    readonly parent_seq: number | null;
    readonly kind: string;
    readonly role: string | null;
    readonly heading: string | null;
    readonly text: string | null;
    readonly text_excerpt: string | null;
    readonly start_offset: number | null;
    readonly end_offset: number | null;
    readonly confidence: number;
}

interface TurnContentAtomRow {
    readonly document_id: string;
    readonly block_seq: number;
    readonly kind: string;
    readonly value: string;
    readonly normalized: string | null;
    readonly confidence: number;
    readonly raw: unknown;
}

function contentDocumentRid(value: string): string | null {
    const prefix = "content_document:";
    if (!value.startsWith(prefix)) return null;
    const key = value.slice(prefix.length);
    if (!key) return null;
    if (/^[A-Za-z0-9_:-]+$/.test(key)) return `${prefix}${key}`;
    return `${prefix}\`${key.replace(/`/g, "")}\``;
}

export const resolveTurnContent = (
    sessionId: string,
): Effect.Effect<Map<number, InspectTurnContentDto>, never, SurrealClient> =>
    Effect.gen(function* () {
        const documentRows = yield* queryMany<TurnContentDocumentRow, TurnContentDocumentRow>(
            interpolateRid(TURN_CONTENT_DOCUMENTS_SQL, toBareSessionId(sessionId)),
            (row) => row,
            "session-turn-content resolveDocuments",
        );
        if (documentRows.length === 0) return new Map<number, InspectTurnContentDto>();

        const documents = documentRows
            .map((row) => contentDocumentRid(row.document_id))
            .filter((value): value is string => value !== null);
        if (documents.length === 0) return new Map<number, InspectTurnContentDto>();

        const documentMetaById = new Map<string, TurnContentDocumentRow>();
        for (const row of documentRows) documentMetaById.set(row.document_id, row);
        const documentListSql = `[${documents.join(", ")}]`;

        const [blockRows, atomRows] = yield* Effect.all([
            queryMany<TurnContentBlockRow, TurnContentBlockRow>(
                TURN_CONTENT_BLOCKS_SQL.split("$documents").join(documentListSql),
                (row) => row,
                "session-turn-content resolveBlocks",
            ),
            queryMany<TurnContentAtomRow, TurnContentAtomRow>(
                TURN_CONTENT_ATOMS_SQL.split("$documents").join(documentListSql),
                (row) => row,
                "session-turn-content resolveAtoms",
            ),
        ], { concurrency: "unbounded" });

        const atomsByDocumentAndBlock = new Map<string, InspectContentAtomDto[]>();
        for (const atom of atomRows) {
            const key = `${atom.document_id}\0${atom.block_seq}`;
            const list = atomsByDocumentAndBlock.get(key) ?? [];
            list.push({
                kind: atom.kind,
                value: atom.value,
                normalized: atom.normalized ?? null,
                confidence: atom.confidence,
                raw: atom.raw ?? null,
            });
            atomsByDocumentAndBlock.set(key, list);
        }

        const byTurn = new Map<number, InspectTurnContentDto>();
        const blocksByTurn = new Map<number, InspectContentBlockDto[]>();
        for (const row of blockRows) {
            const documentMeta = documentMetaById.get(row.document_id);
            if (!documentMeta || documentMeta.turn_seq === null || documentMeta.turn_seq === undefined) continue;
            const atoms = atomsByDocumentAndBlock.get(`${row.document_id}\0${row.seq}`) ?? [];
            const blocks = blocksByTurn.get(documentMeta.turn_seq) ?? [];
            blocks.push({
                seq: row.seq,
                parent_seq: row.parent_seq ?? null,
                kind: row.kind,
                role: row.role ?? null,
                heading: row.heading ?? null,
                text: row.text ?? null,
                text_excerpt: row.text_excerpt ?? null,
                start_offset: row.start_offset ?? null,
                end_offset: row.end_offset ?? null,
                confidence: row.confidence,
                atoms,
            });
            blocksByTurn.set(documentMeta.turn_seq, blocks);
            byTurn.set(documentMeta.turn_seq, {
                document_id: row.document_id,
                parser_id: documentMeta.parser_id,
                parser_version: documentMeta.parser_version,
                blockset_hash: documentMeta.blockset_hash ?? null,
                blocks,
            });
        }
        return byTurn;
    });
