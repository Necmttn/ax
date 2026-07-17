/**
 * Pure view-model for the studio team boards. No react imports - keeps the
 * formatting/derivation logic testable without a DOM.
 */
import type { TeamBoards } from "@ax/community-compile/team";

export const fmtUsd = (n: number): string =>
    n >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : n >= 1 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;

export const fmtBig = (n: number | null | undefined): string => {
    if (n == null) return "0";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return n.toLocaleString("en-US");
};

const fmtAvg = (n: number): string => n.toFixed(1).replace(/\.0$/, "");

export interface TeamHeroTile {
    label: string;
    value: string;
    small?: string;
    sub: string;
}

export interface TeamSkillView {
    skill: string;
    devs: number;
    runs: number;
    sessions: number;
    medianRuns: number;
    devShare: number;
}

export interface TeamModelView {
    model: string;
    tokens: string;
    share: number;
    cost: string;
}

export interface TeamBoardsViewModel {
    empty: boolean;
    activation: string;
    hero: TeamHeroTile[];
    skills: TeamSkillView[];
    models: TeamModelView[];
    tokens: { prompt: string; completion: string; total: string };
    efficiency: { toolCalls: string; failureRate: string; verificationShare: string };
    costNote: string | null;
}

function identifiedSegment(contributing: number, identified: number): string {
    if (identified === contributing) return `${identified} identified`;
    return `${identified} identified · ${contributing - identified} anon`;
}

function activationLine(contributing: number, identified: number): string {
    const devWord = contributing === 1 ? "dev" : "devs";
    return `${contributing} ${devWord} contributing · ${identifiedSegment(contributing, identified)}`;
}

export function buildTeamView(b: TeamBoards): TeamBoardsViewModel {
    const { contributing, identified } = b.coverage;
    const empty = contributing === 0;

    const costNote =
        b.spend.costContributors === contributing && contributing > 0
            ? null
            : b.spend.costContributors === 0
              ? "no cost data pushed"
              : `${b.spend.costContributors} of ${contributing} devs report cost`;

    const spendTile: TeamHeroTile =
        b.spend.costContributors > 0
            ? {
                  label: "spend",
                  value: fmtUsd(b.spend.costUsd),
                  sub: costNote ?? "all devs report cost",
              }
            : {
                  label: "spend",
                  value: "-",
                  sub: "no cost data pushed",
              };

    const hero: TeamHeroTile[] = [
        {
            label: "devs contributing",
            value: String(contributing),
            sub: identifiedSegment(contributing, identified),
        },
        {
            label: "sessions",
            value: fmtBig(b.adoption.sessions.total),
            sub: `avg ${fmtAvg(b.adoption.sessions.average)}/dev`,
        },
        {
            label: "active days",
            value: fmtBig(b.adoption.activeDays.total),
            sub: `avg ${fmtAvg(b.adoption.activeDays.average)}/dev`,
        },
        spendTile,
    ];

    const maxDevs = b.skillMatrix.reduce((max, row) => Math.max(max, row.devs), 0);
    const skills: TeamSkillView[] = b.skillMatrix.map((row) => ({
        skill: row.skill,
        devs: row.devs,
        runs: row.runs,
        sessions: row.sessions,
        medianRuns: row.medianRuns,
        devShare: maxDevs === 0 ? 0 : row.devs / maxDevs,
    }));

    const models: TeamModelView[] = b.spend.modelMix.map((row) => ({
        model: row.model,
        tokens: fmtBig(row.tokens),
        share: row.share,
        cost: row.costContributors === 0 ? "-" : fmtUsd(row.costUsd),
    }));

    return {
        empty,
        activation: activationLine(contributing, identified),
        hero,
        skills,
        models,
        tokens: {
            prompt: fmtBig(b.spend.tokens.prompt),
            completion: fmtBig(b.spend.tokens.completion),
            total: fmtBig(b.spend.tokens.total),
        },
        efficiency: {
            toolCalls: fmtBig(b.efficiency.toolCalls),
            failureRate: `${Math.round(b.efficiency.toolFailureRate * 100)}%`,
            verificationShare: `${Math.round(b.efficiency.verificationShare * 100)}%`,
        },
        costNote,
    };
}
