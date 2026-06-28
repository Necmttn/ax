/**
 * P2.2 tests: renderSessionMarkdown / renderSessionJson pure renderer.
 *
 * All tests use fixed payloads - no DB, no Effect.
 */

import { describe, expect, it } from "bun:test";
import { renderSessionMarkdown, renderSessionJson } from "./session-show-format.ts";
import type { SessionShowPayload } from "../dashboard/session-show.ts";
import type { SessionDetailPayload, SessionLink } from "@ax/lib/shared/dashboard-types";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

type SessionId = import("@ax/lib/shared/session-id").SessionId;

const makeOverview = (
    partial: Partial<SessionDetailPayload["overview"]> = {},
): SessionDetailPayload["overview"] => ({
    id: "session:⟨019e0ad4-c977-7ab8-0000-000000000001⟩" as unknown as SessionId,
    project: "-Users-necmttn-Projects-ax",
    cwd: "/Users/necmttn/Projects/ax",
    model: "claude-opus-4-6",
    source: "claude",
    started_at: "2026-05-28T14:32:00Z",
    ended_at: "2026-05-28T15:19:00Z",
    ...partial,
});

const makeChild = (id: string, nickname?: string): SessionLink => ({
    session_id: id as unknown as SessionId,
    project: null,
    started_at: null,
    nickname: nickname ?? null,
    tool: "Task",
    ts: "2026-05-28T14:35:00Z",
});

const MINIMAL_PAYLOAD: SessionShowPayload = {
    session: {
        overview: makeOverview(),
        top_skills: [
            { skill: "superpowers:tdd", count: 5, last_used: null },
            { skill: "caveman", count: 3, last_used: null },
        ],
        tool_calls: [
            { label: "Bash", count: 12, failures: 1, last_used: null },
            { label: "Read", count: 8, failures: 0, last_used: null },
            { label: "Edit", count: 4, failures: 0, last_used: null },
        ],
        children: [
            makeChild("claude-subagent-a41ef01d6ca8", "implement X"),
            makeChild("claude-subagent-b51fc12d7db9", "review Y"),
        ],
        parent: null,
        agent_delegations: [
            {
                id: "del:001",
                ts: "2026-05-28T14:35:00Z",
                subagent_type: "claude",
                description: "implement login flow",
                prompt_excerpt: null,
                output_excerpt: null,
                phase: "execute",
            },
        ],
        token_usage: null,
    },
    expanded_subagents: [],
    by_role: null,
    compactions: [],
};

// ---------------------------------------------------------------------------
// Tests: renderSessionMarkdown
// ---------------------------------------------------------------------------

