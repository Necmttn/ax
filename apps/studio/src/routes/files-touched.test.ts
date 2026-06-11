import { describe, expect, test } from "bun:test";
import type { InspectTurnDto, ToolCallDto } from "@ax/lib/shared/dashboard-types";
import { buildFilesTouched, buildFileStory, buildHunkPatch, buildTouchContexts, commonDirPrefix } from "./files-touched.ts";

const toolCall = (over: Partial<ToolCallDto> = {}): ToolCallDto => ({
    seq: 0,
    name: "Read",
    category: "file",
    input: null,
    command: null,
    output_excerpt: null,
    has_error: false,
    tokens: null,
    ...over,
});

const turn = (seq: number, calls: ToolCallDto[]): InspectTurnDto => ({
    seq,
    role: "assistant",
    semantic_role: "tool_use",
    ts: null,
    char_count: 0,
    raw_text: "",
    spans: [],
    token_usage: null,
    tool_calls: calls,
});

const read = (file_path: string): ToolCallDto => toolCall({ name: "Read", input: { file_path } });
const edit = (file_path: string): ToolCallDto => toolCall({ name: "Edit", category: "edit", input: { file_path } });
const write = (file_path: string): ToolCallDto => toolCall({ name: "Write", category: "edit", input: { file_path } });

describe("commonDirPrefix", () => {
    test("whole-segment prefix across siblings", () => {
        expect(commonDirPrefix(["/repo/src/a.ts", "/repo/src/sub/b.ts"])).toBe("/repo/src");
    });

    test("single path strips nothing", () => {
        expect(commonDirPrefix(["/repo/src/a.ts"])).toBe("");
    });

    test("divergence at filesystem root strips nothing", () => {
        expect(commonDirPrefix(["/repo/a.ts", "/home/user/b.ts"])).toBe("");
    });

    test("does not split mid-segment", () => {
        expect(commonDirPrefix(["/repo/src-one/a.ts", "/repo/src-two/b.ts"])).toBe("/repo");
    });
});

