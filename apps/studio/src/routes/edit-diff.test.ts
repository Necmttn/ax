import { describe, expect, test } from "bun:test";
import { extractDiffPairs, extractReadView } from "./edit-diff.ts";

describe("extractDiffPairs", () => {
    test("Edit yields one pair keyed to file_path", () => {
        const pairs = extractDiffPairs("Edit", {
            file_path: "/repo/src/a.ts",
            old_string: "const x = 1;",
            new_string: "const x = 2;",
        });
        expect(pairs).toEqual([
            { fileName: "/repo/src/a.ts", oldText: "const x = 1;", newText: "const x = 2;" },
        ]);
    });

    test("MultiEdit yields one pair per edits[] entry", () => {
        const pairs = extractDiffPairs("MultiEdit", {
            file_path: "b.py",
            edits: [
                { old_string: "a", new_string: "b" },
                { old_string: "c", new_string: "d" },
            ],
        });
        expect(pairs).toHaveLength(2);
        expect(pairs?.[1]).toEqual({ fileName: "b.py", oldText: "c", newText: "d" });
    });

    test("Write yields an all-added pair", () => {
        const pairs = extractDiffPairs("Write", { file_path: "new.md", content: "# hi" });
        expect(pairs).toEqual([{ fileName: "new.md", oldText: "", newText: "# hi" }]);
    });

    test("NotebookEdit uses new_source against empty", () => {
        const pairs = extractDiffPairs("NotebookEdit", { notebook_path: "n.ipynb", new_source: "print(1)" });
        expect(pairs).toEqual([{ fileName: "n.ipynb", oldText: "", newText: "print(1)" }]);
    });

    test("apply_patch V4A multi-file patch yields per-hunk pairs", () => {
        const patch = [
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@",
            " ctx",
            "-old line",
            "+new line",
            "*** Add File: src/b.ts",
            "+line1",
            "+line2",
            "*** End Patch",
        ].join("\n");
        const pairs = extractDiffPairs("apply_patch", { patch });
        expect(pairs).toEqual([
            { fileName: "src/a.ts", oldText: "ctx\nold line", newText: "ctx\nnew line" },
            { fileName: "src/b.ts", oldText: "", newText: "line1\nline2" },
        ]);
    });

    test("apply_patch V4A multiple hunks in one file stay separate", () => {
        const patch = [
            "*** Begin Patch",
            "*** Update File: x.go",
            "@@ func A",
            "-a1",
            "+a2",
            "@@ func B",
            "-b1",
            "+b2",
            "*** End Patch",
        ].join("\n");
        const pairs = extractDiffPairs("apply_patch", { patch });
        expect(pairs).toEqual([
            { fileName: "x.go", oldText: "a1", newText: "a2" },
            { fileName: "x.go", oldText: "b1", newText: "b2" },
        ]);
    });

    test("apply_diff standard unified diff parses headers and hunks", () => {
        const diff = [
            "--- a/x.py",
            "+++ b/x.py",
            "@@ -1,3 +1,3 @@",
            " import os",
            "-print(1)",
            "+print(2)",
        ].join("\n");
        const pairs = extractDiffPairs("apply_diff", { diff });
        expect(pairs).toEqual([
            { fileName: "x.py", oldText: "import os\nprint(1)", newText: "import os\nprint(2)" },
        ]);
    });

    test("hunks with only context lines are dropped", () => {
        const patch = [
            "*** Begin Patch",
            "*** Update File: y.ts",
            "@@",
            " only context",
            "*** End Patch",
        ].join("\n");
        expect(extractDiffPairs("apply_patch", { patch })).toBeNull();
    });

    test("empty-both-sides pairs are dropped", () => {
        expect(extractDiffPairs("Edit", { file_path: "a", old_string: "", new_string: "" })).toBeNull();
    });

    test("unrecognized input shapes return null", () => {
        expect(extractDiffPairs("Edit", { file_path: "a" })).toBeNull();
        expect(extractDiffPairs("apply_patch", { patch: 42 })).toBeNull();
        expect(extractDiffPairs("apply_patch", { nothing: "here" })).toBeNull();
        expect(extractDiffPairs("Bash", { command: "ls" })).toBeNull();
        expect(extractDiffPairs("Edit", null)).toBeNull();
    });
});

describe("extractReadView", () => {
    test("numbered Read result yields stripped contents with the start offset", () => {
        const result = ["  4258→const a = 1;", "  4259→const b = 2;"].join("\n");
        const view = extractReadView("Read", { file_path: "src/cli/index.ts" }, result);
        expect(view).toEqual({
            fileName: "src/cli/index.ts",
            contents: "const a = 1;\nconst b = 2;",
            startLine: 4258,
            tail: "",
        });
    });

    test("non-numbered trailing lines land in tail", () => {
        const result = ["  1→x", "", "<system-reminder>note</system-reminder>"].join("\n");
        const view = extractReadView("Read", { file_path: "a.ts" }, result);
        expect(view?.contents).toBe("x");
        expect(view?.startLine).toBe(1);
        expect(view?.tail).toBe("<system-reminder>note</system-reminder>");
    });

    test("tab-numbered (cat -n) Read results parse too", () => {
        const view = extractReadView("Read", { file_path: "a.ts" }, "1\timport x;\n2\texport y;");
        expect(view?.contents).toBe("import x;\nexport y;");
        expect(view?.startLine).toBe(1);
    });

    test("non-Read tools, images, and empty results return null", () => {
        expect(extractReadView("Bash", { command: "ls" }, "  1→x")).toBeNull();
        expect(extractReadView("Read", { file_path: "img.png" }, "[Image]")).toBeNull();
        expect(extractReadView("Read", { file_path: "a.ts" }, "")).toBeNull();
    });
});
