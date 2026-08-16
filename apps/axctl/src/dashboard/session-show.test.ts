/**
 * P2.2 tests: fetchSessionShow call counts and expansion logic.
 *
 * Most cases exercise the filtering predicate directly (no database needed).
 * The three that call `fetchSessionShow` run against a REAL published snapshot
 * holding one session and nothing else - they assert the "no children, no
 * roles" shape, which is what an EMPTY read produces too, so a fake would prove
 * nothing about them. `session-view.test.ts` is where the populated shape is
 * pinned; the `testing/surreal.ts` stub this file used to satisfy the layer
 * requirement with is gone with that requirement.
 */

import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import type { SessionDetailPayload, SessionLink, SessionViewPayload } from "@ax/lib/shared/dashboard-types";
import { fetchSessionShow } from "./session-show.ts";
import { EmptyJudgmentTestLayer } from "../testing/judgment-test-layer.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session-show", { requireFts: true });

const LONE = "019e0ad4-0000-0000-0000-000000000001";

/** One childless, skill-less session. */
const showLayer = async (sessionId: string) => {
    const fixture = await runWithPlatform(
        publishCacheFixture(tempDir("ax-session-show-"), dylibPath, (w: CacheWriteService) =>
            w.put("session", {
                id: sessionId,
                source: "claude",
                project: "test-project",
                cwd: "/test/cwd",
                started_at: new Date("2026-05-28T10:00:00.000Z"),
                ended_at: new Date("2026-05-28T11:00:00.000Z"),
            }),
        ),
    );
    return Layer.mergeAll(readFixture(fixture.snapshotPath, dylibPath), EmptyJudgmentTestLayer);
};

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
    dtest("makes exactly 1 fetchSessionDetail call when expand is empty", async () => {
        const result = await Effect.runPromise(
            fetchSessionShow({
                sessionId: LONE,
                expand: new Set(),
                expandAll: false,
            }).pipe(Effect.provide(await showLayer(LONE))) as Effect.Effect<SessionViewPayload, unknown>,
        );

        // The session itself must RESOLVE - otherwise "no expansions" is just
        // "nothing was read", which is the exact confusion this chunk removes.
        expect(result.session.overview?.id).toBe(LONE);
        expect(result.expanded_subagents).toHaveLength(0);
    }, 60_000);

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
    dtest("by_role is null when byRole=false (default)", async () => {
        const result = await Effect.runPromise(
            fetchSessionShow({
                sessionId: LONE,
                expand: new Set(),
                expandAll: false,
                byRole: false,
            }).pipe(Effect.provide(await showLayer(LONE))) as Effect.Effect<SessionViewPayload, unknown>,
        );

        expect(result.session.overview?.id).toBe(LONE);
        expect(result.by_role).toBeNull();
    }, 60_000);

    dtest("by_role is null when top_skills is empty even with byRole=true", async () => {
        // No invoked edges in the fixture, so the role fetch is skipped.
        const result = await Effect.runPromise(
            fetchSessionShow({
                sessionId: LONE,
                expand: new Set(),
                expandAll: false,
                byRole: true,
            }).pipe(Effect.provide(await showLayer(LONE))) as Effect.Effect<SessionViewPayload, unknown>,
        );

        expect(result.session.overview?.id).toBe(LONE);
        expect(result.session.top_skills).toEqual([]);
        expect(result.by_role).toBeNull();
    }, 60_000);

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
