import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FencedCode, HighlightedCode, TextWithFences } from "./HighlightedCode.tsx";
import { parseFences, type FenceSegment } from "./lang.ts";
import { tokenize } from "./highlighter.ts";

const textOf = (html: string) => html.replace(/<[^>]+>/g, "");
const unescape = (s: string) =>
    s.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll(
        "&amp;",
        "&",
    );

describe("HighlightedCode (SSR = pre-token fallback)", () => {
    test("renders the code string verbatim before tokens load", () => {
        const html = renderToStaticMarkup(<HighlightedCode code={'rg -n "foo" | head'} lang="shellscript" />);
        expect(unescape(textOf(html))).toBe('rg -n "foo" | head');
    });
});

describe("TextWithFences", () => {
    test("plain text passes through renderText untouched", () => {
        const html = renderToStaticMarkup(
            <TextWithFences text="no code here" renderText={(t) => <em>{t}</em>} />,
        );
        expect(html).toBe("<em>no code here</em>");
    });

    test("fenced input splits: dim markers, body intact, prose still custom-rendered", () => {
        const text = "intro\n```ts\nconst x = 1\n```\noutro";
        const html = renderToStaticMarkup(
            <TextWithFences text={text} renderText={(t) => <em>{t}</em>} />,
        );
        // prose segments keep the caller's renderer
        expect(html).toContain("<em>intro\n</em>");
        expect(html).toContain("<em>\noutro</em>");
        // fence markers render dim, body survives verbatim
        expect(html).toContain("opacity:0.45");
        expect(unescape(textOf(html))).toBe(text);
    });

    test("text content always reconstructs the input exactly", () => {
        for (
            const text of [
                "a\n```sh\nls\n```\nb",
                "```\nunclosed",
                "```json\n{\"k\":1}\n```",
            ]
        ) {
            const html = renderToStaticMarkup(<TextWithFences text={text} />);
            expect(unescape(textOf(html))).toBe(text);
        }
    });
});

describe("FencedCode", () => {
    test("renders exactly the segment's raw text", () => {
        const seg = parseFences("```py\nprint(1)\n```")[0] as FenceSegment;
        const html = renderToStaticMarkup(<FencedCode segment={seg} />);
        expect(textOf(html)).toBe("```py\nprint(1)\n```");
    });
});

describe("tokenize (real shiki pipeline)", () => {
    test("typescript grammar produces colored tokens", async () => {
        const tokens = await tokenize("const x: number = 1", "typescript");
        expect(tokens).not.toBeNull();
        const flat = tokens!.flat();
        expect(flat.map((t) => t.content).join("")).toBe("const x: number = 1");
        expect(new Set(flat.map((t) => t.color)).size).toBeGreaterThan(1);
    });

    test("unsupported lang → null", async () => {
        expect(await tokenize("x", "brainfuck")).toBeNull();
    });
});
