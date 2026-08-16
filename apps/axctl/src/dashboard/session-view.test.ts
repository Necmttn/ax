/**
 * Session View against a REAL published DuckDB snapshot.
 *
 * The two `fetchSessionView` cases below used to run on `testing/surreal.ts`'s
 * route-table fake, matching on SQL SUBSTRINGS (`sql.includes("FROM invoked")`)
 * and answering canned rows. That fake is why the v2 cut-over could ship this
 * path green while it returned nothing: it answers whatever the case wants,
 * whatever the statement says and whatever engine is behind it. Rows now come
 * out of a snapshot the seam published, through the same `CacheRead` the CLI
 * resolves, so a wrong JOIN or a wrong column contract fails here.
 *
 * `Judgment` stays a test layer: role edges live in the SQLite sidecar, which
 * this chunk does not touch.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import type { SessionLink, SessionTopSkill, SessionViewPayload } from "@ax/lib/shared/dashboard-types";
import { EmptyJudgmentTestLayer, judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import {
    fetchSessionView,
    groupSessionSkillsByRole,
    selectSessionChildrenToExpand,
} from "./session-view.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session-view", { requireFts: true });

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

const PRIMARY = "019e0ad4-0000-0000-0000-000000000001";
const CHILD = "claude-subagent-a41ef01d6ca8d521c";
const T = (iso: string): Date => new Date(iso);

/** One parent session with two turns, three invoked skills and one spawned
 *  child - the smallest corpus that exercises every join in the view. */
const CORPUS = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            {
                id: PRIMARY,
                source: "claude",
                project: "test-project",
                cwd: "/tmp/test-project",
                started_at: T("2026-05-28T10:00:00.000Z"),
                ended_at: T("2026-05-28T10:10:00.000Z"),
            },
            {
                id: CHILD,
                source: "claude-subagent",
                project: "test-project",
                cwd: "/tmp/test-project",
                started_at: T("2026-05-28T10:01:00.000Z"),
                ended_at: T("2026-05-28T10:05:00.000Z"),
            },
        ]);
        yield* w.putMany("turn", [
            {
                id: "turn-one",
                session: PRIMARY,
                seq: 1,
                ts: T("2026-05-28T10:00:01.000Z"),
                role: "user",
                message_kind: "user",
                intent_kind: "task",
                text: "Please inspect the complete normalized turn.",
                text_excerpt: "Please inspect the complete…",
                has_tool_use: false,
                has_error: false,
            },
            {
                id: "turn-two",
                session: PRIMARY,
                seq: 2,
                ts: T("2026-05-28T10:00:02.000Z"),
                role: "assistant",
                message_kind: "assistant",
                intent_kind: "response",
                text: "I inspected the complete normalized turn.",
                text_excerpt: "I inspected the complete…",
                has_tool_use: false,
                has_error: true,
            },
            {
                // Excluded by message_kind - pins that the NOT IN filter still
                // bites once the `IS NULL` arm was added to it.
                id: "turn-system",
                session: PRIMARY,
                seq: 3,
                ts: T("2026-05-28T10:00:03.000Z"),
                role: "user",
                message_kind: "system",
                intent_kind: null,
                text: "a system turn nobody asked for",
                text_excerpt: null,
                has_tool_use: false,
                has_error: false,
            },
        ]);
        yield* w.putMany("skill", [
            { id: "skill-plan", name: "plan-skill", scope: "user", dir_path: "/s/plan", content_hash: "h1" },
            { id: "skill-debug", name: "debug-skill", scope: "user", dir_path: "/s/debug", content_hash: "h2" },
            { id: "skill-raw", name: "raw-skill", scope: "user", dir_path: "/s/raw", content_hash: "h3" },
        ]);
        yield* w.putMany(
            "invoked",
            [
                ...Array.from({ length: 8 }, (_, i) => ["skill-plan", i] as const),
                ...Array.from({ length: 3 }, (_, i) => ["skill-debug", i] as const),
                ...Array.from({ length: 2 }, (_, i) => ["skill-raw", i] as const),
            ].map(([skill, i]) => ({
                id: `inv-${skill}-${i}`,
                in_id: "turn-one",
                out_id: skill,
                session: PRIMARY,
                ts: T("2026-05-28T10:00:05.000Z"),
            })),
        );
        yield* w.put("compaction", {
            id: "compact-one",
            session: PRIMARY,
            harness: "claude",
            ts: T("2026-05-28T10:04:00.000Z"),
            strategy: "summarize",
            source_confidence: "explicit",
            // `trigger` is a reserved word - this row is what proves the read
            // quotes it rather than emitting a statement DuckDB rejects.
            trigger: "auto",
            tokens_before: 150000,
            kept_count: 12,
            summary: "kept the seam work",
        });
        yield* w.put("spawned", {
            id: "spawn-one",
            in_id: PRIMARY,
            out_id: CHILD,
            ts: T("2026-05-28T10:01:00.000Z"),
            tool: "Agent",
            nickname: "worker",
        });
    });

const publish = (prefix: string) =>
    runWithPlatform(publishCacheFixture(tempDir(prefix), dylibPath, CORPUS));

