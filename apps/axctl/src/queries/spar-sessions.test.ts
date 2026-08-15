import { describe, expect, test } from "bun:test";
import { cacheReadResults, runWithCacheRead } from "../testing/cache-read.ts";
import { fetchSparSessionIds } from "./spar-sessions.ts";

describe("fetchSparSessionIds", () => {
    test("returns DuckDB string ids", async () => {
        const ids = await runWithCacheRead(
            fetchSparSessionIds(),
            cacheReadResults([[{ id: "spar-a" }, { id: "spar-b" }]]),
        );
        expect(ids).toEqual(["spar-a", "spar-b"]);
    });

    test("returns an empty list when no rows match", async () => {
        expect(await runWithCacheRead(fetchSparSessionIds(), cacheReadResults([[]]))).toEqual([]);
    });
});
