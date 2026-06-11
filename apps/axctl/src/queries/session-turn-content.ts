import { Array as Arr, Effect } from "effect";
import type { SurrealClient } from "@ax/lib/db";
import type {
    InspectContentAtomDto,
    InspectContentBlockDto,
    InspectTurnContentDto,
} from "@ax/lib/shared/dashboard-types";
import { identityPart } from "@ax/lib/ids";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { refListSource } from "@ax/lib/shared/record-select";
import { interpolateRid, queryMany } from "@ax/lib/shared/graph-query";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import { recordRef } from "@ax/lib/shared/surql";

const TURN_CONTENT_DOCUMENTS_SQL = `
    SELECT
        source_ref,
        type::string(id) AS document_id,
        parser_id,
        parser_version,
        blockset_hash,
        turn.seq AS turn_seq
    FROM content_document
    WHERE source_kind = "turn" AND session = $sid
    ORDER BY turn_seq;
`;

const TURN_CONTENT_DOCUMENTS_FOR_SEQS_SQL = `
    SELECT
        source_ref,
        type::string(id) AS document_id,
        parser_id,
        parser_version,
        blockset_hash,
        turn.seq AS turn_seq
    FROM content_document
    WHERE source_kind = "turn" AND session = $sid AND turn.seq IN $seqs
    ORDER BY turn_seq;
`;

// Per-document content queries: `document = $document` hits
// content_block_document_seq / content_atom_document_kind, so each is a ~1ms
// indexed lookup. They replace `... WHERE document IN [<all docs>]`, which was a
// membership scan over the whole 430k-block / 1.1M-atom tables (6s + 22s on a
// 318-doc session) - the same IN-scan family fixed for `enrichSessions`. Fanned
// out per document, full content export drops from ~28s to ~1s. `$document` is a
// validated record literal (contentDocumentRid), interpolated, never a binding.
const TURN_CONTENT_BLOCKS_FOR_DOC_SQL = `
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
    WHERE document = $document
    ORDER BY seq;
`;

const TURN_CONTENT_ATOMS_FOR_DOC_SQL = `
    SELECT
        type::string(document) AS document_id,
        block.seq AS block_seq,
        kind,
        value,
        normalized,
        confidence,
        raw
    FROM content_atom
    WHERE document = $document
    ORDER BY block_seq, kind, value;
`;

/** Per-document fan-out width for full content resolution (share export). */
const CONTENT_FANOUT_CONCURRENCY = 16;

/**
 * Max record refs a single materialized record-list query may carry on the
 * fast inspector path. Unbounded, a session at the inspect pagination cap
 * (2000 turns) packed 2000 x 20 = 40k block refs - and up to 40k x 8 kinds x 5
 * = 1.6M atom refs - into ONE SurrealQL statement, risking dashboard timeouts
 * and DB stalls. Exported for the query-capture regression tests.
 */
export const DIRECT_REF_BUDGET_PER_QUERY = 200;

/** Bounded concurrency for the chunked direct-ref fetches - same chunked-query
 *  discipline as the metrics fetchers (see metrics/fragility-cascade.ts). */
const DIRECT_REF_CONCURRENCY = 8;

/**
 * Hard ceiling on total speculative direct refs per request (block + atom
 * stages combined). Past it the speculative fetch degrades to the
 * per-document indexed fan-out the slow path already uses (~1ms per document
 * via content_block_document_seq / content_atom_document_kind), which beats
 * issuing hundreds of record-list chunks that mostly dereference to NONE.
 * Exported for the fan-out regression tests.
 */
export const MAX_SPECULATIVE_REFS_PER_REQUEST = 24_000;

/** Run one bounded record-list query per ref chunk (each query carries at
 *  most {@link DIRECT_REF_BUDGET_PER_QUERY} refs), flattening the per-chunk
 *  rows. Callers re-sort in JS - cross-chunk order is not meaningful. */
const chunkedRefQuery = <Row>(
    refs: ReadonlyArray<string>,
    sqlForChunk: (chunk: ReadonlyArray<string>) => string,
    context: string,
): Effect.Effect<ReadonlyArray<Row>, never, SurrealClient> =>
    Effect.forEach(
        Arr.chunksOf(refs, DIRECT_REF_BUDGET_PER_QUERY),
        (chunk) => queryMany<Row, Row>(sqlForChunk(chunk), (row) => row, context),
        { concurrency: DIRECT_REF_CONCURRENCY },
    ).pipe(Effect.map((results) => results.flat()));

interface TurnContentDocumentRow {
    readonly source_ref: string | null;
    readonly document_id: string;
    readonly parser_id: string;
    readonly parser_version: string;
    readonly blockset_hash: string | null;
    readonly turn_seq: number | null;
}

