import { Effect } from "effect";
import { SurrealClient } from "../../lib/db.ts";
import type { DbError } from "../../lib/errors.ts";
import { executeStatements } from "../../lib/shared/statement-exec.ts";
import {
    recordRef,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionInt,
    surrealOptionRecord,
    surrealOptionString,
    surrealString,
} from "../../lib/shared/surql.ts";
import { identityPart, stableDigest } from "../record-keys.ts";
import type {
    ContentSourceKind,
    ParsedContentAtom,
    ParsedContentBlock,
    ParsedContentDocument,
} from "./types.ts";

const REGISTRY_VERSION = "content-blocks-v1";
const SEARCH_TEXT_LIMIT = 8_000;

type JsonInput = unknown;

export type ContentDocumentRefs = {
    readonly turnId?: string | null;
    readonly sessionId?: string | null;
    readonly agentEventId?: string | null;
    readonly skillId?: string | null;
    readonly artifactId?: string | null;
    readonly planSnapshotId?: string | null;
};

export type ContentDocumentWrite = ContentDocumentRefs & {
    readonly sourceKind: ContentSourceKind;
    readonly sourceRef: string;
    readonly path?: string | null;
    readonly uri?: string | null;
    readonly title?: string | null;
    readonly contentHash: string;
    readonly rawText?: string | null;
    readonly raw?: JsonInput;
    readonly labels?: JsonInput;
    readonly metrics?: JsonInput;
    readonly repositoryId?: string | null;
    readonly workspaceId?: string | null;
    readonly artifactKind?: string | null;
    readonly parsed: ParsedContentDocument;
};

export type ContentAtomRelationWrite = {
    readonly atomKey: string;
    readonly blockKey: string;
    readonly documentKey: string;
    readonly sourceKind: ContentSourceKind;
    readonly workspaceId?: string | null;
    readonly targetKey: string;
    readonly confidence?: number | null;
};

export const contentDocumentRecordKey = (
    sourceKind: ContentSourceKind,
    sourceRef: string,
): string => `${sourceKind}__${identityPart(sourceRef, "source")}`;

export const contentBlockRecordKey = (documentKey: string, seq: number): string =>
    `${documentKey}__block_${seq.toString(10).padStart(6, "0")}`;

export const contentAtomRecordKey = (
    blockKey: string,
    kind: string,
    seq: number,
): string => `${blockKey}__${identityPart(kind, "atom")}__${seq.toString(10).padStart(4, "0")}`;

export const contentBlockHash = (block: ParsedContentBlock): string =>
    stableDigest(JSON.stringify({
        kind: block.kind,
        parentSeq: block.parentSeq ?? null,
        role: block.role ?? null,
        heading: block.heading ?? null,
        text: block.text ?? null,
        searchText: block.searchText ?? null,
        parser: block.parser,
    }));

export const contentBlocksetHash = (
    blocks: readonly ParsedContentBlock[],
    atoms: readonly ParsedContentAtom[],
): string => stableDigest(JSON.stringify({
    blocks: blocks.map(contentBlockHash),
    atoms: atoms.map((atom) => ({
        blockSeq: atom.blockSeq,
        kind: atom.kind,
        value: atom.value,
        normalized: atom.normalized ?? null,
    })),
}));

export const contentParseFingerprint = (
    write: Pick<ContentDocumentWrite, "contentHash" | "parsed">,
): string => stableDigest(JSON.stringify({
    registryVersion: REGISTRY_VERSION,
    parserId: write.parsed.parserId,
    parserVersion: write.parsed.parserVersion,
    classifierVersions: write.parsed.classifierVersions ?? {},
    contentHash: write.contentHash,
}));

const classifierVersionsJson = (
    versions: Record<string, string> | null | undefined,
): JsonInput => versions ?? null;

const confidence = (value: number | null | undefined): string =>
    Number.isFinite(value) ? String(value) : "1";

const cappedSearchText = (value: string | null | undefined): string | null => {
    if (!value) return null;
    return value.length > SEARCH_TEXT_LIMIT ? value.slice(0, SEARCH_TEXT_LIMIT) : value;
};

