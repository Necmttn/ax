import { describe, expect, it } from "bun:test";
import {
    SUBAGENT_SOURCES,
    isSubagentSource,
    originOfSource,
    codexSourceForThread,
} from "./source-origin.ts";

describe("source-origin", () => {
    it("isSubagentSource: only the -subagent sources", () => {
        expect(isSubagentSource("claude-subagent")).toBe(true);
        expect(isSubagentSource("codex-subagent")).toBe(true);
        expect(isSubagentSource("claude")).toBe(false);
        expect(isSubagentSource("codex")).toBe(false);
        expect(isSubagentSource("pi")).toBe(false);
        expect(isSubagentSource(null)).toBe(false);
        expect(isSubagentSource(undefined)).toBe(false);
    });

    it("originOfSource: subagent vs main", () => {
        expect(originOfSource("codex-subagent")).toBe("subagent");
        expect(originOfSource("claude-subagent")).toBe("subagent");
        expect(originOfSource("codex")).toBe("main");
        expect(originOfSource("claude")).toBe("main");
        expect(originOfSource(null)).toBe("main");
    });

    it("codexSourceForThread: subagent thread -> codex-subagent, else codex", () => {
        expect(codexSourceForThread("subagent")).toBe("codex-subagent");
        expect(codexSourceForThread("user")).toBe("codex");
        expect(codexSourceForThread(null)).toBe("codex");
        expect(codexSourceForThread(undefined)).toBe("codex");
        expect(codexSourceForThread("something-else")).toBe("codex");
    });

    it("SUBAGENT_SOURCES covers both providers", () => {
        expect([...SUBAGENT_SOURCES]).toEqual(["claude-subagent", "codex-subagent"]);
    });
});
