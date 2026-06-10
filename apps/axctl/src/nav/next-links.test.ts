import { describe, expect, test } from "bun:test";
import type {
    RecallResponse,
    RecallHit,
    SessionViewPayload,
    SessionDetailPayload,
} from "@ax/lib/shared/dashboard-types";
import type { SessionRow } from "../dashboard/sessions-query.ts";
import {
    buildRecallNext,
    buildSessionsNext,
    buildSessionShowNext,
} from "./next-links.ts";

const UUID_A = "019e2531-b552-7b53-a029-c780adbb6560";
const UUID_B = "019e9999-aaaa-7b53-a029-c780adbb6560";

const hit = (over: Partial<RecallHit>): RecallHit => ({
    turn_id: "turn:1",
    session_id: UUID_A,
    project: "-Users-x-proj",
    source: "claude",
    cwd: "/Users/x/proj",
    role: "user",
    ts: "2026-06-09T02:00:00.000Z",
    snippet: "timeline vision",
    ...over,
});

const recallResponse = (
    hits: ReadonlyArray<RecallHit>,
    total = hits.length,
): RecallResponse => ({
    q: "timeline",
    hits,
    commits: [],
    skills: [],
    truncated: false,
    total_count: total,
    total_counts: { turn: total, commit: 0, skill: 0 },
    window: { offset: 0, limit: 50 },
});

const row = (over: Partial<SessionRow>): SessionRow => ({
    id: UUID_A,
    started_at: "2026-06-09T02:00:00.000Z",
    ended_at: null,
    source: "claude",
    project: "-Users-x-proj",
    cwd: "/Users/x/proj",
    repository: null,
    turn_count: 5,
    first_user_message: "hello",
    ...over,
});

const detail = (over: Partial<SessionDetailPayload>): SessionDetailPayload => ({
    overview: {
        id: UUID_A,
        project: "-Users-x-proj",
        cwd: "/Users/x/proj",
        model: null,
        source: "claude",
        started_at: "2026-06-09T02:00:00.000Z",
        ended_at: null,
    },
    top_skills: [],
    tool_calls: [],
    children: [],
    parent: null,
    agent_delegations: [],
    token_usage: null,
    ...over,
});

const view = (session: SessionDetailPayload): SessionViewPayload => ({
    session,
    expanded_subagents: [],
    by_role: null,
    compactions: [],
});

describe("buildRecallNext", () => {
    test("per-hit next is exactly one session drill-in", () => {
        const { hits } = buildRecallNext(recallResponse([hit({})]), {
            requestedSources: ["turn"],
        });
        expect(hits[0]?.next).toHaveLength(1);
        expect(hits[0]?.next?.[0]?.call?.tool).toBe("session_show");
        expect(hits[0]?.next?.[0]?.call?.arguments).toEqual({ sessionId: UUID_A });
        expect(hits[0]?.next?.[0]?.cmd).toBe(`ax sessions show ${UUID_A}`);
    });

    test("top-level next carries resume cmd for claude hit with cwd", () => {
        const { next } = buildRecallNext(recallResponse([hit({})]), {
            requestedSources: ["turn"],
        });
        const resume = next.find((l) => l.ui?.group === "resume");
        expect(resume?.cmd).toBe(`cd /Users/x/proj && claude --resume ${UUID_A}`);
    });

    test("codex hit → codex resume cmd", () => {
        const { next } = buildRecallNext(
            recallResponse([hit({ source: "codex", session_id: UUID_B })]),
            { requestedSources: ["turn"] },
        );
        const resume = next.find((l) => l.ui?.group === "resume");
        expect(resume?.cmd).toBe(`codex resume ${UUID_B}`);
    });

    test("subagent hit → no resume link", () => {
        const { next } = buildRecallNext(
            recallResponse([
                hit({ source: "claude-subagent", session_id: "claude-subagent-abc" }),
            ]),
            { requestedSources: ["turn"] },
        );
        expect(next.find((l) => l.ui?.group === "resume")).toBeUndefined();
    });

    test("resume links dedupe by session and cap at 2 distinct sessions", () => {
        const { next } = buildRecallNext(
            recallResponse([
                hit({}),
                hit({}),
                hit({ session_id: UUID_B }),
                hit({ session_id: "019e3333-b552-7b53-a029-c780adbb6560" }),
            ]),
            { requestedSources: ["turn"] },
        );
        expect(next.filter((l) => l.ui?.group === "resume")).toHaveLength(2);
    });

    test("empty result teaches broaden + sessions_around", () => {
        const { next } = buildRecallNext(recallResponse([], 0), {
            requestedSources: ["turn"],
        });
        expect(next.length).toBeGreaterThanOrEqual(2);
        const tools = next.map((l) => l.call?.tool);
        expect(tools).toContain("recall");
        expect(tools).toContain("sessions_around");
    });

    test("thin results from subset sources suggest broadening", () => {
        const { next } = buildRecallNext(recallResponse([hit({})], 1), {
            requestedSources: ["turn"],
        });
        const broaden = next.find((l) => l.call?.tool === "recall");
        expect(broaden?.call?.arguments).toEqual({
            q: "timeline",
            sources: ["turn", "commit", "skill"],
        });
    });

    test("all sources requested + results → no broaden link", () => {
        const { next } = buildRecallNext(recallResponse([hit({})], 5), {
            requestedSources: ["turn", "commit", "skill"],
        });
        expect(next.find((l) => l.call?.tool === "recall")).toBeUndefined();
    });
});

