import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { RecordId } from "surrealdb";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import { fetchSparSessionIds } from "./spar-sessions.ts";

describe("fetchSparSessionIds", () => {
    it("converts sidecar session labels to cache RecordIds", async () => {
        const ids = await Effect.runPromise(fetchSparSessionIds().pipe(
            Effect.provide(judgmentTestLayer(() => [
                { session_id: "spar-abc" },
                { session_id: "spar-def" },
            ])),
        ));
        expect(ids).toHaveLength(2);
        expect(ids.every((id) => id instanceof RecordId)).toBe(true);
        expect(ids.map(String)).toEqual(["session:⟨spar-abc⟩", "session:⟨spar-def⟩"]);
    });

    it("uses the session_label table and spar filter", async () => {
        const seen: string[] = [];
        await Effect.runPromise(fetchSparSessionIds().pipe(
            Effect.provide(judgmentTestLayer((sql) => {
                seen.push(sql);
                return [];
            })),
        ));
        expect(seen[0]).toContain("FROM session_label");
        expect(seen[0]).toContain("label = ?");
    });
});
