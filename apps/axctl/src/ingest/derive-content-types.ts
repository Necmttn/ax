/**
 * @stage derive-content-types
 * @rationale Build a `has_content` edge from each `tool_call` to the closed
 *   `content_type` taxonomy node that best describes its output. Extension
 *   matching on the `file_path` from the tool input is the strongest signal;
 *   a lightweight content sniff handles Bash/exec output that has no path; a
 *   text fallback closes the set. Category nodes are a fixed closed taxonomy
 *   (12 values) upserted once per ingest run. The edge is keyed by tool_call
 *   id so re-runs are idempotent.
 * @inputs `tool_call` rows: id, session, name, input_json, output_excerpt, bytes, ts
 * @outputs `content_type` nodes (upsert, idempotent) + `has_content` edges
 * @order after tool-calls
 *
 * Pure layer - no Effect, no DB calls. Task 4 wires this into the ingest stage.
 */

import {
    recordKeyPart,
    recordRef,
    safeKeyPart,
    surrealDate,
    surrealString,
} from "@ax/lib/shared/surreal";
import {
    ALL_CONTENT_CATEGORIES,
    classifyContentType,
    type ContentCategory,
} from "./content-type-classify.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRow {
    readonly id: string;
    readonly session: string | null;
    readonly name: string | null;
    readonly inputJson: string | null;
    readonly outputExcerpt: string | null;
    readonly bytes: number;
    readonly ts: string;
}

export interface ContentEdgeSpec {
    readonly toolCallId: string;
    readonly category: ContentCategory;
    readonly session: string | null;
    readonly method: string;
    readonly confidence: number;
    readonly fineLabel: string | null;
    readonly bytes: number;
    readonly ts: string;
}

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

/** Extract a file path from a JSON-encoded tool input (Read/Edit/Write/NotebookEdit). */
const filePathFromInput = (inputJson: string | null): string | null => {
    if (!inputJson) return null;
    try {
        const obj = JSON.parse(inputJson) as Record<string, unknown>;
        const fp = obj["file_path"] ?? obj["path"] ?? obj["notebook_path"];
        return typeof fp === "string" ? fp : null;
    } catch {
        return null;
    }
};

/**
 * Derive a content-edge spec from a single tool_call row. Classifies the
 * output and denormalizes session + bytes onto the edge for fast aggregation
 * without a join.
 */
export const buildContentEdge = (row: ToolCallRow): ContentEdgeSpec => {
    const r = classifyContentType({
        filePath: filePathFromInput(row.inputJson),
        output: row.outputExcerpt ?? "",
        toolName: row.name,
    });
    return {
        toolCallId: row.id,
        category: r.category,
        session: row.session,
        method: r.method,
        confidence: r.confidence,
        fineLabel: r.fineLabel,
        bytes: row.bytes,
        ts: row.ts,
    };
};

/** Upsert all 12 fixed taxonomy nodes. Idempotent; safe on every ingest run. */
export const renderContentTypeNodes = (): string[] =>
    ALL_CONTENT_CATEGORIES.map(
        (c) =>
            `UPSERT content_type:${c} SET category = ${surrealString(c)}, label = ${surrealString(c)};`,
    );

/**
 * Render one `has_content` RELATE statement. The edge is keyed by the
 * tool_call id so repeated ingest runs are idempotent (same tool_call ->
 * same edge key -> RELATE upserts in place).
 *
 * Returns `null` when the tool_call id cannot be decomposed into a valid
 * SurrealDB key (empty string, unrecognised shape).
 */
export const renderContentEdge = (e: ContentEdgeSpec): string | null => {
    const tcKey = recordKeyPart(e.toolCallId, "tool_call");
    if (!tcKey) return null;
    const edgeKey = safeKeyPart(e.toolCallId);
    const sessionKey = e.session ? recordKeyPart(e.session, "session") : null;
    const sessionClause = sessionKey
        ? `, session = ${recordRef("session", sessionKey)}`
        : "";
    const fineClause = e.fineLabel
        ? `, fine_label = ${surrealString(e.fineLabel)}`
        : "";
    return (
        `RELATE ${recordRef("tool_call", tcKey)}->${recordRef("has_content", edgeKey)}->content_type:${e.category} ` +
        `SET method = ${surrealString(e.method)}, confidence = ${e.confidence}, bytes = ${e.bytes}, ` +
        `ts = ${surrealDate(e.ts)}${sessionClause}${fineClause};`
    );
};
