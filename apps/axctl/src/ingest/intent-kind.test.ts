import { describe, expect, test } from "bun:test";
import { classifyTurnIntent } from "./intent-kind.ts";

const user = (text: string, messageKind: string | null = "task") =>
    classifyTurnIntent({ role: "user", messageKind, text, source: null });

describe("classifyTurnIntent - correction (true positives)", () => {
    test("short rebuttal with 'no don't'", () => {
        expect(user("no don't mock the DB here")).toBe("correction");
    });
    test("'wait, that's wrong'", () => {
        expect(user("wait, that's the wrong file")).toBe("correction");
    });
    test("'this is wrong'", () => {
        expect(user("this is wrong, revert it")).toBe("correction");
    });
    test("'i was talking about'", () => {
        expect(user("i was talking about the other route")).toBe("correction");
    });
    test("'stop doing X'", () => {
        expect(user("stop adding new commands without updating DB_COMMANDS")).toBe("correction");
    });
});

describe("classifyTurnIntent - correction (false positives we must avoid)", () => {
    test("slash-command body containing the word 'wait' is wrapper_instruction, not correction", () => {
        const body = "## Your task\nMonitor the staging deploy for `` (a SHA, branch name, or empty for current `HEAD`). Report progress live and bail immediately on any failure - do NOT make the user wait 10 minutes for a failure that surfaced at minute 2.\n### Phase 1";
        expect(user(body)).not.toBe("correction");
    });

    test("long /review body containing 'actually' is wrapper_instruction, not correction", () => {
        const body = "## Your task\nScope: `` if provided (PR URL, commit range, or file paths), else `git diff HEAD` (staged + unstaged).\n### Phase 1 - context gathering (skip if diff < 50 lines or non-JS/TS)\nBefore the reviewers run, gather context the diff actually needs.";
        expect(user(body)).not.toBe("correction");
    });

    test("'why did you do that?' as a question is fine - but a long FAQ body with 'why ... ?' is not a correction", () => {
        const body = "Here's the FAQ. Question 1: Why does the deploy take so long? Question 2: Why does the schema migrate on every cold start?".repeat(10);
        expect(user(body)).not.toBe("correction");
    });

    test("organic task that happens to contain 'wait' as a verb is not a correction", () => {
        expect(user("add a wait of 500ms between retries")).not.toBe("correction");
    });
});

describe("classifyTurnIntent - wrapper / control / pasted detection", () => {
    test("slash command tag is control", () => {
        expect(user("<command-name>foo</command-name>", "task")).toBe("control");
    });
    test("text starting with '# /' is wrapper_instruction", () => {
        expect(user("# /review\nHere are the rules…")).toBe("wrapper_instruction");
    });
    test("'## Your task' header is wrapper_instruction", () => {
        expect(user("## Your task\nDo the thing.")).toBe("wrapper_instruction");
    });
});

describe("classifyTurnIntent - preference vs organic", () => {
    test("'i wanna' is preference", () => {
        expect(user("i wanna add a new flag")).toBe("preference");
    });
    test("plain task is organic_task", () => {
        expect(user("add a new endpoint that returns the latest run")).toBe("organic_task");
    });
});
