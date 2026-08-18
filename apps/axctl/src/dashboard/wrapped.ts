import { Effect } from "effect";
import { resolveArchetype } from "@ax/lib/shared/archetypes";
import { daysAgoExpr } from "@ax/lib/duckdb/clause";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import { isContextTool, isVerificationTool } from "../profile/tool-taxonomy.ts";
import type {
    WrappedArchetype,
    WrappedConfidence,
    WrappedEvidence,
    WrappedFact,
    WrappedProfile,
    WrappedUsageDay,
} from "@ax/lib/shared/dashboard-types";

// The `ax wrapped` DuckDB query set, consumed via `fetchWrapped` /
// `sanitizeWrappedProfile` elsewhere in this module and by
// `dashboard/contract/insights.ts`. All ten queries share the same `${DAYS}d`
// lookback bound, so every one takes the same single
// `[WRAPPED_DAYS_LOOKBACK]` param.

const WRAPPED_DAYS_LOOKBACK = 365;

const WRAPPED_USAGE_SQL = `
    SELECT
        COUNT(DISTINCT session) AS sessions,
        count(*) AS messages,
        COUNT(DISTINCT strftime(ts, '%Y-%m-%d')) AS active_days
    FROM turn
    WHERE ts > ${daysAgoExpr}
`;

const WRAPPED_DAILY_ACTIVITY_SQL = `
    SELECT
        strftime(ts, '%Y-%m-%d') AS date,
        COUNT(DISTINCT session) AS sessions,
        count(*) AS turns
    FROM turn
    WHERE ts > ${daysAgoExpr} AND ts IS NOT NULL
    GROUP BY date
    ORDER BY date ASC
`;

const WRAPPED_PEAK_HOUR_SQL = `
    SELECT strftime(started_at, '%H') AS hour, count(*) AS count
    FROM session
    WHERE started_at > ${daysAgoExpr} AND started_at IS NOT NULL
    GROUP BY hour
    ORDER BY count DESC
    LIMIT 1
`;

const WRAPPED_MODEL_SQL = `
    SELECT model, count(*) AS count
    FROM session
    WHERE started_at > ${daysAgoExpr} AND model IS NOT NULL
    GROUP BY model
    ORDER BY count DESC
    LIMIT 1
`;

const WRAPPED_TOKEN_USAGE_SQL = `
    SELECT
        SUM(estimated_tokens) AS estimated_tokens,
        SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
        SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
        count(*) AS sessions
    FROM session_token_usage
    WHERE ts > ${daysAgoExpr}
`;

const WRAPPED_SKILLS_SQL = `
    SELECT sk.name AS skill, count(*) AS count
    FROM invoked iv
    JOIN skill sk ON sk.id = iv.out_id
    WHERE iv.ts > ${daysAgoExpr}
      AND sk.name IS NOT NULL
      AND sk.dir_path != '(synthetic)'
    GROUP BY skill
    ORDER BY count DESC
    LIMIT 50
`;

// The alias avoids "tool" - tool_call has its own \`tool\` column (a ref ->
// the tool table), and DuckDB resolves a bare GROUP BY name against a real
// column before an output alias, which silently grouped by the wrong thing.
const WRAPPED_TOOLS_SQL = `
    SELECT
        COALESCE(command_norm, name) AS tool_label,
        count(*) AS count,
        SUM(CASE WHEN has_error = true THEN 1 ELSE 0 END) AS failures
    FROM tool_call
    WHERE ts > ${daysAgoExpr}
      AND COALESCE(command_norm, name) IS NOT NULL
    GROUP BY tool_label
    ORDER BY count DESC
    LIMIT 50
`;

// Verification / context counts classify on the FULL command (`command_text`),
// not the collapsed `command_norm` (which strips the subcommand for tools
// outside SUBCOMMAND_TOOLS, e.g. `mvn test` -> `mvn`). Grouped to bound
// cardinality; the command text is classified in-process and never surfaced
// (wrapped emits counts only). See issue #471.
const WRAPPED_VERIFY_SQL = `
    SELECT
        COALESCE(command_text, command_norm, name) AS cmd,
        count(*) AS count
    FROM tool_call
    WHERE ts > ${daysAgoExpr}
      AND COALESCE(command_text, command_norm, name) IS NOT NULL
    GROUP BY cmd
`;

const WRAPPED_REPOSITORY_SQL = `
    SELECT repository, count(*) AS count
    FROM session
    WHERE started_at > ${daysAgoExpr} AND repository IS NOT NULL
    GROUP BY repository
    ORDER BY count DESC
    LIMIT 50
`;