interface TurnContentBlockRow {
    readonly id: string;
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

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byDocumentThenSeq = (a: TurnContentBlockRow, b: TurnContentBlockRow): number =>
    compareStrings(a.document_id, b.document_id) || a.seq - b.seq;

const byDocumentBlockKindValue = (a: TurnContentAtomRow, b: TurnContentAtomRow): number =>
    compareStrings(a.document_id, b.document_id) ||
    a.block_seq - b.block_seq ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.value, b.value);

function contentDocumentRid(value: string): string | null {
    const prefix = "content_document:";
    if (!value.startsWith(prefix)) return null;
    const key = value.slice(prefix.length);
    if (!key) return null;
    if (/^[A-Za-z0-9_:-]+$/.test(key)) return `${prefix}${key}`;
    return `${prefix}\`${key.replace(/`/g, "")}\``;
}

export const resolveTurnContent = Effect.fn("queries.resolveTurnContent")(
    function* (sessionId: string) {
        return yield* resolveTurnContentFromDocuments(
            queryMany<TurnContentDocumentRow, TurnContentDocumentRow>(
                interpolateRid(TURN_CONTENT_DOCUMENTS_SQL, toBareSessionId(sessionId)),
                (row) => row,
                "session-turn-content resolveDocuments",
            ),
            { includeAtoms: true },
        );
    },
);

export const resolveTurnContentForTurnSeqs = Effect.fn("queries.resolveTurnContentForTurnSeqs")(
    function* (sessionId: string, turnSeqs: ReadonlyArray<number>) {
        const seqs = [...new Set(turnSeqs)]
            .filter((seq) => Number.isInteger(seq) && seq >= 0)
            .sort((a, b) => a - b);
        if (seqs.length === 0) return new Map<number, InspectTurnContentDto>();
        return yield* resolveTurnContentFromDocuments(
            queryMany<TurnContentDocumentRow, TurnContentDocumentRow>(
                interpolateRid(TURN_CONTENT_DOCUMENTS_FOR_SEQS_SQL, toBareSessionId(sessionId)),
                (row) => row,
                "session-turn-content resolveDocuments",
                { seqs },
            ),
            { includeAtoms: true },
        );
    },
);

const contentDocumentKeyForTurnRef = (sourceRef: string): string =>
    `turn__${identityPart(sourceRef, "source")}`;

export const resolveTurnContentForSourceRefs = Effect.fn("queries.resolveTurnContentForSourceRefs")(
    function* (sourceRefs: ReadonlyArray<string>) {
        const refs = [...new Set(sourceRefs)].filter((ref) => ref.length > 0);
        if (refs.length === 0) return new Map<number, InspectTurnContentDto>();
        const documentRefs = refs.map((ref) =>
            recordRef("content_document", contentDocumentKeyForTurnRef(ref)),
        );
        // Fast inspector path: direct document/block/atom record fetches avoid the
        // multi-second `document IN ...` scans seen on large sessions. Atoms are
        // capped per kind/block so the initial inspect response stays sub-second.
        // Every record-list fetch is chunked to DIRECT_REF_BUDGET_PER_QUERY refs;
        // a window at the pagination cap stays a series of small indexed queries
        // instead of one enormous statement.
        const fetchDocuments = chunkedRefQuery<TurnContentDocumentRow>(
            documentRefs,
            (chunk) => `
                SELECT
                    source_ref,
                    type::string(id) AS document_id,
                    parser_id,
                    parser_version,
                    blockset_hash,
                    turn.seq AS turn_seq
                FROM ${refListSource(chunk, ["id", "source_ref", "parser_id", "parser_version", "blockset_hash", "turn"])};
            `,
            "session-turn-content resolveDocumentsDirect",
        ).pipe(
            Effect.map((rows) => [...rows].sort((a, b) => (a.turn_seq ?? 0) - (b.turn_seq ?? 0))),
        );
        return yield* resolveTurnContentFromDocuments(fetchDocuments, {
            includeAtoms: false,
            directBlockLimitPerDocument: 20,
            directAtomLimitPerKind: 5,
        });
    },
);

const FAST_TURN_ATOM_KINDS = [
    "symbol_ref",
    "section_alias",
    "file_ref",
    "xml_tag",
    "command_ref",
    "url_ref",
    "citation_ref",
    "error_signature",
] as const;

