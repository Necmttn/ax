import { describe, expect, test } from "bun:test";
import { SkillName } from "@ax/lib/brands";
import { skillRecordKey } from "@ax/lib/skill-id";
// Task 4 flipped these imports from "../derive-signals.ts" to "./core.ts" /
// "./types.ts" - that flip was the before/after behavior-preservation
// harness. Assertions are characterization-pinned; do not edit them.
import {
    deriveCorrections,
    deriveDiagnosticsFromToolCalls,
    deriveFrictionFromCorrections,
    deriveFrictionFromToolCalls,
    deriveProposed,
    deriveRecovered,
    deriveSkillPairs,
    groupTurnsBySession,
    matchNegation,
    shouldDeriveAllTimeSkillPairs,
    skillPairedEdgeId,
    toolCallStableKey,
} from "./core.ts";
import type {
    SessionTurns,
    SkillPairAccum,
    ToolCallLike,
    TurnRow,
} from "./types.ts";

// Fixture skill names are plain string literals; brand them through the
// schema constructor so fixtures stay terse while TurnRow carries SkillName.
const sn = (s: string): SkillName => SkillName.make(s);

const turn = (
    partial: Partial<Omit<TurnRow, "invoked_skills">> &
        Pick<TurnRow, "id" | "seq" | "role"> & {
            invoked_skills?: ReadonlyArray<string>;
        },
): TurnRow => ({
    text_excerpt: undefined,
    ts: "2026-06-01T10:00:00.000Z",
    has_error: false,
    ...partial,
    invoked_skills: (partial.invoked_skills ?? []).map(sn),
});

const bundle = (turns: TurnRow[], meta?: Partial<SessionTurns>): SessionTurns => ({
    sessionId: "0a1b2c3d-1111-2222-3333-444455556666",
    repositoryKey: null,
    checkoutKey: null,
    cwd: null,
    turns,
    ...meta,
});

describe("matchNegation", () => {
    test("hard interrupt marker is the strongest correction signal", () => {
        expect(matchNegation("[Request interrupted by user]")).toBe("interrupted");
        expect(matchNegation("[Request interrupted by user for tool use]")).toBe("interrupted");
    });

    test("word-boundary negations match case-insensitively in the first 200 chars", () => {
        expect(matchNegation("No, use the other parser")).toBe("no");
        expect(matchNegation("stop - that branch is protected")).toBe("stop");
        expect(matchNegation("that's the wrong file")).toBe("wrong");
        expect(matchNegation("wait, that deletes prod data")).toBe("wait");
        expect(matchNegation("you forgot the migration file")).toBe("you forgot");
    });

    test("pattern order decides the label when several match", () => {
        // "actually" precedes "instead" in NEGATION_PATTERNS
        expect(matchNegation("actually, let's use bun instead")).toBe("actually");
        // "no" precedes "wrong"
        expect(matchNegation("no, that's the wrong file")).toBe("no");
    });

    test("word boundaries keep 'no' from firing inside 'node'", () => {
        expect(matchNegation("node looks good, ship it")).toBeNull();
    });

    test("plain approval does not match", () => {
        expect(matchNegation("looks great, ship it")).toBeNull();
    });

    test("negations past the 200-char window are ignored", () => {
        expect(matchNegation(`${"a".repeat(200)} wrong`)).toBeNull();
        expect(matchNegation(`${"a".repeat(190)} wrong`)).toBe("wrong");
    });
});

