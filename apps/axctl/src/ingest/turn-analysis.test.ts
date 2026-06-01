import { describe, expect, test } from "bun:test";
import {
    buildTurnAnalysisStatements,
    classifyTurnAnalysis,
    deriveTurnAnalysisRows,
    semanticSignalKey,
} from "./turn-analysis.ts";

const row = (overrides: Partial<Parameters<typeof classifyTurnAnalysis>[0]> = {}) => ({
    id: "turn:`s__seq_000001`",
    session: "session:`s`",
    seq: 1,
    role: "user",
    source: "codex",
    message_kind: "task",
    intent_kind: "organic_task",
    text_excerpt: "hello",
    text: "hello",
    ts: "2026-05-30T00:00:00.000Z",
    ...overrides,
});

describe("classifyTurnAnalysis", () => {
    test("classifies user corrections and promotes wrong-target signal", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "no that's the wrong file",
        }), "assistant_turn");

        expect(analysis.act).toBe("correction");
        expect(analysis.polarity).toBe("revise");
        expect(analysis.semanticSignal?.key).toBe(semanticSignalKey("correction", "wrong_target"));
        expect(analysis.reactsToTurnKey).toBe("assistant_turn");
    });

    test("splits review-requested fixes out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "Spec review requested a Task 2 fix. Finding: SECRET_ASSIGNMENT_PATTERN misses env keys.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("review_fix_request");
    });

    test("splits missing navigation/link corrections out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "alright we have docs but there's no link from the landing.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("missing_link_or_navigation");
    });

    test("splits simplify-copy corrections out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "this took me some time to digest too, unnecessarilly complex formulation.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("simplify_output");
    });

    test("splits factual clarifications out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "when i said durable i meant durable-stream package check the quera codebase how i use it.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("factual_clarification");
    });

    test("splits UX polish direction out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "the delete motion doesn't feel native, there's no curve and I want it to feel native.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("ux_polish_direction");
    });

    test("splits product content direction out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "we need to hint on the landing how we are actually getting this data from the graph.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("product_content_direction");
    });

    test("splits iteration cadence corrections out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "t+7, t+30, t+90 are too long in the era of AI, it should be shorter iterations.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("iteration_cadence");
    });

    test("splits capability corrections out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "No mate, review all is a skill that you can run.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("capability_correction");
    });

    test("splits interaction pattern corrections out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "hold the button, drag up and down, and when you release it goes to that page.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("interaction_pattern");
    });

    test("splits implementation preference corrections out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "clear all migrations and create one from scratch, the app is not live yet.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("implementation_preference");
    });

    test("splits runtime state corrections out of generic corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "well backend is down no?",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).toBe("runtime_state_correction");
    });

    test("does not treat hedged don't-need phrasing as stop_doing", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "we don't necessarily need a dedicated page, but it needs a little hint on the landing.",
        }), "assistant_turn");

        expect(analysis.semanticSignal?.label).not.toBe("stop_doing");
    });

    test("classifies approvals as accepting the previous assistant turn", () => {
        const analysis = classifyTurnAnalysis(row({ text_excerpt: "looks good" }), "assistant_turn");

        expect(analysis.act).toBe("approval");
        expect(analysis.sentiment).toBe("positive");
        expect(analysis.polarity).toBe("accept");
        expect(analysis.reactsToTurnKey).toBe("assistant_turn");
    });

    test("classifies exploration without target reaction edge", () => {
        const analysis = classifyTurnAnalysis(row({ text_excerpt: "can we explore sentiment analysis?" }), "assistant_turn");

        expect(analysis.act).toBe("exploration");
        expect(analysis.polarity).toBe("explore");
        expect(analysis.reactsToTurnKey).toBeNull();
    });

    test("does not promote AGENTS context as a correction signal", () => {
        const analysis = classifyTurnAnalysis(row({
            message_kind: "context",
            intent_kind: "correction",
            text_excerpt: "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\ndo not revert user changes\n</INSTRUCTIONS>",
        }), "assistant_turn");

        expect(analysis.act).toBe("other");
        expect(analysis.polarity).toBe("none");
        expect(analysis.semanticSignal).toBeNull();
        expect(analysis.reactsToTurnKey).toBeNull();
    });

    test("does not promote subagent notifications as verification requests", () => {
        const analysis = classifyTurnAnalysis(row({
            text_excerpt: "<subagent_notification>Tests passed. Check output when ready.</subagent_notification>",
        }), "assistant_turn");

        expect(analysis.act).toBe("other");
        expect(analysis.semanticSignal).toBeNull();
    });

    test("does not promote skill dumps as user asks", () => {
        const analysis = classifyTurnAnalysis(row({
            text_excerpt: "<skill>\n<name>improve-codebase-architecture</name>\n<path>/Users/me/.agents/skills/improve-codebase-architecture/SKILL.md</path>\n</skill>",
        }), "assistant_turn");

        expect(analysis.act).toBe("other");
        expect(analysis.semanticSignal).toBeNull();
    });

    test("does not promote subagent task prompts as human asks", () => {
        const analysis = classifyTurnAnalysis(row({
            source: "claude-subagent",
            text_excerpt: "Implement Task 9 of the Gist-backed session sharing plan in the isolated worktree.",
        }), "assistant_turn");

        expect(analysis.act).toBe("other");
        expect(analysis.semanticSignal).toBeNull();
    });

    test("treats review-only task prompts as wrapper context, not corrections", () => {
        const analysis = classifyTurnAnalysis(row({
            intent_kind: "correction",
            text_excerpt: "Code quality review for Task 6 in worktree /repo.\n\nDo not edit files. Review only.\n\nScope:\n- src/cli/share.ts\n- src/cli/share.test.ts",
        }), "assistant_turn");

        expect(analysis.act).toBe("other");
        expect(analysis.semanticSignal).toBeNull();
        expect(analysis.reactsToTurnKey).toBeNull();
    });

    test("classifies assistant blockers and verification claims", () => {
        const blocked = classifyTurnAnalysis(row({
            role: "assistant",
            message_kind: "assistant",
            text_excerpt: "I cannot run tests because the database is unavailable.",
        }));
        const verified = classifyTurnAnalysis(row({
            role: "assistant",
            message_kind: "assistant",
            text_excerpt: "Verified with bun test and typecheck.",
        }));

        expect(blocked.act).toBe("blocker");
        expect(blocked.semanticSignal?.label).toBe("agent_blocked");
        expect(verified.act).toBe("verification");
        expect(verified.semanticSignal?.label).toBe("verification_claim");
    });

    test("separates assistant verification intent from verification claims", () => {
        const intent = classifyTurnAnalysis(row({
            role: "assistant",
            message_kind: "assistant",
            text_excerpt: "I’m checking the worktree state and then I’ll run tests.",
        }));

        expect(intent.act).toBe("verification");
        expect(intent.semanticSignal?.label).toBe("verification_intent");
    });

    test("derives reaction edges from user turns to nearest previous assistant turn", () => {
        const analyses = deriveTurnAnalysisRows([
            row({ id: "turn:`assistant_1`", role: "assistant", message_kind: "assistant", seq: 1, text_excerpt: "Implemented it." }),
            row({ id: "turn:`user_2`", role: "user", seq: 2, text_excerpt: "no wrong file", intent_kind: "correction" }),
        ]);

        expect(analyses[1]?.reactsToTurnKey).toBe("assistant_1");
    });
});

