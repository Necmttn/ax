import { describe, expect, test } from "bun:test";
import { SkillName } from "@ax/lib/brands";
import {
    OPENCODE_SKILL_LOAD_REASON,
    openCodeLoadedSkillName,
    resolveOpenCodeCatalogSkills,
    type OpenCodeExtract,
} from "./opencode.ts";

describe("openCodeLoadedSkillName (#746)", () => {
    test("reads the skill the `skill` tool loaded", () => {
        expect(openCodeLoadedSkillName("skill", { name: "kubuntu" })).toBe("kubuntu");
        expect(openCodeLoadedSkillName("skill", { name: "  podman  " })).toBe("podman");
    });

    test("ignores every other tool", () => {
        expect(openCodeLoadedSkillName("bash", { name: "kubuntu" })).toBeNull();
        expect(openCodeLoadedSkillName("task", { name: "kubuntu" })).toBeNull();
    });

    test("ignores a skill call with no usable name", () => {
        expect(openCodeLoadedSkillName("skill", {})).toBeNull();
        expect(openCodeLoadedSkillName("skill", { name: "" })).toBeNull();
        expect(openCodeLoadedSkillName("skill", { name: 3 })).toBeNull();
        expect(openCodeLoadedSkillName("skill", null)).toBeNull();
        expect(openCodeLoadedSkillName("skill", "kubuntu")).toBeNull();
    });
});

const extractWith = (
    invocations: OpenCodeExtract["invocations"],
    skillRelations: OpenCodeExtract["skillRelations"],
): OpenCodeExtract => ({
    sessions: [],
    turns: [],
    providerEvents: [],
    toolCalls: [],
    invocations,
    skillRelations,
    compactions: [],
    skipped: 0,
    warnings: [],
});

describe("resolveOpenCodeCatalogSkills", () => {
    const relation = (skillName: string, reason: string) => ({
        toolCallKey: "tc1",
        skillName: SkillName.make(skillName),
        ts: "2026-08-05T00:00:00.000Z",
        reason,
        labels: {},
        metrics: {},
    });
    const invocation = (skill: string, catalogSkill?: boolean) => ({
        session: "s1",
        seq: 1,
        ts: "2026-08-05T00:00:00.000Z",
        skill: SkillName.make(skill),
        args: {},
        ...(catalogSkill ? { catalogSkill: true } : {}),
    });

    test("maps a bare skill-tool load onto its namespaced catalog name", () => {
        const out = resolveOpenCodeCatalogSkills(
            extractWith(
                [invocation("systematic-debugging", true)],
                [relation("systematic-debugging", OPENCODE_SKILL_LOAD_REASON)],
            ),
            new Set(["superpowers:systematic-debugging"]),
        );
        expect(String(out.invocations[0]!.skill)).toBe("superpowers:systematic-debugging");
        expect(String(out.skillRelations[0]!.skillName)).toBe("superpowers:systematic-debugging");
    });

    test("leaves synthetic provider-tool skills alone", () => {
        // The bare-name rule would otherwise fold `opencode:bash` into a real
        // skill named `bash`, merging tool telemetry into skill usage.
        const out = resolveOpenCodeCatalogSkills(
            extractWith(
                [invocation("opencode:bash")],
                [relation("opencode:bash", "OpenCode tool part")],
            ),
            new Set(["bash"]),
        );
        expect(String(out.invocations[0]!.skill)).toBe("opencode:bash");
        expect(String(out.skillRelations[0]!.skillName)).toBe("opencode:bash");
    });

    test("keeps the recorded name when the catalog has no match", () => {
        const out = resolveOpenCodeCatalogSkills(
            extractWith([invocation("kubuntu", true)], []),
            new Set(["podman"]),
        );
        expect(String(out.invocations[0]!.skill)).toBe("kubuntu");
    });

    test("is a no-op against an empty catalog", () => {
        const input = extractWith([invocation("kubuntu", true)], []);
        expect(resolveOpenCodeCatalogSkills(input, new Set())).toBe(input);
    });
});