describe("deriveCorrections", () => {
    const assistant = turn({
        id: { tb: "turn", id: "0a1b2c3d__seq_000003" },
        seq: 3,
        role: "assistant",
        text_excerpt: "I refactored the ingest stage to write directly to the DB.",
        ts: "2026-06-01T10:00:00.000Z",
    });
    const toolResult = turn({
        id: { tb: "turn", id: "0a1b2c3d__seq_000004" },
        seq: 4,
        role: "user", // tool_result user turn: no text_excerpt
    });
    const pushback = turn({
        id: { tb: "turn", id: "0a1b2c3d__seq_000005" },
        seq: 5,
        role: "user",
        text_excerpt: "no, that's the wrong file - the stage lives in derive-signals.ts",
        ts: "2026-06-01T10:00:30.000Z",
    });

    test("user pushback anchors to the last assistant turn, skipping tool_result turns", () => {
        const edges = deriveCorrections(bundle([assistant, toolResult, pushback]));
        expect(edges).toEqual([
            {
                fromTurnKey: "0a1b2c3d__seq_000003",
                toTurnKey: "0a1b2c3d__seq_000005",
                pattern: "no",
                text: "no, that's the wrong file - the stage lives in derive-signals.ts",
                ts: "2026-06-01T10:00:30.000Z",
                repositoryKey: null,
                checkoutKey: null,
                cwd: null,
                correctedSession: "0a1b2c3d-1111-2222-3333-444455556666",
                correctedSeq: 3,
            },
        ]);
    });

    test("a negation before any assistant turn emits nothing", () => {
        expect(deriveCorrections(bundle([pushback]))).toEqual([]);
    });

    test("a text-bearing user turn resets the anchor even without a negation", () => {
        const ack = turn({
            id: { tb: "turn", id: "0a1b2c3d__seq_000004b" },
            seq: 4,
            role: "user",
            text_excerpt: "ok sounds good, continue",
        });
        // assistant -> ack (resets anchor) -> pushback: no anchor left, no edge
        expect(deriveCorrections(bundle([assistant, ack, pushback]))).toEqual([]);
    });

    test("approval text emits nothing", () => {
        const approval = turn({
            id: { tb: "turn", id: "0a1b2c3d__seq_000005c" },
            seq: 5,
            role: "user",
            text_excerpt: "looks great, ship it",
        });
        expect(deriveCorrections(bundle([assistant, approval]))).toEqual([]);
    });
});

describe("deriveProposed", () => {
    const skillNames = ["superpowers:test-driven-development", "diagnose", "tdd"].map(sn);
    const mention = "Run superpowers:test-driven-development first.";

    test("assistant mention of a known skill it did not invoke emits a proposed edge", () => {
        const edges = deriveProposed(
            bundle([
                turn({
                    id: { tb: "turn", id: "0a1b2c3d__seq_000002" },
                    seq: 2,
                    role: "assistant",
                    text_excerpt: mention,
                    ts: "2026-06-01T10:00:00.000Z",
                }),
            ]),
            skillNames,
        );
        expect(edges).toEqual([
            {
                fromTurnKey: "0a1b2c3d__seq_000002",
                skillKey: skillRecordKey(sn("superpowers:test-driven-development")),
                skillName: "superpowers:test-driven-development",
                ts: "2026-06-01T10:00:00.000Z",
                contextExcerpt: mention, // short text: +/-40 chars covers it all
            },
        ]);
    });

    test("already-invoked skills, short names, case mismatches, user turns: no edge", () => {
        const turns = [
            // invoked it -> not "proposed"
            turn({ id: { tb: "turn", id: "t1" }, seq: 1, role: "assistant", text_excerpt: mention, invoked_skills: ["superpowers:test-driven-development"] }),
            // "tdd" mentioned but name.length < 4 -> noise guard
            turn({ id: { tb: "turn", id: "t2" }, seq: 2, role: "assistant", text_excerpt: "Use tdd here." }),
            // case-sensitive: "Diagnose" !== "diagnose"
            turn({ id: { tb: "turn", id: "t3" }, seq: 3, role: "assistant", text_excerpt: "Diagnose the failure first." }),
            // user turns never propose
            turn({ id: { tb: "turn", id: "t4" }, seq: 4, role: "user", text_excerpt: mention }),
        ];
        expect(deriveProposed(bundle(turns), skillNames)).toEqual([]);
    });

    test("empty catalog short-circuits", () => {
        expect(deriveProposed(bundle([turn({ id: "turn:t1", seq: 1, role: "assistant", text_excerpt: mention })]), [])).toEqual([]);
    });
});

