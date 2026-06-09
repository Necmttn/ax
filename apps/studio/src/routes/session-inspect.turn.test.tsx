import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Turn } from "./session-inspect.tsx";

test("Turn renders ToolRow when the turn has tool_calls", () => {
    const turn = {
        seq: 12,
        role: "assistant",
        semantic_role: "tool_use",
        ts: null,
        char_count: 0,
        raw_text: "",
        spans: [],
        token_usage: null,
        content: null,
        tool_calls: [
            {
                seq: 12,
                name: "WebFetch",
                category: "net",
                input: { url: "https://paxel.ai" },
                command: null,
                output_excerpt: null,
                has_error: false,
                tokens: 228,
            },
        ],
    };
    const html = renderToStaticMarkup(
        // deno-lint-ignore no-explicit-any
        <Turn turn={turn as any} anchored={false} activeTarget={null} onInspect={() => {}} />,
    );
    expect(html).toContain("WebFetch");
});

test("tool-only turn condenses the chrome (no kind badge / size·span)", () => {
    const turn = {
        seq: 3,
        role: "assistant",
        semantic_role: "tool_use",
        ts: null,
        char_count: 0,
        raw_text: "",
        spans: [],
        token_usage: null,
        content: null,
        tool_calls: [
            {
                seq: 3,
                name: "Bash",
                category: "sh",
                input: null,
                command: "ls",
                output_excerpt: null,
                has_error: false,
                tokens: 0,
            },
        ],
    };
    const html = renderToStaticMarkup(
        // deno-lint-ignore no-explicit-any
        <Turn turn={turn as any} anchored={false} activeTarget={null} onInspect={() => {}} />,
    );
    // The card still renders the tool.
    expect(html).toContain("Bash");
    // Tool-only turns drop the redundant role label (the card states identity)
    // and the old structure readout - only the shared dim grid header remains.
    expect(html).not.toContain("ASSISTANT TEXT");
    expect(html).not.toContain("tool use");
    expect(html).not.toContain("0span");
    // But the anchor is still reachable in the gutter.
    expect(html).toContain('href="#turn-3"');
});

test("Turn renders no tool row when tool_calls is empty/absent", () => {
    const turn = {
        seq: 5,
        role: "assistant",
        semantic_role: "tool_use",
        ts: null,
        char_count: 0,
        raw_text: "",
        spans: [],
        token_usage: null,
        content: null,
    };
    const html = renderToStaticMarkup(
        // deno-lint-ignore no-explicit-any
        <Turn turn={turn as any} anchored={false} activeTarget={null} onInspect={() => {}} />,
    );
    expect(html).not.toContain("WebFetch");
});

test("Turn renders a tool_result body via ToolResultView (stripped wrapper)", () => {
    const turn = {
        seq: 7,
        role: "user",
        semantic_role: "tool_result",
        ts: null,
        char_count: 11,
        raw_text: "<local-command-stdout>hello world</local-command-stdout>",
        spans: [],
        token_usage: null,
        content: null,
    };
    const html = renderToStaticMarkup(
        // deno-lint-ignore no-explicit-any
        <Turn turn={turn as any} anchored={false} activeTarget={null} onInspect={() => {}} />,
    );
    expect(html).toContain("hello world");
    expect(html).not.toContain("local-command-stdout");
});
