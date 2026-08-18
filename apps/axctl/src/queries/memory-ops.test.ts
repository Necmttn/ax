import { describe, expect, test } from "bun:test";
import { cacheReadResults, runWithCacheRead } from "../testing/cache-read.ts";
import { fetchMemoryOps } from "./memory-ops.ts";

const makeMockDb = (results: ReadonlyArray<ReadonlyArray<ReadonlyArray<unknown>>>) =>
    cacheReadResults([results[0]?.[0] ?? []]);
const runWithMock = <A>(layer: ReturnType<typeof cacheReadResults>, effect: Parameters<typeof runWithCacheRead<A, unknown>>[0]) =>
    runWithCacheRead(effect, layer);

// Helper: a raw `edited`-edge row as the SQL projection returns it.
const row = (o: Partial<{
    ts: string | Date;
    tool: string;
    path: string;
    session_id: string;
    project: string | null;
    source: string | null;
}>) => ({
    ts: new Date(o.ts ?? "2026-06-17T10:00:00.000Z"),
    tool: o.tool ?? "Write",
    path: o.path ?? "/Users/x/.claude/projects/p/memory/foo.md",
    session_id: o.session_id ?? "session:`abc`",
    project: o.project ?? "p",
    source: o.source ?? "claude",
});

describe("fetchMemoryOps - events", () => {
    test("maps tool->op, path->slug+kind, cleans session id", async () => {
        const db = makeMockDb([[[
            row({ tool: "Write", path: "/u/.claude/projects/p/memory/recap.md", session_id: "session:`s1`" }),
            row({ tool: "Edit", path: "/u/.claude/projects/p/memory/MEMORY.md", session_id: "session:`s1`" }),
        ]]]);
        const r = await runWithMock(db, fetchMemoryOps({ sinceDays: 30 }));

        expect(r.events).toHaveLength(2);
        const write = r.events.find((e) => e.slug === "recap")!;
        expect(write.op).toBe("create");
        expect(write.kind).toBe("note");
        expect(write.session_id).toBe("s1"); // session: prefix + backticks stripped

        const idx = r.events.find((e) => e.slug === "MEMORY")!;
        expect(idx.op).toBe("update"); // Edit -> update
        expect(idx.kind).toBe("index"); // MEMORY.md -> index
    });

    test("NotebookEdit counts as update", async () => {
        const db = makeMockDb([[[row({ tool: "NotebookEdit" })]]]);
        const r = await runWithMock(db, fetchMemoryOps({ sinceDays: 30 }));
        expect(r.events[0]!.op).toBe("update");
    });
});

describe("fetchMemoryOps - file rollup", () => {
    test("aggregates writes/edits, distinct sessions, first/last seen", async () => {
        const db = makeMockDb([[[
            row({ tool: "Write", path: "/u/.claude/projects/p/memory/a.md", session_id: "session:`s1`", ts: "2026-06-01T00:00:00.000Z" }),
            row({ tool: "Edit", path: "/u/.claude/projects/p/memory/a.md", session_id: "session:`s1`", ts: "2026-06-03T00:00:00.000Z" }),
            row({ tool: "Edit", path: "/u/.claude/projects/p/memory/a.md", session_id: "session:`s2`", ts: "2026-06-02T00:00:00.000Z" }),
        ]]]);
        const r = await runWithMock(db, fetchMemoryOps({ sinceDays: 30 }));

        expect(r.files).toHaveLength(1);
        const f = r.files[0]!;
        expect(f.slug).toBe("a");
        expect(f.writes).toBe(1);
        expect(f.edits).toBe(2);
        expect(f.ops).toBe(3);
        expect(f.sessions).toBe(2); // s1, s2 distinct
        expect(f.first_seen).toBe("2026-06-01T00:00:00.000Z");
        expect(f.last_seen).toBe("2026-06-03T00:00:00.000Z");
    });

    test("files sorted by last_seen desc", async () => {
        const db = makeMockDb([[[
            row({ path: "/u/.claude/projects/p/memory/old.md", ts: "2026-06-01T00:00:00.000Z" }),
            row({ path: "/u/.claude/projects/p/memory/new.md", ts: "2026-06-10T00:00:00.000Z" }),
        ]]]);
        const r = await runWithMock(db, fetchMemoryOps({ sinceDays: 30 }));
        expect(r.files.map((f) => f.slug)).toEqual(["new", "old"]);
    });
});

describe("fetchMemoryOps - totals", () => {
    test("counts ops, distinct notes, index ops, distinct sessions", async () => {
        const db = makeMockDb([[[
            row({ tool: "Write", path: "/u/.claude/projects/p/memory/a.md", session_id: "session:`s1`" }),
            row({ tool: "Write", path: "/u/.claude/projects/p/memory/b.md", session_id: "session:`s1`" }),
            row({ tool: "Edit", path: "/u/.claude/projects/p/memory/MEMORY.md", session_id: "session:`s2`" }),
        ]]]);
        const r = await runWithMock(db, fetchMemoryOps({ sinceDays: 30 }));
        expect(r.totals.ops).toBe(3);
        expect(r.totals.notes).toBe(2); // a, b (MEMORY index excluded)
        expect(r.totals.index_ops).toBe(1);
        expect(r.totals.sessions).toBe(2);
    });
});

describe("fetchMemoryOps - empty + SQL", () => {
    test("handles empty result", async () => {
        const db = cacheReadResults([[]]);
        const r = await runWithCacheRead(fetchMemoryOps({ sinceDays: 30 }), db);
        expect(r.events).toHaveLength(0);
        expect(r.files).toHaveLength(0);
        expect(r.totals.ops).toBe(0);
    });

    // NOTE: the "SQL windows by sinceDays and filters to .claude memory dirs"
    // case that used to sit here asserted NOTHING - it ran the effect against an
    // empty stub and made no `expect` call, so it could not fail whatever the
    // SQL said. The behaviour it claimed to cover is now proven against a real
    // snapshot in memory-ops.duckdb.test.ts, where the predicate is actually
    // evaluated by DuckDB rather than assumed.
});
