import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { defaultSkillDirs, opencodeSkillDirs } from "./paths.ts";

const savedXdg = process.env.XDG_CONFIG_HOME;
const savedSkillDirs = process.env.AX_SKILLS_DIRS;

afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedSkillDirs === undefined) delete process.env.AX_SKILLS_DIRS;
    else process.env.AX_SKILLS_DIRS = savedSkillDirs;
});

describe("opencodeSkillDirs (#746)", () => {
    test("defaults to ~/.config/opencode and covers both spellings", () => {
        delete process.env.XDG_CONFIG_HOME;
        expect(opencodeSkillDirs().map((d) => d.dir)).toEqual([
            `${homedir()}/.config/opencode/skills`,
            `${homedir()}/.config/opencode/skill`,
        ]);
    });

    test("honors XDG_CONFIG_HOME, as OpenCode itself does", () => {
        process.env.XDG_CONFIG_HOME = "/custom/cfg";
        expect(opencodeSkillDirs().map((d) => d.dir)).toEqual([
            "/custom/cfg/opencode/skills",
            "/custom/cfg/opencode/skill",
        ]);
    });

    test("ignores a blank XDG_CONFIG_HOME rather than rooting at /opencode", () => {
        process.env.XDG_CONFIG_HOME = "   ";
        expect(opencodeSkillDirs()[0]!.dir).toBe(`${homedir()}/.config/opencode/skills`);
    });

    test("scopes rows as opencode", () => {
        expect(new Set(opencodeSkillDirs().map((d) => d.scope))).toEqual(new Set(["opencode"]));
    });
});

describe("defaultSkillDirs", () => {
    test("includes the OpenCode dirs alongside the Claude/agents ones", () => {
        delete process.env.AX_SKILLS_DIRS;
        delete process.env.XDG_CONFIG_HOME;
        const dirs = defaultSkillDirs().map((d) => d.dir);
        expect(dirs).toContain(`${homedir()}/.claude/skills`);
        expect(dirs).toContain(`${homedir()}/.agents/skills`);
        expect(dirs).toContain(`${homedir()}/.config/opencode/skills`);
    });

    test("AX_SKILLS_DIRS stays a full override", () => {
        process.env.AX_SKILLS_DIRS = "/tmp/only";
        expect(defaultSkillDirs()).toEqual([{ dir: "/tmp/only", scope: "user" }]);
    });
});
