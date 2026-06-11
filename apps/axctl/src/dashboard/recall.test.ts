import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeMockDb } from "@ax/lib/testing/surreal";
import { RECALL_COUNT_SQL, RECALL_TURNS_SQL } from "../queries/recall.ts";
import { fetchRecall } from "./recall.ts";

describe("recall pagination", () => {
    test("RECALL_TURNS_SQL uses parameterised offset/limit", () => {
        const sql = RECALL_TURNS_SQL("");
        expect(sql).toMatch(/START \$offset/);
        expect(sql).toMatch(/LIMIT \$limit/);
        // sanity-check the WHERE filters still parameterise q/project/since.
        expect(sql).toMatch(/text_excerpt @@ \$q/);
    });

    test("RECALL_COUNT_SQL shares the same WHERE filter set", () => {
        const sql = RECALL_COUNT_SQL("AND session IN [session:a]");
        expect(sql).toMatch(/count\(\) AS total/);
        expect(sql).toMatch(/text_excerpt @@ \$q/);
        expect(sql).toMatch(/AND session IN \[session:a\]/);
        // Counts must not constrain by the window itself.
        expect(sql).not.toMatch(/\$offset/);
        expect(sql).not.toMatch(/\$limit/);
    });
});

describe("recall back-compat: sources=turn (default)", () => {
    test("total_count equals turn count when only turns requested", async () => {
        const responses = new Map<string, unknown[][]>([
            ["count() AS total", [[{ total: 7 }]]],
        ]);
        const { layer } = makeMockDb(responses);

        const result = await Effect.runPromise(
            // No sources specified - defaults to ["turn"]
            fetchRecall({ q: "auth" }).pipe(Effect.provide(layer)),
        );

        expect(result.total_counts.commit).toBe(0);
        expect(result.total_counts.skill).toBe(0);
        // Back-compat: total_count == turn count when only turns requested
        expect(result.total_count).toBe(result.total_counts.turn);
    });
});
