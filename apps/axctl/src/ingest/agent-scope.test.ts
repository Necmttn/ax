import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { buildScopeMap, loadAgentScopeMap, skillsForAgent } from "./agent-scope.ts";

const agent = (skills: string[]) =>
    `---\nname: x\ntools: Read, Bash\nskills:\n${skills.map((s) => `  - ${s}`).join("\n")}\n---\nbody`;

describe("skillsForAgent", () => {
    test("extracts the skills frontmatter list", () => {
        expect(skillsForAgent(agent(["build-tam", "clay-to-deepline"]))).toEqual([
            "build-tam",
            "clay-to-deepline",
        ]);
    });

    test("no frontmatter → empty", () => {
        expect(skillsForAgent("just a body, no fence")).toEqual([]);
    });

    test("frontmatter without skills key → empty", () => {
        expect(skillsForAgent("---\nname: x\ntools: Read\n---\nbody")).toEqual([]);
    });

    test("drops non-string / empty entries", () => {
        expect(skillsForAgent("---\nskills:\n  - ok\n  - 42\n  - ''\n---\n")).toEqual(["ok"]);
    });

    test("malformed yaml → empty, no throw", () => {
        expect(skillsForAgent("---\nskills: [unterminated\n---\n")).toEqual([]);
    });
});

describe("buildScopeMap", () => {
    test("maps each skill to its agent(s), sorted and deduped", () => {
        const map = buildScopeMap([
            { name: "gtm-prospector", content: agent(["build-tam", "cta-design"]) },
            { name: "design-curator", content: agent(["cta-design", "brandkit"]) },
        ]);
        expect(map.get("build-tam")).toEqual(["gtm-prospector"]);
        expect(map.get("cta-design")).toEqual(["design-curator", "gtm-prospector"]);
        expect(map.get("brandkit")).toEqual(["design-curator"]);
        expect(map.has("nope")).toBe(false);
    });
});

describe("loadAgentScopeMap", () => {
    test("reads .md agent files from a dir, ignores non-md", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-agents-"));
        await writeFile(join(dir, "gtm-prospector.md"), agent(["build-tam"]));
        await writeFile(join(dir, "notes.txt"), agent(["should-be-ignored"]));
        const map = await Effect.runPromise(loadAgentScopeMap([dir]));
        expect(map.get("build-tam")).toEqual(["gtm-prospector"]);
        expect(map.has("should-be-ignored")).toBe(false);
    });

    test("missing dir → empty map, no defect", async () => {
        const map = await Effect.runPromise(
            loadAgentScopeMap([join(tmpdir(), "ax-nope-does-not-exist")]),
        );
        expect(map.size).toBe(0);
    });
});
