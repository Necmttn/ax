import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import type {
    SessionLink,
    SessionTopSkill,
} from "@ax/lib/shared/dashboard-types";
import {
    SESSION_SKILL_ROLES_SQL,
    sessionSkillRolesQuery,
} from "../queries/session-view.ts";
import {
    fetchSessionView,
    groupSessionSkillsByRole,
    selectSessionChildrenToExpand,
} from "./session-view.ts";

const makeChild = (id: string): SessionLink => ({
    session_id: id,
    project: null,
    started_at: null,
    nickname: null,
    tool: null,
    ts: null,
});

const topSkill = (skill: string, count: number): SessionTopSkill => ({
    skill,
    count,
    last_used: null,
});

describe("Session View shape helpers", () => {
    it("selects child sessions by loose expand id or expandAll", () => {
        const children = [
            makeChild("claude-subagent-a41ef01d6ca8d521c"),
            makeChild("claude-subagent-b51fc01d6ca8d522d"),
        ];

        expect(
            selectSessionChildrenToExpand(children, new Set(["a41ef01"]), false),
        ).toEqual([children[0]]);
        expect(selectSessionChildrenToExpand(children, new Set(), true)).toEqual(
            children,
        );
    });

    it("groups top skills by primary role with unclassified skills last", () => {
        const groups = groupSessionSkillsByRole(
            [topSkill("debug-skill", 3), topSkill("plan-skill", 8), topSkill("raw-skill", 2)],
            [
                { skill_name: "debug-skill", role_name: "debugging" },
                { skill_name: "debug-skill", role_name: "review" },
                { skill_name: "plan-skill", role_name: "planning" },
            ],
        );

        expect(groups).toEqual([
            { role: "planning", skills: [{ skill: "plan-skill", count: 8 }] },
            { role: "debugging", skills: [{ skill: "debug-skill", count: 3 }] },
            { role: null, skills: [{ skill: "raw-skill", count: 2 }] },
        ]);
    });
});

describe("session view role query", () => {
    it("keeps skill names in bindings instead of interpolating them", () => {
        const sql = sessionSkillRolesQuery.sql({
            skillNames: ["debug-skill"],
        });

        expect(sql).toBe(SESSION_SKILL_ROLES_SQL.trim());
        expect(sql).toContain("IN $skills");
        expect(sql).not.toContain("debug-skill");
        expect(sessionSkillRolesQuery.bindings?.({ skillNames: ["debug-skill"] }))
            .toEqual({ skills: ["debug-skill"] });
    });

    it("maps invalid role rows to null at the typed query seam", () => {
        expect(
            sessionSkillRolesQuery.mapRow(
                { skill_name: "debug-skill", role_name: "debugging" },
                0,
            ),
        ).toEqual({ skill_name: "debug-skill", role_name: "debugging" });
        expect(
            sessionSkillRolesQuery.mapRow({ skill_name: "debug-skill" }, 0),
        ).toBeNull();
    });
});

