import { Effect } from "effect";
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
        return yield* resolveTurnContentFromDocuments(interpolateRid(TURN_CONTENT_DOCUMENTS_SQL, toBareSessionId(sessionId)), {
            includeAtoms: true,
        });
    },
);

export const resolveTurnContentForTurnSeqs = Effect.fn("queries.resolveTurnContentForTurnSeqs")(
    function* (sessionId: string, turnSeqs: ReadonlyArray<number>) {
        const seqs = [...new Set(turnSeqs)]
            .filter((seq) => Number.isInteger(seq) && seq >= 0)
            .sort((a, b) => a - b);
        if (seqs.length === 0) return new Map<number, InspectTurnContentDto>();
        return yield* resolveTurnContentFromDocuments(
            interpolateRid(TURN_CONTENT_DOCUMENTS_FOR_SEQS_SQL, toBareSessionId(sessionId)),
            { seqs },
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
        const documents = refListSource(
            refs.map((ref) => recordRef("content_document", contentDocumentKeyForTurnRef(ref))),
            ["id", "source_ref", "parser_id", "parser_version", "blockset_hash", "turn"],
        );
        // Fast inspector path: direct document/block/atom record fetches avoid the
        // multi-second `document IN ...` scans seen on large sessions. Atoms are
        // capped per kind/block so the initial inspect response stays sub-second.
        return yield* resolveTurnContentFromDocuments(`
        SELECT
            source_ref,
            type::string(id) AS document_id,
            parser_id,
            parser_version,
            blockset_hash,
            turn.seq AS turn_seq
        FROM ${documents}
        ORDER BY turn_seq;
    `, undefined, {
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
    documentsSql: string,
    bindings?: Record<string, unknown>,
    opts: {
        readonly includeAtoms: boolean;
        readonly directBlockLimitPerDocument?: number;
        readonly directAtomLimitPerKind?: number;
    } = { includeAtoms: true },
): Effect.Effect<Map<number, InspectTurnContentDto>, never, SurrealClient> =>
    Effect.gen(function* () {
        const documentRows = yield* queryMany<TurnContentDocumentRow, TurnContentDocumentRow>(
            documentsSql,
            (row) => row,
            "session-turn-content resolveDocuments",
            bindings,
        );
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
        const blockRows = directBlockRefs.length > 0
            ? yield* queryMany<TurnContentBlockRow, TurnContentBlockRow>(
                `
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
                    FROM ${refListSource(directBlockRefs, ["id", "document", "seq", "parent_seq", "kind", "role", "heading", "text", "text_excerpt", "start_offset", "end_offset", "confidence"])}
                    ORDER BY document_id, seq;
                `,
                (row) => row,
                "session-turn-content resolveBlocksDirect",
            )
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
        const directAtomRefs = opts.directAtomLimitPerKind
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
        const atomRows = directAtomRefs.length > 0
            ? yield* queryMany<TurnContentAtomRow, TurnContentAtomRow>(
                `
                    SELECT
                        type::string(document) AS document_id,
                        block.seq AS block_seq,
                        kind,
                        value,
                        normalized,
                        confidence,
                        raw
                    FROM ${refListSource(directAtomRefs, ["document", "block", "kind", "value", "normalized", "confidence", "raw"])}
                    ORDER BY document_id, block_seq, kind, value;
                `,
                (row) => row,
                "session-turn-content resolveAtomsDirect",
            )
            : opts.includeAtoms
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
