import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { withinDaysClause } from "@ax/lib/duckdb/clause";
import { guidanceFromSignal, type GuidanceDraft } from "./guidance.ts";
import { deriveSignalsForSelfImprove, type SignalInput } from "./signals.ts";

export type SelfImproveCommand =
    | { readonly command: "guidance-next"; readonly json: boolean }
    | { readonly command: "session-summary"; readonly json: boolean }
    | { readonly command: "weekly"; readonly json: boolean };

export function parseSelfImproveArgs(root: string, args: string[]): SelfImproveCommand {
    const json = args.includes("--json");
    if (root === "guidance" && args[0] === "next") return { command: "guidance-next", json };
    if (root === "session" && args[0] === "summary") return { command: "session-summary", json };
    if (root === "self-improve" && args[0] === "weekly") return { command: "weekly", json };
    throw new Error(`unknown self-improve command: ${root} ${args.join(" ")}`);
}

export function guidanceNextSql(): string {
    return `
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before
    , created_at
FROM guidance_version
WHERE status = 'proposed'
ORDER BY created_at DESC
LIMIT 5`;
}

const GuidanceNextRow = Schema.Struct({
    id: Schema.String,
    guidance: Schema.String,
    version: Schema.String,
    text: Schema.String,
    status: Schema.String,
    scope: Schema.NullOr(Schema.String),
    risk: Schema.NullOr(Schema.String),
    evidence: Schema.NullOr(Schema.String),
    metrics_before: Schema.NullOr(Schema.String),
    created_at: TimestampColumn,
});

export const guidanceNext = (): Effect.Effect<unknown, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        return yield* read.rows(GuidanceNextRow, guidanceNextSql());
    });

export function sessionSummarySql(): string {
    return `
SELECT s.id AS id, s.project AS project, s.cwd AS cwd, s.started_at AS started_at, s.ended_at AS ended_at,
    COALESCE(s.ended_at, s.started_at) AS last_seen_at,
    (SELECT count(*) FROM tool_call t WHERE t.session = s.id) AS tool_calls,
    (SELECT count(*) FROM tool_call t WHERE t.session = s.id AND t.has_error = TRUE) AS failures
FROM session s
ORDER BY last_seen_at DESC
LIMIT 5`;
}

const SessionSummaryRow = Schema.Struct({
    id: Schema.String,
    project: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(TimestampColumn),
    ended_at: Schema.NullOr(TimestampColumn),
    last_seen_at: Schema.NullOr(TimestampColumn),
    // count(*) decodes as BIGINT, never Schema.Number - see @ax/lib/duckdb/columns.
    tool_calls: NumberFromBigIntColumn,
    failures: NumberFromBigIntColumn,
});

export const sessionSummary = (): Effect.Effect<unknown, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        return yield* read.rows(SessionSummaryRow, sessionSummarySql());
    });

/**
 * Documentation/test text only - NOT what `deriveWeeklyGuidance` executes.
 * The real reads are three separate bound-parameter DuckDB statements (see
 * below); this stays as a readable summary of what they select, using the
 * same guarded `CURRENT_TIMESTAMP` cast (@ax/lib/duckdb/clause daysAgoExpr)
 * the real queries use, so it also passes check:timestamp-cast.
 */
export function weeklyEvidenceSql(days: number): string {
    const cutoff = `CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(${days} AS INTEGER) * INTERVAL '1 day')`;
    return `
SELECT id, project, started_at AS startedAt FROM session WHERE started_at > ${cutoff};
SELECT session AS sessionId, command_norm AS commandNorm, has_error AS hasError, ts FROM tool_call WHERE ts > ${cutoff};
SELECT session AS sessionId, ts FROM plan_snapshot WHERE ts > ${cutoff};`;
}

const SessionEvidenceRow = Schema.Struct({
    id: Schema.String,
    project: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(TimestampColumn),
});
const ToolCallEvidenceRow = Schema.Struct({
    session: Schema.String,
    command_norm: Schema.NullOr(Schema.String),
    has_error: Schema.Boolean,
    ts: TimestampColumn,
});
// plan_snapshot has no `status` column in the DuckDB schema (never made the
// SurrealDB -> DuckDB migration; SignalInput.planSnapshots.status is optional
// and unused by every current signal deriver - see signals.ts), so it is
// mapped to `null` below rather than selected.
const PlanSnapshotEvidenceRow = Schema.Struct({
    session: Schema.String,
    ts: TimestampColumn,
});

export interface DeriveWeeklyGuidanceResult {
    readonly guidanceCount: number;
    readonly guidance: readonly GuidanceDraft[];
    /**
     * Reads are ported to CacheRead (the published DuckDB snapshot); the
     * write side is NOT. `guidance`/`guidance_version` writes only happen
     * inside ingest, under the ingest lock (`withCacheWrite` in
     * @ax/lib/duckdb/seam) - this command is a standalone CLI invocation,
     * never an ingest stage, so it holds no lock. Persisting SurrealDB
     * instead would be a silent data-loss trap: SurrealDB is write-frozen
     * from ingest's perspective, `guidanceNext` now reads the DuckDB
     * snapshot, and nothing would ever read a Surreal-side write back. So
     * this returns the derived drafts as DATA ONLY, un-persisted, until a
     * follow-up (an ingest derive-stage, or a dedicated locked write path)
     * gives this command a legal write target.
     */
    readonly persisted: false;
}

export const deriveWeeklyGuidance = (
    days = 7,
): Effect.Effect<DeriveWeeklyGuidanceResult, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const within = withinDaysClause("started_at", days);
        const withinTs = withinDaysClause("ts", days);
        const [sessionRows, toolCallRows, planSnapshotRows] = yield* Effect.all([
            read.rows(
                SessionEvidenceRow,
                `SELECT id, project, started_at FROM session WHERE TRUE ${within.sql}`,
                within.params,
            ),
            read.rows(
                ToolCallEvidenceRow,
                `SELECT session, command_norm, has_error, ts FROM tool_call WHERE TRUE ${withinTs.sql}`,
                withinTs.params,
            ),
            read.rows(
                PlanSnapshotEvidenceRow,
                `SELECT session, ts FROM plan_snapshot WHERE TRUE ${withinTs.sql}`,
                withinTs.params,
            ),
        ]);

        const input: SignalInput = {
            sessions: sessionRows.map((r) => ({
                id: r.id,
                project: r.project,
                startedAt: r.started_at?.toISOString() ?? null,
            })),
            toolCalls: toolCallRows.map((r) => ({
                sessionId: r.session,
                commandNorm: r.command_norm,
                hasError: r.has_error,
                ts: r.ts.toISOString(),
            })),
            planSnapshots: planSnapshotRows.map((r) => ({
                sessionId: r.session,
                status: null,
                ts: r.ts.toISOString(),
            })),
        };
        const guidance = deriveSignalsForSelfImprove(input).map(guidanceFromSignal);
        if (guidance.length > 0) {
            console.error(
                `ax self-improve weekly: derived ${guidance.length} guidance draft(s) but did NOT persist them - `
                + "writes only happen inside ingest, under the ingest lock; this command is not an ingest stage. "
                + "See DeriveWeeklyGuidanceResult.persisted in self-improve/commands.ts.",
            );
        }
        return { guidanceCount: guidance.length, guidance, persisted: false };
    });

export const selfImproveWeekly = (): Effect.Effect<DeriveWeeklyGuidanceResult, CacheReadError, CacheRead> =>
    deriveWeeklyGuidance(7);
