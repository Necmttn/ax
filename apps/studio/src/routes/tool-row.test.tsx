import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolRow, ToolRowItem } from "./tool-row.tsx";
import type { ToolCallDto } from "@ax/lib/shared/dashboard-types";

const call = (over: Partial<ToolCallDto> = {}): ToolCallDto => ({
    seq: 12,
    name: "WebFetch",
    category: "net",
    input: { url: "https://paxel.ai/about" },
    command: null,
    output_excerpt: null,
    has_error: false,
    tokens: 228,
    ...over,
});

describe("ToolCallCard (ToolRowItem / ToolRow)", () => {
    test("header shows name + category badge", () => {
        const html = renderToStaticMarkup(<ToolRow calls={[call()]} />);
        expect(html).toContain("WebFetch");
        expect(html).toContain(">net<");
    });

    test("promotes the primary arg into the identity line (WebFetch → url)", () => {
        const html = renderToStaticMarkup(<ToolRowItem call={call()} />);
        // url is the promoted head value, shown inline next to the name...
        expect(html).toMatch(/paxel\.ai\/about/);
        // ...and therefore NOT repeated as a labelled grid cell.
        expect(html).not.toContain(">url<");
    });

    test("non-primary structured args still render in the grid", () => {
        const html = renderToStaticMarkup(
            <ToolRowItem call={call({ name: "Grep", category: "search", input: { pattern: "foo", path: "/src" } })} />,
        );
        // pattern is promoted to the header; path stays as a labelled cell.
        expect(html).toMatch(/foo/);
        expect(html).toContain(">path<");
        expect(html).toMatch(/\/src/);
    });

    test("structured input with no primary arg renders entirely in the grid", () => {
        const html = renderToStaticMarkup(
            <ToolRowItem call={call({ name: "SomeTool", category: "other", input: { alpha: "a", beta: "b" } })} />,
        );
        expect(html).toContain(">alpha<");
        expect(html).toContain(">beta<");
    });

    test("shell-style call shows `$ ` + the full command", () => {
        const html = renderToStaticMarkup(
            <ToolRowItem call={call({ name: "Bash", category: "sh", input: null, command: "ls -la" })} />,
        );
        expect(html).toContain("$ ");
        expect(html).toContain("ls -la");
    });

    test("renders the paired result in a terminal output block, wrapper stripped", () => {
        const html = renderToStaticMarkup(
            <ToolRowItem
                call={call({ name: "Bash", category: "sh", input: null, command: "echo hi" })}
                result="<local-command-stdout>hello world</local-command-stdout>"
            />,
        );
        expect(html).toContain('data-testid="tool-card-output"');
        expect(html).toContain("hello world");
        expect(html).not.toContain("local-command-stdout");
        // terminal styling (the named dark-island tokens)
        expect(html).toContain("var(--term-bg)");
    });

    test(">600-char output renders in FULL (no truncation)", () => {
        const big = "z".repeat(2000);
        const html = renderToStaticMarkup(
            <ToolRowItem
                call={call({ name: "Bash", category: "sh", input: null, command: "x" })}
                result={big}
            />,
        );
        // the full 2000-char block survives into the rendered output
        expect(html).toContain(big);
    });

    test("falls back to call.output_excerpt when no paired result (share path)", () => {
        const html = renderToStaticMarkup(
            <ToolRowItem
                call={call({ name: "Bash", category: "sh", input: null, command: "x", output_excerpt: "share-output" })}
            />,
        );
        expect(html).toContain('data-testid="tool-card-output"');
        expect(html).toContain("share-output");
    });

    test("error call exposes an error affordance", () => {
        const html = renderToStaticMarkup(<ToolRow calls={[call({ has_error: true })]} />);
        expect(html).toContain('data-testid="tool-row-error"');
    });

    test("resultFor wires the i-th call to its paired output", () => {
        const html = renderToStaticMarkup(
            <ToolRow
                calls={[
                    call({ name: "Read", category: "file", input: { file_path: "/a" }, command: null }),
                    call({ name: "Bash", category: "sh", input: null, command: "ls" }),
                ]}
                resultFor={(i) => (i === 1 ? "bash-out" : undefined)}
            />,
        );
        // Both cards mount; only the 2nd call has a paired result.
        expect(html).toContain("Read");
        expect(html).toContain("Bash");
        expect(html).toContain("bash-out");
    });

    test("empty calls list renders nothing", () => {
        expect(renderToStaticMarkup(<ToolRow calls={[]} />)).toBe("");
    });

    test("Skill card folds the injected SKILL.md into the output block + launch sub-line", () => {
        const skillBody = "# Brainstorming\n" + "instruction line\n".repeat(40);
        const html = renderToStaticMarkup(
            <ToolRowItem
                call={call({ name: "Skill", category: "other", input: { skill: "superpowers:brainstorming" }, command: null })}
                result="<local-command-stdout>Launching skill: superpowers:brainstorming</local-command-stdout>"
                skillContent={skillBody}
            />,
        );
        // the skill name reads as the card identity
        expect(html).toContain("Skill");
        expect(html).toContain("superpowers:brainstorming");
        // launch line demotes to the dim sub-line, wrapper stripped
        expect(html).toContain('data-testid="skill-launch-line"');
        expect(html).toContain("Launching skill: superpowers:brainstorming");
        expect(html).not.toContain("local-command-stdout");
        // the FULL SKILL.md body lands in the scrollable terminal output block
        expect(html).toContain('data-testid="tool-card-output"');
        expect(html).toContain(skillBody);
    });

    test("Edit old/new args render verbatim with diff tints (SSR = plain pre-highlight fallback)", () => {
        const html = renderToStaticMarkup(
            <ToolRowItem
                call={call({
                    name: "Edit",
                    category: "edit",
                    input: { file_path: "/a/b.ts", old_string: "const x = 1", new_string: "const x = 2" },
                    command: null,
                })}
            />,
        );
        // code text survives untouched before the client-side token swap
        expect(html).toContain("const x = 1");
        expect(html).toContain("const x = 2");
        // diff tints on the value cells
        expect(html).toContain("var(--red) 7%");
        expect(html).toContain("var(--green) 9%");
    });

    test("Write content arg renders verbatim; no diff tint", () => {
        const html = renderToStaticMarkup(
            <ToolRowItem
                call={call({
                    name: "Write",
                    category: "edit",
                    input: { file_path: "/a/b.py", content: "print('hi')" },
                    command: null,
                })}
            />,
        );
        expect(html).toContain("print(&#x27;hi&#x27;)");
        expect(html).not.toContain("var(--red) 7%");
    });

    test("skillContentFor wires a Skill call's injected content through ToolRow", () => {
        const html = renderToStaticMarkup(
            <ToolRow
                calls={[call({ name: "Skill", category: "other", input: { skill: "ax-repo" }, command: null })]}
                resultFor={() => "Launching skill: ax-repo"}
                skillContentFor={() => "SKILL.md for ax-repo"}
            />,
        );
        expect(html).toContain("SKILL.md for ax-repo");
        expect(html).toContain("ax-repo");
    });
});