describe("deriveSkillPairs", () => {
    const keysSorted = (a: string, b: string): [string, string] => {
        const ka = skillRecordKey(sn(a));
        const kb = skillRecordKey(sn(b));
        return ka < kb ? [ka, kb] : [kb, ka];
    };

    test("skills within 3 seq steps pair undirected; duplicates in one turn dedupe", () => {
        const accum = new Map<string, SkillPairAccum>();
        deriveSkillPairs(
            bundle([
                turn({ id: "turn:t1", seq: 1, role: "assistant", invoked_skills: ["commit", "commit"], ts: "2026-06-01T10:00:00.000Z" }),
                turn({ id: "turn:t2", seq: 4, role: "assistant", invoked_skills: ["diagnose"], ts: "2026-06-01T10:02:00.000Z" }),
                turn({ id: "turn:t3", seq: 8, role: "assistant", invoked_skills: ["retro"], ts: "2026-06-01T10:05:00.000Z" }),
            ]),
            accum,
        );
        // commit<->diagnose (delta 3, in window); diagnose<->retro delta 4: out
        expect(accum.size).toBe(1);
        const [lo, hi] = keysSorted("commit", "diagnose");
        const pair = [...accum.values()][0]!;
        expect(pair).toEqual({ fromKey: lo, toKey: hi, count: 1, lastSeen: "2026-06-01T10:02:00.000Z" });
    });

    test("same-turn co-invocation counts once, never self-pairs", () => {
        const accum = new Map<string, SkillPairAccum>();
        deriveSkillPairs(
            bundle([
                turn({ id: "turn:t1", seq: 1, role: "assistant", invoked_skills: ["alpha-skill", "beta-skill", "alpha-skill"] }),
            ]),
            accum,
        );
        expect(accum.size).toBe(1);
        expect([...accum.values()][0]!.count).toBe(1);
    });

    test("accumulates counts across bundles into the shared map", () => {
        const accum = new Map<string, SkillPairAccum>();
        const b = bundle([
            turn({ id: "turn:t1", seq: 1, role: "assistant", invoked_skills: ["commit"] }),
            turn({ id: "turn:t2", seq: 2, role: "assistant", invoked_skills: ["diagnose"], ts: "2026-06-02T09:00:00.000Z" }),
        ]);
        deriveSkillPairs(b, accum);
        deriveSkillPairs(b, accum);
        expect([...accum.values()][0]!.count).toBe(2);
    });

    test("skillPairedEdgeId is symmetric and orders keys lexicographically", () => {
        const a = skillRecordKey(sn("commit"));
        const b = skillRecordKey(sn("diagnose"));
        const fwd = skillPairedEdgeId(a, b);
        const rev = skillPairedEdgeId(b, a);
        expect(fwd).toEqual(rev);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        expect(fwd.fromKey).toBe(lo);
        expect(fwd.toKey).toBe(hi);
        expect(fwd.edgeId.startsWith(`${lo.slice(0, 24)}__${hi.slice(0, 24)}__`)).toBe(true);
    });
});

describe("deriveRecovered", () => {
    const errorTurn = turn({
        id: { tb: "turn", id: "0a1b2c3d__seq_000002" },
        seq: 2,
        role: "assistant",
        has_error: true,
        text_excerpt: "TypeError: Cannot read properties of undefined (reading 'turns')",
    });

    test("first invocation within 3 seq steps recovers; all skills on that turn emit; later ones don't", () => {
        const edges = deriveRecovered(
            bundle([
                errorTurn,
                turn({ id: { tb: "turn", id: "0a1b2c3d__seq_000004" }, seq: 4, role: "assistant", invoked_skills: ["diagnose", "failure-recovery"], ts: "2026-06-01T10:01:00.000Z" }),
                turn({ id: { tb: "turn", id: "0a1b2c3d__seq_000005" }, seq: 5, role: "assistant", invoked_skills: ["retro"], ts: "2026-06-01T10:02:00.000Z" }),
            ]),
        );
        expect(edges).toEqual([
            {
                fromTurnKey: "0a1b2c3d__seq_000002",
                skillKey: skillRecordKey(sn("diagnose")),
                skillName: "diagnose",
                ts: "2026-06-01T10:01:00.000Z",
                errorExcerpt: "TypeError: Cannot read properties of undefined (reading 'turns')",
            },
            {
                fromTurnKey: "0a1b2c3d__seq_000002",
                skillKey: skillRecordKey(sn("failure-recovery")),
                skillName: "failure-recovery",
                ts: "2026-06-01T10:01:00.000Z",
                errorExcerpt: "TypeError: Cannot read properties of undefined (reading 'turns')",
            },
        ]);
    });

    test("invocations outside the 3-step window do not recover", () => {
        const edges = deriveRecovered(
            bundle([
                errorTurn,
                turn({ id: "turn:t6", seq: 6, role: "assistant", invoked_skills: ["diagnose"] }),
            ]),
        );
        expect(edges).toEqual([]);
    });

    test("no error turns -> nothing", () => {
        expect(
            deriveRecovered(bundle([turn({ id: "turn:t1", seq: 1, role: "assistant", invoked_skills: ["diagnose"] })])),
        ).toEqual([]);
    });
});

