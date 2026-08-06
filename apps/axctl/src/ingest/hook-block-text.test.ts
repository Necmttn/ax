import { describe, expect, test } from "bun:test";
import { parseHookBlocksFromText } from "./hook-block-text.ts";

describe("parseHookBlocksFromText", () => {
    test("recovers a PreToolUse block exactly as Claude Code writes it", () => {
        // Verbatim shape from ~/.claude/projects/**/*.jsonl (CC 2.1.x).
        const text =
            "PreToolUse:Bash hook error: [bun /Users/x/.ax/hooks/enforce-worktree.ts # ax:74da7418]: BLOCKED: history-mutating git op against a DIRTY primary working tree.\n\n  target tree : /Users/x/Projects/apps";
        const fires = parseHookBlocksFromText(text);
        expect(fires).toHaveLength(1);
        expect(fires[0]!.eventName).toBe("PreToolUse");
        expect(fires[0]!.tool).toBe("Bash");
        expect(fires[0]!.hookName).toBe("PreToolUse:Bash");
        expect(fires[0]!.command).toBe("bun /Users/x/.ax/hooks/enforce-worktree.ts # ax:74da7418");
        expect(fires[0]!.message).toStartWith("BLOCKED: history-mutating git op");
        expect(fires[0]!.message).toEndWith("/Users/x/Projects/apps");
    });

    test("handles the ax:hook marker prefix the install path writes", () => {
        const text =
            "PreToolUse:Agent hook error: [echo 'ax:hook__17b5aaf6aade53e5' >/dev/null; /Users/x/hooks/dispatch-model-guard.sh]: this Agent dispatch names no model";
        const fires = parseHookBlocksFromText(text);
        expect(fires).toHaveLength(1);
        expect(fires[0]!.command).toContain("dispatch-model-guard.sh");
        expect(fires[0]!.message).toBe("this Agent dispatch names no model");
    });

    test("splits several hooks blocking the same call", () => {
        const text = [
            "PreToolUse:Write hook error: [bun /h/a.ts]: first said no",
            "PreToolUse:Write hook error: [bun /h/b.ts]: second said no too",
        ].join("\n");
        const fires = parseHookBlocksFromText(text);
        expect(fires.map((f) => f.command)).toEqual(["bun /h/a.ts", "bun /h/b.ts"]);
        expect(fires[0]!.message).toBe("first said no");
        expect(fires[1]!.message).toBe("second said no too");
    });

    test("accepts session-scoped events with no tool suffix", () => {
        const fires = parseHookBlocksFromText("Stop hook error: [node /h/gate.mjs]: not done yet");
        expect(fires).toHaveLength(1);
        expect(fires[0]!.tool).toBeNull();
        expect(fires[0]!.hookName).toBe("Stop");
    });

    test("keeps an empty message when the hook printed nothing after the prefix", () => {
        const fires = parseHookBlocksFromText("PostToolUse:Edit hook error: [/h/fmt.sh]:");
        expect(fires).toHaveLength(1);
        expect(fires[0]!.message).toBe("");
    });

    test("ignores ordinary tool output, errors included", () => {
        expect(parseHookBlocksFromText("error: command not found: rtk")).toEqual([]);
        expect(parseHookBlocksFromText("Error: ENOENT [/tmp/x]: no such file")).toEqual([]);
        expect(parseHookBlocksFromText(null)).toEqual([]);
        expect(parseHookBlocksFromText("")).toEqual([]);
    });

    test("ignores an unknown event name", () => {
        expect(parseHookBlocksFromText("PreCommitUse:Bash hook error: [x]: nope")).toEqual([]);
    });

    test("does not let a bracket-less message swallow following text", () => {
        const text = "PreToolUse:Bash hook error: [x.sh]: nope\nunrelated line";
        expect(parseHookBlocksFromText(text)[0]!.message).toBe("nope\nunrelated line");
    });
});
