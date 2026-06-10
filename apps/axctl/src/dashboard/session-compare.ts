/**
 * Multi-session compare (swimlane P0 - summary metrics).
 *
 * Fetches a handful of sessions and lines up their headline metrics so the
 * caller can answer "same task, which run was faster / cheaper / cleaner?".
 * Reuses the per-session detail queries (overview, token usage) plus two
 * compare-specific reads (session_health, produced-edge count). No per-turn
 * data yet - that's P1.
 *
 * Latency note: `duration_ms` is wall-clock (ended_at - started_at). Raw
 * transcripts carry no request duration / TTFT, so true per-turn model
 * latency is not derivable here - see the compare-view plan.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    sessionCompareTurnsQuery,
    sessionHealthQuery,
    sessionOverviewQuery,
    sessionProducedCountQuery,
    sessionTokenUsageQuery,
    sessionTurnTokenUsageQuery,
} from "../queries/session-detail.ts";
import type {
    SessionCompareEntry,
    SessionComparePayload,
    SessionCompareTurn,
    SessionCompareWinners,
    SessionHealthSummary,
    SessionId,
    SessionOverview,
    SessionTokenUsageDetail,
} from "@ax/lib/shared/dashboard-types";
import { runQuery, runSingleQuery } from "@ax/lib/shared/graph-query";
import { fillEstimatedCost, loadPricingCatalogForModels } from "../metrics/cost-estimate.ts";

export interface SessionCompareOptions {
    /** Attach the per-turn timeline (P1). Off by default - summary only. */
    readonly includeTurns?: boolean;
}

// Mirrors the validation in session-detail.ts: accept real UUIDs and our
// synthetic prefixed ids, restricted to SurrealDB's unquoted-id charset so the
// record ref can be safely interpolated.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

const normalizeUuid = (sessionId: string): string =>
    sessionId
        .replace(/^session:⟨/, "")
        .replace(/⟩$/, "")
        .replace(/^session:/, "");

