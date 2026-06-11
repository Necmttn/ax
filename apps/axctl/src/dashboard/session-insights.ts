import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type { SessionInsightsPayload } from "@ax/lib/shared/dashboard-types";
import { toBareSessionId, toSessionRid } from "@ax/lib/shared/session-id";
import { fetchSessionBaselines } from "./session-baselines.ts";

/**
 * Insight-panel payload for one expanded sessions-list row.
 *
 * Everything here is scoped to one session id and uses aggregate or edge tables:
 * phase_span, reaction_event, produced, spawned, diagnostic_event, invoked,
 * session_metrics, session_token_usage, and session_health. The only turn-level
 * read is the second query over turn_token_usage for the expanded session's
 * context curve.
 */

// Live DB recon in Task 6 Step 1:
// SELECT status, count() AS c FROM diagnostic_event GROUP BY status;
//   -> only { status: 'error', c: 9436 }
// SELECT kind, count() AS c FROM diagnostic_event GROUP BY kind;
//   -> only { kind: 'tool_failure', c: 9436 }
const OK_STATUSES = new Set(["pass", "passed", "success", "ok"]);

const CURVE_MAX_POINTS = 60;
const DEFAULT_CONTEXT_WINDOW = 200_000;

interface PhaseRow {
    readonly phase: string;
    readonly start_ts: string;
    readonly end_ts: string;
    readonly duration_ms: number;
}

interface ReactionRow {
    readonly ts: string;
    readonly reaction_type: string;
}

interface CommitRow {
    readonly ts: string | null;
    readonly sha: string | null;
    readonly reverted: boolean | null;
}

interface SpawnedRow {
    readonly id: string;
    readonly started_at: string | null;
    readonly ended_at: string | null;
}

interface DiagnosticRow {
    readonly kind: string;
    readonly status: string | null;
    readonly ts: string;
}

interface InvokedRow {
    readonly skill: string;
    readonly ts: string;
}

interface MetricsRow {
    readonly lines_added: number;
    readonly lines_removed: number;
    readonly durability_ratio: number | null;
    readonly delegation_ratio: number | null;
    readonly time_to_land_ms: number | null;
}

interface UsageRow {
    readonly estimated_cost_usd: number | null;
    readonly context_window: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly prompt_tokens: number | null;
    readonly estimated_tokens: number | null;
}

interface HealthRow {
    readonly user_corrections: number | null;
    readonly tool_errors: number | null;
}

interface TurnUsageRow {
    readonly seq: number;
    readonly prompt_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly cache_creation_input_tokens: number | null;
    readonly ts: string;
}

interface CompactionRow {
    readonly ts: string;
}

const finiteRatio = (
    numerator: number | null | undefined,
    denominator: number | null | undefined,
): number | null =>
    typeof numerator === "number"
        && typeof denominator === "number"
        && Number.isFinite(numerator)
        && Number.isFinite(denominator)
        && denominator > 0
        ? numerator / denominator
        : null;

