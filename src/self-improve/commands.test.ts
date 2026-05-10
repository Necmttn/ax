import { describe, expect, test } from "bun:test";
import { parseSelfImproveArgs } from "./commands.ts";

describe("self improve command args", () => {
    test("guidance next requires json flag for machine output", () => {
        expect(parseSelfImproveArgs("guidance", ["next", "--json"])).toEqual({ command: "guidance-next", json: true });
    });

    test("session summary accepts json flag", () => {
        expect(parseSelfImproveArgs("session", ["summary", "--json"])).toEqual({ command: "session-summary", json: true });
    });

    test("self-improve weekly accepts json flag", () => {
        expect(parseSelfImproveArgs("self-improve", ["weekly", "--json"])).toEqual({ command: "weekly", json: true });
    });
});