describe("renderSessionMarkdown - sections", () => {
    it("includes a header with the FULL session id (short form misled - see retro)", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        const headerLine = out.split("\n")[0]!;
        expect(headerLine.startsWith("# session ")).toBe(true);
        // Full id, not a 12-char slice: the header must echo exactly what the
        // user queried.
        expect(headerLine).toContain(String(MINIMAL_PAYLOAD.session.overview!.id));
    });

    it("includes started_at and source in overview", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("2026-05-28T14:32:00Z");
        expect(out).toContain("source claude");
    });

    it("renders duration", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("47m"); // 47 minutes
    });

    it("renders token usage and cost when available", () => {
        const out = renderSessionMarkdown({
            ...MINIMAL_PAYLOAD,
            session: {
                ...MINIMAL_PAYLOAD.session,
                token_usage: {
                    model: "gpt-5.5",
                    prompt_tokens: 1000,
                    completion_tokens: 200,
                    cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 500,
                    estimated_tokens: 1200,
                    estimated_cost_usd: 0.1234,
                    pricing_source: "test",
                },
            },
        });
        expect(out).toContain("usage     model gpt-5.5");
        expect(out).toContain("tokens 1,200");
        expect(out).toContain("cost $0.1234");
        expect(out).toContain("cache_read 500");
    });

    it("renders project name prettified", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        // prettifyProjectSlug strips the leading -Users-necmttn-Projects-
        expect(out).toContain("ax");
    });

    it("renders cwd path", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("/Users/necmttn/Projects/ax");
    });

    it("renders parent=none for top-level session", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("parent    none");
    });

    it("renders parent session id for child session", () => {
        const parentLink: SessionLink = {
            session_id: "claude-subagent-pppppppppppp" as unknown as SessionId,
            project: null,
            started_at: null,
            nickname: null,
            tool: null,
            ts: null,
        };
        const payloadWithParent: SessionShowPayload = {
            ...MINIMAL_PAYLOAD,
            session: { ...MINIMAL_PAYLOAD.session, parent: parentLink },
        };
        const out = renderSessionMarkdown(payloadWithParent);
        expect(out).toContain("parent");
        expect(out).toContain("pppppppppppp");
    });

    it("renders Top skills section", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("## Top skills");
        expect(out).toContain("superpowers:tdd");
        expect(out).toContain("caveman");
    });

    it("renders skill counts", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("5"); // superpowers:tdd count
        expect(out).toContain("3"); // caveman count
    });

    it("renders Timeline section", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("## Timeline");
    });

    it("renders tool calls in timeline", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("Bash");
        expect(out).toContain("Read");
        expect(out).toContain("Edit");
    });

    it("renders agent delegation (spawn) in timeline", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("Agent ->");
        expect(out).toContain("implement login flow");
    });

    it("renders Subagents section with correct count", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("## Subagents (2)");
    });

    it("renders child session ids in Subagents section", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        // short id of "claude-subagent-a41ef01d6ca8" ends in "a41ef01d6ca8"
        expect(out).toContain("a41ef01d6ca8");
    });

    it("renders child nicknames when present", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("implement X");
    });
});

describe("renderSessionMarkdown - compaction", () => {
    it("renders a compaction section when compactions present", () => {
        const payload: SessionShowPayload = {
            ...MINIMAL_PAYLOAD,
            compactions: [
                {
                    harness: "codex",
                    ts: "2026-05-14T15:34:42.663Z",
                    strategy: "history_replacement",
                    trigger: "auto",
                    tokens_before: 120000,
                    kept_count: 83,
                    summary: null,
                },
                {
                    harness: "opencode",
                    ts: "2026-05-29T06:05:38.132Z",
                    strategy: "summarize",
                    trigger: "auto",
                    tokens_before: 90000,
                    kept_count: null,
                    summary: null,
                    source_confidence: "derived",
                },
                {
                    harness: "pi",
                    ts: "2026-05-29T06:06:38.132Z",
                    strategy: "summarize",
                    trigger: "auto",
                    tokens_before: 91000,
                    kept_count: null,
                    summary: "Goal: ship X",
                },
            ],
        };
        const md = renderSessionMarkdown(payload);
        expect(md).toContain("## Compaction");
        expect(md).toContain("history_replacement");
        expect(md).toContain("83 kept");
        expect(md).toContain("opencode · summarize · derived");
        expect(md).toContain("Goal: ship X");
    });

    it("does NOT render a compaction section when compactions empty", () => {
        const md = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(md).not.toContain("## Compaction");
    });
});

describe("renderSessionMarkdown - not found", () => {
    it("emits not-found message when overview is null", () => {
        const payload: SessionShowPayload = {
            session: {
                overview: null,
                top_skills: [],
                tool_calls: [],
                children: [],
                parent: null,
                agent_delegations: [],
                token_usage: null,
            },
            expanded_subagents: [],
            by_role: null,
            compactions: [],
        };
        const out = renderSessionMarkdown(payload);
        expect(out).toContain("not found");
    });
});