describe("buildFilesTouched", () => {
    test("aggregates reads and writes per file with jump seqs", () => {
        const model = buildFilesTouched([
            turn(1, [read("/repo/src/a.ts")]),
            turn(3, [edit("/repo/src/a.ts"), read("/repo/src/b.ts")]),
            turn(5, [edit("/repo/src/a.ts")]),
        ]);
        expect(model.root).toBe("/repo/src");
        const a = model.files.find((f) => f.path === "a.ts");
        expect(a).toMatchObject({ reads: 1, writes: 2, firstSeq: 1, lastSeq: 5, status: "modified" });
        const b = model.files.find((f) => f.path === "b.ts");
        expect(b).toMatchObject({ reads: 1, writes: 0, status: null });
        expect(model.totalReads).toBe(2);
        expect(model.totalWrites).toBe(2);
    });

    test("file created by Write is added; Write after Read is modified", () => {
        const model = buildFilesTouched([
            turn(1, [write("/r/new.ts")]),
            turn(2, [read("/r/old.ts")]),
            turn(3, [write("/r/old.ts")]),
        ]);
        expect(model.files.find((f) => f.path === "new.ts")?.status).toBe("added");
        expect(model.files.find((f) => f.path === "old.ts")?.status).toBe("modified");
    });

    test("ignores non-file tools and pathless calls", () => {
        const model = buildFilesTouched([
            turn(1, [
                toolCall({ name: "Bash", category: "sh", command: "ls" }),
                toolCall({ name: "Grep", category: "search", input: { pattern: "foo" } }),
                toolCall({ name: "Read", input: {} }),
            ]),
        ]);
        expect(model.files).toHaveLength(0);
    });

    test("counts errors on the touched file", () => {
        const model = buildFilesTouched([
            turn(1, [toolCall({ name: "Edit", input: { file_path: "/r/a.ts" }, has_error: true })]),
        ]);
        expect(model.files[0]?.errors).toBe(1);
    });

    test("NotebookEdit uses notebook_path and counts as write", () => {
        const model = buildFilesTouched([
            turn(1, [toolCall({ name: "NotebookEdit", input: { notebook_path: "/r/nb.ipynb" } })]),
        ]);
        expect(model.files[0]).toMatchObject({ path: "/r/nb.ipynb".replace(/^\//, ""), writes: 1 });
    });

    test("Edit counts new_string as added and old_string as removed", () => {
        const model = buildFilesTouched([
            turn(1, [toolCall({ name: "Edit", input: { file_path: "/r/a.ts", old_string: "ab", new_string: "abcdef" } })]),
            turn(2, [toolCall({ name: "Edit", input: { file_path: "/r/a.ts", old_string: "xyz", new_string: "x" } })]),
        ]);
        expect(model.files[0]).toMatchObject({ charsAdded: 7, charsRemoved: 5 });
    });

    test("Write counts content as added only", () => {
        const model = buildFilesTouched([
            turn(1, [toolCall({ name: "Write", input: { file_path: "/r/a.ts", content: "hello" } })]),
        ]);
        expect(model.files[0]).toMatchObject({ charsAdded: 5, charsRemoved: 0 });
    });

    test("failed edits contribute no char delta", () => {
        const model = buildFilesTouched([
            turn(1, [toolCall({ name: "Edit", input: { file_path: "/r/a.ts", old_string: "ab", new_string: "cdef" }, has_error: true })]),
        ]);
        expect(model.files[0]).toMatchObject({ charsAdded: 0, charsRemoved: 0, errors: 1 });
    });

    test("MultiEdit sums deltas across its edits", () => {
        const model = buildFilesTouched([
            turn(1, [toolCall({
                name: "MultiEdit",
                input: { file_path: "/r/a.ts", edits: [{ old_string: "a", new_string: "bb" }, { old_string: "ccc", new_string: "d" }] },
            })]),
        ]);
        expect(model.files[0]).toMatchObject({ charsAdded: 3, charsRemoved: 4 });
    });

    test("single-file session keeps full path minus leading slash", () => {
        const model = buildFilesTouched([turn(1, [read("/repo/src/a.ts")])]);
        expect(model.files[0]?.path).toBe("repo/src/a.ts");
    });
});

describe("buildFileStory", () => {
    test("returns only the asked file's touches, in order, reads included", () => {
        const story = buildFileStory([
            turn(1, [read("/r/a.ts"), read("/r/b.ts")]),
            turn(3, [toolCall({ name: "Edit", input: { file_path: "/r/a.ts", old_string: "x", new_string: "yy" } })]),
            turn(5, [write("/r/b.ts")]),
        ], "/r/a.ts");
        expect(story).toHaveLength(2);
        expect(story[0]).toMatchObject({ turnSeq: 1, op: "read", tool: "Read" });
        expect(story[1]).toMatchObject({ turnSeq: 3, op: "write", oldString: "x", newString: "yy" });
    });

    test("expands MultiEdit into one event per inner edit", () => {
        const story = buildFileStory([
            turn(2, [toolCall({
                name: "MultiEdit",
                input: { file_path: "/r/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
            })]),
        ], "/r/a.ts");
        expect(story).toHaveLength(2);
        expect(story[0]).toMatchObject({ oldString: "a", newString: "b", callIndex: 0 });
        expect(story[1]).toMatchObject({ oldString: "c", newString: "d", callIndex: 0 });
    });

    test("Write content lands in newString with null oldString", () => {
        const story = buildFileStory([
            turn(1, [toolCall({ name: "Write", input: { file_path: "/r/a.ts", content: "hello" } })]),
        ], "/r/a.ts");
        expect(story[0]).toMatchObject({ oldString: null, newString: "hello", op: "write" });
    });
});

describe("buildHunkPatch", () => {
    test("replace block emits -old then +new under one hunk", () => {
        const out = buildHunkPatch("src/a.ts", "old1\nold2", "new1");
        expect(out).toContain("@@ -1,2 +1,1 @@");
        expect(out).toContain("-old1\n-old2\n+new1");
    });

    test("pure add (Write) uses -0,0 old side", () => {
        const out = buildHunkPatch("a.md", null, "x\ny");
        expect(out).toContain("@@ -0,0 +1,2 @@");
        const deletions = out.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
        expect(deletions).toHaveLength(0);
    });
});

describe("buildTouchContexts", () => {
    const textTurn = (seq: number, role: "user_input" | "assistant_text", text: string): InspectTurnDto => ({
        seq,
        role: role === "user_input" ? "user" : "assistant",
        semantic_role: role,
        ts: null,
        char_count: text.length,
        raw_text: text,
        spans: [],
        token_usage: null,
    });

    test("attaches nearest direction + reasoning since previous touch", () => {
        const turns = [
            textTurn(1, "user_input", "add the panel"),
            textTurn(2, "assistant_text", "I'll build the tree first"),
            turn(3, [edit("/r/a.ts")]),
            textTurn(4, "user_input", "use diffstat instead"),
            turn(5, [edit("/r/a.ts")]),
        ];
        const ctx = buildTouchContexts(turns, [3, 5]);
        expect(ctx.get(3)).toMatchObject({
            userDirection: { seq: 1, text: "add the panel" },
            reasoning: { seq: 2, text: "I'll build the tree first" },
        });
        expect(ctx.get(5)?.userDirection).toMatchObject({ seq: 4, text: "use diffstat instead" });
        // No new reasoning between touch 3 and 5.
        expect(ctx.get(5)?.reasoning).toBeNull();
    });

    test("direction does not leak across touches when nothing new arrived", () => {
        const turns = [
            textTurn(1, "user_input", "do it"),
            turn(2, [edit("/r/a.ts")]),
            turn(4, [edit("/r/a.ts")]),
        ];
        const ctx = buildTouchContexts(turns, [2, 4]);
        expect(ctx.get(2)?.userDirection?.seq).toBe(1);
        expect(ctx.get(4)?.userDirection).toBeNull();
    });

    test("tracks active todo from the latest TodoWrite", () => {
        const todoCall = toolCall({
            name: "TodoWrite",
            input: { todos: [{ content: "wire panel", status: "completed" }, { content: "swap diffs", activeForm: "Swapping to pierre diffs", status: "in_progress" }] },
        });
        const turns = [
            turn(1, [todoCall]),
            turn(3, [edit("/r/a.ts")]),
        ];
        const ctx = buildTouchContexts(turns, [3]);
        expect(ctx.get(3)?.activeTodo).toBe("Swapping to pierre diffs");
    });

    test("touching turn's own preamble wins over older reasoning", () => {
        const touch: InspectTurnDto = { ...turn(5, [edit("/r/a.ts")]), raw_text: "Now fix the import." };
        const turns = [textTurn(2, "assistant_text", "older thought"), touch];
        const ctx = buildTouchContexts(turns, [5]);
        expect(ctx.get(5)?.reasoning).toMatchObject({ seq: 5, text: "Now fix the import." });
    });
});