describe("buildSessionsNext", () => {
    test("per-row drill-in + top resume", () => {
        const { sessions, next } = buildSessionsNext([row({})]);
        expect(sessions[0]?.next?.[0]?.call?.tool).toBe("session_show");
        const resume = next.find((l) => l.ui?.group === "resume");
        expect(resume?.cmd).toBe(`cd /Users/x/proj && claude --resume ${UUID_A}`);
    });

    test("pi/opencode/cursor rows get no resume link", () => {
        const { next } = buildSessionsNext([
            row({ source: "pi" }),
            row({ source: "opencode", id: UUID_B }),
        ]);
        expect(next.filter((l) => l.ui?.group === "resume")).toHaveLength(0);
    });

    test("empty window with date teaches widening", () => {
        const { next } = buildSessionsNext([], { date: "2026-06-09", days: 3 });
        const widen = next.find((l) => l.call?.tool === "sessions_around");
        expect(widen?.call?.arguments).toEqual({ date: "2026-06-09", days: 6 });
    });

    test("empty window with project filter teaches dropping it", () => {
        const { next } = buildSessionsNext([], {
            date: "2026-06-09",
            days: 3,
            project: "-Users-x-proj",
        });
        expect(next).toHaveLength(2);
    });
});

describe("buildSessionShowNext", () => {
    test("claude session → resume link first", () => {
        const next = buildSessionShowNext(view(detail({})));
        expect(next[0]?.cmd).toBe(`cd /Users/x/proj && claude --resume ${UUID_A}`);
    });

    test("subagent session → parent link, no resume", () => {
        const next = buildSessionShowNext(
            view(
                detail({
                    overview: {
                        id: "claude-subagent-abc",
                        project: null,
                        cwd: null,
                        model: null,
                        source: "claude-subagent",
                        started_at: null,
                        ended_at: null,
                    },
                    parent: {
                        session_id: UUID_A,
                        project: null,
                        started_at: null,
                        nickname: null,
                        tool: null,
                        ts: null,
                    },
                }),
            ),
        );
        expect(next.find((l) => l.ui?.group === "resume")).toBeUndefined();
        expect(next[0]?.call?.arguments).toEqual({ sessionId: UUID_A });
        expect(next[0]?.description).toContain("parent");
    });

    test("children unexpanded → expand-all link", () => {
        const next = buildSessionShowNext(
            view(
                detail({
                    children: [
                        {
                            session_id: "claude-subagent-x",
                            project: null,
                            started_at: null,
                            nickname: null,
                            tool: null,
                            ts: null,
                        },
                    ],
                }),
            ),
        );
        const expand = next.find((l) => l.call?.arguments.expandAll === true);
        expect(expand?.cmd).toBe(`ax sessions show ${UUID_A} --all`);
    });

    test("no overview → empty next", () => {
        const next = buildSessionShowNext(view(detail({ overview: null })));
        expect(next).toHaveLength(0);
    });
});
