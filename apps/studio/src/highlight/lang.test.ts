import { describe, expect, test } from "bun:test";
import { langFromPath, parseFences, resolveLang } from "./lang.ts";

describe("resolveLang", () => {
    test("canonical ids pass through", () => {
        expect(resolveLang("typescript")).toBe("typescript");
        expect(resolveLang("shellscript")).toBe("shellscript");
    });
    test("aliases collapse onto canonical ids", () => {
        expect(resolveLang("ts")).toBe("typescript");
        expect(resolveLang("bash")).toBe("shellscript");
        expect(resolveLang("sh")).toBe("shellscript");
        expect(resolveLang("py")).toBe("python");
        expect(resolveLang("surql")).toBe("sql");
        expect(resolveLang("yml")).toBe("yaml");
    });
    test("case/whitespace-insensitive", () => {
        expect(resolveLang("  TS ")).toBe("typescript");
    });
    test("unknown or empty → null", () => {
        expect(resolveLang("brainfuck")).toBeNull();
        expect(resolveLang("")).toBeNull();
        expect(resolveLang(null)).toBeNull();
    });
});

describe("langFromPath", () => {
    test("maps extensions", () => {
        expect(langFromPath("/a/b/foo.ts")).toBe("typescript");
        expect(langFromPath("src/App.tsx")).toBe("tsx");
        expect(langFromPath("schema.surql")).toBe("sql");
        expect(langFromPath("conf.yml")).toBe("yaml");
        expect(langFromPath("main.go")).toBe("go");
    });
    test("Dockerfile special-case", () => {
        expect(langFromPath("ops/Dockerfile")).toBe("dockerfile");
    });
    test("no/unknown extension or dotfile → null", () => {
        expect(langFromPath("/usr/bin/axctl")).toBeNull();
        expect(langFromPath("photo.heic")).toBeNull();
        expect(langFromPath(".gitignore")).toBeNull();
        expect(langFromPath(null)).toBeNull();
    });
});

describe("parseFences", () => {
    test("no fence → single text segment", () => {
        const segs = parseFences("plain prose\nno code here");
        expect(segs).toEqual([{ type: "text", raw: "plain prose\nno code here" }]);
    });

    test("basic fence with info string", () => {
        const text = "before\n```ts\nconst x = 1\n```\nafter";
        const segs = parseFences(text);
        expect(segs.map((s) => s.type)).toEqual(["text", "fence", "text"]);
        const fence = segs[1] as Extract<(typeof segs)[number], { type: "fence" }>;
        expect(fence.lang).toBe("typescript");
        expect(fence.body).toBe("const x = 1");
        expect(fence.openLine).toBe("```ts");
        expect(fence.closeLine).toBe("```");
    });

    test("unclosed fence runs to end", () => {
        const segs = parseFences("hi\n```sh\necho 1");
        expect(segs).toHaveLength(2);
        const fence = segs[1] as Extract<(typeof segs)[number], { type: "fence" }>;
        expect(fence.closeLine).toBeNull();
        expect(fence.body).toBe("echo 1");
        expect(fence.lang).toBe("shellscript");
    });

    test("unknown info string → fence with null lang", () => {
        const segs = parseFences("```whatever\nx\n```");
        const fence = segs[0] as Extract<(typeof segs)[number], { type: "fence" }>;
        expect(fence.type).toBe("fence");
        expect(fence.lang).toBeNull();
    });

    test("longer close marker closes shorter open", () => {
        const segs = parseFences("```\nx\n````");
        const fence = segs[0] as Extract<(typeof segs)[number], { type: "fence" }>;
        expect(fence.closeLine).toBe("````");
    });

    test("reconstruction invariant: raw segments concat to input", () => {
        const cases = [
            "",
            "text only",
            "a\n```ts\ncode\n```\nb",
            "```\nunclosed",
            "x\n```json\n{}\n```",
            "```a\n1\n```\nmid\n```b\n2\n```\ntail",
            "trailing newline\n```sh\nls\n```\n",
        ];
        for (const text of cases) {
            expect(parseFences(text).map((s) => s.raw).join("")).toBe(text);
        }
    });

    test("inline backticks are not fences", () => {
        const segs = parseFences("use `ls` and ``x`` inline");
        expect(segs).toHaveLength(1);
        expect(segs[0].type).toBe("text");
    });
});
