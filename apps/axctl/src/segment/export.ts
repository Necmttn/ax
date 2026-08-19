// apps/axctl/src/segment/export.ts
/**
 * `ax segment export` (#902): write a session-scoped event segment to a plain
 * directory - one `<table>.ndjson` per contract table via `COPY ... TO`
 * (works on the READ_ONLY snapshot connection: COPY TO writes the filesystem,
 * not the catalog), `manifest.json` LAST so a manifest-less dir is an aborted
 * export.
 *
 * PRIVACY: a segment carries raw turn text and tool I/O. It is a LOCAL
 * artifact the user moves themselves; nothing here publishes, and no
 * attribution plug is applied (internal artifact).
 */
import { Data, Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { hashFileSha256 } from "@ax/lib/duckdb/watermark";
import {
    SEGMENT_MANIFEST_FILE,
    SEGMENT_MARKER_FILE,
    SEGMENT_TABLES,
    SEGMENT_VERSION,
    ddlHash,
    quoteScopeId,
    segmentExportColumns,
    withScope,
    type SegmentManifestT,
    type SegmentSourceFileT,
    type SegmentTableEntryT,
} from "./contract.ts";

export class SegmentExportError extends Data.TaggedError("SegmentExportError")<{
    readonly message: string;
}> {}

export interface SegmentExportOptions {
    /** Explicit session ids (expanded to spawned descendants), or... */
    readonly sessions?: readonly string[];
    /** ...a started_at window in days. Exactly one of the two. */
    readonly sinceDays?: number;
    readonly outDir: string;
    readonly axVersion: string;
    readonly now?: Date;
}

export interface SegmentExportResult {
    readonly outDir: string;
    readonly sessions: number;
    readonly tables: readonly SegmentTableEntryT[];
    readonly sourceFiles: number;
}

const IdRow = Schema.Struct({ id: Schema.String });
const CountRow = Schema.Struct({ n: Schema.Number });

/** Expand explicit session ids to their spawned descendants (a subagent's
 *  rows are part of its parent's story). Iterates to a fixpoint in JS - the
 *  spawn tree is shallow, so this is 2-3 small queries. */
const expandDescendants = (
    ids: readonly string[],
): Effect.Effect<readonly string[], CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const scope = new Set(ids);
        let frontier = [...ids];
        while (frontier.length > 0) {
            const children = yield* cache.rows(
                IdRow,
                `SELECT DISTINCT out_id AS id FROM spawned WHERE in_id IN (${frontier.map(quoteScopeId).join(", ")})`,
            );
            frontier = children.map((row) => row.id).filter((id) => !scope.has(id));
            for (const id of frontier) scope.add(id);
        }
        return [...scope];
    });

const resolveScope = (
    opts: SegmentExportOptions,
): Effect.Effect<readonly string[], CacheReadError | SegmentExportError, CacheRead> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        if (opts.sessions !== undefined && opts.sessions.length > 0) {
            const known = yield* cache.rows(
                IdRow,
                `SELECT id FROM session WHERE id IN (${opts.sessions.map(quoteScopeId).join(", ")})`,
            );
            const missing = opts.sessions.filter((id) => !known.some((row) => row.id === id));
            if (missing.length > 0) {
                return yield* new SegmentExportError({
                    message: `unknown session id(s): ${missing.join(", ")}`,
                });
            }
            return yield* expandDescendants(opts.sessions);
        }
        if (opts.sinceDays !== undefined) {
            const rows = yield* cache.rows(
                IdRow,
                "SELECT id FROM session WHERE started_at >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')",
                [opts.sinceDays],
            );
            return rows.map((row) => row.id);
        }
        return yield* new SegmentExportError({ message: "pass --sessions=<ids> or --since=Nd" });
    });

const sqlPath = (path: string): string => path.replace(/'/g, "''");

export const runSegmentExport = (
    opts: SegmentExportOptions,
): Effect.Effect<SegmentExportResult, CacheReadError | SegmentExportError, CacheRead> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const manifestPath = `${opts.outDir}/${SEGMENT_MANIFEST_FILE}`;
        const existing = yield* Effect.promise(() => Bun.file(manifestPath).exists());
        if (existing) {
            return yield* new SegmentExportError({
                message: `${opts.outDir} already holds a segment (manifest.json exists) - export into a fresh directory`,
            });
        }

        const scope = yield* resolveScope(opts);
        if (scope.length === 0) {
            return yield* new SegmentExportError({ message: "no sessions in scope - nothing to export" });
        }

        // The marker write creates the directory (Bun.write mkdir -p's), so
        // COPY TO has somewhere to land. Marker-without-manifest = aborted.
        yield* Effect.promise(() => Bun.write(`${opts.outDir}/${SEGMENT_MARKER_FILE}`, `ax segment v${SEGMENT_VERSION}\n`));

        const tables: SegmentTableEntryT[] = [];
        for (const spec of SEGMENT_TABLES) {
            const columns = segmentExportColumns(spec.table);
            const predicate = withScope(spec.predicate, scope);
            const select = `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${spec.table}" WHERE ${predicate}`;
            const filePath = `${opts.outDir}/${spec.table}.ndjson`;
            yield* cache.raw(`COPY (${select}) TO '${sqlPath(filePath)}' (FORMAT JSON, ARRAY false)`);
            const count = yield* cache.rows(
                CountRow,
                `SELECT CAST(count(*) AS DOUBLE) AS n FROM "${spec.table}" WHERE ${predicate}`,
            );
            const sha = yield* hashFileSha256(filePath);
            if (sha === null) {
                return yield* new SegmentExportError({ message: `could not hash ${filePath} after COPY` });
            }
            tables.push({ table: spec.table, rows: count[0]?.n ?? 0, sha256: sha, columns });
        }

        // Watermark handshake payload: content hashes of the transcript files
        // behind the exported sessions, read off `ingest_file_state` via
        // `session.raw_file`. Rows without a stored sha (pre-#900 history not
        // yet re-marked) are simply absent - the importer then reparses, which
        // is the safe direction.
        const SourceRow = Schema.Struct({
            source_kind: Schema.String,
            sha: Schema.String,
            size: Schema.NullOr(Schema.Number),
        });
        const sourceRows = yield* cache.rows(
            SourceRow,
            `SELECT DISTINCT f.source_kind, f.sha, CAST(f.size AS DOUBLE) AS size
             FROM ingest_file_state f
             JOIN session s ON s.raw_file = f.path
             WHERE s.id IN (${scope.map(quoteScopeId).join(", ")}) AND f.sha IS NOT NULL`,
        );
        const sourceFiles: SegmentSourceFileT[] = sourceRows.map((row) => ({
            source_kind: row.source_kind,
            sha: row.sha,
            size: row.size,
        }));

        const manifest: SegmentManifestT = {
            segment_version: SEGMENT_VERSION,
            created_at: (opts.now ?? new Date()).toISOString(),
            ax_version: opts.axVersion,
            ddl_hash: ddlHash(),
            scope: {
                kind: opts.sessions !== undefined && opts.sessions.length > 0 ? "sessions" : "since",
                sessions: scope,
                since_days: opts.sinceDays ?? null,
            },
            tables,
            source_files: sourceFiles,
            notes: {
                cost_columns:
                    "estimated_* cost columns were priced by the exporting machine's catalog; divergence accepted",
                enrichment_stripped: true,
            },
        };
        yield* Effect.promise(() => Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`));

        return { outDir: opts.outDir, sessions: scope.length, tables, sourceFiles: sourceFiles.length };
    });