describe("fetchSessionView", () => {
    it("includes ordered normalized turns in the requested text mode", async () => {
        const primaryId = "019e0ad4-0000-0000-0000-000000000001";
        let turnQueries = 0;
        const tc = makeTestSurrealClient({
            denyWrites: true,
            fallback: (sql) => {
                if (sql.includes("FROM turn")) {
                    turnQueries += 1;
                    return [[
                        {
                            id: "turn:one",
                            seq: 1,
                            ts: "2026-05-28T10:00:01Z",
                            role: "user",
                            message_kind: "user",
                            intent_kind: "task",
                            text: "Please inspect the complete normalized turn.",
                            text_excerpt: "Please inspect the complete…",
                            has_error: false,
                        },
                        {
                            id: "turn:two",
                            seq: 2,
                            ts: "2026-05-28T10:00:02Z",
                            role: "assistant",
                            message_kind: "assistant",
                            intent_kind: "response",
                            text: "I inspected the complete normalized turn.",
                            text_excerpt: "I inspected the complete…",
                            has_error: true,
                        },
                    ]];
                }

                if (sql.includes("FROM session:")) {
                    return [[{
                        id: `session:⟨${primaryId}⟩`,
                        project: "test-project",
                        cwd: "/tmp/test-project",
                        source: "pi",
                        started_at: "2026-05-28T10:00:00Z",
                        ended_at: "2026-05-28T10:10:00Z",
                    }]];
                }

                return [[]];
            },
        });

        const result = await Effect.runPromise(
            fetchSessionView({
                sessionId: primaryId,
                expand: new Set(),
                expandAll: false,
                turns: "excerpt",
            }).pipe(Effect.provide(tc.layer)),
        );

        expect(turnQueries).toBe(1);
        expect(result.turns).toEqual([
            {
                seq: 1,
                ts: "2026-05-28T10:00:01Z",
                role: "user",
                message_kind: "user",
                intent_kind: "task",
                text_excerpt: "Please inspect the complete…",
                has_error: false,
            },
            {
                seq: 2,
                ts: "2026-05-28T10:00:02Z",
                role: "assistant",
                message_kind: "assistant",
                intent_kind: "response",
                text_excerpt: "I inspected the complete…",
                has_error: true,
            },
        ]);

        const fullResult = await Effect.runPromise(
            fetchSessionView({
                sessionId: primaryId,
                expand: new Set(),
                expandAll: false,
                turns: "full",
            }).pipe(Effect.provide(tc.layer)),
        );

        expect(turnQueries).toBe(2);
        expect(fullResult.turns?.[0]).toEqual({
            seq: 1,
            ts: "2026-05-28T10:00:01Z",
            role: "user",
            message_kind: "user",
            intent_kind: "task",
            text: "Please inspect the complete normalized turn.",
            has_error: false,
        });
    });

    it("owns expansion and by-role grouping for the session show read shape", async () => {
        const primaryId = "019e0ad4-0000-0000-0000-000000000001";
        const childId = "claude-subagent-a41ef01d6ca8d521c";
        const seenRoleBindings: unknown[] = [];
        let turnQueries = 0;

        const tc = makeTestSurrealClient({
            denyWrites: true,
            fallback: (sql, bindings) => {
                if (sql.includes("FROM turn")) {
                    turnQueries += 1;
                    return [[]];
                }

                if (sql.includes("FROM plays_role")) {
                    seenRoleBindings.push(bindings);
                    return [
                        [
                            { skill_name: "plan-skill", role_name: "planning" },
                            { skill_name: "debug-skill", role_name: "debugging" },
                        ],
                    ];
                }

                const isChild = sql.includes(`session:⟨${childId}⟩`);

                if (sql.includes("FROM session:")) {
                    const id = isChild ? childId : primaryId;
                    return [
                        [
                            {
                                id: `session:⟨${id}⟩`,
                                project: "test-project",
                                cwd: "/tmp/test-project",
                                source: "claude",
                                started_at: "2026-05-28T10:00:00Z",
                                ended_at: "2026-05-28T10:10:00Z",
                            },
                        ],
                    ];
                }

                if (sql.includes("FROM invoked")) {
                    return [
                        isChild
                            ? []
                            : [
                                  { skill: "plan-skill", count: 8, last_used: null },
                                  { skill: "debug-skill", count: 3, last_used: null },
                                  { skill: "raw-skill", count: 2, last_used: null },
                              ],
                    ];
                }

                if (sql.includes("FROM spawned") && sql.includes("WHERE in =")) {
                    return [
                        isChild
                            ? []
                            : [
                                  {
                                      child: `session:⟨${childId}⟩`,
                                      project: "test-project",
                                      started_at: "2026-05-28T10:01:00Z",
                                      nickname: "worker",
                                      tool: "Agent",
                                      ts: "2026-05-28T10:01:00Z",
                                  },
                              ],
                    ];
                }

                return [[]];
            },
        });

        const result = await Effect.runPromise(
            fetchSessionView({
                sessionId: primaryId,
                expand: new Set(["a41ef01"]),
                expandAll: false,
                byRole: true,
            }).pipe(
                Effect.provide(tc.layer),
            ),
        );

        expect(result.session.overview?.id).toBe(primaryId);
        expect(result.expanded_subagents).toHaveLength(1);
        expect(result.expanded_subagents[0]?.overview?.id).toBe(childId);
        expect(result.by_role).toEqual([
            { role: "planning", skills: [{ skill: "plan-skill", count: 8 }] },
            { role: "debugging", skills: [{ skill: "debug-skill", count: 3 }] },
            { role: null, skills: [{ skill: "raw-skill", count: 2 }] },
        ]);
        expect(seenRoleBindings).toEqual([
            { skills: ["plan-skill", "debug-skill", "raw-skill"] },
        ]);
        expect(turnQueries).toBe(0);
        expect("turns" in result).toBe(false);
    });
});
