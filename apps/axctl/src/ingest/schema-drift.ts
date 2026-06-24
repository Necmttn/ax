/**
 * Additive schema self-heal, gated to once per binary version (#283).
 *
 * Releases that add schema fields break ingest for anyone who swaps the
 * `axctl` binary without re-running `axctl install`. The DB is SCHEMAFULL, so
 * an UPSERT that writes a field the DB's schema predates is rejected outright:
 *
 *   ingest: FAILED after 0 sessions - Found field 'last_progress_at', but no
 *   such field exists for table 'ingest_run'
 *
 * The installer re-applies the full schema, but a manual binary swap is a real
 * upgrade path (the v0.24.0 checksum incident #251 forced exactly that; dev /
 * bench setups hit it too). This replays the bundled `DEFINE TABLE` / `DEFINE
 * FIELD` statements as `IF NOT EXISTS` - a no-op for everything that already
 * exists, an additive create for whatever the old schema lacks - so the next
 * ingest after an upgrade heals itself.
 *
 * Scope is deliberately the additive subset only. Indexes (a UNIQUE rebuild can
 * abort on duplicate data), analyzers, functions, and buckets (which need
 * per-machine bucket-path rendering, #251) stay the installer's job - replaying
 * them here would risk the exact transaction rollback #251 was about.
 *
 * A version-keyed sentinel (`dataDir/.schema-heal-<version>`) gates the replay
 * to once per binary version: drift can only appear right after an upgrade, so
 * steady-state ingest pays a single `fs.exists` and nothing more. The whole
 * thing is best-effort and fail-open - on any error ingest proceeds exactly as
 * it does today (and surfaces the honest missing-field verdict from #265),
 * never worse.
 */
import { Effect, FileSystem, Path } from "effect";
import schemaSurql from "@ax/schema/schema.surql" with { type: "text" };
import { SurrealClient } from "@ax/lib/db";

/** Statement prefixes safe to replay additively (no index/bucket/analyzer). */
const HEAL_PREFIXES = ["DEFINE TABLE ", "DEFINE FIELD "] as const;

/** Insert `IF NOT EXISTS` after the `DEFINE TABLE` / `DEFINE FIELD` keyword so
 *  the replay is a no-op on an already-defined table/field and an additive
 *  create otherwise. Idempotent: a statement that already carries the guard is
 *  left untouched. */
export const asIfNotExists = (line: string): string =>
    line
        .replace(/^DEFINE TABLE\s+(?!IF NOT EXISTS\b)/, "DEFINE TABLE IF NOT EXISTS ")
        .replace(/^DEFINE FIELD\s+(?!IF NOT EXISTS\b)/, "DEFINE FIELD IF NOT EXISTS ");

/**
 * The additive heal statements derived from a schema DDL string, in source
 * order (so each table is defined before its fields). Pure - exported for tests.
 */
export const schemaAdditiveHealStatements = (schema: string): string[] =>
    schema
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => HEAL_PREFIXES.some((p) => l.startsWith(p)))
        .map(asIfNotExists);

export interface SchemaHealResult {
    /** Whether the heal ran (false when the version sentinel already existed). */
    readonly checked: boolean;
    /** Whether the replay query succeeded (and the sentinel was written). */
    readonly applied: boolean;
    /** Number of DEFINE statements in the replay. */
    readonly statements: number;
}

/** Path of the per-version sentinel. Exported for tests. */
export const schemaHealSentinelPath = (pathSvc: Path.Path, dataDir: string, version: string): string =>
    pathSvc.join(dataDir, `.schema-heal-${version}`);

/**
 * Apply the additive schema heal once per binary version. Sentinel-gated,
 * fail-open: never fails its caller (errors collapse to `applied: false`).
 */
export const healAdditiveSchemaDrift = (opts: {
    readonly version: string;
    readonly dataDir: string;
}): Effect.Effect<SchemaHealResult, never, SurrealClient | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;
        const sentinel = schemaHealSentinelPath(pathSvc, opts.dataDir, opts.version);

        // Steady state: sentinel present => already healed for this version.
        const already = yield* fs.exists(sentinel).pipe(Effect.orElseSucceed(() => false));
        if (already) return { checked: false, applied: false, statements: 0 };

        const statements = schemaAdditiveHealStatements(schemaSurql);
        if (statements.length === 0) return { checked: true, applied: false, statements: 0 };

        const db = yield* SurrealClient;
        const applied = yield* db.query(statements.join("\n")).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
        );

        // Only stamp the sentinel on success, so a transient failure retries on
        // the next ingest instead of being silently skipped forever.
        if (applied) {
            yield* fs
                .writeFileString(sentinel, `${new Date().toISOString()}\n`)
                .pipe(Effect.ignore);
        }
        return { checked: true, applied, statements: statements.length };
    });
