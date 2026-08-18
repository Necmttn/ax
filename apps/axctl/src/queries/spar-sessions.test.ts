import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import { fetchSparSessionIds } from "./spar-sessions.ts";

describe("fetchSparSessionIds", () => {
    it("returns the sidecar session ids bare, ready to compare against DuckDB", async () => {
        const ids = await Effect.runPromise(fetchSparSessionIds().pipe(
            Effect.provide(judgmentTestLayer(() => [
                { session_id: "spar-abc" },
                { session_id: "spar-def" },
            ])),
        ));
        // No record wrapper and no `session:` prefix: `invoked.session` and
        // `session.id` are plain VARCHARs, so a caller binds these as-is.
        expect(ids).toEqual(["spar-abc", "spar-def"]);
        expect(ids.every((id) => typeof id === "string")).toBe(true);
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
