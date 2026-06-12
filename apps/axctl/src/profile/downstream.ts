/**
 * computeDownstreamShares: for each skill, the fraction of session wall-time
 * AFTER its first invocation. Pure - no Effect, no IO.
 *
 * Formula: (ended_at - first_invocation_ts) / (ended_at - started_at)
 * Clamped [0,1]. Sessions < 5min excluded. Average over qualifying sessions.
 * Result rounded to 2 decimal places.
 */

export interface InvocationForShare {
    readonly session: string;
    readonly skill: string;
    readonly ts: string;
}

export interface SessionForShare {
    readonly id: string;
    readonly s: string; // started_at ISO string
    readonly e: string; // ended_at ISO string
}

const MS_5MIN = 5 * 60 * 1000;

/**
 * Returns a map of skill name -> downstream_share (2dp).
 * Skills with no qualifying sessions are omitted from the map.
 */
export function computeDownstreamShares(
    invocations: ReadonlyArray<InvocationForShare>,
    sessions: ReadonlyArray<SessionForShare>,
): Map<string, number> {
    // Build session lookup by id
    const sessionMap = new Map<string, { startMs: number; endMs: number }>();
    for (const s of sessions) {
        const startMs = Date.parse(s.s);
        const endMs = Date.parse(s.e);
        if (!isFinite(startMs) || !isFinite(endMs)) continue;
        const duration = endMs - startMs;
        if (duration < MS_5MIN) continue;
        sessionMap.set(s.id, { startMs, endMs });
    }

    // Per skill per session, track the earliest invocation ts
    // Map: skill -> session -> earliest_ts_ms
    const earliest = new Map<string, Map<string, number>>();
    for (const inv of invocations) {
        const sess = sessionMap.get(inv.session);
        if (sess === undefined) continue;
        const tsMs = Date.parse(inv.ts);
        if (!isFinite(tsMs)) continue;
        let bySession = earliest.get(inv.skill);
        if (bySession === undefined) { bySession = new Map(); earliest.set(inv.skill, bySession); }
        const current = bySession.get(inv.session);
        if (current === undefined || tsMs < current) bySession.set(inv.session, tsMs);
    }

    // Compute average downstream share per skill
    const result = new Map<string, number>();
    for (const [skill, bySession] of earliest) {
        let sum = 0;
        let n = 0;
        for (const [sessionId, firstTs] of bySession) {
            const sess = sessionMap.get(sessionId);
            if (sess === undefined) continue;
            const duration = sess.endMs - sess.startMs;
            const remaining = sess.endMs - firstTs;
            const share = Math.max(0, Math.min(1, remaining / duration));
            sum += share;
            n++;
        }
        if (n > 0) {
            const avg = sum / n;
            result.set(skill, Math.round(avg * 100) / 100);
        }
    }

    return result;
}
