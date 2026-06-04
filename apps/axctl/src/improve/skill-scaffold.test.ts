import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { kebabCase, scaffoldContent, scaffoldSkill, skillScaffoldFile, type ScaffoldOptions } from "./skill-scaffold.ts";

// scaffoldSkill now returns an Effect requiring FileSystem + Path (migrated to
// @effect/platform); run it against the real Bun-backed layers in tests.
const fsLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const runScaffold = (opts: ScaffoldOptions) =>
    Effect.runPromise(scaffoldSkill(opts).pipe(Effect.provide(fsLayer)));

describe("kebabCase", () => {
    test("downcases + replaces non-alnum + collapses runs", () => {
        expect(kebabCase("Schema Change Guardrail")).toBe("schema-change-guardrail");
        expect(kebabCase("  Multi   Spaces  ")).toBe("multi-spaces");
        expect(kebabCase("SurrealDB: schema/change")).toBe("surrealdb-schema-change");
    });

    test("strips diacritics and trims to 60", () => {
        expect(kebabCase("Café")).toBe("cafe");
        expect(kebabCase("a".repeat(200))).toHaveLength(60);
    });
});

describe("scaffoldContent", () => {
    test("renders frontmatter + behavior + scaffold marker", () => {
        const md = scaffoldContent({
            title: "Schema Change Guardrail",
            hypothesis: "Schema edits need a verification loop.",
            proposedBehavior: "Run schema lint before edit.",
            triggerPattern: "schema file edit",
            expectedImpact: "fewer broken migrations",
            dedupeSig: "skill__abc",
            nowIso: "2026-05-25T00:00:00.000Z",
        });
        expect(md).toContain("name: schema-change-guardrail");
        expect(md).toContain("description: Schema edits need a verification loop.");
        expect(md).toContain("# Schema Change Guardrail");
        expect(md).toContain("Run schema lint before edit.");
        expect(md).toContain("## When to apply");
        expect(md).toContain("schema file edit");
        expect(md).toContain("## Expected impact");
        expect(md).toContain("fewer broken migrations");
        expect(md).toContain("from proposal skill__abc");
    });

    test("omits optional sections when fields are null", () => {
        const md = scaffoldContent({
            title: "Tight",
            hypothesis: "hyp",
            proposedBehavior: "do this",
            dedupeSig: "skill__tight",
            nowIso: "2026-05-25T00:00:00.000Z",
        });
        expect(md).not.toContain("## When to apply");
        expect(md).not.toContain("## Expected impact");
    });
});

describe("scaffoldSkill", () => {
    test("creates SKILL.md under baseDir/<kebab-name>/", async () => {
        const baseDir = mkdtempSync(join(tmpdir(), "ax-scaffold-"));
        try {
            const result = await runScaffold({
                baseDir,
                input: {
                    title: "Demo Skill",
                    hypothesis: "gap",
                    proposedBehavior: "do",
                    dedupeSig: "skill__demo",
                    nowIso: "2026-05-25T00:00:00.000Z",
                },
            });
            expect(result.created).toBe(true);
            expect(result.skipped).toBe(false);
            expect(result.path).toBe(skillScaffoldFile("Demo Skill", baseDir));
            expect(existsSync(result.path)).toBe(true);
            expect(readFileSync(result.path, "utf-8")).toContain("name: demo-skill");
        } finally {
            rmSync(baseDir, { recursive: true, force: true });
        }
    });

    test("refuses to clobber an existing file unless force=true", async () => {
        const baseDir = mkdtempSync(join(tmpdir(), "ax-scaffold-"));
        try {
            const input = {
                title: "Demo",
                hypothesis: "h",
                proposedBehavior: "b",
                dedupeSig: "skill__d",
                nowIso: "2026-05-25T00:00:00.000Z",
            };
            const first = await runScaffold({ baseDir, input });
            expect(first.created).toBe(true);
            const second = await runScaffold({ baseDir, input });
            expect(second.created).toBe(false);
            expect(second.skipped).toBe(true);
            const forced = await runScaffold({ baseDir, input: { ...input, proposedBehavior: "new" }, force: true });
            expect(forced.created).toBe(true);
            expect(readFileSync(forced.path, "utf-8")).toContain("new");
        } finally {
            rmSync(baseDir, { recursive: true, force: true });
        }
    });
});
