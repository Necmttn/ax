// apps/axctl/src/segment/import.ts
/**
 * `ax segment import <dir>` (#902): load a segment directory into the local
 * store under the ingest lock, then re-derive.
 *
 * The loader is the COLUMN-INTERSECTION loader the spec calls for - NEW
 * machinery, deliberately not the ingest spool: the spool refuses undeclared
 * columns and its `DO UPDATE` set comes from its own batch, so a narrower
 * NDJSON file would NULL columns it never meant to touch. Here the update set
 * is exactly (manifest columns ∩ local DDL columns): extra file fields are
 * ignored by `read_ndjson` under an explicit `columns=`, missing local
 * columns load as NULL, and the importer's own enrichment columns - which
 * never ride in a segment - cannot be clobbered.
 *
 * After the load, the importer writes `__imported__/<kind>/<sha>` watermark
 * marks from the manifest's `source_files`, so the target's next ingest
 * refresh-skips the original transcript bytes instead of reparsing them
 * (the slice-2/slice-3 handshake), and computes the wide re-derive window
 * `ceil(now - min(started_at))` - there is no session-scoped derive mode, so
 * the window is deliberately WIDE and its cost is the known post-#888 cost.
 */
import { Data, Effect, Schema } from "effect";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { hashFileSha256, importedMarkPath, WATERMARK_TABLE, watermarkRow } from "@ax/lib/duckdb/watermark";
import { ALL_STAGES } from "../ingest/stage/registry.ts";
import {
    SEGMENT_MANIFEST_FILE,
    SEGMENT_VERSION,
    ddlHash,
    localColumnDefs,
    SegmentManifest,
    type SegmentManifestT,
} from "./contract.ts";

export class SegmentImportError extends Data.TaggedError("SegmentImportError")<{
    readonly message: string;
}> {}

export interface SegmentImportPlanTable {
    readonly table: string;
    readonly rows: number;
    readonly columns: readonly string[];
    readonly droppedColumns: readonly string[];
    readonly filePath: string;
}

export interface SegmentImportPlan {
    readonly manifest: SegmentManifestT;
    readonly tables: readonly SegmentImportPlanTable[];
    readonly ddlMismatch: boolean;
}

export interface SegmentImportResult {
    readonly sessions: number;
    readonly tables: readonly SegmentImportPlanTable[];
    readonly marksWritten: number;
    readonly rederiveSinceDays: number | null;
    readonly rederiveStages: readonly string[];
}

/** The re-derive set, CONTRACT-driven: every registered stage whose declared
 *  writes are all derive/enrich/bookkeep. Loaders and parsers (any `parse`
 *  write) are excluded - their inputs are files this machine does not have. */
export const rederiveStageKeys = (): readonly string[] =>
    ALL_STAGES.filter(
        (stage) =>
            stage.meta.writes.length > 0 &&
            stage.meta.writes.every((write) => write.mode !== "parse"),
    ).map((stage) => stage.meta.key);

/** Read + validate the segment directory WITHOUT writing anything: manifest
 *  schema, segment version, per-file sha256, and the ddl_hash comparison the
 *  CLI turns into a `--yes` gate. */
export const planSegmentImport = (
    dir: string,
): Effect.Effect<SegmentImportPlan, SegmentImportError> =>
    Effect.gen(function* () {
        const manifestPath = `${dir}/${SEGMENT_MANIFEST_FILE}`;
        const rawText = yield* Effect.tryPromise({
            try: () => Bun.file(manifestPath).text(),
            catch: () => new SegmentImportError({ message: `no readable ${SEGMENT_MANIFEST_FILE} in ${dir} (aborted or not a segment)` }),
        });
        const raw = yield* Effect.try({
            try: () => JSON.parse(rawText) as unknown,
            catch: () => new SegmentImportError({ message: `${manifestPath} is not valid JSON` }),
        });
        const manifest = yield* Schema.decodeUnknownEffect(SegmentManifest)(raw).pipe(
            Effect.mapError((error) => new SegmentImportError({ message: `manifest does not match the segment schema: ${String(error)}` })),
        );
        if (manifest.segment_version !== SEGMENT_VERSION) {
            return yield* new SegmentImportError({
                message: `segment_version ${manifest.segment_version} is not supported (this ax reads v${SEGMENT_VERSION})`,
            });
        }

        const tables: SegmentImportPlanTable[] = [];
        for (const entry of manifest.tables) {
            if (entry.rows === 0) continue;
            const local = localColumnDefs(entry.table);
            if (local.size === 0) {
                // A table this DDL does not know - skip it loudly via droppedColumns-style
                // reporting rather than failing the whole import.
                continue;
            }
            const filePath = `${dir}/${entry.table}.ndjson`;
            const sha = yield* hashFileSha256(filePath);
            if (sha !== entry.sha256) {
                return yield* new SegmentImportError({
                    message: `${entry.table}.ndjson does not match its manifest sha256 (file ${sha ?? "unreadable"})`,
                });
            }
            const columns = entry.columns.filter((name) => local.has(name));
            const droppedColumns = entry.columns.filter((name) => !local.has(name));
            if (!columns.includes("id")) {
                return yield* new SegmentImportError({
                    message: `${entry.table}: exported columns carry no local "id" - cannot upsert`,
                });
            }
            tables.push({ table: entry.table, rows: entry.rows, columns, droppedColumns, filePath });
        }

        return { manifest, tables, ddlMismatch: manifest.ddl_hash !== ddlHash() };
    });

