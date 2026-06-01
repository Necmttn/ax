import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type {
    WrappedArchetype,
    WrappedConfidence,
    WrappedEvidence,
    WrappedFact,
    WrappedProfile,
    WrappedUsageDay,
} from "@ax/lib/shared/dashboard-types";
import {
    WRAPPED_DAILY_ACTIVITY_SQL,
    WRAPPED_DAYS_LOOKBACK,
    WRAPPED_MODEL_SQL,
    WRAPPED_PEAK_HOUR_SQL,
    WRAPPED_REPOSITORY_SQL,
    WRAPPED_SKILLS_SQL,
    WRAPPED_SPAWNED_SQL,
    WRAPPED_TOKEN_USAGE_SQL,
    WRAPPED_TOOLS_SQL,
    WRAPPED_USAGE_SQL,
} from "../queries/wrapped.ts";

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
): WrappedArchetype => ({
    id,
    label,
    score,
    confidence: confidence(score),
    publicLine,
    internalExplanation,
    evidence,
});

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

const contextToolPattern = /recall|context|rg|sed|cat|find|grep|open|read/i;
const verificationToolPattern = /test|check|verify|lint|typecheck|tsc|vitest|bun test/i;

export function fetchWrapped(): Effect.Effect<WrappedProfile, DbError, SurrealClient> {
    return Effect.gen(function* () {
        const db = yield* SurrealClient;
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
        ] = yield* db.query<[
            Row[],
            Row[],
            Row[],
            Row[],
            Row[],
            Row[],
            Row[],
            Row[],
            Row[],
        ]>(
            [
                WRAPPED_USAGE_SQL,
                WRAPPED_DAILY_ACTIVITY_SQL,
                WRAPPED_PEAK_HOUR_SQL,
                WRAPPED_MODEL_SQL,
                WRAPPED_TOKEN_USAGE_SQL,
                WRAPPED_SKILLS_SQL,
                WRAPPED_TOOLS_SQL,
                WRAPPED_REPOSITORY_SQL,
                WRAPPED_SPAWNED_SQL,
            ].join("\n"),
        );

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
        const toolCount = (pattern: RegExp): number =>
            tools
                .filter((row) => pattern.test(toString(row.tool) ?? ""))
                .reduce((sum, row) => sum + toNumber(row.count), 0);
        const verificationCalls = toolCount(verificationToolPattern);
        const contextCalls = toolCount(contextToolPattern);
        const topToolRow = tools[0];
        const topSkillRow = skills[0];
        const topTool = topToolRow && toString(topToolRow.tool)
            ? { label: toString(topToolRow.tool)!, count: toNumber(topToolRow.count) }
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
            refactorSignals: toolCount(/refactor|rewrite|format/i),
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
