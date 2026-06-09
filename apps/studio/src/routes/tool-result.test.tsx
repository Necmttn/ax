import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolResultView } from "./tool-result.tsx";

describe("ToolResultView", () => {
    test("strips the <local-command-stdout> wrapper (output present, tags absent when expanded)", () => {
        const html = renderToStaticMarkup(
            <ToolResultView text="<local-command-stdout>hello world</local-command-stdout>" open={true} />,
        );
        expect(html).toContain("hello world");
        expect(html).not.toContain("local-command-stdout");
        expect(html).not.toContain("&lt;local-command-stdout&gt;");
    });

    test("strips the <tool_result> wrapper (tolerant of attributes)", () => {
        const html = renderToStaticMarkup(
            <ToolResultView text={'<tool_result foo="bar">inner output</tool_result>'} open={true} />,
        );
        expect(html).toContain("inner output");
        expect(html).not.toContain("tool_result");
    });

    test("collapsed (open=false) hides the full body, shows the summary", () => {
        const text = "<local-command-stdout>line one\nline two\nline three</local-command-stdout>";
        const html = renderToStaticMarkup(<ToolResultView text={text} open={false} />);
        // summary line count
        expect(html).toContain("result · 3 lines");
        // full body suppressed when collapsed
        expect(html).not.toContain("line two");
        expect(html).not.toContain("line three");
    });

    test("expanded (open=true) shows the output in the terminal <pre>", () => {
        const text = "<local-command-stdout>line one\nline two</local-command-stdout>";
        const html = renderToStaticMarkup(<ToolResultView text={text} open={true} />);
        expect(html).toContain("<pre");
        expect(html).toContain("line one");
        expect(html).toContain("line two");
    });

    test("strips ANSI escape codes", () => {
        const html = renderToStaticMarkup(
            <ToolResultView text={"<local-command-stdout>\x1b[31mred\x1b[0m</local-command-stdout>"} open={true} />,
        );
        expect(html).toContain("red");
        expect(html).not.toContain("\x1b");
        expect(html).not.toContain("[31m");
    });

    test("empty output renders a muted (no output) line", () => {
        const html = renderToStaticMarkup(
            <ToolResultView text="<local-command-stdout></local-command-stdout>" open={true} />,
        );
        expect(html).toContain("(no output)");
        // no terminal block for empty output
        expect(html).not.toContain("<pre");
    });
});
