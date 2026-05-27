import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFiles, type LintTarget } from "./lint.ts";

const make = () => {
    const root = mkdtempSync(join(tmpdir(), "ax-lint-"));
    mkdirSync(join(root, "skills", "foo"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# user file");
    writeFileSync(join(root, "AGENTS.md"), "# agents file");
    writeFileSync(join(root, "skills", "foo", "SKILL.md"), "---\n---\nbody");
    writeFileSync(join(root, "agents", "bar.md"), "---\n---\nprompt");
    return root;
};

describe("discoverFiles", () => {
    test("walks the given roots and returns categorized targets", () => {
        const root = make();
        const out = discoverFiles({ roots: [root] });
        const paths = out.map((t: LintTarget) => t.path).sort();
        expect(paths).toContain(join(root, "CLAUDE.md"));
        expect(paths).toContain(join(root, "AGENTS.md"));
        expect(paths).toContain(join(root, "skills", "foo", "SKILL.md"));
    });

    test("tags each target with form=guidance/skill/subagent", () => {
        const root = make();
        const out = discoverFiles({ roots: [root] });
        const claude = out.find((t) => t.path.endsWith("CLAUDE.md"));
        expect(claude?.form).toBe("guidance");
        const skill = out.find((t) => t.path.endsWith("SKILL.md"));
        expect(skill?.form).toBe("skill");
    });
});