const skillNameFromKey = (key: string): string =>
    key.replace(/^skill:/, "").replace(/`/g, "").replace(/__/g, ":");

const downsampleCurve = (
    rows: ReadonlyArray<TurnUsageRow>,
    contextWindow: number | null | undefined,
): ReadonlyArray<{ readonly t: number; readonly pct: number }> => {
    const window = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
        ? contextWindow
        : DEFAULT_CONTEXT_WINDOW;
    const firstTs = rows[0]?.ts ? new Date(rows[0].ts).getTime() : 0;
    const points = rows.map((row) => {
        const ts = row.ts ? new Date(row.ts).getTime() : firstTs;
        const prompt = row.prompt_tokens ?? 0;
        const cacheRead = row.cache_read_input_tokens ?? 0;
        const cacheCreation = row.cache_creation_input_tokens ?? 0;
        return {
            t: Number.isFinite(ts) && Number.isFinite(firstTs) ? Math.max(0, ts - firstTs) : 0,
            pct: Math.min(1, (prompt + cacheRead + cacheCreation) / window),
        };
    });

    if (points.length <= CURVE_MAX_POINTS) return points;

    // Always keep index 0 (t=0 origin), then stride over the rest to fill
    // CURVE_MAX_POINTS - 1 slots, then append the last point unconditionally.
    const target = CURVE_MAX_POINTS - 1;
    const stride = Math.ceil((points.length - 1) / target);
    const sampled: Array<{ readonly t: number; readonly pct: number }> = [points[0]!];
    for (let i = stride; i < points.length - 1; i += stride) {
        sampled.push(points[i]!);
    }
    const last = points.at(-1)!;
    if (sampled.at(-1) !== last) sampled.push(last);
    return sampled;
};

const groupedChecks = (
    rows: ReadonlyArray<DiagnosticRow>,
): SessionInsightsPayload["checks"] => {
    const byKind = new Map<string, Array<{ readonly ts: string; readonly ok: boolean }>>();
    for (const row of rows) {
        const runs = byKind.get(row.kind) ?? [];
        runs.push({
            ts: row.ts,
            ok: row.status !== null && OK_STATUSES.has(row.status.toLowerCase()),
        });
        byKind.set(row.kind, runs);
    }
    return Array.from(byKind, ([kind, runs]) => ({ kind, runs }));
};

export const fetchSessionInsights = (
    bareId: string,
): Effect.Effect<SessionInsightsPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const session = toBareSessionId(bareId);
        const rid = toSessionRid(session);

        const [
            phases,
            negativeReactions,
            producedCommits,
            spawnedChildren,
            diagnostics,
            invokedSkills,
            metricsRows,
            usageRows,
            healthRows,
        ] = yield* db.query<[
            PhaseRow[],
            ReactionRow[],
            CommitRow[],
            SpawnedRow[],
            DiagnosticRow[],
            InvokedRow[],
            MetricsRow[],
            UsageRow[],
            HealthRow[],
        ]>(`
            SELECT phase, type::string(start_ts) AS start_ts, type::string(end_ts) AS end_ts, duration_ms
            FROM phase_span WHERE session = ${rid} ORDER BY start_ts ASC;

            SELECT type::string(ts) AS ts, reaction_type
            FROM reaction_event WHERE session = ${rid} AND polarity = "negative" ORDER BY ts ASC;

            SELECT type::string(out.ts) AS ts, out.sha AS sha, out.reverted AS reverted
            FROM produced WHERE in = ${rid};

            SELECT type::string(out) AS id, type::string(out.started_at) AS started_at, type::string(out.ended_at) AS ended_at
            FROM spawned WHERE in = ${rid};

            SELECT kind, status, type::string(ts) AS ts
            FROM diagnostic_event WHERE session = ${rid} ORDER BY ts ASC;

            SELECT type::string(out) AS skill, type::string(ts) AS ts
            FROM invoked WHERE session = ${rid} ORDER BY ts ASC;

            SELECT lines_added, lines_removed, durability_ratio, delegation_ratio, time_to_land_ms
            FROM session_metrics WHERE session = ${rid};

            SELECT estimated_cost_usd, context_window, cache_read_input_tokens, prompt_tokens, estimated_tokens
            FROM session_token_usage WHERE session = ${rid};

            SELECT user_corrections, tool_errors
            FROM session_health WHERE session = ${rid};
        `);

        const [turnUsage] = yield* db.query<[TurnUsageRow[]]>(`
            SELECT seq, prompt_tokens, cache_read_input_tokens, cache_creation_input_tokens, type::string(ts) AS ts
            FROM turn_token_usage WHERE session = ${rid} ORDER BY seq ASC;
        `);

        const [compactions] = yield* db.query<[CompactionRow[]]>(`
            SELECT type::string(ts) AS ts
            FROM compaction WHERE session = ${rid} ORDER BY ts ASC;
        `);

        const metrics = metricsRows[0] ?? null;
        const usage = usageRows[0] ?? null;
        const health = healthRows[0] ?? null;
        const friction = health
            ? (Number(health.user_corrections) || 0) + (Number(health.tool_errors) || 0)
            : null;

        const baselines = yield* fetchSessionBaselines().pipe(
            Effect.catch(() => Effect.succeed(null)),
        );

        const cacheRead = usage?.cache_read_input_tokens ?? null;
        const estimatedTokens = usage?.estimated_tokens ?? null;

        const contextCurve = downsampleCurve(turnUsage, usage?.context_window);

        // Compute t offsets for compaction dots using the same t0 as the curve.
        const curveT0Ms = turnUsage[0]?.ts ? new Date(turnUsage[0].ts).getTime() : 0;
        const curveTMax = contextCurve.length > 0 ? Math.max(...contextCurve.map((p) => p.t)) : 0;
        const compactionsWithT = compactions.map((c) => {
            const cMs = new Date(c.ts).getTime();
            const rawT = Number.isFinite(cMs) && Number.isFinite(curveT0Ms) ? Math.max(0, cMs - curveT0Ms) : 0;
            return { ts: c.ts, t: Math.min(rawT, curveTMax) };
        });

        return {
            session,
            phases,
            friction_ticks: negativeReactions.map((row) => ({ ts: row.ts, kind: row.reaction_type })),
            commits: producedCommits
                .filter((commit): commit is CommitRow & { readonly ts: string; readonly sha: string } =>
                    typeof commit.ts === "string" && commit.ts.length > 0
                    && typeof commit.sha === "string" && commit.sha.length > 0,
                )
                .map((commit) => ({ ts: commit.ts, sha: commit.sha, reverted: commit.reverted === true }))
                .sort((a, b) => a.ts.localeCompare(b.ts)),
            subagent_spans: spawnedChildren.map((child) => ({
                id: toBareSessionId(child.id),
                started_at: child.started_at,
                ended_at: child.ended_at,
            })),
            checks: groupedChecks(diagnostics),
            loc: metrics ? { added: metrics.lines_added, removed: metrics.lines_removed } : null,
            durability: metrics?.durability_ratio ?? null,
            delegation_ratio: metrics?.delegation_ratio ?? null,
            skills: invokedSkills.map((row) => ({ name: skillNameFromKey(row.skill), ts: row.ts })),
            context_curve: contextCurve,
            compactions: compactionsWithT,
            baseline: {
                cost_ratio: finiteRatio(usage?.estimated_cost_usd, baselines?.median_cost_usd),
                friction_ratio: finiteRatio(friction, baselines?.median_friction),
                land_ratio: finiteRatio(metrics?.time_to_land_ms, baselines?.median_time_to_land_ms),
                cache_pct: finiteRatio(cacheRead, estimatedTokens),
            },
        };
    });
