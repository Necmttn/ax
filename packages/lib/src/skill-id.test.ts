import { describe, expect, test } from "bun:test";
import { resolveSkillName } from "./skill-id.ts";

describe("resolveSkillName", () => {
    const catalog = new Set<string>([
        "tdd",
        "superpowers:subagent-driven-development",
        "superpowers:systematic-debugging",
        "codex:rescue",
        "caveman:caveman",
        "gsd:plan-phase",
    ]);

    test("exact catalog name resolves to itself", () => {
        expect(resolveSkillName("tdd", catalog)).toBe("tdd");
        expect(resolveSkillName("codex:rescue", catalog)).toBe("codex:rescue");
        expect(resolveSkillName("gsd:plan-phase", catalog)).toBe("gsd:plan-phase");
    });

    test("bare name resolves to its plugin-namespaced row", () => {
        expect(resolveSkillName("subagent-driven-development", catalog)).toBe(
            "superpowers:subagent-driven-development",
        );
        expect(resolveSkillName("systematic-debugging", catalog)).toBe(
            "superpowers:systematic-debugging",
        );
        expect(resolveSkillName("caveman", catalog)).toBe("caveman:caveman");
    });

    test("slash-command hyphen form folds to the namespaced row", () => {
        // `codex-rescue` -> `codex:rescue`
        expect(resolveSkillName("codex-rescue", catalog)).toBe("codex:rescue");
    });

    test("double-prefixed form resolves through the colon segment", () => {
        // `codex:codex-rescue` -> segment `codex-rescue` -> `codex:rescue`
        expect(resolveSkillName("codex:codex-rescue", catalog)).toBe("codex:rescue");
    });

    test("genuinely unknown skill stays unresolved", () => {
        expect(resolveSkillName("totally-made-up-skill", catalog)).toBeNull();
        expect(resolveSkillName("simplify", catalog)).toBeNull();
    });

    test("ambiguous bare name does not mis-attach", () => {
        const ambiguous = new Set<string>(["alpha:loop", "beta:loop"]);
        expect(resolveSkillName("loop", ambiguous)).toBeNull();
    });

    test("exact match wins over a suffix match", () => {
        const both = new Set<string>(["loop", "plugin:loop"]);
        expect(resolveSkillName("loop", both)).toBe("loop");
    });
});
