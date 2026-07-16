/**
 * buildTeamProfile - repo-scoped, redacted, daily-collapsed TeamProfileV1
 * snapshot builder (goal package §5 Slice 1). Sibling of profile/render.ts
 * buildProfile, but scoped to ONE repo: an indexed session query resolves the
 * repo's session-id set; usage/invocation rows are filtered against it in JS;
 * tool_call aggregates fan out per-session literal. Privacy invariants live
 * HERE: anon strips login; !includeCost nulls cost; the output shape carries
 * no free text (structural redaction - see team-profile-types.ts).
 */
import { Effect } from "effect";
import { fetchWindowedInvocations } from "../profile/queries.ts";
import { isVerificationTool } from "../profile/tool-taxonomy.ts";
import {
    fetchSessionUsageRows,
    fetchTeamRepoSessions,
    fetchToolCallAggBySession,
} from "./team-profile-queries.ts";
import { decodeTeamProfile, type TeamProfileV1, type TeamShare } from "./team-profile-types.ts";

export interface TeamProfileEnv {
    readonly login: string;
    readonly generatedAt: string;
}

const day = (iso: string): string => iso.slice(0, 10);

export const buildTeamProfile = Effect.fn("team.buildTeamProfile")(
    function* (opts: {
        readonly org: string;
        readonly repoKey: string;
        readonly windowDays: number;
        readonly share: TeamShare;
        readonly includeCost: boolean;
        readonly env: TeamProfileEnv;
    }) {
        const { org, repoKey, windowDays, share, includeCost, env } = opts;

        // 1. Repo session set (indexed; the ONLY query that names the repo).
        const sessions = yield* fetchTeamRepoSessions({ repoKey, windowDays });
        const sessionIds = new Set(sessions.map((s) => s.id));

        // 2. Machine-window per-row fetches, repo-filtered in JS.
        const usageAll = yield* fetchSessionUsageRows({ windowDays });
        const usage = usageAll.filter((u) => sessionIds.has(u.session));
        const invocationsAll = yield* fetchWindowedInvocations({ windowDays });
        const invocations = invocationsAll.filter((i) => sessionIds.has(i.session));

        // 3. Per-session indexed tool_call fan-out (repo-scoped by construction).
        // Sorted for deterministic query order (Set iteration order is
        // insertion order in practice, but the sort makes it explicit).
        const toolAgg = yield* fetchToolCallAggBySession({
            sessionIds: [...sessionIds].sort(),
        });

        // --- stats + daily-collapsed activity ---------------------------------
        const usageBySession = new Map(usage.map((u) => [u.session, u]));
        const dailyMap = new Map<string, { sessions: number; tokens: number }>();
        for (const s of sessions) {
            const d = day(s.started_at);
            const cur = dailyMap.get(d) ?? { sessions: 0, tokens: 0 };
            cur.sessions += 1;
            const u = usageBySession.get(s.id);
            if (u !== undefined) cur.tokens += u.prompt_tokens + u.completion_tokens;
            dailyMap.set(d, cur);
        }
        const daily = [...dailyMap.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([date, v]) => ({ date, sessions: v.sessions, tokens: v.tokens }));

        const harnessCounts = new Map<string, number>();
        for (const s of sessions) {
            harnessCounts.set(s.source, (harnessCounts.get(s.source) ?? 0) + 1);
        }
        const harnesses = [...harnessCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([source]) => source);

        // --- skills ------------------------------------------------------------
        const skillAgg = new Map<string, { runs: number; sessions: Set<string> }>();
        for (const inv of invocations) {
            const cur = skillAgg.get(inv.skill) ?? { runs: 0, sessions: new Set<string>() };
            cur.runs += 1;
            cur.sessions.add(inv.session);
            skillAgg.set(inv.skill, cur);
        }
        const skills = [...skillAgg.entries()]
            .sort((a, b) => b[1].runs - a[1].runs)
            .map(([skill, v]) => ({ skill, runs: v.runs, sessions: v.sessions.size }));

        // --- spend --------------------------------------------------------------
        const prompt = usage.reduce((s, u) => s + u.prompt_tokens, 0);
        const completion = usage.reduce((s, u) => s + u.completion_tokens, 0);
        const totalTokens = prompt + completion;
        const totalCost = usage.reduce((s, u) => s + (u.cost_usd ?? 0), 0);

        const modelAgg = new Map<string, { tokens: number; cost: number }>();
        for (const u of usage) {
            const name = u.model ?? "(unattributed)";
            const cur = modelAgg.get(name) ?? { tokens: 0, cost: 0 };
            cur.tokens += u.prompt_tokens + u.completion_tokens;
            cur.cost += u.cost_usd ?? 0;
            modelAgg.set(name, cur);
        }
        // share is cost-weighted when cost is shared, token-weighted under
        // no_cost (a cost-derived share would leak spend ratios).
        const model_mix = [...modelAgg.entries()]
            .sort((a, b) => b[1].tokens - a[1].tokens)
            .map(([model, v]) => ({
                model,
                share: includeCost
                    ? totalCost > 0 ? v.cost / totalCost : 0
                    : totalTokens > 0 ? v.tokens / totalTokens : 0,
                tokens: v.tokens,
                ...(includeCost ? { cost_usd: v.cost } : {}),
            }));

        // --- efficiency ----------------------------------------------------------
        const tool_calls = toolAgg.reduce((s, r) => s + r.count, 0);
        const tool_failures = toolAgg.reduce((s, r) => s + r.failures, 0);
        const verification_calls = toolAgg
            .filter((r) => isVerificationTool(r.cmd))
            .reduce((s, r) => s + r.count, 0);

        // decodeTeamProfile throws on invariant breach -> Effect defect (die),
        // intentionally unrecoverable: a malformed snapshot is a bug here.
        const profile: TeamProfileV1 = decodeTeamProfile({
            v: 1,
            login: share === "anon" ? null : env.login,
            org,
            repo_key: repoKey,
            window_days: windowDays,
            generated_at: env.generatedAt,
            stats: {
                sessions: sessions.length,
                active_days: dailyMap.size,
                harnesses,
            },
            activity: { daily },
            skills,
            spend: {
                tokens: { prompt, completion, total: totalTokens },
                cost_usd: includeCost ? totalCost : null,
                model_mix,
            },
            efficiency: { tool_calls, tool_failures, verification_calls },
        });
        return profile;
    },
);