describe("deriveFrictionFromCorrections", () => {
    const edge = {
        fromTurnKey: "0a1b2c3d__seq_000003",
        toTurnKey: "0a1b2c3d__seq_000005",
        pattern: "no",
        text: "no, that's the wrong file",
        ts: "2026-06-01T10:00:30.000Z",
        repositoryKey: null as string | null,
        checkoutKey: null as string | null,
        cwd: null as string | null,
        correctedSession: "0a1b2c3d-1111-2222-3333-444455556666",
        correctedSeq: 3,
    };

    test("repository scope wins; event keyed by the correcting turn", () => {
        const [event] = deriveFrictionFromCorrections([
            { ...edge, repositoryKey: "github_com_necmttn_ax", cwd: "/Users/necmttn/Projects/ax" },
        ]);
        expect(event).toMatchObject({
            key: "user_correction__0a1b2c3d__seq_000005",
            kind: "user_correction",
            sessionId: "0a1b2c3d-1111-2222-3333-444455556666",
            turnKey: "0a1b2c3d__seq_000005",
            source: "corrected_by",
            confidence: 0.8,
            text: "no, that's the wrong file",
            ts: "2026-06-01T10:00:30.000Z",
        });
        expect(event!.labels).toMatchObject({
            source: "corrected_by",
            pattern: "no",
            repository: "repository:github_com_necmttn_ax",
            scope: "repository",
            scopeId: "repository:github_com_necmttn_ax",
        });
        expect(event!.metrics).toEqual({ confidence: 0.8 });
        expect(event!.raw).toEqual({
            correctedTurn: "turn:0a1b2c3d__seq_000003",
            correctionTurn: "turn:0a1b2c3d__seq_000005",
            correctedSeq: 3,
        });
    });

    test("checkout scope wins when repository is absent, even with cwd set", () => {
        const [event] = deriveFrictionFromCorrections([
            { ...edge, checkoutKey: "github_com_necmttn_ax__main", cwd: "/Users/necmttn/Projects/ax" },
        ]);
        expect(event!.labels).toMatchObject({
            checkout: "checkout:github_com_necmttn_ax__main",
            scope: "checkout",
            scopeId: "checkout:github_com_necmttn_ax__main",
        });
    });

    test("cwd alone resolves to workspace scope", () => {
        const [event] = deriveFrictionFromCorrections([
            { ...edge, cwd: "/Users/necmttn/Projects/ax" },
        ]);
        expect(event!.labels).toMatchObject({
            scope: "workspace",
            scopeId: "/Users/necmttn/Projects/ax",
        });
    });

    test("falls back to session scope when repo/checkout/cwd are all null", () => {
        const [event] = deriveFrictionFromCorrections([edge]);
        expect(event!.labels).toMatchObject({
            scope: "session",
            scopeId: "0a1b2c3d-1111-2222-3333-444455556666",
        });
    });
});

