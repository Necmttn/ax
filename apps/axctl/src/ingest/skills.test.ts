import { describe, expect, test } from "bun:test";
import { extractRoles } from "./skills.ts";

describe("skill frontmatter roles", () => {
    test("accepts and normalizes one role", () => {
        expect(extractRoles({ role: "  Framing  " })).toEqual(["framing"]);
    });

    test("accepts and normalizes a role list", () => {
        expect(extractRoles({ role: ["Framing", " Execution "] })).toEqual(["framing", "execution"]);
    });

    test("drops absent and invalid roles", () => {
        expect(extractRoles({})).toEqual([]);
        expect(extractRoles({ role: null })).toEqual([]);
        expect(extractRoles({ role: { framing: true } })).toEqual([]);
    });

    test("drops invalid list entries", () => {
        expect(extractRoles({ role: ["framing", 42, null, "", "execution"] })).toEqual([
            "framing",
            "execution",
        ]);
    });
});
