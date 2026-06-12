import { describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { fetchWorktreesOverview } from "./worktrees-overview.ts";

/** Canned aggregate rows keyed by a marker in the SQL text. */
const fixtures: ReadonlyArray<{ readonly marker: string; readonly rows: unknown[] }> = [
    {
        marker: "FROM checkout",
        rows: [
            { id: "checkout:a", path: "/a", created_at: "2026-01-01", last_seen: "2026-01-01" },
            { id: "checkout:b", path: "/b", created_at: "2026-02-01", last_seen: "2026-02-01" },
        ],
    },
    {
        marker: "FROM repository",
        rows: [{ id: "repository:r1", name: "ax", checkout_count: 2, created_at: "2026-01-01", last_seen: "2026-01-01" }],
    },
    {
        marker: "FROM session",
        rows: [
            { id: "session:s1", checkout: "checkout:a", repository: "repository:r1" },
            { id: "session:s2", checkout: "checkout:a", repository: "repository:r1" },
            { id: "session:s3", checkout: null, repository: "repository:r1" },
        ],
    },
    { marker: "FROM turn", rows: [{ session: "session:s1", n: 10 }, { session: "session:s2", n: 5 }] },
    {
        marker: "FROM tool_call WHERE has_error",
        rows: [{ session: "session:s1", n: 2 }],
    },
    { marker: "FROM tool_call GROUP", rows: [{ session: "session:s1", n: 7 }, { session: "session:s2", n: 3 }] },
    { marker: "FROM produced GROUP BY in", rows: [{ in: "session:s1", n: 4 }] },
    { marker: "FROM produced GROUP BY out", rows: [{ out: "commit:c1", n: 4 }] },
    { marker: "FROM touched GROUP BY in", rows: [{ in: "commit:c1", n: 9 }, { in: "commit:c2", n: 2 }] },
    { marker: "FROM commit WHERE repository", rows: [{ repository: "repository:r1", n: 6 }] },
    {
        marker: "FROM commit;",
        rows: [
            { id: "commit:c1", repository: "repository:r1" },
            { id: "commit:c2", repository: "repository:r1" },
        ],
    },
    {
        // commit -> checkout linkage rides on produced edges; c2 has none,
        // so its touched edges count for the repo only.
        marker: "FROM produced WHERE checkout",
        rows: [{ out: "commit:c1", checkout: "checkout:a" }],
    },
];

const stubDb = Layer.mock(SurrealClient, {
    query: <T extends unknown[] = unknown[]>(sql: string, _bindings?: Record<string, unknown> | undefined): Effect.Effect<T, DbError, never> => {
        const hit = fixtures.find((f) => sql.includes(f.marker));
        return Effect.succeed([hit?.rows ?? []] as unknown as T);
    },
    raw: null as never,
});

describe("fetchWorktreesOverview", () => {
    test("joins per-session aggregates up to checkouts and repositories", async () => {
        const rt = ManagedRuntime.make(stubDb);
        const overview = await rt.runPromise(fetchWorktreesOverview(50));
        await rt.dispose();

        const a = overview.activity.find((c) => String(c.id) === "checkout:a");
        expect(a).toMatchObject({
            session_count: 2,
            turn_count: 15,           // s1:10 + s2:5
            tool_call_count: 10,      // s1:7 + s2:3
            tool_failure_count: 2,    // s1:2
            produced_count: 4,        // s1:4
            touched_count: 9,
        });
        const b = overview.activity.find((c) => String(c.id) === "checkout:b");
        expect(b).toMatchObject({ session_count: 0, turn_count: 0, touched_count: 0 });
        // Sort: active checkout first.
        expect(String(overview.activity[0]?.id)).toBe("checkout:a");

        const r1 = overview.git[0];
        expect(r1).toMatchObject({
            session_count: 3,                  // s1, s2, s3
            checkout_linked_session_count: 2,  // s1, s2
            commit_count: 6,
            touched_count: 11,                 // c1:9 + c2:2 rolled up via commits
            produced_count: 4,                 // commit:c1's 4 edges
            checkout_count: 2,
        });
    });

    test("respects the row limit", async () => {
        const rt = ManagedRuntime.make(stubDb);
        const overview = await rt.runPromise(fetchWorktreesOverview(1));
        await rt.dispose();
        expect(overview.activity.length).toBe(1);
        expect(String(overview.activity[0]?.id)).toBe("checkout:a");
    });
});
