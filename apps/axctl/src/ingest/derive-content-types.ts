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
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import {
    BaseStageStats,
    IngestContext,
    StageMeta,
    sinceDaysFromCtx,
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
export const contentTypeRows = () =>
    ALL_CONTENT_CATEGORIES.map((category) => cacheRow({ id: category, category, label: category }));

/**
 * Render one `has_content` RELATE statement. The edge is keyed by a stable
 * digest of the full tool_call id, ensuring collision-free keys even for long
 * cursor/opencode ids that share a 96+ char common prefix.
 *
 * Returns `null` when the tool_call id cannot be decomposed into a valid
 * SurrealDB key (empty string, unrecognised shape).
 */
export const contentEdgeRow = (edge: ContentEdgeSpec) => cacheRow({
    id: stableId("has_content", [edge.toolCallId]),
    in_id: edge.toolCallId,
    out_id: edge.category,
    method: edge.method,
    confidence: edge.confidence,
    fine_label: edge.fineLabel,
    bytes: edge.bytes,
    session: edge.session,
    ts: tsParam(edge.ts),
});

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

// Incremental: classify only tool_calls with no has_content edge yet.
// Two flat queries (deref-free): already-classified id set, then the rows.
// Edge ids are deterministic so re-running is a safe no-op upsert.
const ALREADY_SQL = `SELECT in_id AS tid FROM has_content`;

/** ROWS_SQL scoped by an optional since window (watcher runs pass 1d; full
 *  re-derives pass undefined to scan everything). */
export const rowsSql = (sinceDays: number | undefined): string => `
SELECT id, session, name,
       input_json AS inputJson, output_excerpt AS outputExcerpt,
       length(output_json) AS bytes, ts
FROM tool_call WHERE output_json IS NOT NULL ${sinceDays === undefined ? "" : "AND ts >= current_timestamp - (? * INTERVAL '1 day')"};
`;

export interface DeriveContentTypeStats {
    readonly written: number;
    readonly skipped: number;
}

const ToolCallDbRow = Schema.Struct({
    id: Schema.String,
    session: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
    inputJson: Schema.NullOr(Schema.String),
    outputExcerpt: Schema.NullOr(Schema.String),
    bytes: Schema.BigInt,
    ts: TimestampColumn,
});

export const deriveContentTypes = (write: CacheWriteService, sinceDays?: number): Effect.Effect<
    DeriveContentTypeStats,
    CacheWriteError
> =>
    Effect.gen(function* () {
        const already = yield* write.rows(Schema.Struct({ tid: Schema.String }), ALREADY_SQL);
        const dbRows = yield* write.rows(ToolCallDbRow, rowsSql(sinceDays), sinceDays === undefined ? [] : [sinceDays]);
        const rows: ToolCallRow[] = dbRows.map((row) => ({
            id: row.id,
            session: row.session,
            name: row.name,
            inputJson: row.inputJson,
            outputExcerpt: row.outputExcerpt,
            bytes: Number(row.bytes),
            ts: row.ts.toISOString(),
        }));

        const done = new Set(already.map((r) => r.tid));
        const edges = [];
        let written = 0;
        let skipped = 0;
        for (const row of rows) {
            if (done.has(row.id)) {
                skipped += 1;
                continue;
            }
            edges.push(contentEdgeRow(buildContentEdge(row)));
            written += 1;
        }
        yield* write.putMany("content_type", contentTypeRows());
        yield* write.putMany("has_content", edges);
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
export const contentTypesStage: StageDef<ContentTypeStats, never, CacheWriteError> = {
    meta: StageMeta.make({
        key: "content-types",
        deps: ["claude", "codex", "pi", "omp", "cursor"],
        tags: ["derive"],
    }),
    run: (ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveContentTypes(write, sinceDaysFromCtx(ctx));
            return ContentTypeStats.make({
                durationMs: Date.now() - t0,
                summary: `classified ${result.written} tool outputs (${result.skipped} already done)`,
                written: result.written,
                skipped: result.skipped,
            });
        }),
};
