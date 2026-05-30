import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProviderTurn } from "./parse-turn.ts";
import { classifyTurnSectionAliases } from "./turn-section-aliases.ts";
import type { ContentDocumentInput, ParsedContentAtom } from "./types.ts";

const ROOT = import.meta.dir;

async function readFixture(path: string): Promise<string> {
    return readFile(join(ROOT, "fixtures", path), "utf8");
}

const turnInput = (
    text: string,
    labels: Record<string, unknown> = { provider: "codex", role: "user", messageKind: "task" },
): ContentDocumentInput => ({
    sourceKind: "turn",
    sourceRef: "session-a:1",
    text,
    labels,
});

const aliasAtoms = (atoms: readonly ParsedContentAtom[]) =>
    atoms.filter((atom) => atom.kind === "section_alias");

const aliasValues = (atoms: readonly ParsedContentAtom[]) =>
    aliasAtoms(atoms).map((atom) => ({
        blockSeq: atom.blockSeq,
        value: atom.value,
        inherited: atom.raw?.["inherited"],
        method: atom.raw?.["method"],
        sourceBlockSeq: atom.raw?.["sourceBlockSeq"],
    }));

const expectAlias = (
    values: ReturnType<typeof aliasValues>,
    expected: Partial<ReturnType<typeof aliasValues>[number]>,
) => {
    expect(values).toContainEqual(expect.objectContaining(expected));
};

