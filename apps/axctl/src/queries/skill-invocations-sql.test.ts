import { describe, expect, test } from "bun:test";
import { skillWithInvocationsSql } from "./skill-invocations-sql.ts";

describe("skillWithInvocationsSql", () => {
    test("renders the shared skill-lookup + invocations scaffold", () => {
        const sql = skillWithInvocationsSql({ windows: [7, 30], blocks: [] });
        expect(sql).toContain("LET $s = (SELECT * FROM skill WHERE name = $name)[0];");
        expect(sql).toContain("total: array::len((SELECT * FROM invoked WHERE out = $s.id))");
        expect(sql).toContain(
            "last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts",
        );
    });

    test("only the requested day windows are rendered", () => {
        const sql = skillWithInvocationsSql({ windows: [7, 30], blocks: [] });
        expect(sql).toContain("time::now() - 7d");
        expect(sql).toContain("time::now() - 30d");
        expect(sql).not.toContain("d90:");

        const withD90 = skillWithInvocationsSql({ windows: [7, 30, 90], blocks: [] });
        expect(withD90).toContain("time::now() - 90d");
    });

    test("joins extra RETURN blocks with commas inside the RETURN object", () => {
        const sql = skillWithInvocationsSql({
            windows: [7],
            blocks: ["    a: ( SELECT 1 )", "    b: ( SELECT 2 )"],
        });
        expect(sql).toContain("    a: ( SELECT 1 ),\n    b: ( SELECT 2 )\n};");
    });
});
