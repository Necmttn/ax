import { Effect } from "effect";
import { cacheRow, jsonParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import { identityPart, stableDigest } from "../record-keys.ts";
import type { ContentSourceKind, ParsedContentAtom, ParsedContentBlock, ParsedContentDocument } from "./types.ts";

const REGISTRY_VERSION = "content-blocks-v1";
const SEARCH_TEXT_LIMIT = 8_000;
type JsonInput = unknown;

export type ContentDocumentRefs = {
    readonly turnId?: string | null; readonly sessionId?: string | null;
    readonly agentEventId?: string | null; readonly skillId?: string | null;
    readonly artifactId?: string | null; readonly planSnapshotId?: string | null;
};
export type ContentDocumentWrite = ContentDocumentRefs & {
    readonly sourceKind: ContentSourceKind; readonly sourceRef: string;
    readonly path?: string | null; readonly uri?: string | null; readonly title?: string | null;
    readonly contentHash: string; readonly rawText?: string | null; readonly raw?: JsonInput;
    readonly labels?: JsonInput; readonly metrics?: JsonInput; readonly repositoryId?: string | null;
    readonly workspaceId?: string | null; readonly artifactKind?: string | null;
    readonly parsed: ParsedContentDocument;
};
export type ContentAtomRelationWrite = {
    readonly atomKey: string; readonly blockKey: string; readonly documentKey: string;
    readonly sourceKind: ContentSourceKind; readonly workspaceId?: string | null;
    readonly targetKey: string; readonly confidence?: number | null;
};

export const contentDocumentRecordKey = (sourceKind: ContentSourceKind, sourceRef: string): string =>
    `${sourceKind}__${identityPart(sourceRef, "source")}`;
export const contentBlockRecordKey = (documentKey: string, seq: number): string =>
    `${documentKey}__block_${seq.toString(10).padStart(6, "0")}`;
export const contentAtomRecordKey = (blockKey: string, kind: string, seq: number): string =>
    `${blockKey}__${identityPart(kind, "atom")}__${seq.toString(10).padStart(4, "0")}`;
export const contentBlockHash = (block: ParsedContentBlock): string => stableDigest(JSON.stringify({
    kind: block.kind, parentSeq: block.parentSeq ?? null, role: block.role ?? null,
    heading: block.heading ?? null, text: block.text ?? null, searchText: block.searchText ?? null,
    parser: block.parser,
}));
export const contentBlocksetHash = (blocks: readonly ParsedContentBlock[], atoms: readonly ParsedContentAtom[]): string =>
    stableDigest(JSON.stringify({ blocks: blocks.map(contentBlockHash), atoms: atoms.map((atom) => ({
        blockSeq: atom.blockSeq, kind: atom.kind, value: atom.value, normalized: atom.normalized ?? null,
    })) }));
export const contentParseFingerprint = (write: Pick<ContentDocumentWrite, "contentHash" | "parsed">): string =>
    stableDigest(JSON.stringify({
        registryVersion: REGISTRY_VERSION, parserId: write.parsed.parserId,
        parserVersion: write.parsed.parserVersion, classifierVersions: write.parsed.classifierVersions ?? {},
        contentHash: write.contentHash,
    }));

const jsonValue = (value: unknown) => value == null ? null : jsonParam(value);
const finiteConfidence = (value: number | null | undefined) => Number.isFinite(value) ? value! : 1;
const cappedSearchText = (value: string | null | undefined): string | null =>
    value ? value.slice(0, SEARCH_TEXT_LIMIT) : null;

export const buildContentDocumentRows = (write: ContentDocumentWrite) => {
    const documentKey = contentDocumentRecordKey(write.sourceKind, write.sourceRef);
    const document = cacheRow({
        id: documentKey, source_kind: write.sourceKind, source_ref: write.sourceRef,
        turn: write.turnId ?? null, session: write.sessionId ?? null, agent_event: write.agentEventId ?? null,
        skill: write.skillId ?? null, artifact: write.artifactId ?? null, plan_snapshot: write.planSnapshotId ?? null,
        path: write.path ?? null, uri: write.uri ?? null, title: write.title ?? null,
        content_hash: write.contentHash, parse_fingerprint: contentParseFingerprint(write),
        registry_version: REGISTRY_VERSION, parser_id: write.parsed.parserId,
        parser_version: write.parsed.parserVersion,
        classifier_versions: jsonValue(write.parsed.classifierVersions),
        blockset_hash: contentBlocksetHash(write.parsed.blocks, write.parsed.atoms),
        raw_text: write.rawText ?? null, raw: jsonValue(write.raw), labels: jsonValue(write.labels),
        metrics: jsonValue(write.metrics), ts: new Date(),
    });
    const blocks = write.parsed.blocks.map((block) => {
        const blockKey = contentBlockRecordKey(documentKey, block.seq);
        return cacheRow({
            id: blockKey, document: documentKey, source_kind: write.sourceKind, kind: block.kind,
            seq: block.seq, parent_seq: block.parentSeq ?? null, role: block.role ?? null,
            heading: block.heading ?? null, text: block.text ?? null, text_excerpt: block.textExcerpt ?? null,
            search_text: cappedSearchText(block.searchText), block_hash: contentBlockHash(block),
            start_offset: block.startOffset ?? null, end_offset: block.endOffset ?? null,
            confidence: finiteConfidence(block.confidence), parser: block.parser,
            raw: jsonValue(block.raw), labels: jsonValue(block.labels), metrics: jsonValue(block.metrics), ts: new Date(),
        });
    });
    const atoms = write.parsed.atoms.map((atom, index) => {
        const blockKey = contentBlockRecordKey(documentKey, atom.blockSeq);
        return cacheRow({
            id: contentAtomRecordKey(blockKey, atom.kind, index + 1), block: blockKey, document: documentKey,
            source_kind: write.sourceKind, session: write.sessionId ?? null, agent_session: null,
            repository: write.repositoryId ?? null, workspace: write.workspaceId ?? null,
            artifact_kind: write.artifactKind ?? null, kind: atom.kind, value: atom.value,
            normalized: atom.normalized ?? null, start_offset: atom.startOffset ?? null,
            end_offset: atom.endOffset ?? null, confidence: finiteConfidence(atom.confidence),
            raw: jsonValue(atom.raw), ts: new Date(),
        });
    });
    return { documentKey, document, blocks, atoms };
};

export const contentAtomRelationRow = (
    table: "mentions_file" | "mentions_commit" | "mentions_artifact",
    relation: ContentAtomRelationWrite,
) => cacheRow({
    id: stableId(table, [relation.atomKey, relation.targetKey]), in_id: relation.atomKey,
    out_id: relation.targetKey, document: relation.documentKey, block: relation.blockKey,
    confidence: finiteConfidence(relation.confidence), source_kind: relation.sourceKind,
    ...(table === "mentions_artifact" ? {} : { workspace: relation.workspaceId ?? null }), ts: new Date(),
});

export const writeContentDocument = (
    writer: CacheWriteService,
    input: ContentDocumentWrite,
): Effect.Effect<{ documents: number; blocks: number; atoms: number }, CacheWriteError> =>
    Effect.gen(function* () {
        const rows = buildContentDocumentRows(input);
        yield* writer.exec("DELETE FROM content_atom WHERE document = ?", [rows.documentKey]);
        yield* writer.exec("DELETE FROM content_block WHERE document = ?", [rows.documentKey]);
        yield* writer.put("content_document", rows.document);
        yield* writer.putMany("content_block", rows.blocks);
        yield* writer.putMany("content_atom", rows.atoms);
        return { documents: 1, blocks: rows.blocks.length, atoms: rows.atoms.length };
    });