const resolveTurnContentFromDocuments = (
    fetchDocuments: Effect.Effect<ReadonlyArray<TurnContentDocumentRow>, never, SurrealClient>,
    opts: {
        readonly includeAtoms: boolean;
        readonly directBlockLimitPerDocument?: number;
        readonly directAtomLimitPerKind?: number;
    } = { includeAtoms: true },
): Effect.Effect<Map<number, InspectTurnContentDto>, never, SurrealClient> =>
    Effect.gen(function* () {
        const documentRows = yield* fetchDocuments;
        if (documentRows.length === 0) return new Map<number, InspectTurnContentDto>();

        const documents = documentRows
            .map((row) => contentDocumentRid(row.document_id))
            .filter((value): value is string => value !== null);
        if (documents.length === 0) return new Map<number, InspectTurnContentDto>();

        const documentMetaById = new Map<string, TurnContentDocumentRow>();
        for (const row of documentRows) documentMetaById.set(row.document_id, row);

        const directBlockRefs = opts.directBlockLimitPerDocument
            ? documentRows.flatMap((row) => {
                if (!row.source_ref) return [];
                const documentKey = contentDocumentKeyForTurnRef(row.source_ref);
                return Array.from({ length: opts.directBlockLimitPerDocument ?? 0 }, (_, i) =>
                    recordRef("content_block", `${documentKey}__block_${(i + 1).toString(10).padStart(6, "0")}`),
                );
            })
            : [];
        // Hard ceiling on the speculative fan-out: past it, fall back to the
        // per-document indexed path - issuing one ~1ms indexed query per
        // document beats flooding the DB with speculative refs that mostly
        // dereference to NONE.
        const useDirectBlocks =
            directBlockRefs.length > 0 && directBlockRefs.length <= MAX_SPECULATIVE_REFS_PER_REQUEST;
        const blockRows = useDirectBlocks
            ? [...(yield* chunkedRefQuery<TurnContentBlockRow>(
                directBlockRefs,
                (chunk) => `
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
                    FROM ${refListSource(chunk, ["id", "document", "seq", "parent_seq", "kind", "role", "heading", "text", "text_excerpt", "start_offset", "end_offset", "confidence"])};
                `,
                "session-turn-content resolveBlocksDirect",
            ))].sort(byDocumentThenSeq)
            // Per-document indexed fan-out instead of a `document IN [<all docs>]`
            // membership scan (see TURN_CONTENT_BLOCKS_FOR_DOC_SQL).
            : (yield* Effect.forEach(
                documents,
                (docRid) =>
                    queryMany<TurnContentBlockRow, TurnContentBlockRow>(
                        TURN_CONTENT_BLOCKS_FOR_DOC_SQL.split("$document").join(docRid),
                        (row) => row,
                        "session-turn-content resolveBlocksPerDoc",
                    ),
                { concurrency: CONTENT_FANOUT_CONCURRENCY },
            )).flat();
        // Speculative atom refs only make sense while the request is still in
        // direct mode; once blocks fell back per-document, atoms follow.
        const directAtomRefs = useDirectBlocks && opts.directAtomLimitPerKind
            ? blockRows.flatMap((block) => {
                const blockKey = recordKeyPart(block.id, "content_block");
                if (!blockKey) return [];
                return FAST_TURN_ATOM_KINDS.flatMap((kind) =>
                    Array.from({ length: opts.directAtomLimitPerKind ?? 0 }, (_, i) =>
                        recordRef(
                            "content_atom",
                            `${blockKey}__${identityPart(kind, "atom")}__${(i + 1).toString(10).padStart(4, "0")}`,
                        ),
                    ),
                );
            })
            : [];
        const useDirectAtoms =
            directAtomRefs.length > 0 &&
            directBlockRefs.length + directAtomRefs.length <= MAX_SPECULATIVE_REFS_PER_REQUEST;
        // On the fast path, atoms past the ceiling degrade to the per-document
        // indexed fetch too (still correct - just no longer capped per kind).
        const wantsAtomFallback =
            opts.includeAtoms ||
            (opts.directAtomLimitPerKind !== undefined && !useDirectAtoms && blockRows.length > 0);
        const atomRows = useDirectAtoms
            ? [...(yield* chunkedRefQuery<TurnContentAtomRow>(
                directAtomRefs,
                (chunk) => `
                    SELECT
                        type::string(document) AS document_id,
                        block.seq AS block_seq,
                        kind,
                        value,
                        normalized,
                        confidence,
                        raw
                    FROM ${refListSource(chunk, ["document", "block", "kind", "value", "normalized", "confidence", "raw"])};
                `,
                "session-turn-content resolveAtomsDirect",
            ))].sort(byDocumentBlockKindValue)
            : wantsAtomFallback
              // Per-document indexed fan-out instead of a `document IN [...]` scan.
              ? (yield* Effect.forEach(
                  documents,
                  (docRid) =>
                      queryMany<TurnContentAtomRow, TurnContentAtomRow>(
                          TURN_CONTENT_ATOMS_FOR_DOC_SQL.split("$document").join(docRid),
                          (row) => row,
                          "session-turn-content resolveAtomsPerDoc",
                      ),
                  { concurrency: CONTENT_FANOUT_CONCURRENCY },
              )).flat()
              : [];

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
