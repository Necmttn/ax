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
 * @order after claude, codex, pi, cursor
 */

import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { stableDigest } from "@ax/lib/ids";
import {
    executeStatementsWith,
    recordKeyPart,
    recordRef,
    surrealDate,
    surrealString,
} from "@ax/lib/shared/surreal";
import {
    BaseStageStats,
    IngestContext,
    StageMeta,
    sinceDaysFromCtx,
    sinceAndClause,
} from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
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
 * Render one `has_content` RELATE statement. The edge is keyed by a stable
 * digest of the full tool_call id, ensuring collision-free keys even for long
 * cursor/opencode ids that share a 96+ char common prefix.
 *
 * Returns `null` when the tool_call id cannot be decomposed into a valid
 * SurrealDB key (empty string, unrecognised shape).
 */
export const renderContentEdge = (e: ContentEdgeSpec): string | null => {
    const tcKey = recordKeyPart(e.toolCallId, "tool_call");
    if (!tcKey) return null;
    // h-prefix distinguishes these keys from the old safeKeyPart-truncated scheme
    // used in the first watcher run; existing edges are found via ALREADY_SQL
    // (reads the `in` field, not the edge key), so no migration is needed.
    const edgeKey = `h${stableDigest(e.toolCallId)}`;
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

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

// Incremental: classify only tool_calls with no has_content edge yet.
// Two flat queries (deref-free): already-classified id set, then the rows.
// Edge ids are deterministic so re-running is a safe no-op upsert.
const ALREADY_SQL = `SELECT type::string(in) AS tid FROM has_content;`;

/** ROWS_SQL scoped by an optional since window (watcher runs pass 1d; full
 *  re-derives pass undefined to scan everything). */
export const rowsSql = (sinceDays: number | undefined): string => `
SELECT type::string(id) AS id, type::string(session) AS session, name,
       input_json AS inputJson, output_excerpt AS outputExcerpt,
       string::len(output_json) AS bytes, type::string(ts) AS ts
FROM tool_call WHERE output_json != NONE ${sinceAndClause(sinceDays)};
`;

export interface DeriveContentTypeStats {
    readonly written: number;
    readonly skipped: number;
}

export const deriveContentTypes = (sinceDays?: number): Effect.Effect<
    DeriveContentTypeStats,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        const [already] = yield* db.query<[Array<{ tid: string }>]>(ALREADY_SQL);
        const [rows] = yield* db.query<[Array<ToolCallRow>]>(rowsSql(sinceDays));

        const done = new Set((already ?? []).map((r) => r.tid));
        const stmts: string[] = renderContentTypeNodes();
        let written = 0;
        let skipped = 0;
        for (const row of rows ?? []) {
            if (done.has(row.id)) {
                skipped += 1;
                continue;
            }
            const sql = renderContentEdge(buildContentEdge(row));
            if (sql) {
                stmts.push(sql);
                written += 1;
            }
        }
        yield* executeStatementsWith(db, stmts, { chunkSize: 250, label: "contentEdges" });
        return { written, skipped } satisfies DeriveContentTypeStats;
    });

export class ContentTypeStats extends BaseStageStats.extend<ContentTypeStats>(
    "ContentTypeStats",
)({
    written: Schema.Number,
    skipped: Schema.Number,
}) {}

/**
 * Content-types stage - classifies tool_call outputs into a closed taxonomy and
 * writes has_content edges (denormalized session + bytes for deref-free reads).
 * Depends on all four harness stages that produce tool_call rows.
 * Tags: derive.
 */
export const contentTypesStage: StageDef<ContentTypeStats, SurrealClient> = {
    meta: StageMeta.make({
        key: "content-types",
        deps: ["claude", "codex", "pi", "cursor"],
        tags: ["derive"],
    }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveContentTypes(sinceDaysFromCtx(ctx));
            return ContentTypeStats.make({
                durationMs: Date.now() - t0,
                summary: `classified ${result.written} tool outputs (${result.skipped} already done)`,
                written: result.written,
                skipped: result.skipped,
            });
        }),
};
