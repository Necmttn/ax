/**
 * A narrow contract over the SHIPPED retro skill (`skills/retro/SKILL.md`).
 *
 * The retro is the workflow that reads verdicts, so its ordering is part of
 * #1134: the checkpoint measurement has to run, and finish, before any verdict
 * read - otherwise the retro presents the previous run's suggestions as fresh
 * ones. This inspects the command ORDER and the flags in the workflow, not the
 * prose around them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_PATH = join(import.meta.dir, "../../../../skills/retro/SKILL.md");
const skill = readFileSync(SKILL_PATH, "utf8");

/** Every ```bash fence in the document, in order. */
const bashBlocks = (markdown: string): string[] =>
    [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

/** The commands of the workflow steps, in document order - the CLI reference
 *  section at the end is a lookup table, not a sequence. */
const workflowCommands = (): string[] => {
    const workflow = skill.slice(
        skill.indexOf("## Workflow"),
        skill.indexOf("## CLI reference"),
    );
    return bashBlocks(workflow)
        .flatMap((block) => block.split("\n"))
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
};

describe("shipped retro skill", () => {
    test("the checkpoint prerequisite precedes every verdict read", () => {
        const commands = workflowCommands();
        const checkpoint = commands.findIndex((c) => c.includes("ax improve checkpoint"));
        const verdictReads = commands
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => c.includes("ax improve verdict"));
        expect(checkpoint).toBeGreaterThanOrEqual(0);
        expect(verdictReads.length).toBeGreaterThan(0);
        for (const { i } of verdictReads) expect(i).toBeGreaterThan(checkpoint);
    });

    test("no workflow command runs checkpoint with --force", () => {
        for (const command of workflowCommands()) {
            if (command.includes("ax improve checkpoint")) {
                expect(command).not.toContain("--force");
            }
        }
    });

    test("every workflow read disables the automatic freshness drive", () => {
        // A prefix on the first command does not carry to the next one, so each
        // ax command in the snapshot step needs its own.
        const snapshot = skill.slice(skill.indexOf("### Step 1 - Snapshot"), skill.indexOf("### Step 2"));
        const commands = bashBlocks(snapshot)
            .flatMap((block) => block.split("\n"))
            .map((line) => line.trim())
            .filter((line) => line.startsWith("ax ") || line.includes(" ax "));
        expect(commands.length).toBeGreaterThan(0);
        for (const command of commands) expect(command).toStartWith("AX_NO_AUTO_INGEST=1 ax ");
    });
});