const WRAPPED_SPAWNED_SQL = `
    SELECT count(*) AS count
    FROM spawned
    WHERE ts > ${daysAgoExpr}
`;

/**
 * Defensive raw-row reader: a failed query degrades to `[]` (matches the
 * `cacheRows` contract), so one bad query in the batch below never sinks the
 * whole rollup. Mirrors the identical helper in session-canvas.ts / triage.ts
 * / workflow.ts.
 */
const rawRows = (
    read: CacheReadService,
    sql: string,
    params?: ReadonlyArray<DuckDbParam>,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, never> =>
    read.raw(sql, params).pipe(
        Effect.map((result) => result.rows),
        Effect.catch((error) => {
            console.error(`wrapped query failed: ${sql.slice(0, 60)}...`, error);
            return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
        }),
    );

export interface ArchetypeSignals {
    readonly verificationCalls: number;
    readonly toolFailures: number;
    readonly recoveredFailures: number;
    readonly distinctSkills: number;
    readonly distinctTools: number;
    readonly repositories: number;
    readonly spawnedAgents: number;
    readonly contextCalls: number;
    readonly refactorSignals: number;
}

type Row = Record<string, unknown>;

const MS_PER_DAY = 86_400_000;

const toNumber = (value: unknown): number => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
};

const toString = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

const confidence = (score: number): WrappedConfidence =>
    score >= 20 ? "high" : score >= 8 ? "medium" : "low";

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

export function computeStreaks(
    dates: ReadonlyArray<string>,
    now = new Date(),
): { currentStreakDays: number; longestStreakDays: number } {
    const unique = Array.from(new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))).sort();
    let longestStreakDays = 0;
    let run = 0;
    let previousTime: number | null = null;

    for (const date of unique) {
        const currentTime = Date.parse(`${date}T00:00:00.000Z`);
        const dayDiff = previousTime === null ? 1 : Math.round((currentTime - previousTime) / MS_PER_DAY);
        run = dayDiff === 1 ? run + 1 : 1;
        longestStreakDays = Math.max(longestStreakDays, run);
        previousTime = currentTime;
    }

    const active = new Set(unique);
    const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let currentStreakDays = 0;
    while (active.has(dayKey(cursor))) {
        currentStreakDays += 1;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }

    return { currentStreakDays, longestStreakDays };
}

const archetype = (
    id: string,
    label: string,
    score: number,
    publicLine: string,
    internalExplanation: string,
    evidence: ReadonlyArray<WrappedEvidence>,
): WrappedArchetype => {
    // Name + public line come from the canonical dictionary so the classifier,
    // the agent, the studio hero, and the SEO pages can never disagree. The
    // inline label/publicLine remain as a fallback for ids not yet in the dict.
    const def = resolveArchetype(id);
    const matched = def.id === id;
    return {
        id,
        label: matched ? def.name : label,
        score,
        confidence: confidence(score),
        publicLine: matched ? def.tagline : publicLine,
        internalExplanation,
        evidence,
    };
};

export function choosePrimaryArchetype(signals: ArchetypeSignals): {
    readonly primary: WrappedArchetype;
    readonly secondary: ReadonlyArray<WrappedArchetype>;
} {
    const candidates = [
        archetype(
            "verifier",
            "The Verifier",
            signals.verificationCalls * 2 + signals.refactorSignals,
            "You test before declaring victory.",
            "Verification, typecheck, lint, and test activity dominate this profile.",
            [{ kind: "tool", label: "verification calls", count: signals.verificationCalls }],
        ),
        archetype(
            "debugger",
            "The Debugger",
            signals.toolFailures + signals.recoveredFailures * 2,
            "You turn failures into solved patterns.",
            "Failure and recovery signals are prominent in the graph.",
            [{ kind: "tool", label: "tool failures", count: signals.toolFailures }],
        ),
        archetype(
            "orchestrator",
            "The Orchestrator",
            signals.spawnedAgents * 2 + signals.distinctTools,
            "You coordinate work across tools and agents.",
            "Subagent and tool-diversity signals are prominent.",
            [{ kind: "tool", label: "distinct tools", count: signals.distinctTools }],
        ),
        archetype(
            "skill-collector",
            "The Skill Collector",
            signals.distinctSkills * 1.5,
            "You build by stacking specialized skills.",
            "Skill invocation diversity is the strongest signal.",
            [{ kind: "skill", label: "distinct skills", count: signals.distinctSkills }],
        ),
        archetype(
            "context-curator",
            "The Context Curator",
            signals.contextCalls * 2,
            "You ground the agent before making it move.",
            "Context, recall, and file-reading activity are high.",
            [{ kind: "query", label: "context calls", count: signals.contextCalls }],
        ),
        archetype(
            "repo-hopper",
            "The Repo Hopper",
            signals.repositories * 2,
            "You spread agent work across many codebases.",
            "Repository breadth is the strongest signal.",
            [{ kind: "project", label: "repositories", count: signals.repositories }],
        ),
    ].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    const scored = candidates.filter((candidate) => candidate.score > 0);
    const fallback = archetype(
        "observer",
        "The Observer",
        0,
        "Your graph is still warming up.",
        "Not enough activity has been ingested yet.",
        [],
    );

    return {
        primary: scored[0] ?? fallback,
        secondary: scored.slice(1, 4),
    };
}