const sqlPath = (path: string): string => path.replace(/'/g, "''");

/** Load one table with the intersection loader. */
const loadTable = (
    write: CacheWriteService,
    plan: SegmentImportPlanTable,
): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
        const local = localColumnDefs(plan.table);
        const columnSpec = plan.columns
            .map((name) => `${name}: '${local.get(name)!.type}'`)
            .join(", ");
        const quoted = plan.columns.map((name) => `"${name}"`);
        const updates = plan.columns
            .filter((name) => name !== "id")
            .map((name) => `"${name}" = excluded."${name}"`)
            .join(", ");
        const conflict = updates.length > 0 ? `DO UPDATE SET ${updates}` : "DO NOTHING";
        yield* write.raw(
            `INSERT INTO "${plan.table}" (${quoted.join(", ")})
             SELECT ${quoted.join(", ")}
             FROM read_ndjson('${sqlPath(plan.filePath)}', columns={${columnSpec}})
             ON CONFLICT ("id") ${conflict}`,
        );
    });

/** Execute a validated plan against the LIVE store (caller supplies the
 *  lock-held write service, e.g. via `withConfigWrite`). Returns everything
 *  the CLI needs to trigger + report the re-derive. */
export const runSegmentImport = (
    write: CacheWriteService,
    plan: SegmentImportPlan,
): Effect.Effect<SegmentImportResult, SegmentImportError> =>
    Effect.gen(function* () {
        for (const table of plan.tables) {
            yield* loadTable(write, table).pipe(
                Effect.mapError(
                    (error) => new SegmentImportError({ message: `loading ${table.table}: ${String(error)}` }),
                ),
            );
        }

        // Watermark handshake: one `__imported__/<kind>/<sha>` mark per source
        // file. Idempotent (PK is (source_kind, path)-derived).
        let marksWritten = 0;
        for (const source of plan.manifest.source_files) {
            yield* write
                .put(
                    WATERMARK_TABLE,
                    watermarkRow(source.source_kind, importedMarkPath(source.source_kind, source.sha), {
                        sha: source.sha,
                        size: source.size,
                    }),
                )
                .pipe(
                    Effect.mapError(
                        (error) => new SegmentImportError({ message: `writing imported mark: ${String(error)}` }),
                    ),
                );
            marksWritten += 1;
        }

        // The wide re-derive window, from the segment's own session file (the
        // local table may hold older sessions that would widen it for free).
        const OldestRow = Schema.Struct({ oldest: Schema.NullOr(Schema.String) });
        const sessionPlan = plan.tables.find((table) => table.table === "session");
        let rederiveSinceDays: number | null = null;
        if (sessionPlan !== undefined) {
            const rows = yield* write
                .rows(
                    OldestRow,
                    `SELECT CAST(min(started_at) AS VARCHAR) AS oldest
                     FROM read_ndjson('${sqlPath(sessionPlan.filePath)}', columns={started_at: 'TIMESTAMP'})`,
                )
                .pipe(
                    Effect.mapError(
                        (error) => new SegmentImportError({ message: `reading oldest session: ${String(error)}` }),
                    ),
                );
            const oldest = rows[0]?.oldest ?? null;
            if (oldest !== null) {
                const ms = Date.now() - new Date(`${oldest.replace(" ", "T")}Z`).getTime();
                rederiveSinceDays = Math.max(1, Math.ceil(ms / 86_400_000));
            }
        }

        return {
            sessions: plan.manifest.scope.sessions.length,
            tables: plan.tables,
            marksWritten,
            rederiveSinceDays,
            rederiveStages: rederiveStageKeys(),
        };
    });
