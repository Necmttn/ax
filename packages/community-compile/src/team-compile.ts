/**
 * Pure TeamProfileV1 aggregation for the team dashboard.
 *
 * The caller owns fetching and validation. This module only folds validated
 * snapshots, so it stays effect-free and safe to run in a browser.
 */
import type { TeamProfileV1 } from "@ax/lib/shared/team-community";

export interface TeamBoards {
    readonly coverage: {
        readonly contributing: number;
        readonly identified: number;
    };
    readonly adoption: {
        readonly contributingDevs: number;
        readonly identifiedLogins: string[];
        readonly sessions: {
            readonly total: number;
            readonly average: number;
        };
        readonly activeDays: {
            readonly total: number;
            readonly average: number;
        };
    };
    readonly skillMatrix: TeamSkillRow[];
    readonly spend: {
        readonly tokens: TeamTokenTotals;
        readonly costUsd: number;
        readonly costContributors: number;
        readonly modelMix: TeamModelRow[];
    };
    readonly efficiency: {
        readonly toolCalls: number;
        readonly toolFailures: number;
        readonly verificationCalls: number;
        readonly toolFailureRate: number;
        readonly verificationShare: number;
    };
}

export interface TeamSkillRow {
    readonly skill: string;
    readonly devs: number;
    readonly runs: number;
    readonly sessions: number;
    readonly medianRuns: number;
}

export interface TeamTokenTotals {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
}

export interface TeamModelRow {
    readonly model: string;
    readonly tokens: number;
    readonly share: number;
    readonly costUsd: number;
    readonly costContributors: number;
}

interface SkillAggregate {
    devs: number;
    runs: number;
    sessions: number;
    runsByDev: number[];
}

interface ModelAggregate {
    tokens: number;
    costUsd: number;
    costContributors: number;
}

const ratio = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : numerator / denominator;

function median(values: ReadonlyArray<number>): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function compileTeam(snapshots: ReadonlyArray<TeamProfileV1>): TeamBoards {
    const identifiedLogins = new Set<string>();
    const skills = new Map<string, SkillAggregate>();
    const models = new Map<string, ModelAggregate>();

    let sessions = 0;
    let activeDays = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let costUsd = 0;
    let costContributors = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    let verificationCalls = 0;

    for (const snapshot of snapshots) {
        if (snapshot.login !== null) identifiedLogins.add(snapshot.login);

        sessions += snapshot.stats.sessions;
        activeDays += snapshot.stats.active_days;
        promptTokens += snapshot.spend.tokens.prompt;
        completionTokens += snapshot.spend.tokens.completion;
        totalTokens += snapshot.spend.tokens.total;
        toolCalls += snapshot.efficiency.tool_calls;
        toolFailures += snapshot.efficiency.tool_failures;
        verificationCalls += snapshot.efficiency.verification_calls;

        if (snapshot.spend.cost_usd !== null) {
            costUsd += snapshot.spend.cost_usd;
            costContributors += 1;
        }

        const snapshotSkills = new Map<string, { runs: number; sessions: number }>();
        for (const row of snapshot.skills) {
            const current = snapshotSkills.get(row.skill) ?? { runs: 0, sessions: 0 };
            current.runs += row.runs;
            current.sessions += row.sessions;
            snapshotSkills.set(row.skill, current);
        }
        for (const [skill, row] of snapshotSkills) {
            const current = skills.get(skill) ?? { devs: 0, runs: 0, sessions: 0, runsByDev: [] };
            current.devs += 1;
            current.runs += row.runs;
            current.sessions += row.sessions;
            current.runsByDev.push(row.runs);
            skills.set(skill, current);
        }

        const snapshotModels = new Map<string, { tokens: number; costUsd: number; hasCost: boolean }>();
        for (const row of snapshot.spend.model_mix) {
            const current = snapshotModels.get(row.model) ?? { tokens: 0, costUsd: 0, hasCost: false };
            current.tokens += row.tokens;
            if (row.cost_usd !== undefined) {
                current.costUsd += row.cost_usd;
                current.hasCost = true;
            }
            snapshotModels.set(row.model, current);
        }
        for (const [model, row] of snapshotModels) {
            const current = models.get(model) ?? { tokens: 0, costUsd: 0, costContributors: 0 };
            current.tokens += row.tokens;
            current.costUsd += row.costUsd;
            if (row.hasCost) current.costContributors += 1;
            models.set(model, current);
        }
    }

    const contributing = snapshots.length;
    const identified = identifiedLogins.size;
    const modelTokenTotal = [...models.values()].reduce((total, row) => total + row.tokens, 0);

    return {
        coverage: { contributing, identified },
        adoption: {
            contributingDevs: contributing,
            identifiedLogins: [...identifiedLogins].sort((a, b) => a.localeCompare(b)),
            sessions: {
                total: sessions,
                average: ratio(sessions, contributing),
            },
            activeDays: {
                total: activeDays,
                average: ratio(activeDays, contributing),
            },
        },
        skillMatrix: [...skills.entries()]
            .map(([skill, row]): TeamSkillRow => ({
                skill,
                devs: row.devs,
                runs: row.runs,
                sessions: row.sessions,
                medianRuns: median(row.runsByDev),
            }))
            .sort((a, b) => b.devs - a.devs || b.runs - a.runs || a.skill.localeCompare(b.skill)),
        spend: {
            tokens: {
                prompt: promptTokens,
                completion: completionTokens,
                total: totalTokens,
            },
            costUsd,
            costContributors,
            modelMix: [...models.entries()]
                .map(([model, row]): TeamModelRow => ({
                    model,
                    tokens: row.tokens,
                    share: ratio(row.tokens, modelTokenTotal),
                    costUsd: row.costUsd,
                    costContributors: row.costContributors,
                }))
                .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
        },
        efficiency: {
            toolCalls,
            toolFailures,
            verificationCalls,
            toolFailureRate: ratio(toolFailures, toolCalls),
            verificationShare: ratio(verificationCalls, toolCalls),
        },
    };
}