export function makeInterestingFacts(input: {
    readonly sessions: number;
    readonly messages: number;
    readonly totalTokens: number | null;
    readonly activeDays: number;
    readonly currentStreakDays: number;
    readonly longestStreakDays: number;
    readonly peakHour: number | null;
    readonly favoriteModel: string | null;
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly contextCalls: number;
    readonly verificationCalls: number;
    readonly distinctSkills: number;
    readonly distinctTools: number;
    readonly spawnedAgents: number;
    readonly repositories: number;
    readonly topTool: { readonly label: string; readonly count: number } | null;
    readonly topSkill: { readonly label: string; readonly count: number } | null;
}): WrappedFact[] {
    const facts: WrappedFact[] = [];

    if ((input.totalTokens ?? 0) >= 1_000_000) {
        facts.push({
            id: "token-maxxing",
            title: "Token Maxxing",
            publicText: `You burned through about ${fmtFactCount(input.totalTokens ?? 0)} estimated tokens.`,
            internalText: `Estimated token total across session_token_usage: ${input.totalTokens}.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: "token total", count: input.totalTokens ?? 0 }],
        });
    }

    if (input.messages >= 100_000) {
        facts.push({
            id: "message-maxxing",
            title: "Message Maxxing",
            publicText: `${fmtFactCount(input.messages)} transcript turns landed in your graph.`,
            internalText: `${input.messages} turn records appeared in the wrapped period.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: "turn records", count: input.messages }],
        });
    }

    if (input.contextCalls >= 1_000) {
        facts.push({
            id: "context-maxxing",
            title: "Context Maxxing",
            publicText: `You made ${fmtFactCount(input.contextCalls)} context/search/read moves before acting.`,
            internalText: `${input.contextCalls} tool calls matched recall/context/read/search commands.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: "context calls", count: input.contextCalls }],
        });
    }

    if (input.toolCalls >= 10_000) {
        facts.push({
            id: "tool-call-maxxing",
            title: "Tool Call Maxxing",
            publicText: `${fmtFactCount(input.toolCalls)} tool calls. The harness got a workout.`,
            internalText: `${input.toolCalls} tool_call records appeared in the wrapped period.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "tool", label: "tool calls", count: input.toolCalls }],
        });
    }

    if (input.toolFailures > 0 && input.toolCalls > 0) {
        const rate = Math.round((input.toolFailures / input.toolCalls) * 100);
        facts.push({
            id: "friction-farmer",
            title: "Friction Farmer",
            publicText: `${fmtFactCount(input.toolFailures)} failed tool calls, about ${rate}% of the run. You kept going.`,
            internalText: `${input.toolFailures} failed tool calls out of ${input.toolCalls} total.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "tool", label: "tool failures", count: input.toolFailures }],
        });
    }

    if (input.longestStreakDays >= 7) {
        facts.push({
            id: "streak-mode",
            title: "Streak Mode",
            publicText: `Your longest active streak was ${input.longestStreakDays} days.`,
            internalText: `Daily activity records produced a ${input.longestStreakDays}-day longest streak and ${input.currentStreakDays}-day current streak.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: "longest streak days", count: input.longestStreakDays }],
        });
    }

    if (input.peakHour !== null) {
        facts.push({
            id: "peak-hour-agent",
            title: "Peak Hour Agent",
            publicText: `Your strongest agent hour was ${hourFactLabel(input.peakHour)}.`,
            internalText: `Most sessions started during hour ${input.peakHour}.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: "peak hour", count: input.peakHour }],
        });
    }

    if (input.favoriteModel !== null) {
        facts.push({
            id: "model-loyalist",
            title: "Model Loyalist",
            publicText: `Your most-used model was ${input.favoriteModel}.`,
            internalText: `Favorite model aggregate: ${input.favoriteModel}.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: input.favoriteModel }],
        });
    }

    if (input.verificationCalls >= 10) {
        facts.push({
            id: "verifycel",
            title: "Verifycel",
            publicText: `${fmtFactCount(input.verificationCalls)} verification-like commands. You kept asking the machine to prove it.`,
            internalText: `${input.verificationCalls} verification-like commands were detected.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "tool", label: "verification calls", count: input.verificationCalls }],
        });
    }

    if (input.distinctSkills >= 10) {
        facts.push({
            id: "skill-stacker",
            title: "Skill Stacker",
            publicText: `${input.distinctSkills} distinct skills showed up in your workflow.`,
            internalText: `${input.distinctSkills} distinct skills were invoked.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "skill", label: "distinct skills", count: input.distinctSkills }],
        });
    }

    if (input.topSkill !== null) {
        facts.push({
            id: "main-skill-energy",
            title: "Main Skill Energy",
            publicText: `${input.topSkill.label} was your most repeated skill signal.`,
            internalText: `${input.topSkill.label} appeared ${input.topSkill.count} times in invoked edges.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "skill", label: input.topSkill.label, count: input.topSkill.count }],
        });
    }

    if (input.topTool !== null) {
        facts.push({
            id: "favorite-button",
            title: "Favorite Button",
            publicText: `${input.topTool.label} was your most-used tool path.`,
            internalText: `${input.topTool.label} appeared ${input.topTool.count} times in tool_call rows.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "tool", label: input.topTool.label, count: input.topTool.count }],
        });
    }

    if (input.spawnedAgents > 0) {
        facts.push({
            id: "subagent-summoner",
            title: "Subagent Summoner",
            publicText: `${fmtFactCount(input.spawnedAgents)} spawned-agent links. You delegated aggressively.`,
            internalText: `${input.spawnedAgents} spawned-agent records were detected.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: "spawned agents", count: input.spawnedAgents }],
        });
    }

    if (input.repositories >= 5) {
        facts.push({
            id: "repo-hopper",
            title: "Repo Hopper",
            publicText: `Your agent graph spread across ${input.repositories} repositories.`,
            internalText: `${input.repositories} repositories appeared in the wrapped period.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "project", label: "repository count", count: input.repositories }],
        });
    }

    return facts;
}

