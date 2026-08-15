import { describe, expect, test } from "bun:test";
import { cacheReadResults, runWithCacheRead } from "../testing/cache-read.ts";
import { fetchSparSessionIds } from "./spar-sessions.ts";

describe("fetchSparSessionIds", () => {
    test("returns DuckDB string ids", async () => {
        const ids = await runWithCacheRead(
            fetchSparSessionIds(),
            cacheReadResults([[{ id: "session:spar-a" }, { id: "session:spar-b" }]]),
        );
        expect(ids).toEqual(["session:spar-a", "session:spar-b"]);
    });

    test("returns an empty list when no rows match", async () => {
        expect(await runWithCacheRead(fetchSparSessionIds(), cacheReadResults([[]]))).toEqual([]);
    });
});
