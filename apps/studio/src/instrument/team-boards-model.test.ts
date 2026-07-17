import { describe, expect, test } from "bun:test";
import type { TeamBoards } from "@ax/community-compile/team";
import { buildTeamView, fmtBig, fmtUsd } from "./team-boards-model.ts";

function boards(overrides: Partial<TeamBoards> = {}): TeamBoards {
    return {
        coverage: { contributing: 3, identified: 2 },
        adoption: {
            contributingDevs: 3,
            identifiedLogins: ["alice", "bob"],
            sessions: { total: 30, average: 10 },
            activeDays: { total: 15, average: 5 },
        },
        skillMatrix: [
            { skill: "tdd", devs: 3, runs: 30, sessions: 10, medianRuns: 10 },
            { skill: "debug", devs: 1, runs: 5, sessions: 2, medianRuns: 5 },
        ],
        spend: {
            tokens: { prompt: 800, completion: 200, total: 1_000 },
            costUsd: 25,
            costContributors: 2,
            modelMix: [
                { model: "claude-sonnet", tokens: 700, share: 0.7, costUsd: 20, costContributors: 2 },
                { model: "claude-haiku", tokens: 300, share: 0.3, costUsd: 0, costContributors: 0 },
            ],
        },
        efficiency: {
            toolCalls: 100,
            toolFailures: 10,
            verificationCalls: 20,
            toolFailureRate: 0.1,
            verificationShare: 0.2,
        },
        ...overrides,
    };
}

describe("fmtUsd", () => {
    test("formats thousands with K suffix", () => {
        expect(fmtUsd(2_500)).toBe("$2.5K");
    });
    test("strips trailing .0", () => {
        expect(fmtUsd(3_000)).toBe("$3K");
    });
    test("rounds sub-thousand amounts", () => {
        expect(fmtUsd(42.6)).toBe("$43");
    });
    test("keeps two decimals under $1", () => {
        expect(fmtUsd(0.5)).toBe("$0.50");
    });
});

describe("fmtBig", () => {
    test("returns 0 for null/undefined", () => {
        expect(fmtBig(null)).toBe("0");
        expect(fmtBig(undefined)).toBe("0");
    });
    test("formats billions", () => {
        expect(fmtBig(2_500_000_000)).toBe("2.5B");
    });
    test("formats millions", () => {
        expect(fmtBig(3_000_000)).toBe("3M");
    });
    test("formats ten-thousands as K", () => {
        expect(fmtBig(12_345)).toBe("12.3K");
    });
    test("uses locale string below 10K", () => {
        expect(fmtBig(1_234)).toBe("1,234");
    });
});

describe("buildTeamView - empty", () => {
    test("empty is true iff coverage.contributing === 0", () => {
        expect(buildTeamView(boards()).empty).toBe(false);
        expect(
            buildTeamView(boards({ coverage: { contributing: 0, identified: 0 } })).empty,
        ).toBe(true);
    });
});

describe("buildTeamView - activation", () => {
    test("contributing 3, identified 2 -> anon segment", () => {
        expect(buildTeamView(boards()).activation).toBe(
            "3 devs contributing · 2 identified · 1 anon",
        );
    });
    test("identified === contributing -> no anon segment", () => {
        const v = buildTeamView(
            boards({ coverage: { contributing: 3, identified: 3 } }),
        );
        expect(v.activation).toBe("3 devs contributing · 3 identified");
    });
    test("contributing 1 -> singular dev", () => {
        const v = buildTeamView(
            boards({ coverage: { contributing: 1, identified: 1 } }),
        );
        expect(v.activation).toBe("1 dev contributing · 1 identified");
    });
});

