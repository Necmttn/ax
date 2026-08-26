import { describe, expect, test } from "bun:test";
import { deriveGuardrailReceipts } from "./guardrails.ts";

describe("deriveGuardrailReceipts", () => {
    test("matches hook evidence by the installed hook script embedded in the command", () => {
        expect(deriveGuardrailReceipts({
            hookFiles: ["enforce-worktree.ts", "enforce-worktree-write.ts", "guard.test.ts"],
            hookEvidence: [
                // Recent fires against the real installed command, ax-marker included.
                {
                    command: "bun /Users/me/.ax/hooks/enforce-worktree.ts # ax:74da7418",
                    fires: 10,
                    blocked: 2,
                    warned: 1,
                },
                // A sibling hook whose name shares a prefix - must NOT fold into
                // "enforce-worktree" above.
                {
                    command: "bun /Users/me/.ax/hooks/enforce-worktree-write.ts # ax:9c1a0b2e",
                    fires: 3,
                    blocked: 0,
                    warned: 3,
                },
                // A second install of the same hook (different ax marker id, e.g.
                // after a reinstall) - aggregates into the same bucket.
                {
                    command: "bun /Users/me/.ax/hooks/enforce-worktree.ts # ax:ab00cd11",
                    fires: 5,
                    blocked: 1,
                    warned: 0,
                },
                // Compiled-binary install (.js bundle instead of .ts) still matches
                // the installed ".ts" name.
                {
                    command: "bun /Users/me/.ax/hooks/enforce-worktree.js # ax:5f5f5f5f",
                    fires: 2,
                    blocked: 0,
                    warned: 0,
                },
                // Not installed locally - excluded rather than mis-bucketed.
                {
                    command: "bun /Users/me/.ax/hooks/uninstalled.ts # ax:deadbeef",
                    fires: 99,
                    blocked: 99,
                    warned: 99,
                },
                // The same basename outside the installed hook directory is not
                // evidence for the installed guard.
                {
                    command: "bun /Users/me/project/enforce-worktree.ts",
                    fires: 50,
                    blocked: 50,
                    warned: 0,
                },
                // Multiple installed hook paths have ambiguous attribution.
                {
                    command: "bun /Users/me/.ax/hooks/enforce-worktree.ts /Users/me/.ax/hooks/enforce-worktree-write.ts",
                    fires: 40,
                    blocked: 40,
                    warned: 0,
                },
            ],
            verdicts: [
                { verdict: "adopted", count: 4 },
                { verdict: "ignored", count: 1 },
                { verdict: "regressed", count: 1 },
                { verdict: "partial", count: 2 },
                { verdict: "no_longer_needed", count: 3 },
            ],
        })).toEqual({
            hooks: [
                { name: "enforce-worktree", fires: 17, blocked: 3, warned: 1 },
                { name: "enforce-worktree-write", fires: 3, blocked: 0, warned: 3 },
            ],
            verdicts: {
                worked: 4,
                did_not_work: 2,
                partial: 2,
                no_longer_needed: 3,
            },
        });
    });

    test("omits the receipt block when there are no installed hooks or verdicts", () => {
        expect(deriveGuardrailReceipts({
            hookFiles: [],
            hookEvidence: [
                { command: "bun /Users/me/.ax/hooks/uninstalled.ts # ax:deadbeef", fires: 1, blocked: 1, warned: 0 },
            ],
            verdicts: [],
        })).toBeNull();
    });
});