const durationMs = (overview: SessionOverview): number | null => {
    if (!overview.started_at || !overview.ended_at) return null;
    const start = new Date(overview.started_at).getTime();
    const end = new Date(overview.ended_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return end - start;
};

const noiseScore = (health: SessionHealthSummary | null): number | null =>
    health === null
        ? null
        : health.tool_errors + health.user_corrections + health.interruptions;

/**
 * Pick the session with the unique minimum finite metric. Returns null when no
 * session has the metric, or when the minimum is shared (a tie is not a clear
 * winner). Comparing a single session is meaningless, so callers should only
 * trust winners with 2+ entries.
 */
const argMinUnique = (
    entries: ReadonlyArray<SessionCompareEntry>,
    pick: (entry: SessionCompareEntry) => number | null,
): SessionId | null => {
    const candidates = entries
        .map((entry) => ({ id: entry.session_id, value: pick(entry) }))
        .filter((c): c is { id: SessionId; value: number } =>
            c.value !== null && Number.isFinite(c.value),
        );
    if (candidates.length === 0) return null;
    let best = candidates[0]!;
    let tied = false;
    for (const c of candidates.slice(1)) {
        if (c.value < best.value) {
            best = c;
            tied = false;
        } else if (c.value === best.value) {
            tied = true;
        }
    }
    return tied ? null : best.id;
};

/** Exported for unit tests (pure). */
export const computeWinners = (
    entries: ReadonlyArray<SessionCompareEntry>,
): SessionCompareWinners => ({
    fastest: argMinUnique(entries, (e) => e.duration_ms),
    // "Cheapest" is only decidable when EVERY session's cost is known - an
    // unknown cost is unknown, not $0, so a priced session must not win by
    // default over one we simply could not price (#175).
    cheapest: entries.every((e) => (e.token_usage?.estimated_cost_usd ?? null) !== null)
        ? argMinUnique(entries, (e) => e.token_usage?.estimated_cost_usd ?? null)
        : null,
    fewest_tokens: argMinUnique(entries, (e) => e.token_usage?.estimated_tokens ?? null),
    cleanest: argMinUnique(entries, (e) => e.noise_score),
});

const sharedTaskLabel = (
    entries: ReadonlyArray<SessionCompareEntry>,
): string | null => {
    const labels = entries.map((e) => e.health?.task_label ?? null);
    const first = labels[0] ?? null;
    if (first === null) return null;
    return labels.every((l) => l === first) ? first : null;
};

/** Build the per-turn timeline: turn spine merged with token usage (by seq),
 *  with wall-clock gaps derived from consecutive timestamps. */
const buildTurns = (params: { recordRef: string }) =>
    Effect.gen(function* () {
        const [spine, usage] = yield* Effect.all([
            runQuery(sessionCompareTurnsQuery, params),
            runQuery(sessionTurnTokenUsageQuery, params),
        ]);
        const usageBySeq = new Map<number, { tokens: number | null; cost: number | null }>();
        for (const u of usage) {
            if (u === null) continue;
            usageBySeq.set(u.seq, {
                tokens: u.estimated_tokens ?? null,
                cost: u.estimated_cost_usd ?? null,
            });
        }

        let prevMs: number | null = null;
        const turns: SessionCompareTurn[] = [];
        for (const row of spine) {
            if (row === null) continue;
            const ms = row.ts ? new Date(row.ts).getTime() : null;
            const gap_ms =
                prevMs !== null && ms !== null && Number.isFinite(ms) && ms >= prevMs
                    ? ms - prevMs
                    : null;
            if (ms !== null && Number.isFinite(ms)) prevMs = ms;
            const u = usageBySeq.get(row.seq);
            turns.push({
                seq: row.seq,
                role: row.role,
                ts: row.ts,
                gap_ms,
                est_tokens: u?.tokens ?? null,
                est_cost_usd: u?.cost ?? null,
                has_error: row.has_error,
            });
        }
        return turns;
    });

export const fetchSessionCompare = (
    sessionIds: ReadonlyArray<string>,
    options: SessionCompareOptions = {},
): Effect.Effect<SessionComparePayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const notFound: string[] = [];
        const entries: SessionCompareEntry[] = [];

        for (const sessionId of sessionIds) {
            const uuid = normalizeUuid(sessionId);
            if (!SESSION_ID_RE.test(uuid)) {
                notFound.push(sessionId);
                continue;
            }
            const params = { recordRef: `session:⟨${uuid}⟩` };
            const [overview, token_usage, health, commit_count] = yield* Effect.all([
                runSingleQuery(sessionOverviewQuery, params),
                runSingleQuery(sessionTokenUsageQuery, params),
                runSingleQuery(sessionHealthQuery, params),
                runSingleQuery(sessionProducedCountQuery, params),
            ]);

            if (overview === null) {
                notFound.push(sessionId);
                continue;
            }

            const turns = options.includeTurns ? yield* buildTurns(params) : undefined;

            entries.push({
                session_id: overview.id,
                source: overview.source,
                model: overview.model,
                project: overview.project,
                started_at: overview.started_at,
                ended_at: overview.ended_at,
                duration_ms: durationMs(overview),
                token_usage: token_usage as SessionTokenUsageDetail | null,
                health: health as SessionHealthSummary | null,
                commit_count: commit_count ?? 0,
                noise_score: noiseScore(health as SessionHealthSummary | null),
                ...(turns ? { turns } : {}),
            });
        }

        // #175: Claude byte-estimate usage rows were never priced at ingest, so
        // their stored estimated_cost_usd is null. Backfill an estimate from the
        // row's token counts × agent_model pricing (pricing_source gains an
        // `estimated:` prefix) so "cheapest" compares real numbers - and stays
        // undecided when a session genuinely cannot be priced.
        const catalog = yield* loadPricingCatalogForModels(
            entries.map((e) => e.token_usage?.model ?? e.model),
        );
        const priced = entries.map((entry) => {
            if (entry.token_usage === null) return entry;
            const usage = entry.token_usage;
            const filled = fillEstimatedCost({
                model: usage.model ?? entry.model,
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                estimated_tokens: usage.estimated_tokens,
                estimated_cost_usd: usage.estimated_cost_usd,
                pricing_source: usage.pricing_source,
            }, catalog);
            return filled.estimated
                ? {
                    ...entry,
                    token_usage: {
                        ...usage,
                        estimated_cost_usd: filled.estimatedCostUsd,
                        pricing_source: filled.pricingSource,
                    },
                }
                : entry;
        });

        return {
            task_label: sharedTaskLabel(priced),
            sessions: priced,
            winners: computeWinners(priced),
            not_found: notFound,
        };
    });