describe("renderSessionMarkdown - expansions", () => {
    const subPayload: SessionDetailPayload = {
        overview: makeOverview({
            id: "session:⟨claude-subagent-a41ef01d6ca8⟩" as unknown as SessionId,
            started_at: "2026-05-28T14:35:00Z",
            ended_at: "2026-05-28T14:50:00Z",
        }),
        top_skills: [],
        tool_calls: [
            { label: "Edit", count: 2, failures: 0, last_used: null },
        ],
        children: [],
        parent: null,
        agent_delegations: [],
        token_usage: null,
    };

    it("renders expanded timeline header for subagent", () => {
        const payloadWithExpansion: SessionShowPayload = {
            ...MINIMAL_PAYLOAD,
            expanded_subagents: [subPayload],
        };
        const out = renderSessionMarkdown(payloadWithExpansion);
        expect(out).toContain("Expanded subagent timelines");
    });

    it("renders expanded subagent's tool calls", () => {
        const payloadWithExpansion: SessionShowPayload = {
            ...MINIMAL_PAYLOAD,
            expanded_subagents: [subPayload],
        };
        const out = renderSessionMarkdown(payloadWithExpansion);
        expect(out).toContain("Edit");
    });

    it("marks expanded children in Subagents section", () => {
        const payloadWithExpansion: SessionShowPayload = {
            ...MINIMAL_PAYLOAD,
            expanded_subagents: [subPayload],
        };
        const out = renderSessionMarkdown(payloadWithExpansion);
        expect(out).toContain("[expanded]");
    });
});

describe("renderSessionMarkdown - ordering", () => {
    it("Top skills appears before Timeline", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        const skillsIdx = out.indexOf("## Top skills");
        const timelineIdx = out.indexOf("## Timeline");
        expect(skillsIdx).toBeGreaterThanOrEqual(0);
        expect(timelineIdx).toBeGreaterThanOrEqual(0);
        expect(skillsIdx).toBeLessThan(timelineIdx);
    });

    it("Timeline appears before Subagents", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        const timelineIdx = out.indexOf("## Timeline");
        const subagentsIdx = out.indexOf("## Subagents");
        expect(timelineIdx).toBeGreaterThanOrEqual(0);
        expect(subagentsIdx).toBeGreaterThanOrEqual(0);
        expect(timelineIdx).toBeLessThan(subagentsIdx);
    });
});

describe("renderSessionMarkdown - empty session", () => {
    it("omits Top skills section when no skills", () => {
        const payload: SessionShowPayload = {
            session: {
                overview: makeOverview(),
                top_skills: [],
                tool_calls: [],
                children: [],
                parent: null,
                agent_delegations: [],
                token_usage: null,
            },
            expanded_subagents: [],
            by_role: null,
            compactions: [],
        };
        const out = renderSessionMarkdown(payload);
        expect(out).not.toContain("## Top skills");
    });

    it("omits Subagents section when no children", () => {
        const payload: SessionShowPayload = {
            session: {
                overview: makeOverview(),
                top_skills: [],
                tool_calls: [],
                children: [],
                parent: null,
                agent_delegations: [],
                token_usage: null,
            },
            expanded_subagents: [],
            by_role: null,
            compactions: [],
        };
        const out = renderSessionMarkdown(payload);
        expect(out).not.toContain("## Subagents");
    });
});

// ---------------------------------------------------------------------------
// Tests: renderSessionMarkdown - Metrics block (durability drill-down, #176)
// ---------------------------------------------------------------------------

import type { SessionDurabilityDetail } from "../metrics/reverted-commits.ts";

const DURABILITY_DETAIL: SessionDurabilityDetail = {
    producedCommits: 3,
    revertedCommits: 1,
    durabilityRatio: 2 / 3,
    reverted: [
        {
            commitId: "commit:`feat_key`",
            sha: "92417acaeaa7afcee3f7b61cc89f4b02373aa5f8",
            message: "feat: add widget",
            ts: "2026-05-25T02:13:28Z",
            fixes: [
                {
                    commitId: "commit:`fix_key`",
                    sha: "134bd7bd67f2177c134bd7bd67f2177c134bd7bd",
                    message: "fix: widget broke",
                    ts: "2026-05-26T08:00:00Z",
                    daysBetween: 1.24,
                    confidence: "high",
                },
            ],
        },
    ],
};

