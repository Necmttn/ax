import { describe, expect, it } from "bun:test";
import { axMcpTools } from "./tools.ts";

describe("dojo_agenda MCP tool", () => {
    it("is registered with the expected name + input fields", () => {
        const t = axMcpTools.find((x) => x.name === "dojo_agenda");
        expect(t).toBeDefined();
        expect(Object.keys(t!.inputSchema).sort()).toEqual(["days", "spar"]);
    });
});