const fmtFactCount = (value: number): string =>
    new Intl.NumberFormat("en", {
        notation: value >= 10_000 ? "compact" : "standard",
        maximumFractionDigits: 1,
    }).format(value);

const hourFactLabel = (hour: number): string => {
    const suffix = hour < 12 ? "AM" : "PM";
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return `${display} ${suffix}`;
};

export function sanitizeWrappedProfile(profile: WrappedProfile): WrappedProfile {
    const cleanEvidence = (evidence: ReadonlyArray<WrappedEvidence>): WrappedEvidence[] =>
        evidence
            .filter((item) => item.sensitive !== true)
            .map(({ sensitive: _sensitive, href: _href, ...item }) => item);

    return {
        ...profile,
        primaryArchetype: {
            ...profile.primaryArchetype,
            internalExplanation: "",
            evidence: cleanEvidence(profile.primaryArchetype.evidence),
        },
        secondaryArchetypes: profile.secondaryArchetypes.map((archetype) => ({
            ...archetype,
            internalExplanation: "",
            evidence: cleanEvidence(archetype.evidence),
        })),
        facts: profile.facts
            .filter((fact) => fact.sensitivity !== "sensitive")
            .map((fact) => ({
                ...fact,
                internalText: "",
                evidence: cleanEvidence(fact.evidence),
            })),
        privacy: {
            publicSafe: true,
            redactedFields: [
                "sensitive evidence",
                "internal explanations",
                "internal fact text",
                "evidence links",
            ],
        },
    };
}

const queryRows = (rows: ReadonlyArray<Row> | undefined): ReadonlyArray<Row> => rows ?? [];

const parsePeakHour = (row: Row | undefined): number | null => {
    if (!row) return null;
    const hour = Number(toString(row.hour) ?? row.hour);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
};

// Verification / context classification shared with profile/queries.ts via
// tool-taxonomy.ts (ecosystem-aware program matching; see issue #471).
const refactorToolPattern = /refactor|rewrite|format/i;