describe("turn section aliases", () => {
    const providerFixtures = [
        {
            name: "Codex goal context",
            fixture: "turns/codex-goal-context.input.txt",
            labels: { provider: "codex", role: "user", messageKind: "task" },
            aliases: [
                "objective",
                "continuation_behavior",
                "budget",
                "work_from_evidence",
                "progress_visibility",
                "completion_audit",
            ],
            absent: [],
        },
        {
            name: "Codex system context",
            fixture: "turns/codex-system-context.input.txt",
            labels: { provider: "codex", role: "user", messageKind: "developer" },
            aliases: [
                "permissions",
                "environment_context",
                "apps_manifest",
                "skills_manifest",
                "plugins_manifest",
            ],
            absent: [],
        },
        {
            name: "Claude assistant plan",
            fixture: "turns/claude-assistant-plan.input.txt",
            labels: { provider: "claude", role: "assistant", messageKind: "assistant" },
            aliases: ["plan", "todo", "verification", "tool_call", "reference"],
            absent: [],
        },
        {
            name: "Pi plain user task",
            fixture: "turns/pi-plain-task.input.txt",
            labels: { provider: "pi", role: "user", messageKind: "task" },
            aliases: ["reference"],
            absent: ["budget", "plan", "objective"],
        },
        {
            name: "OpenCode plain assistant plan",
            fixture: "turns/opencode-plain-assistant.input.txt",
            labels: { provider: "opencode", role: "assistant", messageKind: "assistant" },
            aliases: ["plan", "verification", "reference"],
            absent: ["budget", "objective"],
        },
        {
            name: "Cursor plain user task false-positive guard",
            fixture: "turns/cursor-plain-user.input.txt",
            labels: { provider: "cursor", role: "user", messageKind: "task" },
            aliases: ["reference"],
            absent: ["budget"],
        },
    ] as const;

    for (const fixture of providerFixtures) {
        test(`${fixture.name} fixture produces expected aliases`, async () => {
            const parsed = parseProviderTurn(turnInput(await readFixture(fixture.fixture), fixture.labels));
            const aliases = aliasAtoms(parsed.atoms).map((atom) => atom.value);

            for (const alias of fixture.aliases) {
                expect(aliases).toContain(alias);
            }
            for (const alias of fixture.absent) {
                expect(aliases).not.toContain(alias);
            }
        });
    }

    test("identifies Codex goal-context aliases and inherits labeled sections", () => {
        const parsed = parseProviderTurn(turnInput([
            "<goal_context>",
            "Continue working toward the active thread goal.",
            "",
            "<objective>",
            "Build the turn section alias classifier.",
            "</objective>",
            "",
            "Continuation behavior:",
            "- This goal persists across turns.",
            "- Keep the full objective intact.",
            "",
            "Budget:",
            "- Hard limit: none",
            "",
            "Completion audit:",
            "Before deciding that the goal is achieved, verify evidence.",
            "</goal_context>",
        ].join("\n")));

        const aliases = classifyTurnSectionAliases(parsed.blocks, parsed.atoms, { labels: { provider: "codex" } });
        const values = aliasValues(aliases.atoms);

        expectAlias(values, { value: "objective", method: "xml-tag" });
        expectAlias(values, { value: "continuation_behavior", method: "label-prefix" });
        expectAlias(values, { value: "budget", method: "label-prefix" });
        expectAlias(values, { value: "budget", method: "inherited", inherited: true });
        expectAlias(values, { value: "completion_audit", method: "label-prefix" });

        const budgetHeader = values.find((value) => value.value === "budget" && value.method === "label-prefix");
        const inheritedBudget = values.find((value) => value.value === "budget" && value.method === "inherited");
        expect(budgetHeader).toBeDefined();
        expect(inheritedBudget?.sourceBlockSeq).toBe(budgetHeader?.blockSeq);
    });

    test("identifies Codex injected system wrapper aliases", () => {
        const parsed = parseProviderTurn(turnInput([
            "<permissions instructions>sandbox_mode=danger-full-access approval policy is never</permissions instructions>",
            "<environment_context><cwd>/repo</cwd><shell>zsh</shell><current_date>2026-05-30</current_date></environment_context>",
            "<skills_instructions>## Skills\n### Available skills\n- tdd</skills_instructions>",
            "<apps_instructions>## Apps (Connectors)\nGitHub</apps_instructions>",
            "<plugins_instructions>## Plugins\nSuperpowers</plugins_instructions>",
        ].join("\n")));

        const aliases = classifyTurnSectionAliases(parsed.blocks, parsed.atoms);
        const values = aliasValues(aliases.atoms);
        expectAlias(values, { value: "permissions", method: "block-heading" });
        expectAlias(values, { value: "environment_context", method: "block-heading" });
        expectAlias(values, { value: "skills_manifest", method: "block-heading" });
        expectAlias(values, { value: "apps_manifest", method: "block-heading" });
        expectAlias(values, { value: "plugins_manifest", method: "block-heading" });
    });

    test("classifies assistant plans, todos, verification, tool calls, and references", () => {
        const parsed = parseProviderTurn(turnInput([
            "## Plan",
            "- [ ] Update `src/ingest/content-blocks/parse-turn.ts`",
            "- Run `bun test src/ingest/content-blocks/parse-turn.test.ts`",
            "",
            "Verification:",
            "- `bun run typecheck`",
            "",
            "<tool_use name=\"Read\">{\"file_path\":\"src/cli/index.ts\"}</tool_use>",
        ].join("\n"), { provider: "claude", role: "assistant", messageKind: "assistant" }));

        const aliases = classifyTurnSectionAliases(parsed.blocks, parsed.atoms);
        const values = aliasValues(aliases.atoms);
        expectAlias(values, { value: "plan", method: "label-prefix" });
        expectAlias(values, { value: "todo", method: "label-prefix" });
        expectAlias(values, { value: "verification", method: "label-prefix" });
        expectAlias(values, { value: "tool_call", method: "block-kind" });
        expectAlias(values, { value: "reference", method: "atom-kind" });
    });

    test("does not turn casual prose into boundary aliases", () => {
        const parsed = parseProviderTurn(turnInput(
            "We should budget time later, but for now inspect BudgetService and keep going.",
            { provider: "pi", role: "user", messageKind: "task" },
        ));

        const aliases = classifyTurnSectionAliases(parsed.blocks, parsed.atoms);
        const semantic = aliasAtoms(aliases.atoms).map((atom) => atom.value);
        expect(semantic).not.toContain("budget");
        expect(semantic).toContain("reference");
    });
});
