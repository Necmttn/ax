/**
 * Unit tests for validateRoleName + validateSkillName in src/lib/role-name.ts.
 */
import { describe, it, expect } from "bun:test";
import {
    validateRoleName,
    validateSkillName,
    ROLE_NAME_RE,
    SKILL_NAME_RE,
} from "./role-name.ts";

// ---------------------------------------------------------------------------
// validateRoleName
// ---------------------------------------------------------------------------

describe("validateRoleName", () => {
    it("accepts simple lowercase name", () => {
        expect(validateRoleName("framing")).toBe("framing");
    });

    it("accepts name with hyphen", () => {
        expect(validateRoleName("code-review")).toBe("code-review");
    });

    it("accepts name with underscore", () => {
        expect(validateRoleName("code_review")).toBe("code_review");
    });

    it("accepts name with digits", () => {
        expect(validateRoleName("phase1")).toBe("phase1");
    });

    it("trims surrounding whitespace", () => {
        expect(validateRoleName("  framing  ")).toBe("framing");
    });

    it("lowercases uppercase input", () => {
        expect(validateRoleName("FRAMING")).toBe("framing");
    });

    it("trims + lowercases together", () => {
        expect(validateRoleName("  Execution  ")).toBe("execution");
    });

    it("throws on empty string", () => {
        expect(() => validateRoleName("")).toThrow(/invalid role name/);
    });

    it("throws on whitespace-only string", () => {
        expect(() => validateRoleName("   ")).toThrow(/invalid role name/);
    });

    it("throws on name starting with digit", () => {
        expect(() => validateRoleName("1framing")).toThrow(/invalid role name/);
    });

    it("throws on name containing backtick", () => {
        expect(() => validateRoleName("fra`ming")).toThrow(/invalid role name/);
    });

    it("throws on name containing semicolon", () => {
        expect(() => validateRoleName("framing;drop table role")).toThrow(/invalid role name/);
    });

    it("throws on name containing newline", () => {
        expect(() => validateRoleName("framing\nexecution")).toThrow(/invalid role name/);
    });

    it("throws on name containing null byte", () => {
        expect(() => validateRoleName("framing\x00")).toThrow(/invalid role name/);
    });

    it("throws on name with colon (colons not allowed in role names)", () => {
        expect(() => validateRoleName("superpowers:framing")).toThrow(/invalid role name/);
    });

    it("ROLE_NAME_RE.source matches the thrown message", () => {
        try {
            validateRoleName("bad name with spaces");
            expect(true).toBe(false); // unreachable
        } catch (e) {
            expect((e as Error).message).toContain(ROLE_NAME_RE.source);
        }
    });
});

// ---------------------------------------------------------------------------
// validateSkillName
// ---------------------------------------------------------------------------

describe("validateSkillName", () => {
    it("accepts simple bare name", () => {
        expect(validateSkillName("tdd")).toBe("tdd");
    });

    it("accepts plugin-namespaced name", () => {
        expect(validateSkillName("superpowers:tdd")).toBe("superpowers:tdd");
    });

    it("accepts name with hyphens", () => {
        expect(validateSkillName("ax-extract-workflow")).toBe("ax-extract-workflow");
    });

    it("accepts name with underscores", () => {
        expect(validateSkillName("ax_extract")).toBe("ax_extract");
    });

    it("accepts mixed case (skill names are case-sensitive)", () => {
        expect(validateSkillName("MySkill")).toBe("MySkill");
    });

    it("trims surrounding whitespace", () => {
        expect(validateSkillName("  tdd  ")).toBe("tdd");
    });

    it("does NOT lowercase (skill names are case-sensitive)", () => {
        expect(validateSkillName("TDD")).toBe("TDD");
    });

    it("throws on empty string", () => {
        expect(() => validateSkillName("")).toThrow(/invalid skill name/);
    });

    it("throws on whitespace-only string", () => {
        expect(() => validateSkillName("   ")).toThrow(/invalid skill name/);
    });

    it("throws on name containing backtick", () => {
        expect(() => validateSkillName("skill`name")).toThrow(/invalid skill name/);
    });

    it("throws on name containing semicolon", () => {
        expect(() => validateSkillName("skill;drop")).toThrow(/invalid skill name/);
    });

    it("throws on name with two colons (only one namespace separator allowed)", () => {
        expect(() => validateSkillName("a:b:c")).toThrow(/invalid skill name/);
    });

    it("throws on name starting with colon", () => {
        expect(() => validateSkillName(":skill")).toThrow(/invalid skill name/);
    });

    it("throws on name ending with colon", () => {
        expect(() => validateSkillName("plugin:")).toThrow(/invalid skill name/);
    });

    it("throws on name with spaces", () => {
        expect(() => validateSkillName("my skill")).toThrow(/invalid skill name/);
    });

    it("SKILL_NAME_RE.source matches the thrown message", () => {
        try {
            validateSkillName("bad name!");
            expect(true).toBe(false); // unreachable
        } catch (e) {
            expect((e as Error).message).toContain(SKILL_NAME_RE.source);
        }
    });
});
