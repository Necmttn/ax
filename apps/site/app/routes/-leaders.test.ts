import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("leaders trending skills", () => {
    test("links rows to the validated skill adoption route", () => {
        const src = readFileSync(new URL("./leaders.tsx", import.meta.url), "utf8");

        expect(src).toContain("skillRouteKey");
        expect(src).toContain('to="/skills/$key"');
        expect(src).toContain("params={{ key: skillRouteKey(name, s) }}");
    });
});