export function fetchWrapped(): Effect.Effect<WrappedProfile, never, CacheRead> {
    return Effect.gen(function* () {
        const read = yield* CacheRead;
        const [
            usageRows,
            dailyRows,
            peakHourRows,
            modelRows,
            tokenRows,
            skillRows,
            toolRows,
            repositoryRows,
            spawnedRows,
            verifyRows,
        ] = yield* Effect.all([
            rawRows(read, WRAPPED_USAGE_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_DAILY_ACTIVITY_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_PEAK_HOUR_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_MODEL_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_TOKEN_USAGE_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_SKILLS_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_TOOLS_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_REPOSITORY_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_SPAWNED_SQL, [WRAPPED_DAYS_LOOKBACK]),
            rawRows(read, WRAPPED_VERIFY_SQL, [WRAPPED_DAYS_LOOKBACK]),
        ]);

        const usage = usageRows[0] ?? {};
        const days: WrappedUsageDay[] = queryRows(dailyRows)
            .map((row) => ({
                date: toString(row.date) ?? "",
                sessions: toNumber(row.sessions),
                turns: toNumber(row.turns),
                tokens: null,
            }))
            .filter((day) => day.date.length > 0);
        const streaks = computeStreaks(days.map((day) => day.date));
        const peakHour = parsePeakHour(peakHourRows[0]);
        const favoriteModel = toString(modelRows[0]?.model);
        const totalTokensRaw = toNumber(tokenRows[0]?.estimated_tokens);
        const totalTokens = totalTokensRaw > 0 ? totalTokensRaw : null;
        const tools = queryRows(toolRows);
        const skills = queryRows(skillRows);
        const toolCount = (pred: (label: string) => boolean): number =>
            tools
                .filter((row) => pred(toString(row.tool_label) ?? ""))
                .reduce((sum, row) => sum + toNumber(row.count), 0);
        // Verification/context classify on the full command text (verifyRows),
        // not the collapsed command_norm tool label (tools).
        const cmdCount = (pred: (label: string) => boolean): number =>
            queryRows(verifyRows)
                .filter((row) => pred(toString(row.cmd) ?? ""))
                .reduce((sum, row) => sum + toNumber(row.count), 0);
        const verificationCalls = cmdCount(isVerificationTool);
        const contextCalls = cmdCount(isContextTool);
        const topToolRow = tools[0];
        const topSkillRow = skills[0];
        const topTool = topToolRow && toString(topToolRow.tool_label)
            ? { label: toString(topToolRow.tool_label)!, count: toNumber(topToolRow.count) }
            : null;
        const topSkill = topSkillRow && toString(topSkillRow.skill)
            ? { label: toString(topSkillRow.skill)!, count: toNumber(topSkillRow.count) }
            : null;

        const metrics = {
            toolCalls: tools.reduce((sum, row) => sum + toNumber(row.count), 0),
            toolFailures: tools.reduce((sum, row) => sum + toNumber(row.failures), 0),
            distinctTools: tools.length,
            distinctSkills: skills.length,
            repositories: queryRows(repositoryRows).length,
            verificationCalls,
            spawnedAgents: toNumber(spawnedRows[0]?.count),
        };
        const archetypes = choosePrimaryArchetype({
            verificationCalls,
            toolFailures: metrics.toolFailures,
            recoveredFailures: 0,
            distinctSkills: metrics.distinctSkills,
            distinctTools: metrics.distinctTools,
            repositories: metrics.repositories,
            spawnedAgents: metrics.spawnedAgents,
            contextCalls,
            refactorSignals: toolCount((label) => refactorToolPattern.test(label)),
        });
        const now = new Date();

        return {
            generatedAt: now.toISOString(),
            period: {
                label: `Last ${WRAPPED_DAYS_LOOKBACK} days`,
                startedAt: new Date(now.getTime() - WRAPPED_DAYS_LOOKBACK * MS_PER_DAY).toISOString(),
                endedAt: now.toISOString(),
            },
            usage: {
                sessions: toNumber(usage.sessions),
                messages: toNumber(usage.messages),
                totalTokens,
                activeDays: toNumber(usage.active_days),
                ...streaks,
                peakHour,
                favoriteModel,
                tokenComparison: null,
                days,
            },
            primaryArchetype: archetypes.primary,
            secondaryArchetypes: archetypes.secondary,
            facts: makeInterestingFacts({
                sessions: toNumber(usage.sessions),
                messages: toNumber(usage.messages),
                totalTokens,
                activeDays: toNumber(usage.active_days),
                currentStreakDays: streaks.currentStreakDays,
                longestStreakDays: streaks.longestStreakDays,
                peakHour,
                favoriteModel,
                toolCalls: metrics.toolCalls,
                toolFailures: metrics.toolFailures,
                contextCalls,
                verificationCalls,
                distinctSkills: metrics.distinctSkills,
                distinctTools: metrics.distinctTools,
                spawnedAgents: metrics.spawnedAgents,
                repositories: metrics.repositories,
                topTool,
                topSkill,
            }),
            metrics,
            privacy: { publicSafe: false, redactedFields: [] },
        };
    });
}
