import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LogText, looksLikeDiff, tokenizeLogLine } from "./log-line.tsx";
import { parseNumberedOutput } from "./numbered-code.tsx";

const rejoin = (spans: ReturnType<typeof tokenizeLogLine>) => spans.map((s) => s.text).join("");
const kinds = (line: string) => tokenizeLogLine(line).filter((s) => s.kind !== "plain").map((s) => [s.kind, s.text]);

describe("tokenizeLogLine", () => {
    test("file paths (abs, rel, with :line) tint as path", () => {
        expect(kinds("wrote /a/b/c.ts and src/foo/bar.tsx:12 ok")).toEqual([
            ["path", "/a/b/c.ts"],
            ["path", "src/foo/bar.tsx:12"],
        ]);
    });

    test("severity words tint", () => {
        expect(kinds("1 error, 2 warnings: build failed")).toEqual([
            ["error", "error"],
            ["warn", "warnings"],
            ["error", "failed"],
        ]);
    });

    test("numbers only tint with a unit", () => {
        expect(kinds("ran 240 tests in 1.5s using 12MB (98%)")).toEqual([
            ["number", "1.5s"],
            ["number", "12MB"],
            ["number", "98%"],
        ]);
    });

    test("diff lines only color in diff context", () => {
        expect(tokenizeLogLine("- a bullet", { diff: false })[0].kind).toBe("plain");
        expect(tokenizeLogLine("+added line", { diff: true })[0]).toEqual({ text: "+added line", kind: "add" });
        expect(tokenizeLogLine("-removed", { diff: true })[0]).toEqual({ text: "-removed", kind: "del" });
        expect(tokenizeLogLine("@@ -1,2 +3,4 @@", { diff: true })[0].kind).toBe("hunk");
    });

    test("spans always reconstruct the line", () => {
        for (
            const line of [
                "",
                "plain text only",
                "error at /x/y/z.go:9 after 30ms",
                "+not a diff add here",
            ]
        ) {
            expect(rejoin(tokenizeLogLine(line))).toBe(line);
        }
    });
});

describe("looksLikeDiff", () => {
    test("detects unified diff markers", () => {
        expect(looksLikeDiff("@@ -1 +1 @@\n-a\n+b")).toBe(true);
        expect(looksLikeDiff("- just\n- bullets")).toBe(false);
    });
});

describe("LogText", () => {
    test("rendered text equals input", () => {
        const text = "error: /a/b.ts:1 failed in 20ms\nplain line";
        const html = renderToStaticMarkup(<LogText text={text} />);
        expect(html.replace(/<[^>]+>/g, "")).toBe(text);
    });
});

describe("parseNumberedOutput", () => {
    test("parses cat -n style read output", () => {
        const out = "     1\timport x\n     2\t\n     3\texport y";
        const parsed = parseNumberedOutput(out);
        expect(parsed).not.toBeNull();
        expect(parsed!.prefixes).toEqual(["     1\t", "     2\t", "     3\t"]);
        expect(parsed!.code).toBe("import x\n\nexport y");
        expect(parsed!.tail).toBeNull();
    });

    test("keeps an unnumbered tail verbatim", () => {
        const out = "1\ta\n2\tb\n3\tc\n\n<note>appended</note>";
        const parsed = parseNumberedOutput(out)!;
        expect(parsed.code).toBe("a\nb\nc");
        expect(parsed.tail).toBe("\n<note>appended</note>");
    });

    test("rejects non-numbered or too-short output", () => {
        expect(parseNumberedOutput("hello\nworld")).toBeNull();
        expect(parseNumberedOutput("1\ta\n2\tb")).toBeNull();
    });
});
