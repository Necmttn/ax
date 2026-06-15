import { Effect } from "effect";
import type { DbError } from "@ax/lib/errors";
import { SurrealClient } from "@ax/lib/db";
import { DigestItem } from "./model.ts";
import { salience } from "./rank.ts";
import { recommend } from "../improve/recommend.ts";
import {
    fetchDispatchCandidates,
    fetchDispatches,
} from "../queries/dispatch-analytics.ts";
import { fetchSessionChurnSummary } from "../metrics/session-churn.ts";

const COST_FLOOR_USD = 5;
const QUOTA_HOT_PCT = 70;

export const improveToItem = (openCount: number, now: Date): DigestItem | null => {
    if (openCount <= 0) return null;
    return DigestItem.make({
        id: "improve:open",
        kind: "improve",
        salience: salience({ kind: "improve", urgency: openCount, ageHours: 0 }),
        text: `${openCount} improve proposal${openCount === 1 ? "" : "s"} pending`,
        action: "ax improve recommend",
        computed_at: now,
    });
};

export const costToItem = (
    input: { savingsPerWeekUsd: number; inheritPct: number },
    now: Date,
): DigestItem | null => {
    if (input.savingsPerWeekUsd < COST_FLOOR_USD) return null;
    return DigestItem.make({
        id: "cost:routing",
        kind: "cost",
        salience: salience({ kind: "cost", urgency: input.savingsPerWeekUsd, ageHours: 0 }),
        text: `routing could save ~$${Math.round(input.savingsPerWeekUsd)}/wk (${Math.round(input.inheritPct)}% inherit)`,
        action: "ax dispatches --candidates",
        computed_at: now,
    });
};

export const churnToItem = (
    input: { sessionId: string; repairLoc: number; failedChecks: number; topFile: string | null },
    now: Date,
): DigestItem | null => {
    if (input.repairLoc <= 0) return null;
    const where = input.topFile ? ` in ${input.topFile}` : "";
    return DigestItem.make({
        id: `churn:${input.sessionId}`,
        kind: "churn",
        salience: salience({ kind: "churn", urgency: input.repairLoc + input.failedChecks * 5, ageHours: 0 }),
        text: `repair-loop${where} (${input.repairLoc} LOC churned, ${input.failedChecks} failed check${input.failedChecks === 1 ? "" : "s"})`,
        action: "ax sessions churn --here",
        evidence: input.sessionId,
        computed_at: now,
    });
};

export const quotaToItem = (
    input: { windowLabel: string; pctUsed: number },
    now: Date,
): DigestItem | null => {
    if (input.pctUsed <= QUOTA_HOT_PCT) return null;
    return DigestItem.make({
        id: `quota:${input.windowLabel}`,
        kind: "quota",
        salience: salience({ kind: "quota", urgency: input.pctUsed / 100, ageHours: 0 }),
        text: `${Math.round(input.pctUsed)}% of your ${input.windowLabel} quota window used`,
        action: "ax quota",
        computed_at: now,
    });
};

// ---- Effect wrappers ----

export const improveItems = (
    now: Date,
): Effect.Effect<DigestItem[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const proposals = yield* recommend({ limit: 100 });
        const item = improveToItem(proposals.length, now);
        return item ? [item] : [];
    });

export const costItems = (
    now: Date,
    windowDays: number,
): Effect.Effect<DigestItem[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        // Fetch candidates for savings estimate
        const candidates = yield* fetchDispatchCandidates({ sinceDays: windowDays });
        // Fetch dispatches summary for inherit_pct (not available on CandidatesResult)
        const dispatches = yield* fetchDispatches({ sinceDays: windowDays, limit: 1 });
        const savingsPerWeekUsd = (candidates.total_est_savings_usd * 7) / windowDays;
        const inheritPct = dispatches.inherit_pct;
        const item = costToItem({ savingsPerWeekUsd, inheritPct }, now);
        return item ? [item] : [];
    });

export const churnItems = (
    now: Date,
    windowDays: number,
): Effect.Effect<DigestItem[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const summary = yield* fetchSessionChurnSummary({ since, limit: 50 });
        // Pick the single worst session by repair LOC (repairLinesAdded)
        const worst = summary.hotSessions.reduce<
            typeof summary.hotSessions[number] | null
        >((best, row) => {
            if (!best) return row;
            return row.repairLinesAdded > best.repairLinesAdded ? row : best;
        }, null);
        if (!worst) return [];
        // SessionChurnRow has `topCheck` (the most-failing check), not topFile.
        // We use topCheck as the "where" label since per-file data is not exposed.
        const item = churnToItem(
            {
                sessionId: worst.session,
                repairLoc: worst.repairLinesAdded,
                failedChecks: worst.verificationFailures,
                topFile: worst.topCheck,
            },
            now,
        );
        return item ? [item] : [];
    });
