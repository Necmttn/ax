import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { tmpdir } from "node:os";

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


test("setup executes only a successfully downloaded and approved installer", () => {
    const text = readFileSync(join(skillsDir, "setup", "SKILL.md"), "utf8");
    const script = text.match(/```bash\n([\s\S]*?)```/)![1]!;
    const root = mkdtempSync(join(tmpdir(), "ax-setup-security-"));
    try {
        const bin = join(root, "bin");
        const temporary = join(root, "temporary");
        mkdirSync(bin);
        mkdirSync(temporary);
        writeFileSync(join(bin, "curl"), `#!/bin/sh
[ "$DOWNLOAD" = ok ] || exit 22
while [ "$1" != -o ]; do shift; done
shift
printf '%s\n' '#!/bin/sh' 'printf installed > "$RESULT_FILE"' > "$1"
`, { mode: 0o755 });
        writeFileSync(join(bin, "less"), '#!/bin/sh\n[ "$REVIEW" = ok ]\n', { mode: 0o755 });
        for (const [download, review, answer, success] of [
            ["fail", "ok", "yes\n", false], ["ok", "fail", "yes\n", false],
            ["ok", "ok", "no\n", false], ["ok", "ok", "", false], ["ok", "ok", "yes\n", true],
        ] as const) {
            const resultFile = join(root, "installed");
            const result = Bun.spawnSync(["/bin/bash", "-c", script], {
                stdin: Buffer.from(answer),
                env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary,
                    DOWNLOAD: download, REVIEW: review, RESULT_FILE: resultFile },
            });
            expect(result.exitCode === 0).toBe(success);
            expect(existsSync(resultFile)).toBe(success);
            expect(readdirSync(temporary)).toEqual([]);
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});