describe("buildTurnAnalysisStatements", () => {
    test("writes analysis, semantic signal, expresses edge, and reacts_to edge", () => {
        const analysis = classifyTurnAnalysis(row({
            id: "turn:`user_2`",
            text_excerpt: "no wrong file",
            intent_kind: "correction",
        }), "assistant_1");

        const sql = buildTurnAnalysisStatements([analysis]).join("\n");

        expect(sql).toContain("UPSERT turn_analysis:`user_2`");
        expect(sql).toContain("UPSERT semantic_signal:`correction__wrong_target`");
        expect(sql).toContain("->expresses:");
        expect(sql).toContain("->reacts_to:");
        expect(sql).toContain("signal = semantic_signal:`correction__wrong_target`");
    });

    test("aggregates semantic signal time bounds before writing", () => {
        const early = classifyTurnAnalysis(row({
            id: "turn:`user_1`",
            text_excerpt: "no wrong file",
            intent_kind: "correction",
            ts: "2026-05-29T00:00:00.000Z",
        }), "assistant_1");
        const late = classifyTurnAnalysis(row({
            id: "turn:`user_2`",
            text_excerpt: "no wrong route",
            intent_kind: "correction",
            ts: "2026-05-30T00:00:00.000Z",
        }), "assistant_2");

        const sql = buildTurnAnalysisStatements([late, early]).join("\n");

        expect(sql).toContain('first_seen: d"2026-05-29T00:00:00.000Z"');
        expect(sql).toContain('last_seen: d"2026-05-30T00:00:00.000Z"');
    });
});