describe("renderSessionMarkdown - Metrics block (#176)", () => {
    it("renders durability ratio with produced/reverted counts", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: DURABILITY_DETAIL });
        expect(out).toContain("## Metrics");
        expect(out).toContain("durability  67%");
        expect(out).toContain("3 produced / 1 reverted");
    });

    it("lists reverted commits with short sha + message", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: DURABILITY_DETAIL });
        expect(out).toContain("92417ac");
        expect(out).toContain("feat: add widget");
    });

    it("lists the fixing commit with sha, days and confidence", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: DURABILITY_DETAIL });
        expect(out).toContain("fixed by 134bd7b");
        expect(out).toContain("fix: widget broke");
        expect(out).toContain("+1.2d");
        expect(out).toContain("high");
    });

    it("notes when the fix landed outside the ingest window", () => {
        const noFix: SessionDurabilityDetail = {
            ...DURABILITY_DETAIL,
            reverted: [{ ...DURABILITY_DETAIL.reverted[0]!, fixes: [] }],
        };
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: noFix });
        expect(out).toContain("outside ingest window");
    });

    it("zero-commit session renders an explicit no-commits durability line", () => {
        const empty: SessionDurabilityDetail = {
            producedCommits: 0,
            revertedCommits: 0,
            durabilityRatio: null,
            reverted: [],
        };
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: empty });
        expect(out).toContain("## Metrics");
        expect(out).toContain("produced no commits");
    });

    it("omits the Metrics section without detail (back-compat)", () => {
        expect(renderSessionMarkdown(MINIMAL_PAYLOAD)).not.toContain("## Metrics");
        expect(renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: null })).not.toContain("## Metrics");
    });

    it("caps fixing commits at 3 with an overflow line", () => {
        const manyFixes: SessionDurabilityDetail = {
            ...DURABILITY_DETAIL,
            reverted: [{
                ...DURABILITY_DETAIL.reverted[0]!,
                fixes: Array.from({ length: 7 }, (_, i) => ({
                    ...DURABILITY_DETAIL.reverted[0]!.fixes[0]!,
                    commitId: `commit:\`fix_${i}\``,
                    sha: `${i}`.repeat(40),
                })),
            }],
        };
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: manyFixes });
        expect(out).toContain("… and 4 more fixing commits");
        expect(out.split("\n").filter((l) => l.includes("fixed by ")).length).toBe(3);
    });

    it("caps the reverted list at 10 with a --json pointer", () => {
        const many: SessionDurabilityDetail = {
            producedCommits: 30,
            revertedCommits: 14,
            durabilityRatio: 16 / 30,
            reverted: Array.from({ length: 14 }, (_, i) => ({
                ...DURABILITY_DETAIL.reverted[0]!,
                commitId: `commit:\`feat_${i}\``,
            })),
        };
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: many });
        expect(out).toContain("… and 4 more reverted commits (use --json for the full list)");
    });

    it("no reverted-commits list when everything survived", () => {
        const clean: SessionDurabilityDetail = {
            producedCommits: 2,
            revertedCommits: 0,
            durabilityRatio: 1,
            reverted: [],
        };
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD, { metrics: clean });
        expect(out).toContain("durability  100%");
        expect(out).not.toContain("reverted commits:");
    });
});

