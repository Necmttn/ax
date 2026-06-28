import { describe, expect, test } from "bun:test";
import { deriveGuardrailReceipts } from "./guardrails.ts";

describe("deriveGuardrailReceipts", () => {
    test("matches hook evidence by normalized installed hook name", () => {
        expect(deriveGuardrailReceipts({
            hookFiles: ["enforce-worktree.ts", "enforce-worktree-write.ts", "guard.test.ts"],
            hookEvidence: [
                { hook_name: "/Users/me/.ax/hooks/enforce-worktree.ts", fires: 10, blocked: 2, warned: 1 },
                { hook_name: "enforce-worktree-write.js", fires: 3, blocked: 0, warned: 3 },
                { hook_name: "uninstalled.ts", fires: 99, blocked: 99, warned: 99 },
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
                { name: "enforce-worktree", fires: 10, blocked: 2, warned: 1 },
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
                { hook_name: "uninstalled.ts", fires: 1, blocked: 1, warned: 0 },
            ],
            verdicts: [],
        })).toBeNull();
    });
});
