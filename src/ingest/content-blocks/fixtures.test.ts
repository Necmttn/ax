import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decideMarkdownParser, parseAcceptedMarkdown, type ParsedAtom, type ParsedBlock } from "./parse-markdown.ts";

const ROOT = import.meta.dir;

async function readFixture(path: string): Promise<string> {
    return readFile(join(ROOT, "fixtures", path), "utf8");
}

async function readGolden<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(join(ROOT, "golden", path), "utf8")) as T;
}

function projectBlocks(blocks: readonly ParsedBlock[]) {
    return blocks.map((block) => ({
        kind: block.kind,
        heading: block.heading,
    }));
}

function projectAtoms(atoms: readonly ParsedAtom[]) {
    return atoms.map((atom) => ({
        kind: atom.kind,
        value: atom.value,
        normalized: atom.normalized,
        checked: typeof atom.raw?.["checked"] === "boolean" ? atom.raw["checked"] : undefined,
    }));
}

function expectSemanticItems(
    actual: readonly Record<string, unknown>[],
    expected: readonly Record<string, unknown>[],
) {
    for (const item of expected) {
        expect(actual).toContainEqual(expect.objectContaining(item));
    }
}

describe("content block fixture corpus", () => {
    const acceptedCases = [
        {
            name: "GSD plan",
            fixture: "artifacts/gsd/plan.accepted.input.md",
            sourcePath: ".planning/quick/62-fix-backend-types/62-PLAN.md",
            blocks: "artifacts/gsd/plan.blocks.json",
            atoms: "artifacts/gsd/plan.atoms.json",
            artifactKind: "gsd_plan",
        },
        {
            name: "GSD state",
            fixture: "artifacts/gsd/state.accepted.input.md",
            sourcePath: ".planning/STATE.md",
            blocks: "artifacts/gsd/state.blocks.json",
            atoms: "artifacts/gsd/state.atoms.json",
            artifactKind: "gsd_state",
        },
        {
            name: "GSD verification",
            fixture: "artifacts/gsd/verification.accepted.input.md",
            sourcePath: ".planning/quick/62-fix-backend-types/62-VERIFICATION.md",
            blocks: "artifacts/gsd/verification.blocks.json",
            atoms: "artifacts/gsd/verification.atoms.json",
            artifactKind: "gsd_verification",
        },
        {
            name: "SKILL.md",
            fixture: "artifacts/skills/skill.accepted.input.md",
            sourcePath: "/tmp/skills/diagnose/SKILL.md",
            blocks: "artifacts/skills/skill.blocks.json",
            atoms: "artifacts/skills/skill.atoms.json",
            artifactKind: "skill",
        },
    ] as const;

    for (const c of acceptedCases) {
        test(`${c.name} accepted fixture matches semantic golden output`, async () => {
            const text = await readFixture(c.fixture);
            const decision = decideMarkdownParser({ path: c.sourcePath, text });
            expect(decision).toMatchObject({ decision: "accept" });

            const parsed = parseAcceptedMarkdown({ path: c.sourcePath, text });
            expect(parsed.artifactKind).toBe(c.artifactKind);
            expect(parsed.parserVersion).toBe("fixture-scaffold-v1");

            expectSemanticItems(
                projectBlocks(parsed.blocks),
                await readGolden<readonly Record<string, unknown>[]>(c.blocks),
            );
            expectSemanticItems(
                projectAtoms(parsed.atoms),
                await readGolden<readonly Record<string, unknown>[]>(c.atoms),
            );
        });
    }

    test("ordinary markdown is rejected by MVP artifact parsers", async () => {
        const text = await readFixture("artifacts/gsd/generic.rejected.input.md");
        const decision = decideMarkdownParser({ path: "notes/weekend.md", text });
        expect(decision).toMatchObject({
            decision: "reject",
            reason: expect.stringContaining("none:"),
        });
    });

    test("markdown that mentions SKILL.md is rejected when the path is not a skill file", async () => {
        const text = await readFixture("artifacts/skills/not-skill.rejected.input.md");
        const decision = decideMarkdownParser({ path: "docs/diagnose-notes.md", text });
        expect(decision).toMatchObject({
            decision: "reject",
            reason: expect.stringContaining("none:"),
        });
    });
});
