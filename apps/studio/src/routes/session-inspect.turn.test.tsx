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
    // Tool-only turns drop the VISIBLE role label (the card states identity)
    // and the old structure readout - the role survives only as an sr-only
    // span for screen readers (the accent bar alone is color-only signal).
    expect(html).not.toContain("ASSISTANT TEXT");
    expect(html).toContain('class="sr-only">tool use turn');
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

test("plain parsed assistant prose does not render inside a terminal block", () => {
    const text = "Now the wrapped-brief pattern + profile schema/render + dossier.";
    const turn = {
        seq: 34,
        role: "assistant",
        semantic_role: "assistant_text",
        ts: null,
        char_count: text.length,
        raw_text: text,
        spans: [{ kind: "assistant_text", text }],
        token_usage: null,
        content: {
            parser_id: "test-parser",
            parser_version: "1",
            blockset_hash: "hash",
            blocks: [
                {
                    seq: 0,
                    parent_seq: null,
                    kind: "paragraph",
                    role: "assistant",
                    heading: null,
                    text,
                    text_excerpt: text,
                    start_offset: 0,
                    end_offset: text.length,
                    confidence: 1,
                    atoms: [],
                },
            ],
        },
    };
    const html = renderToStaticMarkup(
        // deno-lint-ignore no-explicit-any
        <Turn turn={turn as any} anchored={false} activeTarget={null} onInspect={() => {}} />,
    );
    expect(html).toContain(text);
    expect(html).not.toContain("background:var(--term-bg)");
});
