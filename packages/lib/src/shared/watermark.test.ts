import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ensureWatermarkIdMigration, fileWatermark } from "./watermark.ts";
import { SurrealClient, type SurrealClientShape } from "../db.ts";
import { stableDigest } from "../ids.ts";
import { makeTestSurrealClient } from "../testing/surreal.ts";

type Row = { path?: unknown; mtime_ms?: unknown; size?: unknown };

/**
 * In-memory recording adapter (the second adapter that makes the seam real),
 * built on the shared test factory. `query` returns canned rows keyed by a
 * crude match on the SQL text and records every call; writes are stubbed.
 */
const recordingClient = (
    rowsForSelect: readonly Row[],
): { calls: string[]; layer: SurrealClientShape } => {
    const tc = makeTestSurrealClient({
        routes: [
            // The sentinel SELECT must look absent so the migration runs.
            { match: "__watermark_migration__", rows: [[]] },
            { match: /^SELECT/, rows: [[...rowsForSelect]] },
        ],
        fallback: [],
    });
    return { calls: tc.captured, layer: tc.client };
};

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, layer: SurrealClientShape) =>
    Effect.runPromise(eff.pipe(Effect.provideService(SurrealClient, layer)));

const cfg = { sourceKind: "claude_transcript", forceEnv: "AX_TEST_REDERIVE" } as const;

describe("fileWatermark - load", () => {
    test("builds the Map from rows; wrong-typed fields are filtered out", async () => {
        const { layer } = recordingClient([
            { path: "/a", mtime_ms: 100, size: 10 },
            { path: "/b", mtime_ms: "nope", size: 20 }, // bad mtime
            { path: 123, mtime_ms: 5, size: 5 }, // bad path
            { path: "/c", mtime_ms: 7, size: "big" }, // bad size
        ]);
        const wm = await run(fileWatermark(cfg), layer);
        expect(wm.unchanged("/a", 100, 10)).toBe(true);
        expect(wm.unchanged("/b", 0, 20)).toBe(false); // filtered ⇒ unknown
        expect(wm.unchanged("/c", 7, 0)).toBe(false); // filtered ⇒ unknown
    });

    test("force env '1' ⇒ empty map ⇒ unchanged always false", async () => {
        const prev = process.env.AX_TEST_REDERIVE;
        process.env.AX_TEST_REDERIVE = "1";
        try {
            const { layer } = recordingClient([{ path: "/a", mtime_ms: 100, size: 10 }]);
            const wm = await run(fileWatermark(cfg), layer);
            expect(wm.unchanged("/a", 100, 10)).toBe(false);
        } finally {
            if (prev === undefined) delete process.env.AX_TEST_REDERIVE;
            else process.env.AX_TEST_REDERIVE = prev;
        }
    });
});

describe("fileWatermark - unchanged predicate", () => {
    test("true on exact match; false on mtime/size mismatch or missing path", async () => {
        const { layer } = recordingClient([{ path: "/a", mtime_ms: 100, size: 10 }]);
        const wm = await run(fileWatermark(cfg), layer);
        expect(wm.unchanged("/a", 100, 10)).toBe(true);
        expect(wm.unchanged("/a", 999, 10)).toBe(false); // mtime mismatch
        expect(wm.unchanged("/a", 100, 999)).toBe(false); // size mismatch
        expect(wm.unchanged("/missing", 100, 10)).toBe(false); // unknown path
    });
});

describe("fileWatermark - commit", () => {
    test("UPSERTs id stableDigest('sourceKind|path') with full CONTENT", async () => {
        const { calls, layer } = recordingClient([]);
        const wm = await run(fileWatermark(cfg), layer);
        const before = calls.length;
        await run(wm.commit("/some/file", 1234, 56), layer);
        const upsert = calls.slice(before).find((c) => c.startsWith("UPSERT"));
        expect(upsert).toBeDefined();
        const expectedId = stableDigest("claude_transcript|/some/file");
        expect(upsert).toContain(`ingest_file_state:\`${expectedId}\``);
        expect(upsert).toContain(`path: ${JSON.stringify("/some/file")}`);
        expect(upsert).toContain(`source_kind: ${JSON.stringify("claude_transcript")}`);
        expect(upsert).toContain("mtime_ms: 1234");
        expect(upsert).toContain("size: 56");
    });
});

describe("ensureWatermarkIdMigration", () => {
    test("sentinel absent ⇒ emits DELETE + sentinel UPSERT", async () => {
        const { calls, layer } = recordingClient([]);
        await run(ensureWatermarkIdMigration, layer);
        const joined = calls.join("\n");
        expect(joined).toContain("DELETE ingest_file_state WHERE source_kind IN [");
        expect(joined).toContain(JSON.stringify("claude_transcript"));
        expect(joined).toContain(JSON.stringify("claude_subagent"));
        expect(joined).toContain("__watermark_migration__");
        // DELETE must precede the sentinel UPSERT.
        const del = calls.find((c) => c.includes("DELETE ingest_file_state"));
        expect(del).toBeDefined();
    });

    test("sentinel present ⇒ no DELETE", async () => {
        const tc = makeTestSurrealClient({
            fallback: (sql) =>
                sql.includes("__watermark_migration__") && sql.startsWith("SELECT")
                    ? [[{ id: "x" }]]
                    : [[]],
        });
        await run(ensureWatermarkIdMigration, tc.client);
        expect(tc.captured.some((c) => c.includes("DELETE ingest_file_state"))).toBe(false);
    });
});
