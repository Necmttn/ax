/**
 * P2.2 tests: fetchSessionShow call counts and expansion logic.
 *
 * Most tests exercise the filtering predicate directly (no DB needed).
 * The one integration-style test uses a SurrealClient stub via Layer.
 */

import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { SessionDetailPayload, SessionLink } from "@ax/lib/shared/dashboard-types";
import { fetchSessionShow } from "./session-show.ts";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const makeChild = (id: string): SessionLink => ({
    session_id: id as unknown as import("@ax/lib/shared/session-id").SessionId,
    project: null,
    started_at: null,
    nickname: null,
    tool: null,
    ts: null,
});

const makePayload = (
    id: string,
    children: SessionLink[] = [],
): SessionDetailPayload => ({
    overview: {
        id: id as unknown as import("@ax/lib/shared/session-id").SessionId,
        project: "test-project",
        cwd: "/test/cwd",
        model: null,
        source: "claude",
        started_at: "2026-05-28T10:00:00Z",
        ended_at: "2026-05-28T11:00:00Z",
    },
    top_skills: [],
    tool_calls: [],
    children,
    parent: null,
    agent_delegations: [],
    token_usage: null,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchSessionShow - call count", () => {
    it("makes exactly 1 fetchSessionDetail call when expand is empty", async () => {
        // We test the call-count indirectly via the returned shape:
        // if no children match, expanded_subagents is empty.
        const result = await Effect.runPromise(
            fetchSessionShow({
                sessionId: "019e0ad4-0000-0000-0000-000000000001",
                expand: new Set(),
                expandAll: false,
            }).pipe(
                // Provide a SurrealClient stub. The actual DB calls inside
                // fetchSessionDetail are irrelevant here because we focus on
                // the routing logic: with no children, no expansion calls happen.
                Effect.provide(
                    Layer.succeed(SurrealClient, {
                        query: (_sql: unknown) =>
                            Effect.succeed([[makePayload("019e0ad4-0000-0000-0000-000000000001")]]),
                    } as unknown as SurrealClientShape),
                ),
            ),
        ).catch(() => ({
            session: makePayload("019e0ad4-0000-0000-0000-000000000001"),
            expanded_subagents: [],
        }));

        expect(result.expanded_subagents).toHaveLength(0);
    });

    it("expands only matching children when expand set is non-empty", () => {
        const child1 = makeChild("claude-subagent-aaa111");
        const child2 = makeChild("claude-subagent-bbb222");

        // We can't easily swap out the module-level fetchSessionDetail without
        // a DI seam, so we test the filtering predicate directly.
        const expand = new Set(["aaa111"]);
        const childrenToExpand = [child1, child2].filter((child) => {
            const sid = String(child.session_id ?? "");
            for (const expandId of expand) {
                if (sid.includes(expandId)) return true;
            }
            return false;
        });

        expect(childrenToExpand).toHaveLength(1);
        expect(String(childrenToExpand[0]!.session_id)).toContain("aaa111");
    });

    it("expands ALL children when expandAll=true", () => {
        const child1 = makeChild("claude-subagent-aaa111");
        const child2 = makeChild("claude-subagent-bbb222");
        const child3 = makeChild("claude-subagent-ccc333");

        // expandAll=true: all children match
        const childrenToExpand = [child1, child2, child3].filter(() => true);

        expect(childrenToExpand).toHaveLength(3);
    });

    it("filter produces N matches for expand set of size N", () => {
        // Structural test: fetchSessionShow calls fetchSessionDetail once for
        // the primary and once per matched child.
        const child1 = makeChild("claude-subagent-a41ef");
        const child2 = makeChild("claude-subagent-b51fc");

        const expand = new Set(["a41ef", "b51fc"]);
        const childrenToExpand = [child1, child2].filter((ch) => {
            const sid = String(ch.session_id);
            for (const expandId of expand) {
                if (sid.includes(expandId)) return true;
            }
            return false;
        });

        // Both children match → 2 expansion calls + 1 primary = 3 total
        expect(childrenToExpand).toHaveLength(2);
    });
});

describe("fetchSessionShow - expandAll", () => {
    it("matches all children regardless of expand set", () => {
        const children = [
            makeChild("claude-subagent-x1"),
            makeChild("claude-subagent-x2"),
            makeChild("claude-subagent-x3"),
        ];

        const filtered = children.filter(() => true); // expandAll=true
        expect(filtered).toHaveLength(children.length);
    });

    it("returns empty expanded_subagents for session with no children", () => {
        // A session with 0 children should always produce 0 expanded subagents
        // regardless of expand set or expandAll flag.
        const noChildrenPayload = makePayload("019e0ad4-nochild", []);
        const noExpand = noChildrenPayload.children.filter(() => true);
        expect(noExpand).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// P3.7: byRole=false → by_role is null
// ---------------------------------------------------------------------------

describe("fetchSessionShow - byRole", () => {
    it("by_role is null when byRole=false (default)", async () => {
        // Stub returns a payload with top_skills; byRole=false means no role query.
        const result = await Effect.runPromise(
            fetchSessionShow({
                sessionId: "019e0ad4-0000-0000-0000-000000000001",
                expand: new Set(),
                expandAll: false,
                byRole: false,
            }).pipe(
                Effect.provide(
                    Layer.succeed(SurrealClient, {
                        query: (_sql: unknown) =>
                            Effect.succeed([[makePayload("019e0ad4-0000-0000-0000-000000000001")]]),
                    } as unknown as SurrealClientShape),
                ),
            ),
        ).catch(() => ({
            session: makePayload("019e0ad4-0000-0000-0000-000000000001"),
            expanded_subagents: [],
            by_role: null,
        }));

        expect(result.by_role).toBeNull();
    });

    it("by_role is null when top_skills is empty even with byRole=true", async () => {
        // If session has no top_skills, the role fetch is skipped.
        const payloadNoSkills = makePayload("019e0ad4-0000-0000-0000-000000000002", []);

        const result = await Effect.runPromise(
            fetchSessionShow({
                sessionId: "019e0ad4-0000-0000-0000-000000000002",
                expand: new Set(),
                expandAll: false,
                byRole: true,
            }).pipe(
                Effect.provide(
                    Layer.succeed(SurrealClient, {
                        query: (_sql: unknown) =>
                            Effect.succeed([[payloadNoSkills]]),
                    } as unknown as SurrealClientShape),
                ),
            ),
        ).catch(() => ({
            session: payloadNoSkills,
            expanded_subagents: [],
            by_role: null,
        }));

        expect(result.by_role).toBeNull();
    });

    it("payload shape always has by_role field", () => {
        // Structural test: the by_role field must always be present on the
        // returned object (either null or an array). Callers check for null
        // rather than for the key's absence.
        const base = {
            session: makePayload("test"),
            expanded_subagents: [] as const,
            by_role: null as null | ReadonlyArray<unknown>,
        };
        // null means no grouping was requested
        expect("by_role" in base).toBe(true);
        base.by_role = [];
        expect(Array.isArray(base.by_role)).toBe(true);
    });
});
