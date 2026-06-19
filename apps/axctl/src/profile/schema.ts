/**
 * ProfileV1 - the canonical ax profile artifact (spec:
 * docs/superpowers/specs/2026-06-12-ax-profiles-design.md §1).
 * Single source of truth for renderer, gist publish (Plan 2),
 * registry CI (Plan 3), and site (Plan 4). Aggregates only - never
 * transcript content, project names, or paths.
 */
import { Schema } from "effect";

export const PATTERN_CATEGORIES = [
    "design-aesthetic",
    "problem-solving-strategy",
    "debugging",
    "failure-mode",
    "workflow",
    "tool-output-mix",
    "stack-choice",
] as const;
export type PatternCategory = (typeof PATTERN_CATEGORIES)[number];

const Trend = Schema.Literals(["rising", "stable", "falling", "stale"]);

export const Evidence = Schema.Struct({
    sessions: Schema.Number,
    confidence: Schema.Number,
    last_reinforced: Schema.optional(Schema.String),
    trend: Schema.optional(Trend),
});

const PatternLink = Schema.Struct({
    rel: Schema.Literals(["recovered-by", "pairs-with", "conflicts-with"]),
    ref: Schema.String,
});

/** Prose patterns: every category except stack-choice; summary required. */
const ProsePattern = Schema.Struct({
    category: Schema.Literals([
        "design-aesthetic",
        "problem-solving-strategy",
        "debugging",
        "failure-mode",
        "workflow",
        "tool-output-mix",
    ]),
    name: Schema.String,
    summary: Schema.String,
    evidence: Evidence,
    links: Schema.optional(Schema.Array(PatternLink)),
});

/** stack-choice: X-vs-Y tool preference; slot required, no summary. */
const StackChoicePattern = Schema.Struct({
    category: Schema.Literal("stack-choice"),
    slot: Schema.String,
    name: Schema.String,
    over: Schema.optional(Schema.Array(Schema.String)),
    context: Schema.optional(Schema.String),
    evidence: Evidence,
    links: Schema.optional(Schema.Array(PatternLink)),
});

export const TastePattern = Schema.Union([ProsePattern, StackChoicePattern]);
export type TastePattern = typeof TastePattern.Type;

const ModelShare = Schema.Struct({
    name: Schema.String,
    share: Schema.Number,
    cost_usd: Schema.optional(Schema.Number),
});

const Stats = Schema.Struct({
    sessions: Schema.Number,
    active_days: Schema.Number,
    streak_days: Schema.Number,
    tokens: Schema.Struct({
        prompt: Schema.Number,
        completion: Schema.Number,
        total: Schema.Number,
    }),
    cost_usd: Schema.optional(Schema.Number),
    models: Schema.Array(ModelShare),
    harnesses: Schema.Array(Schema.String),
});

const Rig = Schema.Struct({
    skills: Schema.Array(
        Schema.Struct({
            name: Schema.String,
            source: Schema.String,
            runs: Schema.Number,
            downstream_share: Schema.optional(Schema.Number),
        }),
    ),
    hooks: Schema.Array(Schema.String),
    routing_table: Schema.Boolean,
    rules: Schema.optional(
        Schema.Struct({
            count: Schema.Number,
            topics: Schema.optional(Schema.Array(Schema.String)),
        }),
    ),
});

const WorkflowArc = Schema.Struct({
    steps: Schema.Array(Schema.String),
    count: Schema.Number,
});

const Workflow = Schema.Struct({
    arcs: Schema.Array(WorkflowArc),
});

export const Highlights = Schema.Struct({
    authored_at: Schema.String,
    setup: Schema.optional(Schema.Array(Schema.Struct({
        title: Schema.String,
        what: Schema.String,
        why: Schema.String,
        link: Schema.optional(Schema.String),
    }))),
    skills: Schema.optional(Schema.Array(Schema.Struct({
        name: Schema.String,
        source: Schema.String,
        summary: Schema.String,
    }))),
    taste: Schema.optional(Schema.String),
    wins: Schema.optional(Schema.Array(Schema.Struct({
        text: Schema.String,
        evidence: Schema.optional(Schema.String),
    }))),
});
export type Highlights = typeof Highlights.Type;

const DailyModelRow = Schema.Struct({
    name: Schema.String,
    tokens: Schema.Number,
});

const DailyRow = Schema.Struct({
    date: Schema.String,
    sessions: Schema.Number,
    tokens: Schema.Number,
    models: Schema.optional(Schema.Array(DailyModelRow)),
    tool_calls: Schema.optional(Schema.Number),
    commits: Schema.optional(Schema.Number),
});

const BusiestDay = Schema.Struct({
    date: Schema.String,
    sessions: Schema.Number,
});

const ToolRun = Schema.Struct({
    name: Schema.String,
    runs: Schema.Number,
});

const Activity = Schema.Struct({
    daily: Schema.Array(DailyRow),
});

const Insights = Schema.Struct({
    hours_total: Schema.Number,
    longest_session_minutes: Schema.Number,
    deep_session_share: Schema.Number,
    peak_hour_utc: Schema.Number,
    busiest_day: BusiestDay,
    max_parallel_sessions: Schema.Number,
    subagents_spawned: Schema.Number,
    commits: Schema.Number,
    tools_top: Schema.Array(ToolRun),
    // wrapped-style window aggregates - all optional so old gists stay valid
    turns: Schema.optional(Schema.Number),
    tool_calls: Schema.optional(Schema.Number),
    tool_failures: Schema.optional(Schema.Number),
    distinct_skills: Schema.optional(Schema.Number),
    distinct_tools: Schema.optional(Schema.Number),
    repos_count: Schema.optional(Schema.Number),
    verification_calls: Schema.optional(Schema.Number),
    context_calls: Schema.optional(Schema.Number),
});

export const ProfileV1 = Schema.Struct({
    v: Schema.Literal(1),
    github: Schema.String,
    generated_at: Schema.String,
    window_days: Schema.Number,
    stats: Stats,
    rig: Rig,
    taste: Schema.optional(Schema.Struct({ patterns: Schema.Array(TastePattern) })),
    activity: Schema.optional(Activity),
    insights: Schema.optional(Insights),
    workflow: Schema.optional(Workflow),
    highlights: Schema.optional(Highlights),
});
export type ProfileV1 = typeof ProfileV1.Type;

export const decodeProfile = (input: unknown): ProfileV1 =>
    Schema.decodeUnknownSync(ProfileV1)(input);
