import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const skillsDir = join(import.meta.dir, "../../../skills");

describe("shipped skill safety", () => {
    test("every skill frontmatter parses as YAML", () => {
        for (const name of readdirSync(skillsDir, { withFileTypes: true })) {
            if (!name.isDirectory()) continue;
            const file = join(skillsDir, name.name, "SKILL.md");
            const text = readFileSync(file, "utf8");
            const match = text.match(/^---\n([\s\S]*?)\n---/);
            expect(match, name.name).not.toBeNull();
            const frontmatter = YAML.parse(match![1]!);
            expect(frontmatter, name.name).toBeObject();
            expect(frontmatter.name, name.name).toBeString();
            expect(frontmatter.description, name.name).toBeString();
        }
    });

    test("setup does not pipe a remote script to a shell or auto-delete", () => {
        const text = readFileSync(join(skillsDir, "setup", "SKILL.md"), "utf8");
        expect(text).not.toMatch(/curl[^\n|]*\|\s*(ba)?sh/);
        expect(text).not.toMatch(/wget[^\n|]*\|\s*(ba)?sh/);
        expect(text).toContain("does not publish a checksum for install.sh");
        expect(text).toMatch(/Execute this installer\?/);
        expect(text).not.toMatch(/\brm\s+-rf\b/);
    });

    test("dojo does not require a SurrealDB daemon", () => {
        const text = readFileSync(join(skillsDir, "dojo", "SKILL.md"), "utf8");
        expect(text).not.toMatch(/local SurrealDB running/i);
        expect(text).toContain("embedded DuckDB");
        expect(text).toContain("no database daemon is required");
    });
});