describe("tool-call derivers", () => {
    const failedCall: ToolCallLike = {
        id: "tool_call:session__call_1",
        session: "session:abc",
        turn: "turn:abc_7",
        name: "exec_command",
        command_norm: "bun test",
        output_excerpt: "1 fail, 2 pass",
        error_text: "Expected 1 failure",
        exit_code: 1,
        has_error: true,
        ts: "2026-05-09T10:00:00.000Z",
    };

    test("failed command derives tool_error friction with command target name", () => {
        const events = deriveFrictionFromToolCalls([failedCall]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: "tool_error__session__call_1",
            kind: "tool_error",
            sessionId: "abc",
            turnKey: "abc_7",
            targetType: "tool",
            targetName: "bun test",
            text: "Expected 1 failure",
            ts: "2026-05-09T10:00:00.000Z",
        });
        expect(events[0]?.labels).toMatchObject({ targetType: "tool", targetName: "bun test" });
        expect(events[0]?.metrics).toMatchObject({ exitCode: 1 });
    });

    // exactOptionalPropertyTypes forbids explicit `undefined` on ToolCallLike's
    // optional props, so "property absent" variants are built via rest-omission.
    const { error_text: _omitErrorText, ...callWithoutErrorText } = failedCall;
    const { command_norm: _omitCommandNorm, ...callWithoutCommandNorm } = failedCall;

    test("failed command derives diagnostic_event shape", () => {
        const events = deriveDiagnosticsFromToolCalls([
            { ...callWithoutErrorText, id: "tool_call:session__call_2", turn: "turn:abc_8", output_excerpt: "TypeScript error", status: "error", ts: "2026-05-09T10:01:00.000Z" },
        ]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: "tool_failure__session__call_2",
            kind: "tool_failure",
            status: "error",
            text: "TypeScript error",
            targetType: "tool",
            targetName: "bun test",
        });
    });

    test("successful calls derive nothing (isFailedToolCall re-check)", () => {
        const ok: ToolCallLike = { ...failedCall, has_error: false, exit_code: 0, status: "ok" };
        expect(deriveFrictionFromToolCalls([ok])).toEqual([]);
        expect(deriveDiagnosticsFromToolCalls([ok])).toEqual([]);
    });

    test("nonzero exit code alone marks the call failed", () => {
        const { has_error: _omitHasError, ...callWithoutFlags } = failedCall;
        const events = deriveFrictionFromToolCalls([{ ...callWithoutFlags, exit_code: 2 }]);
        expect(events).toHaveLength(1);
        expect(events[0]?.metrics).toMatchObject({ exitCode: 2 });
    });

    test("toolCallStableKey: record id wins; deterministic hashed fallback otherwise", () => {
        expect(toolCallStableKey(failedCall, 0)).toBe("session__call_1");
        const noId: ToolCallLike = { session: "session:abc", call_id: "call_42", has_error: true, ts: "2026-05-09T10:00:00.000Z" };
        const k1 = toolCallStableKey(noId, 0);
        const k2 = toolCallStableKey(noId, 5); // index only matters when nothing else identifies the call
        expect(k1).toBe(k2);
        expect(k1.startsWith("abc__call_42__")).toBe(true);
        expect(k1).toMatch(/__[0-9a-f]+$/);
    });

    test("targetName precedence: command_norm > tool_name > tool.name > name", () => {
        expect(deriveFrictionFromToolCalls([failedCall])[0]?.targetName).toBe("bun test");
        expect(
            deriveFrictionFromToolCalls([{ ...callWithoutCommandNorm, tool_name: "Bash" }])[0]?.targetName,
        ).toBe("Bash");
        expect(
            deriveFrictionFromToolCalls([
                { ...callWithoutCommandNorm, tool: { name: "Bash" } },
            ])[0]?.targetName,
        ).toBe("Bash");
        expect(
            deriveFrictionFromToolCalls([callWithoutCommandNorm])[0]?.targetName,
        ).toBe("exec_command");
    });
});

describe("groupTurnsBySession", () => {
    test("string and object session refs normalize to the same bundle; first row wins meta", () => {
        const rows = [
            {
                ...turn({ id: "turn:t1", seq: 1, role: "user", text_excerpt: "fix the parser" }),
                session: "session:⟨0a1b⟩",
                repository: "repository:github_com_necmttn_ax",
                cwd: "/Users/necmttn/Projects/ax",
            },
            {
                // Conflicting meta on a later row: must NOT overwrite row 1's
                // values (pins first-row-wins against last-row-wins drift).
                ...turn({ id: "turn:t2", seq: 2, role: "assistant", text_excerpt: "done" }),
                session: { tb: "session", id: "0a1b" },
                repository: "repository:github_com_other_repo",
                cwd: "/tmp/elsewhere",
            },
        ];
        const bundles = groupTurnsBySession(rows);
        expect(bundles).toHaveLength(1);
        expect(bundles[0]).toMatchObject({
            sessionId: "0a1b",
            repositoryKey: "github_com_necmttn_ax",
            checkoutKey: null,
            cwd: "/Users/necmttn/Projects/ax",
        });
        expect(bundles[0]!.turns).toHaveLength(2);
    });
});

describe("shouldDeriveAllTimeSkillPairs", () => {
    test("skips all-time skill pair aggregate updates for since-scoped derives", () => {
        expect(shouldDeriveAllTimeSkillPairs(undefined)).toBe(true);
        expect(shouldDeriveAllTimeSkillPairs(0)).toBe(true);
        expect(shouldDeriveAllTimeSkillPairs(1)).toBe(false);
    });
});