describe("fetchSessionView", () => {
    dtest("includes ordered normalized turns in the requested text mode", async () => {
        const fixture = await publish("ax-session-view-turns-");
        const layer = Layer.mergeAll(
            readFixture(fixture.snapshotPath, dylibPath),
            EmptyJudgmentTestLayer,
        );

        const result = await Effect.runPromise(
            fetchSessionView({
                sessionId: PRIMARY,
                expand: new Set(),
                expandAll: false,
                turns: "excerpt",
            }).pipe(Effect.provide(layer)) as Effect.Effect<SessionViewPayload, unknown>,
        );

        expect(result.turns).toEqual([
            {
                seq: 1,
                ts: "2026-05-28T10:00:01.000Z",
                role: "user",
                message_kind: "user",
                intent_kind: "task",
                text_excerpt: "Please inspect the complete…",
                has_error: false,
            },
            {
                seq: 2,
                ts: "2026-05-28T10:00:02.000Z",
                role: "assistant",
                message_kind: "assistant",
                intent_kind: "response",
                text_excerpt: "I inspected the complete…",
                has_error: true,
            },
        ]);

        const fullResult = await Effect.runPromise(
            fetchSessionView({
                sessionId: PRIMARY,
                expand: new Set(),
                expandAll: false,
                turns: "full",
            }).pipe(Effect.provide(layer)) as Effect.Effect<SessionViewPayload, unknown>,
        );

        expect(fullResult.turns?.[0]).toEqual({
            seq: 1,
            ts: "2026-05-28T10:00:01.000Z",
            role: "user",
            message_kind: "user",
            intent_kind: "task",
            text: "Please inspect the complete normalized turn.",
            has_error: false,
        });
    }, 60_000);

    dtest("owns expansion and by-role grouping for the session show read shape", async () => {
        const fixture = await publish("ax-session-view-expand-");
        const seenRoleBindings: unknown[] = [];

        const result = await Effect.runPromise(
            fetchSessionView({
                sessionId: PRIMARY,
                expand: new Set(["a41ef01"]),
                expandAll: false,
                byRole: true,
            }).pipe(
                Effect.provide(Layer.mergeAll(
                    readFixture(fixture.snapshotPath, dylibPath),
                    judgmentTestLayer((_sql, params) => {
                        seenRoleBindings.push(params);
                        return [
                            { skill_id: "skill-plan", role_name: "planning" },
                            { skill_id: "skill-debug", role_name: "debugging" },
                        ];
                    }),
                )),
            ) as Effect.Effect<SessionViewPayload, unknown>,
        );

        expect(result.session.overview?.id).toBe(PRIMARY);
        expect(result.session.overview?.project).toBe("test-project");
        // The counts come out of a real GROUP BY over `invoked` JOIN `skill`,
        // which is where a BIGINT decoded as Schema.Number would have silently
        // emptied the list instead of raising.
        expect(result.session.top_skills).toEqual([
            { skill: "plan-skill", count: 8, last_used: "2026-05-28T10:00:05.000Z" },
            { skill: "debug-skill", count: 3, last_used: "2026-05-28T10:00:05.000Z" },
            { skill: "raw-skill", count: 2, last_used: "2026-05-28T10:00:05.000Z" },
        ]);
        expect(result.session.children.map((child) => child.session_id)).toEqual([CHILD]);
        expect(result.expanded_subagents).toHaveLength(1);
        expect(result.expanded_subagents[0]?.overview?.id).toBe(CHILD);
        expect(result.expanded_subagents[0]?.parent?.session_id).toBe(PRIMARY);
        expect(result.by_role).toEqual([
            { role: "planning", skills: [{ skill: "plan-skill", count: 8 }] },
            { role: "debugging", skills: [{ skill: "debug-skill", count: 3 }] },
            { role: null, skills: [{ skill: "raw-skill", count: 2 }] },
        ]);
        // The sidecar is asked for the ids the CACHE resolved, so this also
        // pins that the skill-name lookup actually returned rows.
        // Order is the cache's, not the caller's, so compare as a set.
        expect(result.compactions).toEqual([
            {
                harness: "claude",
                ts: "2026-05-28T10:04:00.000Z",
                strategy: "summarize",
                source_confidence: "explicit",
                trigger: "auto",
                tokens_before: 150000,
                kept_count: 12,
                summary: "kept the seam work",
            },
        ]);
        expect(seenRoleBindings).toHaveLength(1);
        expect([...(seenRoleBindings[0] as ReadonlyArray<string>)].sort()).toEqual([
            "skill-debug",
            "skill-plan",
            "skill-raw",
        ]);
        expect("turns" in result).toBe(false);
    }, 60_000);

    dtest("a session the snapshot does not hold reads as not-found, not as empty-but-present", async () => {
        // The negative control. Every assertion above would ALSO pass against a
        // reader that returns nothing for every id - which is exactly the state
        // this chunk fixes - so the suite has to show the two apart.
        const fixture = await publish("ax-session-view-missing-");
        const result = await Effect.runPromise(
            fetchSessionView({
                sessionId: "019e0ad4-0000-0000-0000-00000000dead",
                expand: new Set(),
                expandAll: false,
                turns: "excerpt",
            }).pipe(
                Effect.provide(Layer.mergeAll(
                    readFixture(fixture.snapshotPath, dylibPath),
                    EmptyJudgmentTestLayer,
                )),
            ) as Effect.Effect<SessionViewPayload, unknown>,
        );

        expect(result.session.overview).toBeNull();
        expect(result.session.top_skills).toEqual([]);
        expect(result.turns).toEqual([]);
    }, 60_000);
});