describe("buildTeamView - hero", () => {
    test("has exactly 4 tiles in order", () => {
        const v = buildTeamView(boards());
        expect(v.hero).toHaveLength(4);
        expect(v.hero.map((t) => t.label)).toEqual([
            "devs contributing",
            "sessions",
            "active days",
            "spend",
        ]);
    });

    test("tile 0: devs contributing", () => {
        const v = buildTeamView(boards());
        expect(v.hero[0]).toMatchObject({
            label: "devs contributing",
            value: "3",
            sub: "2 identified · 1 anon",
        });
    });

    test("tile 1: sessions", () => {
        const v = buildTeamView(boards());
        expect(v.hero[1]).toMatchObject({
            label: "sessions",
            value: fmtBig(30),
            sub: "avg 10/dev",
        });
    });

    test("tile 1: sessions avg strips trailing decimal precisely", () => {
        const v = buildTeamView(
            boards({
                adoption: {
                    contributingDevs: 3,
                    identifiedLogins: ["alice", "bob"],
                    sessions: { total: 12, average: 3.47 },
                    activeDays: { total: 15, average: 5 },
                },
            }),
        );
        expect(v.hero[1].sub).toBe("avg 3.5/dev");
    });

    test("tile 2: active days", () => {
        const v = buildTeamView(boards());
        expect(v.hero[2]).toMatchObject({
            label: "active days",
            value: fmtBig(15),
            sub: "avg 5/dev",
        });
    });

    test("tile 3: spend with contributors", () => {
        const v = buildTeamView(boards());
        expect(v.hero[3]).toMatchObject({
            label: "spend",
            value: fmtUsd(25),
            sub: "2 of 3 devs report cost",
        });
    });

    test("tile 3: spend when all devs report cost -> 'all devs report cost'", () => {
        const v = buildTeamView(
            boards({
                spend: {
                    tokens: { prompt: 800, completion: 200, total: 1_000 },
                    costUsd: 25,
                    costContributors: 3,
                    modelMix: [],
                },
            }),
        );
        expect(v.hero[3]).toMatchObject({
            label: "spend",
            value: fmtUsd(25),
            sub: "all devs report cost",
        });
    });

    test("tile 3: spend with zero contributors -> dash + no cost data", () => {
        const v = buildTeamView(
            boards({
                spend: {
                    tokens: { prompt: 800, completion: 200, total: 1_000 },
                    costUsd: 0,
                    costContributors: 0,
                    modelMix: [],
                },
            }),
        );
        expect(v.hero[3]).toMatchObject({
            label: "spend",
            value: "-",
            sub: "no cost data pushed",
        });
    });
});

describe("buildTeamView - costNote", () => {
    test("null when costContributors === contributing && contributing > 0", () => {
        const v = buildTeamView(
            boards({
                spend: {
                    tokens: { prompt: 800, completion: 200, total: 1_000 },
                    costUsd: 25,
                    costContributors: 3,
                    modelMix: [],
                },
            }),
        );
        expect(v.costNote).toBeNull();
    });

    test("'no cost data pushed' when costContributors === 0", () => {
        const v = buildTeamView(
            boards({
                spend: {
                    tokens: { prompt: 800, completion: 200, total: 1_000 },
                    costUsd: 0,
                    costContributors: 0,
                    modelMix: [],
                },
            }),
        );
        expect(v.costNote).toBe("no cost data pushed");
    });

    test("'N of M devs report cost' otherwise", () => {
        const v = buildTeamView(boards());
        expect(v.costNote).toBe("2 of 3 devs report cost");
    });
});

describe("buildTeamView - skills", () => {
    test("preserves input order and computes devShare relative to max devs row", () => {
        const v = buildTeamView(boards());
        expect(v.skills.map((s) => s.skill)).toEqual(["tdd", "debug"]);
        expect(v.skills[0]).toMatchObject({
            skill: "tdd",
            devs: 3,
            runs: 30,
            sessions: 10,
            medianRuns: 10,
            devShare: 1,
        });
        expect(v.skills[1]).toMatchObject({
            skill: "debug",
            devs: 1,
            devShare: 1 / 3,
        });
    });

    test("empty skillMatrix -> empty array, no NaN", () => {
        const v = buildTeamView(boards({ skillMatrix: [] }));
        expect(v.skills).toEqual([]);
    });
});

describe("buildTeamView - models", () => {
    test("share passed through, cost formatted, tokens formatted", () => {
        const v = buildTeamView(boards());
        expect(v.models).toEqual([
            { model: "claude-sonnet", tokens: fmtBig(700), share: 0.7, cost: fmtUsd(20) },
            { model: "claude-haiku", tokens: fmtBig(300), share: 0.3, cost: "-" },
        ]);
    });
});

describe("buildTeamView - efficiency", () => {
    test("toolCalls fmtBig, rates rounded to whole percent", () => {
        const v = buildTeamView(boards());
        expect(v.efficiency).toEqual({
            toolCalls: fmtBig(100),
            failureRate: "10%",
            verificationShare: "20%",
        });
    });
});

describe("buildTeamView - tokens", () => {
    test("fmtBig of prompt/completion/total", () => {
        const v = buildTeamView(boards());
        expect(v.tokens).toEqual({
            prompt: fmtBig(800),
            completion: fmtBig(200),
            total: fmtBig(1_000),
        });
    });
});
