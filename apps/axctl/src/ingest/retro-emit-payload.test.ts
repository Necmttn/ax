import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
    decodeRetroEmitPayload,
    hasUnfiledFindings,
    type RetroEmitPayload,
} from "./retro-emit-payload.ts";

const decode = (raw: unknown) => Effect.runSyncExit(decodeRetroEmitPayload(raw));

const skillProposal = {
    form: "skill",
    title: "Pre-Bash worktree guard",
    hypothesis: "Bash failures cluster on main-branch writes",
    confidence: "medium",
    payload: {
        trigger_pattern: "git write on main",
        suspected_gap: "no guard before the write",
        proposed_behavior: "block and suggest a worktree",
    },
};

describe("decodeRetroEmitPayload", () => {
    test("the pre-existing four-field payload still decodes", () => {
        const exit = decode({ tried: "reviewed 12 sessions", failed: "flaky", next: "guard" });
        expect(Exit.isSuccess(exit)).toBe(true);
    });

    test("accepts proposals in the improve-propose shape", () => {
        const exit = decode({ tried: "t", proposals: [skillProposal] });
        expect(Exit.isSuccess(exit)).toBe(true);
        if (!Exit.isSuccess(exit)) return;
        expect(exit.value.proposals).toHaveLength(1);
        expect(exit.value.proposals![0]!.form).toBe("skill");
    });

    test("rejects a malformed proposal instead of dropping it", () => {
        // A dropped finding is the bug being fixed - this must be loud.
        const exit = decode({ tried: "t", proposals: [{ form: "skill", title: "x" }] });
        expect(Exit.isSuccess(exit)).toBe(false);
    });

    test("rejects an unknown proposal form", () => {
        expect(Exit.isSuccess(decode({ tried: "t", proposals: [{ ...skillProposal, form: "essay" }] }))).toBe(false);
    });

    test("still requires tried", () => {
        expect(Exit.isSuccess(decode({ failed: "something" }))).toBe(false);
    });
});

describe("hasUnfiledFindings", () => {
    const base = { tried: "t" } as RetroEmitPayload;

    test("substantive failed text with no proposals is an open loop", () => {
        expect(hasUnfiledFindings({
            ...base,
            failed: "the agent re-read the same three files after every Bash call",
        })).toBe(true);
    });

    test("substantive next text with no proposals is an open loop", () => {
        expect(hasUnfiledFindings({
            ...base,
            next: "package a pre-Bash guard; this recurred in four separate sessions",
        })).toBe(true);
    });

    test("filing a proposal closes it", () => {
        expect(hasUnfiledFindings({
            ...base,
            failed: "the agent re-read the same three files after every Bash call",
            proposals: [skillProposal as never],
        })).toBe(false);
    });

    test("a thin or absent finding does not nag", () => {
        expect(hasUnfiledFindings(base)).toBe(false);
        expect(hasUnfiledFindings({ ...base, failed: "flaky" })).toBe(false);
    });
});
