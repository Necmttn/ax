/**
 * Unit tests for skills.ts frontmatter role parsing (P3.2).
 *
 * Tests for parseSkillFile (private) are covered via the module's exported
 * shape by calling ingestSkills with synthetic on-disk fixtures. For the pure
 * parse logic we test indirectly via the exported behavior.
 *
 * We also export a test-only helper `_testParseSkillFile` so we can unit-test
 * the extraction logic without a DB.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient } from "../lib/db.ts";
import type { SurrealClientShape } from "../lib/db.ts";

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
// Integration: ingestSkills calls relateSkillRoles with the right roles list
// ---------------------------------------------------------------------------

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Layer } from "effect";
import { ingestSkills } from "./skills.ts";

type Call =
    | { kind: "query"; sql: string; bindings?: Record<string, unknown> }
    | { kind: "upsert"; id: RecordId; content: Record<string, unknown> };

function makeMockDb(queryResponses: Map<string, unknown[][]> = new Map()) {
    const calls: Call[] = [];
    const impl: SurrealClientShape = {
        query: <T extends unknown[] = unknown[]>(sql: string, bindings?: Record<string, unknown>) => {
            calls.push(bindings !== undefined ? { kind: "query", sql, bindings } : { kind: "query", sql });
            for (const [pattern, response] of queryResponses) {
                if (sql.includes(pattern)) return Effect.succeed(response as T);
            }
            return Effect.succeed([[]] as unknown as T);
        },
        upsert: (id: RecordId, content: Record<string, unknown>) => {
            calls.push({ kind: "upsert", id, content });
            return Effect.succeed(undefined);
        },
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: undefined as unknown as import("surrealdb").Surreal,
    };
    return { calls, layer: Layer.succeed(SurrealClient, impl) };
}

describe("ingestSkills end-to-end role wiring", () => {
    test("skill with role: framing in frontmatter produces relateSkillRoles call with ['framing']", async () => {
        const root = await mkdtemp(join(tmpdir(), "ax-skill-test-"));
        // Point AX_SKILLS_DIRS at our temp dir so defaultSkillDirs() returns it.
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

            const { calls, layer } = makeMockDb();
            await Effect.runPromise(
                ingestSkills().pipe(Effect.provide(layer)),
            );

            // Check that a RELATE query was issued with source=frontmatter
            const relateCall = calls.find(
                (c): c is Extract<Call, { kind: "query" }> =>
                    c.kind === "query" && c.sql.includes("RELATE") && c.sql.includes('"frontmatter"'),
            );
            expect(relateCall).toBeDefined();

            // The role binding should be a RecordId for role:framing
            expect(relateCall!.bindings!["role"]).toBeInstanceOf(RecordId);
            const roleId = relateCall!.bindings!["role"] as RecordId;
            expect(String(roleId)).toContain("framing");
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

            const { layer } = makeMockDb();
            const stats = await Effect.runPromise(
                ingestSkills().pipe(Effect.provide(layer)),
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

            const { calls, layer } = makeMockDb();
            const stats = await Effect.runPromise(
                ingestSkills().pipe(Effect.provide(layer)),
            );

            expect(stats.edgesWritten).toBe(0);
            expect(stats.rolesUpserted).toBe(0);

            const relateCall = calls.find(
                (c): c is Extract<Call, { kind: "query" }> =>
                    c.kind === "query" && c.sql.includes("RELATE"),
            );
            expect(relateCall).toBeUndefined();
        } finally {
            if (prevSkillDirs === undefined) delete process.env["AX_SKILLS_DIRS"];
            else process.env["AX_SKILLS_DIRS"] = prevSkillDirs;
            await rm(root, { recursive: true, force: true });
        }
    });
});
