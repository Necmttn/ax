import { Array as Arr, Effect, Schema } from "effect";
import type {
    InspectContentAtomDto,
    InspectContentBlockDto,
    InspectTurnContentDto,
} from "@ax/lib/shared/dashboard-types";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import { toBareSessionId } from "@ax/lib/shared/session-id";

/**
 * `document IN (...)` chunk size, and per-chunk fetch concurrency.
 *
 * The SurrealDB version of this file went to considerable lengths (a
 * deterministic-record-id "speculative fan-out", chunked to
 * DIRECT_REF_BUDGET_PER_QUERY=200 refs/query, capped at
 * MAX_SPECULATIVE_REFS_PER_REQUEST=24k) to avoid a `document IN [<all docs>]`
 * membership scan, which was a real SurrealDB weakness (6s+22s on a 318-doc
 * session per the original comment here). None of that applies to DuckDB:
 * content_block_document_seq and content_atom_document_kind are real indexes,
 * so a chunked `document IN (...)` is itself the fast indexed lookup - there
 * is no separate "slow path" to avoid, and no deterministic record ids to
 * guess (DuckDB ids are opaque VARCHARs, not SurrealDB's colon-delimited
 * table:key literals). This file drops the whole speculative-fetch machinery.
 */
const DOCUMENT_ID_CHUNK = 200;
const DOCUMENT_ID_CONCURRENCY = 8;

const TurnContentDocumentSchemaRow = Schema.Struct({
    source_ref: Schema.NullOr(Schema.String),
    document_id: Schema.String,
    parser_id: Schema.String,
    parser_version: Schema.String,
    blockset_hash: Schema.NullOr(Schema.String),
    turn_seq: Schema.NullOr(NumberFromBigIntColumn),
});
type TurnContentDocumentRow = typeof TurnContentDocumentSchemaRow.Type;

const TurnContentBlockSchemaRow = Schema.Struct({
    id: Schema.String,
    document_id: Schema.String,
    seq: NumberFromBigIntColumn,
    parent_seq: Schema.NullOr(NumberFromBigIntColumn),
    kind: Schema.String,
    role: Schema.NullOr(Schema.String),
    heading: Schema.NullOr(Schema.String),
    text: Schema.NullOr(Schema.String),
    text_excerpt: Schema.NullOr(Schema.String),
    start_offset: Schema.NullOr(NumberFromBigIntColumn),
    end_offset: Schema.NullOr(NumberFromBigIntColumn),
    confidence: Schema.Number,
});
type TurnContentBlockRow = typeof TurnContentBlockSchemaRow.Type;

const TurnContentAtomSchemaRow = Schema.Struct({
    document_id: Schema.String,
    block_seq: NumberFromBigIntColumn,
    kind: Schema.String,
    value: Schema.String,
    normalized: Schema.NullOr(Schema.String),
    confidence: Schema.Number,
    raw: Schema.NullOr(Schema.String),
});
type TurnContentAtomRow = typeof TurnContentAtomSchemaRow.Type;

/** A session's turn documents (share export / full-inspect path). `turn` is
 *  joined (not dereferenced) to recover the turn seq each document belongs to. */
const TURN_CONTENT_DOCUMENTS_BY_SESSION_SQL = `
SELECT cd.source_ref AS source_ref, cd.id AS document_id, cd.parser_id AS parser_id,
       cd.parser_version AS parser_version, cd.blockset_hash AS blockset_hash, t.seq AS turn_seq
FROM content_document cd
LEFT JOIN turn t ON t.id = cd.turn
WHERE cd.source_kind = 'turn' AND cd.session = ?
ORDER BY turn_seq;
`;

const TURN_CONTENT_DOCUMENTS_FOR_SEQS_SQL = (seqs: ReadonlyArray<number>): string => `
SELECT cd.source_ref AS source_ref, cd.id AS document_id, cd.parser_id AS parser_id,
       cd.parser_version AS parser_version, cd.blockset_hash AS blockset_hash, t.seq AS turn_seq
FROM content_document cd
LEFT JOIN turn t ON t.id = cd.turn
WHERE cd.source_kind = 'turn' AND cd.session = ? AND t.seq IN (${seqs.map(() => "?").join(", ")})
ORDER BY turn_seq;
`;

/** Fast inspector path: documents by their turn source_ref, via the
 *  content_document_source (source_kind, source_ref) index. */
const TURN_CONTENT_DOCUMENTS_FOR_REFS_SQL = (refs: ReadonlyArray<string>): string => `
SELECT cd.source_ref AS source_ref, cd.id AS document_id, cd.parser_id AS parser_id,
       cd.parser_version AS parser_version, cd.blockset_hash AS blockset_hash, t.seq AS turn_seq
FROM content_document cd
LEFT JOIN turn t ON t.id = cd.turn
WHERE cd.source_kind = 'turn' AND cd.source_ref IN (${refs.map(() => "?").join(", ")});
`;

/** Blocks for a chunk of document ids - hits the content_block_document_seq
 *  (document, seq) index. */
const BLOCKS_BY_DOCUMENT_SQL = (documentIds: ReadonlyArray<string>): string => `
SELECT id, document AS document_id, seq, parent_seq, kind, role, heading, text, text_excerpt,
       start_offset, end_offset, confidence
FROM content_block
WHERE document IN (${documentIds.map(() => "?").join(", ")})
ORDER BY document, seq;
`;

/** Atoms for a chunk of document ids, joined to their block for `block.seq`
 *  (content_atom has no seq of its own - hits content_atom_document_kind). */
