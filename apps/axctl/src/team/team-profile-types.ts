/**
 * TeamProfileV1 - the per-dev, per-repo, redacted, daily-collapsed snapshot
 * that `ax team push` (later chunk) uploads to `<org>/ax-team` as
 * `.ax-team/<login>.json` (goal package: 2026-07-01-team-dashboard-git-native,
 * §5 Slice 1). Derived from ProfileV1's stat shapes but scoped to ONE repo.
 *
 * Redaction is STRUCTURAL: this shape carries no free-text fields at all -
 * no taste-pattern summaries, no paths, no project names (§4). Aggregates
 * only. `login` is null when the dev pushes anonymously; `cost_usd` is null
 * under the sticky no_cost flag. Plain JSON - it lands in git and is read
 * by a browser (Slice 2/4).
 */
import { Schema } from "effect";

export type TeamShare = "public" | "anon";

const TeamTokens = Schema.Struct({
    prompt: Schema.Number,
    completion: Schema.Number,
    total: Schema.Number,
});

const TeamModelMix = Schema.Struct({
    model: Schema.String,
    /** cost-weighted when cost is shared, token-weighted otherwise */
    share: Schema.Number,
    tokens: Schema.Number,
    cost_usd: Schema.optional(Schema.Number),
});

const TeamStats = Schema.Struct({
    sessions: Schema.Number,
    active_days: Schema.Number,
    harnesses: Schema.Array(Schema.String),
});

const TeamDailyRow = Schema.Struct({
    date: Schema.String,
    sessions: Schema.Number,
    tokens: Schema.Number,
});

const TeamSkillRow = Schema.Struct({
    skill: Schema.String,
    runs: Schema.Number,
    /** distinct repo sessions that invoked the skill (team-side medians are computed across devs) */
    sessions: Schema.Number,
});

const TeamSpend = Schema.Struct({
    tokens: TeamTokens,
    /** null under the sticky no_cost flag */
    cost_usd: Schema.NullOr(Schema.Number),
    model_mix: Schema.Array(TeamModelMix),
});

const TeamEfficiency = Schema.Struct({
    tool_calls: Schema.Number,
    tool_failures: Schema.Number,
    verification_calls: Schema.Number,
});

export const TeamProfileV1 = Schema.Struct({
    v: Schema.Literal(1),
    /** github login; null when share === "anon" */
    login: Schema.NullOr(Schema.String),
    org: Schema.String,
    repo_key: Schema.String,
    window_days: Schema.Number,
    generated_at: Schema.String,
    stats: TeamStats,
    activity: Schema.Struct({ daily: Schema.Array(TeamDailyRow) }),
    skills: Schema.Array(TeamSkillRow),
    spend: TeamSpend,
    efficiency: TeamEfficiency,
});
export type TeamProfileV1 = typeof TeamProfileV1.Type;

/** Throws on invariant breach - a malformed snapshot is a bug in the builder. */
export const decodeTeamProfile = (input: unknown): TeamProfileV1 =>
    Schema.decodeUnknownSync(TeamProfileV1)(input);
