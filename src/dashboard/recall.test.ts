import { describe, expect, test } from "bun:test";
import { RECALL_COUNT_SQL, RECALL_TURNS_SQL } from "../queries/recall.ts";

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
