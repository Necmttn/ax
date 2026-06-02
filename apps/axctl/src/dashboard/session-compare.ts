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
    sessionHealthQuery,
    sessionOverviewQuery,
    sessionProducedCountQuery,
    sessionTokenUsageQuery,
} from "../queries/session-detail.ts";
import type {
    SessionCompareEntry,
    SessionComparePayload,
    SessionCompareWinners,
    SessionHealthSummary,
    SessionId,
    SessionOverview,
    SessionTokenUsageDetail,
} from "@ax/lib/shared/dashboard-types";
import { runSingleQuery } from "@ax/lib/shared/graph-query";

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

const computeWinners = (
    entries: ReadonlyArray<SessionCompareEntry>,
): SessionCompareWinners => ({
    fastest: argMinUnique(entries, (e) => e.duration_ms),
    cheapest: argMinUnique(entries, (e) => e.token_usage?.estimated_cost_usd ?? null),
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

export const fetchSessionCompare = (
    sessionIds: ReadonlyArray<string>,
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
            });
        }

        return {
            task_label: sharedTaskLabel(entries),
            sessions: entries,
            winners: computeWinners(entries),
            not_found: notFound,
        };
    });