export const buildContentDocumentStatements = (
    write: ContentDocumentWrite,
): string[] => {
    const documentKey = contentDocumentRecordKey(write.sourceKind, write.sourceRef);
    const parseFingerprint = contentParseFingerprint(write);
    const blocksetHash = contentBlocksetHash(write.parsed.blocks, write.parsed.atoms);
    const statements: string[] = [
        `DELETE content_atom WHERE document = ${recordRef("content_document", documentKey)};`,
        `DELETE content_block WHERE document = ${recordRef("content_document", documentKey)};`,
        `UPSERT ${recordRef("content_document", documentKey)} CONTENT ${surrealObject([
            ["source_kind", surrealString(write.sourceKind)],
            ["source_ref", surrealString(write.sourceRef)],
            ["turn", surrealOptionRecord("turn", write.turnId)],
            ["session", surrealOptionRecord("session", write.sessionId)],
            ["agent_event", surrealOptionRecord("agent_event", write.agentEventId)],
            ["skill", surrealOptionRecord("skill", write.skillId)],
            ["artifact", surrealOptionRecord("artifact", write.artifactId)],
            ["plan_snapshot", surrealOptionRecord("plan_snapshot", write.planSnapshotId)],
            ["path", surrealOptionString(write.path)],
            ["uri", surrealOptionString(write.uri)],
            ["title", surrealOptionString(write.title)],
            ["content_hash", surrealString(write.contentHash)],
            ["parse_fingerprint", surrealString(parseFingerprint)],
            ["registry_version", surrealString(REGISTRY_VERSION)],
            ["parser_id", surrealString(write.parsed.parserId)],
            ["parser_version", surrealString(write.parsed.parserVersion)],
            ["classifier_versions", surrealJsonTextOption(classifierVersionsJson(write.parsed.classifierVersions))],
            ["blockset_hash", surrealString(blocksetHash)],
            ["raw_text", surrealOptionString(write.rawText)],
            ["raw", surrealJsonTextOption(write.raw)],
            ["labels", surrealJsonTextOption(write.labels)],
            ["metrics", surrealJsonTextOption(write.metrics)],
            ["ts", "time::now()"],
        ])};`,
    ];

    const atomsByBlockSeq = new Map<number, ParsedContentAtom[]>();
    for (const atom of write.parsed.atoms) {
        const atoms = atomsByBlockSeq.get(atom.blockSeq) ?? [];
        atoms.push(atom);
        atomsByBlockSeq.set(atom.blockSeq, atoms);
    }

    for (const block of write.parsed.blocks) {
        const blockKey = contentBlockRecordKey(documentKey, block.seq);
        const searchText = cappedSearchText(block.searchText);
        statements.push(`UPSERT ${recordRef("content_block", blockKey)} CONTENT ${surrealObject([
            ["document", recordRef("content_document", documentKey)],
            ["source_kind", surrealString(write.sourceKind)],
            ["kind", surrealString(block.kind)],
            ["seq", Math.trunc(block.seq).toString(10)],
            ["parent_seq", surrealOptionInt(block.parentSeq)],
            ["role", surrealOptionString(block.role)],
            ["heading", surrealOptionString(block.heading)],
            ["text", surrealOptionString(block.text)],
            ["text_excerpt", surrealOptionString(block.textExcerpt)],
            ["search_text", surrealOptionString(searchText)],
            ["block_hash", surrealString(contentBlockHash(block))],
            ["start_offset", surrealOptionInt(block.startOffset)],
            ["end_offset", surrealOptionInt(block.endOffset)],
            ["confidence", confidence(block.confidence)],
            ["parser", surrealString(block.parser)],
            ["raw", surrealJsonTextOption(block.raw)],
            ["labels", surrealJsonTextOption(block.labels)],
            ["metrics", surrealJsonTextOption(block.metrics)],
            ["ts", "time::now()"],
        ])};`);

        const atoms = atomsByBlockSeq.get(block.seq) ?? [];
        atoms.forEach((atom, index) => {
            const atomKey = contentAtomRecordKey(blockKey, atom.kind, index + 1);
            statements.push(`UPSERT ${recordRef("content_atom", atomKey)} CONTENT ${surrealObject([
                ["block", recordRef("content_block", blockKey)],
                ["document", recordRef("content_document", documentKey)],
                ["source_kind", surrealString(write.sourceKind)],
                ["session", surrealOptionRecord("session", write.sessionId)],
                ["agent_session", "NONE"],
                ["repository", surrealOptionRecord("repository", write.repositoryId)],
                ["workspace", surrealOptionRecord("workspace", write.workspaceId)],
                ["artifact_kind", surrealOptionString(write.artifactKind)],
                ["kind", surrealString(atom.kind)],
                ["value", surrealString(atom.value)],
                ["normalized", surrealOptionString(atom.normalized)],
                ["start_offset", surrealOptionInt(atom.startOffset)],
                ["end_offset", surrealOptionInt(atom.endOffset)],
                ["confidence", confidence(atom.confidence)],
                ["raw", surrealJsonTextOption(atom.raw)],
                ["ts", "time::now()"],
            ])};`);
        });
    }

    return statements;
};

const relationKey = (
    table: string,
    atomKey: string,
    targetKey: string,
): string => stableDigest(`${table}|${atomKey}|${targetKey}`);

const buildAtomRelationStatement = (
    table: "mentions_file" | "mentions_commit" | "mentions_artifact",
    targetTable: "file" | "commit" | "artifact",
    relation: ContentAtomRelationWrite,
): string =>
    `RELATE ${recordRef("content_atom", relation.atomKey)}->${table}:\`${relationKey(table, relation.atomKey, relation.targetKey)}\`->${recordRef(targetTable, relation.targetKey)} SET ${
        [
            ["document", recordRef("content_document", relation.documentKey)],
            ["block", recordRef("content_block", relation.blockKey)],
            ["confidence", confidence(relation.confidence)],
            ["source_kind", surrealString(relation.sourceKind)],
            ["workspace", surrealOptionRecord("workspace", relation.workspaceId)],
            ["ts", "time::now()"],
        ].map(([name, value]) => `${name} = ${value}`).join(", ")
    };`;

export const buildMentionsFileStatement = (relation: ContentAtomRelationWrite): string =>
    buildAtomRelationStatement("mentions_file", "file", relation);

export const buildMentionsCommitStatement = (relation: ContentAtomRelationWrite): string =>
    buildAtomRelationStatement("mentions_commit", "commit", relation);

export const buildMentionsArtifactStatement = (relation: ContentAtomRelationWrite): string =>
    buildAtomRelationStatement("mentions_artifact", "artifact", relation);

export const writeContentDocument = (
    write: ContentDocumentWrite,
): Effect.Effect<{ documents: number; blocks: number; atoms: number }, DbError, SurrealClient> =>
    Effect.gen(function* () {
        yield* executeStatements(buildContentDocumentStatements(write));
        return {
            documents: 1,
            blocks: write.parsed.blocks.length,
            atoms: write.parsed.atoms.length,
        };
    });