describe("renderSessionJson - metrics (#176)", () => {
    it("includes the metrics key when detail is provided", () => {
        const parsed = JSON.parse(renderSessionJson(MINIMAL_PAYLOAD, { metrics: DURABILITY_DETAIL }));
        expect(parsed.metrics.producedCommits).toBe(3);
        expect(parsed.metrics.reverted[0].fixes[0].confidence).toBe("high");
    });

    it("omits the metrics key without detail", () => {
        const parsed = JSON.parse(renderSessionJson(MINIMAL_PAYLOAD));
        expect("metrics" in parsed).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Tests: renderSessionJson
// ---------------------------------------------------------------------------

describe("renderSessionJson", () => {
    it("emits valid JSON", () => {
        const out = renderSessionJson(MINIMAL_PAYLOAD);
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it("includes overview data", () => {
        const parsed = JSON.parse(renderSessionJson(MINIMAL_PAYLOAD));
        expect(parsed.overview).toBeTruthy();
        expect(parsed.overview.source).toBe("claude");
    });

    it("includes expanded_subagents array", () => {
        const parsed = JSON.parse(renderSessionJson(MINIMAL_PAYLOAD));
        expect(Array.isArray(parsed.expanded_subagents)).toBe(true);
    });

    it("includes expanded subagent data when provided", () => {
        const subPayload: SessionDetailPayload = {
            overview: makeOverview({
                id: "session:⟨sub-001⟩" as unknown as SessionId,
            }),
            top_skills: [],
            tool_calls: [{ label: "Bash", count: 5, failures: 0, last_used: null }],
            children: [],
            parent: null,
            agent_delegations: [],
            token_usage: null,
        };
        const payload: SessionShowPayload = {
            ...MINIMAL_PAYLOAD,
            expanded_subagents: [subPayload],
        };
        const parsed = JSON.parse(renderSessionJson(payload));
        expect(parsed.expanded_subagents).toHaveLength(1);
        expect(parsed.expanded_subagents[0].tool_calls[0].label).toBe("Bash");
    });

    it("does not include by_role key when null", () => {
        const parsed = JSON.parse(renderSessionJson(MINIMAL_PAYLOAD));
        expect("by_role" in parsed).toBe(false);
    });

    it("includes by_role array when populated", () => {
        const payload: SessionShowPayload = {
            ...MINIMAL_PAYLOAD,
            by_role: [
                { role: "debugging", skills: [{ skill: "caveman", count: 3 }] },
                { role: null, skills: [{ skill: "untagged", count: 1 }] },
            ],
        };
        const parsed = JSON.parse(renderSessionJson(payload));
        expect(Array.isArray(parsed.by_role)).toBe(true);
        expect(parsed.by_role).toHaveLength(2);
        expect(parsed.by_role[0].role).toBe("debugging");
        expect(parsed.by_role[1].role).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Tests: renderSessionMarkdown - --by-role (P3.7)
// ---------------------------------------------------------------------------

describe("renderSessionMarkdown - by-role (P3.7)", () => {
    const byRolePayload: SessionShowPayload = {
        ...MINIMAL_PAYLOAD,
        by_role: [
            {
                role: "debugging",
                skills: [
                    { skill: "caveman", count: 5 },
                    { skill: "diagnose", count: 2 },
                ],
            },
            {
                role: null,
                skills: [{ skill: "unclassified-tool", count: 1 }],
            },
        ],
    };

    it("renders ## By role header when by_role is populated", () => {
        const out = renderSessionMarkdown(byRolePayload);
        expect(out).toContain("## By role");
    });

    it("does NOT render ## Top skills when by_role is populated", () => {
        const out = renderSessionMarkdown(byRolePayload);
        expect(out).not.toContain("## Top skills");
    });

    it("renders role subheadings", () => {
        const out = renderSessionMarkdown(byRolePayload);
        expect(out).toContain("### debugging");
    });

    it("renders (unclassified) for null role", () => {
        const out = renderSessionMarkdown(byRolePayload);
        expect(out).toContain("### (unclassified)");
    });

    it("renders skill names and counts in by-role section", () => {
        const out = renderSessionMarkdown(byRolePayload);
        expect(out).toContain("caveman");
        expect(out).toContain("×5");
    });

    it("falls back to Top skills when by_role is null", () => {
        const out = renderSessionMarkdown(MINIMAL_PAYLOAD);
        expect(out).toContain("## Top skills");
        expect(out).not.toContain("## By role");
    });
});
