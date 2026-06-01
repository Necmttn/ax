import { describe, expect, test } from "bun:test";
import { defineQuery, defineSingleQuery } from "./query.ts";

const hits = defineQuery({
    name: "demo.hits",
    sql: () => "SELECT * FROM x;",
    mapRow: (row) => ({ id: String(row.id ?? "") }),
});

describe("defineQuery", () => {
    test("carries name, sql, and a row-mapper", () => {
        expect(hits.name).toBe("demo.hits");
        expect(hits.sql({})).toBe("SELECT * FROM x;");
        expect(hits.mapRow({ id: 7 }, 0)).toEqual({ id: "7" });
    });
});

describe("defineSingleQuery", () => {
    test("flag marks it single-row", () => {
        const one = defineSingleQuery({
            name: "demo.one",
            sql: () => "SELECT * FROM x LIMIT 1;",
            mapRow: (row) => ({ id: String(row.id ?? "") }),
        });
        expect(one.single).toBe(true);
    });
});
