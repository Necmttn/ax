import { describe, expect, test } from "bun:test";
import { countRules, deriveRig, isToolScope, skillSource } from "./rig.ts";

describe("skillSource", () => {
    test("plugin scope -> plugin id", () => {
        expect(skillSource("plugin:superpowers")).toBe("superpowers");
    });
    test("user/project/agents-shared -> local", () => {
        expect(skillSource("user")).toBe("local");
        expect(skillSource("project")).toBe("local");
        expect(skillSource("agents-shared")).toBe("local");
    });
    test("project:<name> scopes never leak the project name", () => {
        expect(skillSource("project:necmttn")).toBe("local");
        expect(skillSource("project-command:secret-client")).toBe("local");
    });
    test("unknown scopes collapse to local (no passthrough)", () => {
        expect(skillSource("weird")).toBe("local");
    });
});

describe("isToolScope", () => {
    test("harness tool pseudo-skill scopes detected", () => {
        expect(isToolScope("codex-tool")).toBe(true);
        expect(isToolScope("opencode-tool")).toBe(true);
        expect(isToolScope("user")).toBe(false);
        expect(isToolScope("plugin:superpowers")).toBe(false);
    });
});

describe("countRules", () => {
    test("counts markdown list items", () => {
        expect(countRules("# T\n- one\n- two\n  - nested\ntext\n* star")).toBe(4);
    });
    test("empty/whitespace -> 0", () => {
        expect(countRules("")).toBe(0);
    });
});

describe("deriveRig", () => {
    test("assembles skills with source, hooks, routing flag, rules", () => {
        const rig = deriveRig({
            invocations: [
                { skill: "tdd", count: 88 },
                { skill: "my-local", count: 3 },
            ],
            scopes: new Map([
                ["tdd", "plugin:superpowers"],
                ["my-local", "user"],
            ]),
            hookFiles: ["enforce-worktree.ts", "route-dispatch.ts", "guard.test.ts", "notes.md"],
            hasRoutingTable: true,
            rulesMarkdown: "- a\n- b",
        });
        expect(rig).toEqual({
            skills: [
                { name: "tdd", source: "superpowers", runs_30d: 88 },
                { name: "my-local", source: "local", runs_30d: 3 },
            ],
            hooks: ["enforce-worktree", "route-dispatch"],
            routing_table: true,
            rules: { count: 2 },
        });
    });

    test("unknown skill scope -> local; no rules markdown -> rules omitted", () => {
        const rig = deriveRig({
            invocations: [{ skill: "ghost", count: 1 }],
            scopes: new Map(),
            hookFiles: [],
            hasRoutingTable: false,
            rulesMarkdown: null,
        });
        expect(rig.skills[0]!.source).toBe("local");
        expect(rig.rules).toBeUndefined();
    });

    test("tool pseudo-skills (codex-tool / opencode-tool scopes) are excluded", () => {
        const rig = deriveRig({
            invocations: [
                { skill: "codex:exec_command", count: 59_870 },
                { skill: "tdd", count: 88 },
            ],
            scopes: new Map([
                ["codex:exec_command", "codex-tool"],
                ["tdd", "plugin:superpowers"],
            ]),
            hookFiles: [],
            hasRoutingTable: false,
            rulesMarkdown: null,
        });
        expect(rig.skills).toEqual([{ name: "tdd", source: "superpowers", runs_30d: 88 }]);
    });
});