const ATOMS_BY_DOCUMENT_SQL = (documentIds: ReadonlyArray<string>): string => `
SELECT ca.document AS document_id, cb.seq AS block_seq, ca.kind, ca.value, ca.normalized,
       ca.confidence, ca.raw
FROM content_atom ca
JOIN content_block cb ON cb.id = ca.block
WHERE ca.document IN (${documentIds.map(() => "?").join(", ")})
ORDER BY ca.document, cb.seq, ca.kind, ca.value;
`;

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byDocumentThenSeq = (a: TurnContentBlockRow, b: TurnContentBlockRow): number =>
    compareStrings(a.document_id, b.document_id) || a.seq - b.seq;

const byDocumentBlockKindValue = (a: TurnContentAtomRow, b: TurnContentAtomRow): number =>
    compareStrings(a.document_id, b.document_id) ||
    a.block_seq - b.block_seq ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.value, b.value);

/** Fetch blocks + atoms for a set of documents (chunked `document IN (...)`
 *  lookups) and assemble them into a turn-seq-keyed map. Shared by all three
 *  entry points below - they differ only in how they resolve the document
 *  rows first. */
const resolveTurnContentFromDocuments = Effect.fn("queries.resolveTurnContentFromDocuments")(
    function* (documentRows: ReadonlyArray<TurnContentDocumentRow>) {
        if (documentRows.length === 0) return new Map<number, InspectTurnContentDto>();

        const documentMetaById = new Map<string, TurnContentDocumentRow>();
        for (const row of documentRows) documentMetaById.set(row.document_id, row);
        const documentIds = [...documentMetaById.keys()];
        const idChunks = Arr.chunksOf(documentIds, DOCUMENT_ID_CHUNK);

        const blockRows = (yield* Effect.forEach(
            idChunks,
            (chunk) => cacheRows(
                TurnContentBlockSchemaRow,
                { sql: BLOCKS_BY_DOCUMENT_SQL(chunk), params: [...chunk] },
                "session-turn-content blocks",
            ),
            { concurrency: DOCUMENT_ID_CONCURRENCY },
        )).flat().sort(byDocumentThenSeq);
        if (blockRows.length === 0) return new Map<number, InspectTurnContentDto>();

        const atomRows = (yield* Effect.forEach(
            idChunks,
            (chunk) => cacheRows(
                TurnContentAtomSchemaRow,
                { sql: ATOMS_BY_DOCUMENT_SQL(chunk), params: [...chunk] },
                "session-turn-content atoms",
            ),
            { concurrency: DOCUMENT_ID_CONCURRENCY },
        )).flat().sort(byDocumentBlockKindValue);

        const atomsByDocumentAndBlock = new Map<string, InspectContentAtomDto[]>();
        for (const atom of atomRows) {
            const key = `${atom.document_id}\0${atom.block_seq}`;
            const list = atomsByDocumentAndBlock.get(key) ?? [];
            list.push({
                kind: atom.kind,
                value: atom.value,
                normalized: atom.normalized ?? null,
                confidence: atom.confidence,
                raw: atom.raw === null ? null : safeJsonParse(atom.raw),
            });
            atomsByDocumentAndBlock.set(key, list);
        }

        const byTurn = new Map<number, InspectTurnContentDto>();
        const blocksByTurn = new Map<number, InspectContentBlockDto[]>();
        for (const row of blockRows) {
            const documentMeta = documentMetaById.get(row.document_id);
            if (!documentMeta || documentMeta.turn_seq === null) continue;
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
    },
);

/** Full content resolution for a session (share export path). */
export const resolveTurnContent = Effect.fn("queries.resolveTurnContent")(
    function* (sessionId: string) {
        const documentRows = yield* cacheRows(
            TurnContentDocumentSchemaRow,
            { sql: TURN_CONTENT_DOCUMENTS_BY_SESSION_SQL, params: [toBareSessionId(sessionId)] },
            "session-turn-content documents",
        );
        return yield* resolveTurnContentFromDocuments(documentRows);
    },
);

/** Full content resolution scoped to a specific set of turn seqs. */
export const resolveTurnContentForTurnSeqs = Effect.fn("queries.resolveTurnContentForTurnSeqs")(
    function* (sessionId: string, turnSeqs: ReadonlyArray<number>) {
        const seqs = [...new Set(turnSeqs)]
            .filter((seq) => Number.isInteger(seq) && seq >= 0)
            .sort((a, b) => a - b);
        if (seqs.length === 0) return new Map<number, InspectTurnContentDto>();
        const documentRows = yield* cacheRows(
            TurnContentDocumentSchemaRow,
            {
                sql: TURN_CONTENT_DOCUMENTS_FOR_SEQS_SQL(seqs),
                params: [toBareSessionId(sessionId), ...seqs],
            },
            "session-turn-content documents for seqs",
        );
        return yield* resolveTurnContentFromDocuments(documentRows);
    },
);

/** Inspector path: resolve content for an explicit list of turn source refs
 *  (a window of turns, not a whole session) via the source_ref index. */
export const resolveTurnContentForSourceRefs = Effect.fn("queries.resolveTurnContentForSourceRefs")(
    function* (sourceRefs: ReadonlyArray<string>) {
        const refs = [...new Set(sourceRefs)].filter((ref) => ref.length > 0);
        if (refs.length === 0) return new Map<number, InspectTurnContentDto>();
        const documentRows = (yield* Effect.forEach(
            Arr.chunksOf(refs, DOCUMENT_ID_CHUNK),
            (chunk) => cacheRows(
                TurnContentDocumentSchemaRow,
                { sql: TURN_CONTENT_DOCUMENTS_FOR_REFS_SQL(chunk), params: [...chunk] },
                "session-turn-content documents for refs",
            ),
            { concurrency: DOCUMENT_ID_CONCURRENCY },
        )).flat();
        return yield* resolveTurnContentFromDocuments(documentRows);
    },
);
