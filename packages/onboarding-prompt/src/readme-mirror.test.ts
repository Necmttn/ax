/**
 * The README's setup-prompt block is a MANUAL MIRROR of this package, and it
 * drifted. This test is the gate that should have existed.
 *
 * README.md cannot import TypeScript, so the prompt is pasted into a ```text
 * fence with a comment naming the regeneration command. Nothing compared the
 * two, so when the v2 migration rewrote the prompt's PRIVACY paragraph
 * ("...into a local DuckDB cache file on my machine"), the README kept the v1
 * text ("...into a SurrealDB on 127.0.0.1") and kept telling every reader of
 * the project's landing page to hand their agent a description of an engine ax
 * no longer uses. A "single source of truth" with an unchecked copy is two
 * sources of truth.
 *
 * If this fails, do not edit README.md by hand - regenerate the block:
 *
 *     bun -e "import('./packages/onboarding-prompt/src/index.ts').then(m=>process.stdout.write(m.AGENT_ONBOARDING_WITH_INSTALL))"
 *
 * (The README comment names the `@ax/onboarding-prompt` specifier, which does
 * not resolve from a git worktree - the relative path above always works.)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ONBOARDING_WITH_INSTALL } from "./index.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The prompt lives in the LAST ```text fence of the <details> setup block. */
const readmeMirror = (): string => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const lines = readme.split("\n");
    const start = lines.findIndex(
        (line, i) => line.trim() === "```text" && lines.slice(0, i).join("\n").includes("MANUAL MIRROR"),
    );
    if (start === -1) throw new Error("README.md: could not find the mirrored prompt's ```text fence");
    const end = lines.findIndex((line, i) => i > start && line.trim() === "```");
    if (end === -1) throw new Error("README.md: the mirrored prompt's fence is unterminated");
    return lines.slice(start + 1, end).join("\n").trim();
};

describe("README setup-prompt mirror", () => {
    test("matches AGENT_ONBOARDING_WITH_INSTALL exactly", () => {
        expect(readmeMirror()).toBe(AGENT_ONBOARDING_WITH_INSTALL.trim());
    });

    test("neither copy names a retired engine or command", () => {
        // Belt-and-braces: the equality test above catches drift between the
        // two, but both could be wrong together. These are the names v2
        // removed, so a reintroduction is a defect wherever it appears.
        for (const [label, text] of [
            ["package", AGENT_ONBOARDING_WITH_INSTALL],
            ["README mirror", readmeMirror()],
        ] as const) {
            expect(text, `${label} must not name SurrealDB`).not.toContain("SurrealDB");
            expect(text, `${label} must not name port 8521`).not.toContain("8521");
            // `ax serve` is not a command - it falls through to the root help
            // with exit 0, so telling an agent to run it fails silently.
            expect(text, `${label} must not tell an agent to run 'ax serve'`).not.toContain("ax serve");
        }
    });
});
