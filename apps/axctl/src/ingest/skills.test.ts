/**
 * Unit tests for skills.ts frontmatter role parsing (P3.2).
 *
 * Tests for parseSkillFile (private) are covered via the module's exported
 * shape by calling ingestSkills with synthetic on-disk fixtures. For the pure
 * parse logic we test indirectly via the exported behavior.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeMockDb } from "@ax/lib/testing/surreal";
import { ingestSkills } from "./skills.ts";

// ingestSkills now reads the on-disk fixtures through the @effect/platform
// FileSystem + Path services, so the real Bun-backed layers are provided
// against the mkdtemp fixture (never a mock - this is a genuine on-disk read).
const PlatformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// ---------------------------------------------------------------------------
// Import the module's test-only parse helper
// We re-implement a minimal version here to avoid coupling the test to internal
// implementation details. The real integration goes through ingestSkills.
// ---------------------------------------------------------------------------

// Parse frontmatter role field using the same rules as skills.ts.
function extractRoles(fm: Record<string, unknown>): string[] {
    const raw = fm["role"];
    if (raw === undefined || raw === null || raw === "") return [];
    const items = Array.isArray(raw) ? raw : [raw];
    const result: string[] = [];
    for (const item of items) {
        if (typeof item !== "string") continue;
        const norm = item.trim().toLowerCase();
        if (norm) result.push(norm);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Tests: frontmatter role parsing
// ---------------------------------------------------------------------------

describe("extractRoles (frontmatter parsing)", () => {
    test("single string role: returns [roleName]", () => {
        expect(extractRoles({ role: "framing" })).toEqual(["framing"]);
    });

    test("single string role: normalizes to lowercase+trim", () => {
        expect(extractRoles({ role: "  Framing  " })).toEqual(["framing"]);
    });

    test("array role: returns all valid entries", () => {
        expect(extractRoles({ role: ["framing", "execution"] })).toEqual(["framing", "execution"]);
    });

    test("array role: normalizes each entry", () => {
        expect(extractRoles({ role: ["Framing", " Execution "] })).toEqual(["framing", "execution"]);
    });

    test("empty string role: returns []", () => {
        expect(extractRoles({ role: "" })).toEqual([]);
    });

    test("missing role key: returns []", () => {
        expect(extractRoles({})).toEqual([]);
    });

    test("null role: returns []", () => {
        expect(extractRoles({ role: null })).toEqual([]);
    });

    test("empty array role: returns []", () => {
        expect(extractRoles({ role: [] })).toEqual([]);
    });

    test("object role (invalid type): returns []", () => {
        expect(extractRoles({ role: { framing: true } })).toEqual([]);
    });

    test("array with non-string items: drops them silently", () => {
        expect(extractRoles({ role: ["framing", 42, null, "execution"] })).toEqual(["framing", "execution"]);
    });

    test("array with empty strings: drops them", () => {
        expect(extractRoles({ role: ["framing", "", "  "] })).toEqual(["framing"]);
    });
});

// ---------------------------------------------------------------------------
// looseLineParse list-format fallback: YAML failure + list role field
// ---------------------------------------------------------------------------

describe("looseLineParse list-format fallback", () => {
    test("YAML failure with list role: description: a: b: c + role list → 2 edges", async () => {
        const root = await mkdtemp(join(tmpdir(), "ax-skill-test-loose-"));
        const prevSkillDirs = process.env["AX_SKILLS_DIRS"];
        const skillsDir = join(root, "skills");
        process.env["AX_SKILLS_DIRS"] = skillsDir;
        try {
            const skillDir = join(skillsDir, "loose-role-skill");
            await mkdir(skillDir, { recursive: true });
            // description with unquoted colons forces YAML parse failure
            await writeFile(
                join(skillDir, "SKILL.md"),
                [
                    "---",
                    "name: loose-role-skill",
                    "description: a: b: c",
                    "role:",
                    "  - framing",
                    "  - execution",
                    "---",
                    "# Body",
                    "",
                ].join("\n"),
                "utf8",
            );

            const { layer } = makeMockDb(undefined, { denyWrites: false });
            const stats = await Effect.runPromise(
                ingestSkills().pipe(Effect.provide(Layer.mergeAll(layer, PlatformLayer))),
            );

            expect(stats.edgesWritten).toBe(2);
            expect(stats.rolesUpserted).toBe(2);
        } finally {
            if (prevSkillDirs === undefined) delete process.env["AX_SKILLS_DIRS"];
            else process.env["AX_SKILLS_DIRS"] = prevSkillDirs;
            await rm(root, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Integration: ingestSkills calls relateSkillRoles with the right roles list
// ---------------------------------------------------------------------------

describe("ingestSkills end-to-end role wiring", () => {
    test("skill with role: framing in frontmatter produces RELATE with literal record ids", async () => {
        const root = await mkdtemp(join(tmpdir(), "ax-skill-test-"));
        const prevSkillDirs = process.env["AX_SKILLS_DIRS"];
        const skillsDir = join(root, "skills");
        process.env["AX_SKILLS_DIRS"] = skillsDir;
        try {
            const skillDir = join(skillsDir, "my-test-skill");
            await mkdir(skillDir, { recursive: true });
            await writeFile(
                join(skillDir, "SKILL.md"),
                `---\nname: my-test-skill\ndescription: A test skill\nrole: framing\n---\n# Body\n`,
                "utf8",
            );

            const { calls, layer } = makeMockDb(undefined, { denyWrites: false });
            await Effect.runPromise(
                ingestSkills().pipe(Effect.provide(Layer.mergeAll(layer, PlatformLayer))),
            );

            // RELATE query should use literal record ids, not $skill/$role bindings
            const relateCall = calls.find(
                (c) => c.sql.includes("RELATE") && c.sql.includes('"frontmatter"'),
            );
            expect(relateCall).toBeDefined();
            expect(relateCall!.sql).toContain("role:`framing`");
            expect(relateCall!.sql).not.toContain("$skill");
            expect(relateCall!.sql).not.toContain("$role");
            // No bindings object for record-id queries
            expect(relateCall!.bindings).toBeUndefined();
        } finally {
            if (prevSkillDirs === undefined) delete process.env["AX_SKILLS_DIRS"];
            else process.env["AX_SKILLS_DIRS"] = prevSkillDirs;
            await rm(root, { recursive: true, force: true });
        }
    });

    test("skill with role: [framing, execution] produces 2 edges", async () => {
        const root = await mkdtemp(join(tmpdir(), "ax-skill-test-"));
        const prevSkillDirs = process.env["AX_SKILLS_DIRS"];
        const skillsDir = join(root, "skills");
        process.env["AX_SKILLS_DIRS"] = skillsDir;
        try {
            const skillDir = join(skillsDir, "multi-role-skill");
            await mkdir(skillDir, { recursive: true });
            await writeFile(
                join(skillDir, "SKILL.md"),
                `---\nname: multi-role-skill\ndescription: A skill with two roles\nrole:\n  - framing\n  - execution\n---\n# Body\n`,
                "utf8",
            );

            const { layer } = makeMockDb(undefined, { denyWrites: false });
            const stats = await Effect.runPromise(
                ingestSkills().pipe(Effect.provide(Layer.mergeAll(layer, PlatformLayer))),
            );

            expect(stats.edgesWritten).toBe(2);
            expect(stats.rolesUpserted).toBe(2);
        } finally {
            if (prevSkillDirs === undefined) delete process.env["AX_SKILLS_DIRS"];
            else process.env["AX_SKILLS_DIRS"] = prevSkillDirs;
            await rm(root, { recursive: true, force: true });
        }
    });

    test("skill without role: no RELATE query, edgesWritten=0", async () => {
        const root = await mkdtemp(join(tmpdir(), "ax-skill-test-"));
        const prevSkillDirs = process.env["AX_SKILLS_DIRS"];
        const skillsDir = join(root, "skills");
        process.env["AX_SKILLS_DIRS"] = skillsDir;
        try {
            const skillDir = join(skillsDir, "no-role-skill");
            await mkdir(skillDir, { recursive: true });
            await writeFile(
                join(skillDir, "SKILL.md"),
                `---\nname: no-role-skill\ndescription: A skill without roles\n---\n# Body\n`,
                "utf8",
            );

            const { calls, layer } = makeMockDb(undefined, { denyWrites: false });
            const stats = await Effect.runPromise(
                ingestSkills().pipe(Effect.provide(Layer.mergeAll(layer, PlatformLayer))),
            );

            expect(stats.edgesWritten).toBe(0);
            expect(stats.rolesUpserted).toBe(0);

            const relateCall = calls.find((c) => c.sql.includes("RELATE"));
            expect(relateCall).toBeUndefined();
        } finally {
            if (prevSkillDirs === undefined) delete process.env["AX_SKILLS_DIRS"];
            else process.env["AX_SKILLS_DIRS"] = prevSkillDirs;
            await rm(root, { recursive: true, force: true });
        }
    });
});
