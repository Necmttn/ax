import { describe, expect, test } from "bun:test";
import { spanKindForShareTurn } from "./share-inspect.tsx";

type ShareTurn = Parameters<typeof spanKindForShareTurn>[0];

function turn(partial: Partial<ShareTurn>): ShareTurn {
    return {
        id: "turn:test",
        seq: 1,
        role: "user",
        text: "hello",
        ...partial,
    };
}

describe("spanKindForShareTurn", () => {
    test("uses intent_kind to keep slash-command wrappers out of user input", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "task",
            intent_kind: "wrapper_instruction",
            text: "## Your task\nReview the diff.",
        }))).toBe("wrapper_instruction");
    });

    test("uses intent_kind to preserve skill context exported as user role rows", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "context",
            intent_kind: "skill_context",
            text: "Base directory for this skill: ~/.claude/skills/review-all",
        }))).toBe("skill_context");
    });

    test("plain user tasks remain user input", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "task",
            intent_kind: "organic_task",
            text: "lets run review all command",
        }))).toBe("user_input");
    });
});
