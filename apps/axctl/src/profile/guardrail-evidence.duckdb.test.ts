/**
 * End-to-end regression for #1086: `hook_command_invocation.hook_name` holds
 * the harness EVENT label (e.g. "PreToolUse:Bash"), not the hook's identity -
 * that lives in `command` (e.g. "bun ~/.ax/hooks/enforce-worktree.ts #
 * ax:<id>"). Grouping evidence by `hook_name` collapsed every distinct guard
 * into a handful of event buckets and made `ax profile show`'s guardrail
 * receipts meaningless. This exercises the real query
 * (`fetchGuardrailHookEvidence`) against a published DuckDB snapshot - so the
 * window predicate actually runs - piped into `deriveGuardrailReceipts`, the
 * pure aggregator that matches evidence back to installed hook files.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchGuardrailHookEvidence } from "./queries.ts";
import { deriveGuardrailReceipts } from "./guardrails.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("guardrail evidence", { requireFts: true });

const daysAgo = (d: number): Date => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

const fire = (
    id: string,
    ts: Date,
    opts: {
        readonly eventLabel: string;
        readonly command: string;
        readonly effect: string;
        readonly providerStatus?: string;
    },
) => ({
    id,
    hook_event: `hook_event:${id}`,
    session: "sess-1",
    ts,
    harness: "claude",
    event_name: opts.eventLabel.split(":")[0],
    hook_name: opts.eventLabel,
    tool_call_id: null,
    tool_call: null,
    command: opts.command,
    command_hash: `hash-${id}`,
    provider_status: opts.providerStatus ?? "success",
    effect: opts.effect,
    exit_code: 0,
    duration_ms: 10,
    stdout_excerpt: null,
    stderr_excerpt: null,
    content_excerpt: null,
    blocking_error_excerpt: null,
});

describe("guardrail hook evidence (real DuckDB window + prefix matching)", () => {
    dtest("windows counts correctly and never cross-matches a prefix hook name", async () => {
        const dir = tempDir("guardrail-evidence");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    // Recent, blocked: counts toward "enforce-worktree".
                    yield* write.put("hook_command_invocation", fire("hci:blocked", daysAgo(1), {
                        eventLabel: "PreToolUse:Bash",
                        command: "bun /Users/me/.ax/hooks/enforce-worktree.ts # ax:74da7418",
                        effect: "blocked",
                        providerStatus: "blocking_error",
                    }));
                    // Recent, allowed, SAME hook but a different install (fresh ax
                    // marker) - must aggregate into the same bucket as the fire
                    // above, not a second one.
                    yield* write.put("hook_command_invocation", fire("hci:allowed", daysAgo(2), {
                        eventLabel: "PreToolUse:Bash",
                        command: "bun /Users/me/.ax/hooks/enforce-worktree.ts # ax:ab00cd11",
                        effect: "allowed",
                    }));
                    // Recent, injected_context (warned) for a DIFFERENT hook whose
                    // name is a superstring of the one above - must not fold into
                    // "enforce-worktree".
                    yield* write.put("hook_command_invocation", fire("hci:warned", daysAgo(1), {
                        eventLabel: "PreToolUse:Write",
                        command: "bun /Users/me/.ax/hooks/enforce-worktree-write.ts # ax:9c1a0b2e",
                        effect: "injected_context",
                    }));
                    // Blocked, but OUTSIDE the window - must not count.
                    yield* write.put("hook_command_invocation", fire("hci:old-blocked", daysAgo(60), {
                        eventLabel: "PreToolUse:Bash",
                        command: "bun /Users/me/.ax/hooks/enforce-worktree.ts # ax:74da7418",
                        effect: "blocked",
                        providerStatus: "blocking_error",
                    }));
                    // Recent, but the hook is not installed locally - must be
                    // excluded from the derived receipts entirely.
                    yield* write.put("hook_command_invocation", fire("hci:uninstalled", daysAgo(1), {
                        eventLabel: "PreToolUse:Bash",
                        command: "bun /Users/me/.ax/hooks/retired-guard.ts # ax:deadbeef",
                        effect: "blocked",
                        providerStatus: "blocking_error",
                    }));
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const evidence = await Effect.runPromise(
            fetchGuardrailHookEvidence({ windowDays: 14 }).pipe(Effect.provide(layer)),
        );

        // The 60-day-old fire is outside the 14-day window; everything else is in.
        expect(evidence.reduce((sum, row) => sum + row.fires, 0)).toBe(4);
        // hook_name is never surfaced as the grouping key - the row shape from
        // the real query carries `command`, and no row's `command` is the bare
        // event label a hook_name-keyed regression would have produced.
        for (const row of evidence) {
            expect(row.command).not.toBe("PreToolUse:Bash");
            expect(row.command).not.toBe("PreToolUse:Write");
        }

        const receipts = deriveGuardrailReceipts({
            hookFiles: ["enforce-worktree.ts", "enforce-worktree-write.ts"],
            hookEvidence: evidence,
            verdicts: [],
        });

        expect(receipts).not.toBeNull();
        expect(receipts?.hooks).toEqual([
            { name: "enforce-worktree", fires: 2, blocked: 1, warned: 0 },
            { name: "enforce-worktree-write", fires: 1, blocked: 0, warned: 1 },
        ]);

        // The uninstalled hook's fires never leak into either bucket or inflate
        // a phantom total.
        const totalFires = (receipts?.hooks ?? []).reduce((sum, h) => sum + h.fires, 0);
        expect(totalFires).toBe(3);
    });
});
