import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestCacheRead } from "@ax/lib/testing/cache";
import { fetchSessionShareTurns } from "./session-share-queries.ts";

describe("fetchSessionShareTurns", () => {
    test("reports the total and truncation when the 2000-row cap applies", async () => {
        const rows = Array.from({ length: 2_000 }, (_, index) => ({
            id: `turn-${index}`,
            seq: index + 1,
            ts: "2026-08-01T00:00:00.000Z",
            role: "user",
            message_kind: "task",
            intent_kind: null,
            text: `turn ${index + 1}`,
            text_excerpt: null,
            has_tool_use: false,
            has_error: false,
        }));
        const { service } = makeTestCacheRead({
            routes: {
                "COUNT(*) AS total_turns": [{ total_turns: 2_001 }],
                "FROM turn": rows,
            },
        });
        const result = await Effect.runPromise(fetchSessionShareTurns(service, "share-session"));
        expect(result.turns).toHaveLength(2_000);
        expect(result.totalTurns).toBe(2_001);
        expect(result.truncated).toBe(true);
    });
});
