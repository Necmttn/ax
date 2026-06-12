/**
 * buildProfile - compose windowed queries + pure derivers into a decoded
 * ProfileV1. Privacy invariants live HERE, not at the edge: cost only when
 * includeCost; aggregates only (nothing in this module touches transcript
 * content, project names, or paths). Environment (github login, today,
 * hook files, rules text) is injected so the Effect needs only SurrealClient.
 */
import { Effect } from "effect";
import { fetchCostModels } from "../queries/cost-analytics.ts";
import {
    fetchAcceptedProposals,
    fetchCommitCount,
    fetchDailyActivity,
    fetchDailyActivityFull,
    fetchHarnesses,
    fetchPeakHour,
    fetchSessionDurations,
    fetchSkillInvocations,
    fetchSkillScopes,
    fetchSpawnedCount,
    fetchTokenTotals,
    fetchTopTools,
    fetchWrappedCounts,
} from "./queries.ts";
import { deriveInsights } from "./insights.ts";
import { deriveRig } from "./rig.ts";
import { computeStreak } from "./streak.ts";
import { deriveTastePatterns } from "./taste.ts";
import { decodeProfile, type ProfileV1 } from "./schema.ts";

export interface ProfileEnv {
    readonly github: string;
    readonly generatedAt: string;
    readonly today: string;
    readonly hookFiles: ReadonlyArray<string>;
    readonly hasRoutingTable: boolean;
    readonly rulesMarkdown: string | null;
}

export const buildProfile = Effect.fn("profile.buildProfile")(
    function* (opts: {
        readonly windowDays: number;
        readonly includeCost: boolean;
        readonly env: ProfileEnv;
    }) {
        const { windowDays, includeCost, env } = opts;

        // Sequential on purpose: makeMockDb replays results in call order,
        // and the local DB answers these in milliseconds anyway.
        // Order (keep render.test.ts mocks aligned):
        // 1 tokenTotals  2 dailyActivity  3 harnesses  4 skillInvocations
        // 5 skillScopes  6 acceptedProposals  7 costModels
        // 8+9 dailyActivityFull (sessions, tokens)  10 sessionDurations
        // 11 peakHour  12 spawnedCount  13 commitCount  14 topTools
        // 15+16+17+18 wrappedCounts (toolAgg, turnCount, distinctSkills, reposCount)
        const totals = yield* fetchTokenTotals({ windowDays });
        const daily = yield* fetchDailyActivity({ windowDays });
        const harnesses = yield* fetchHarnesses({ windowDays });
        const invocations = yield* fetchSkillInvocations({ windowDays });
        const scopes = yield* fetchSkillScopes();
        const proposals = yield* fetchAcceptedProposals();
        const cost = yield* fetchCostModels({ sinceDays: windowDays });
        const dailyFull = yield* fetchDailyActivityFull({ windowDays });
        const durations = yield* fetchSessionDurations({ windowDays });
        const peakHour = yield* fetchPeakHour({ windowDays });
        const spawnedCount = yield* fetchSpawnedCount({ windowDays });
        const commitCount = yield* fetchCommitCount({ windowDays });
        const topTools = yield* fetchTopTools({ windowDays });
        const wrappedCounts = yield* fetchWrappedCounts({ windowDays });

        const streak = computeStreak(daily, env.today);

        const totalSessions = cost.rows.reduce((s, r) => s + r.sessions, 0);
        const models = cost.rows.map((r) => {
            // share is cost-weighted when cost is public, session-weighted
            // when --no-cost (a cost-derived share would leak spend ratios).
            const share = includeCost
                ? cost.total_cost_usd > 0 ? r.cost_usd / cost.total_cost_usd : 0
                : totalSessions > 0 ? r.sessions / totalSessions : 0;
            return {
                name: r.model,
                share,
                ...(includeCost ? { cost_usd: r.cost_usd } : {}),
            };
        });

        const patterns = deriveTastePatterns(proposals);

        // null when there is no data at all -> section omitted below.
        const insights = deriveInsights({
            durations,
            peakHour,
            spawned: spawnedCount,
            commits: commitCount,
            tools: topTools,
            daily: dailyFull,
            wrapped: wrappedCounts,
        });

        // decodeProfile throws on invariant breach -> Effect defect (die),
        // intentionally unrecoverable: a malformed profile is a bug here.
        const profile: ProfileV1 = decodeProfile({
            v: 1,
            github: env.github,
            generated_at: env.generatedAt,
            window_days: windowDays,
            stats: {
                sessions: totals.sessions,
                active_days: streak.active_days,
                streak_days: streak.streak_days,
                tokens: {
                    prompt: totals.prompt_tokens,
                    completion: totals.completion_tokens,
                    total: totals.prompt_tokens + totals.completion_tokens,
                },
                ...(includeCost ? { cost_usd: cost.total_cost_usd } : {}),
                models,
                harnesses,
            },
            rig: deriveRig({
                invocations,
                scopes,
                hookFiles: env.hookFiles,
                hasRoutingTable: env.hasRoutingTable,
                rulesMarkdown: env.rulesMarkdown,
            }),
            ...(patterns.length > 0 ? { taste: { patterns } } : {}),
            ...(dailyFull.length > 0 ? { activity: { daily: dailyFull } } : {}),
            ...(insights !== null ? { insights } : {}),
        });
        return profile;
    },
);
