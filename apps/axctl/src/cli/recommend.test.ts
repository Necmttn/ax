import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("axctl improve recommend", () => {
    test("--help lists filter flags", () => {
        const source = readFileSync("apps/axctl/src/cli/commands/improve.ts", "utf8");
        const commandBlock = source.slice(
            source.indexOf("const improveRecommendCommand"),
            source.indexOf("const improveLintCommand"),
        );
        expect(commandBlock).toContain('Flag.integer("limit")');
        expect(commandBlock).toContain('Flag.string("form")');
        expect(commandBlock).toContain('Flag.integer("since")');
        // --json uses the shared spec (Flag.boolean("json") + default false) from commands/shared.ts
        expect(commandBlock).toContain("json: jsonFlag");
        expect(commandBlock).toContain('Flag.boolean("no-clipboard")');
    });
});
