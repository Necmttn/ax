/**
 * End-to-end pure pipeline: realistic evidence bundles -> the
 * deriveSignalsFromEvidence composition -> every statement builder in stage
 * write order. Also pins two cross-cutting contracts the per-rule suites
 * can't see:
 *   - the composition stays equivalent to the stage loop's per-bundle
 *     accumulation in derive-signals.ts (composition-drift guard);
 *   - was_corrected UPDATEs target turn ids byte-equal to the ones the
 *     ingest writer RELATEs invoked edges under (the 43e59a58-class
 *     divergence that left was_corrected silently dead).
 */
import { describe, expect, test } from "bun:test";
import { turnRecordKey } from "@ax/lib/ids";
import { skillRecordKey } from "@ax/lib/skill-id";
import { buildNormalizedSyntheticSkillInvocationStatements } from "../normalized/transcripts.ts";
import {
    deriveCorrections,
    deriveDiagnosticsFromToolCalls,
    deriveFrictionFromCorrections,
    deriveFrictionFromToolCalls,
    deriveProposed,
    deriveRecovered,
    deriveSignalsFromEvidence,
    deriveSkillPairs,
} from "./core.ts";
import {
    buildCorrectedByStatements,
    buildDiagnosticEventStatements,
    buildFrictionEventStatements,
    buildProposedStatements,
    buildRecoveredStatements,
    buildSkillPairStatements,
    buildWasCorrectedStatements,
    correctedInvokedTurnKeys,
} from "./statements.ts";
import type { CorrectionEdge, SessionTurns, SignalEvidence, SkillPairAccum, ToolCallLike } from "./types.ts";

// One Claude-shaped session exercising every rule at once:
//   seq 1 user task -> seq 2 assistant proposes a skill + errors ->
//   seq 3 assistant invokes diagnose (recovery + pair partner) ->
//   seq 4 assistant invokes commit (pairs with diagnose) ->
//   seq 5 tool_result user turn (no text) -> seq 6 user pushback ("no").
const session: SessionTurns = {
    sessionId: "0a1b2c3d-1111-2222-3333-444455556666",
    repositoryKey: "github_com_necmttn_ax",
    checkoutKey: null,
    cwd: "/Users/necmttn/Projects/ax",
    turns: [
        { id: { tb: "turn", id: "s1_1" }, seq: 1, role: "user", text_excerpt: "fix the failing ingest test", ts: "2026-06-01T10:00:00.000Z", has_error: false, invoked_skills: [] },
        { id: { tb: "turn", id: "s1_2" }, seq: 2, role: "assistant", text_excerpt: "I'd start with superpowers:systematic-debugging here. TypeError: x is not a function", ts: "2026-06-01T10:00:10.000Z", has_error: true, invoked_skills: [] },
        { id: { tb: "turn", id: "s1_3" }, seq: 3, role: "assistant", text_excerpt: "running diagnose", ts: "2026-06-01T10:00:20.000Z", has_error: false, invoked_skills: ["diagnose"] },
        { id: { tb: "turn", id: "s1_4" }, seq: 4, role: "assistant", text_excerpt: "committing", ts: "2026-06-01T10:00:30.000Z", has_error: false, invoked_skills: ["commit"] },
        { id: { tb: "turn", id: "s1_5" }, seq: 5, role: "user", text_excerpt: undefined, ts: "2026-06-01T10:00:40.000Z", has_error: false, invoked_skills: [] },
        { id: { tb: "turn", id: "s1_6" }, seq: 6, role: "user", text_excerpt: "no - you fixed the wrong test", ts: "2026-06-01T10:00:50.000Z", has_error: false, invoked_skills: [] },
    ],
};

// A second session: string record-ids, a same-turn skill pair that
// accumulates onto session 1's diagnose/commit edge, and a "wait" pushback.
const session2: SessionTurns = {
    sessionId: "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff",
    repositoryKey: null,
    checkoutKey: null,
    cwd: null,
    turns: [
        { id: "turn:s2_1", seq: 1, role: "user", text_excerpt: "ship it", ts: "2026-06-02T09:00:00.000Z", has_error: false, invoked_skills: [] },
        { id: "turn:s2_2", seq: 2, role: "assistant", text_excerpt: "diagnosing then committing", ts: "2026-06-02T09:00:10.000Z", has_error: false, invoked_skills: ["diagnose", "commit"] },
        { id: "turn:s2_3", seq: 3, role: "user", text_excerpt: "wait, hold on", ts: "2026-06-02T09:00:20.000Z", has_error: false, invoked_skills: [] },
    ],
};

const failedToolCalls: ToolCallLike[] = [
    {
        id: "tool_call:s1__call_1",
        session: "session:0a1b2c3d-1111-2222-3333-444455556666",
        turn: "turn:s1_2",
        name: "exec_command",
        command_norm: "bun test",
        error_text: "TypeError: x is not a function",
        exit_code: 1,
        has_error: true,
        ts: "2026-06-01T10:00:10.000Z",
    },
];

const skillNames = ["superpowers:systematic-debugging", "diagnose", "commit"];

describe("deriveSignalsFromEvidence -> statement builders (stage write order)", () => {
    test("full pipeline on one realistic session", () => {
        const derived = deriveSignalsFromEvidence(
            { bundles: [session], skillNames, failedToolCalls },
            { includeSkillPairs: true },
        );

        expect(derived.turnCount).toBe(6);
        // rule 1: pushback at seq 6 anchored to the assistant turn at seq 4
        // (the tool_result user turn at seq 5 must not reset the anchor)
        expect(derived.corrections).toHaveLength(1);
        expect(derived.corrections[0]).toMatchObject({ fromTurnKey: "s1_4", toTurnKey: "s1_6", pattern: "no", correctedSeq: 4 });
        // rule 4: mentioned superpowers:systematic-debugging, never invoked it
        expect(derived.proposed).toHaveLength(1);
        expect(derived.proposed[0]).toMatchObject({ fromTurnKey: "s1_2", skillKey: skillRecordKey("superpowers:systematic-debugging") });
        // rule 6: error at seq 2 recovered by diagnose at seq 3
        expect(derived.recoveries).toHaveLength(1);
        expect(derived.recoveries[0]).toMatchObject({ fromTurnKey: "s1_2", skillKey: skillRecordKey("diagnose") });
        // rule 5: diagnose (seq 3) + commit (seq 4) pair within the window
        expect(derived.skillPairs).toHaveLength(1);
        expect(derived.skillPairs[0]).toMatchObject({ pair: { count: 1, lastSeen: "2026-06-01T10:00:30.000Z" } });
        // rules 3 + 7: one tool_error + one user_correction friction
        expect(derived.frictionEvents.map((e) => e.kind).sort()).toEqual(["tool_error", "user_correction"]);
        // rule 8: one diagnostic
        expect(derived.diagnosticEvents).toHaveLength(1);
        expect(derived.diagnosticEvents[0]?.kind).toBe("tool_failure");

        // statement layer, in stage write order
        const stmts = [
            ...buildCorrectedByStatements(derived.corrections),
            ...buildWasCorrectedStatements(correctedInvokedTurnKeys(derived.corrections)),
            ...buildProposedStatements(derived.proposed),
            ...buildSkillPairStatements(derived.skillPairs),
            ...buildRecoveredStatements(derived.recoveries),
            ...buildFrictionEventStatements(derived.frictionEvents),
            ...buildDiagnosticEventStatements(derived.diagnosticEvents),
        ];
        // 1 corrected_by + 4 was_corrected (seqs 1..4) + 1 proposed + 1 pair
        // + 1 recovered + 2 friction + 1 diagnostic
        expect(stmts).toHaveLength(11);
        expect(stmts[0]).toContain("-> corrected_by:`s1_4__s1_6` ->");
        expect(stmts.filter((s) => s.startsWith("UPDATE invoked SET was_corrected = true"))).toHaveLength(4);
        expect(stmts.filter((s) => s.startsWith("UPSERT friction_event:"))).toHaveLength(2);
        expect(stmts.filter((s) => s.startsWith("UPSERT diagnostic_event:"))).toHaveLength(1);
    });

    test("includeSkillPairs=false (since-scoped derive) suppresses pairs only - all else identical", () => {
        const evidence: SignalEvidence = { bundles: [session, session2], skillNames, failedToolCalls };
        const withPairs = deriveSignalsFromEvidence(evidence, { includeSkillPairs: true });
        const withoutPairs = deriveSignalsFromEvidence(evidence, { includeSkillPairs: false });
        expect(withPairs.skillPairs.length).toBeGreaterThan(0);
        expect(withoutPairs.skillPairs).toEqual([]);
        expect(withoutPairs).toEqual({ ...withPairs, skillPairs: [] });
    });

    test("composition matches the stage loop's per-bundle accumulation", () => {
        // Mirror of the bundle loop in derive-signals.ts (same per-rule
        // functions, per-bundle, one shared pairs accumulator). If the
        // composition in core.ts ever diverges from what the stage
        // accumulates, this deep-equal breaks.
        const evidence: SignalEvidence = { bundles: [session, session2], skillNames, failedToolCalls };
        const corrections: CorrectionEdge[] = [];
        const proposed = [];
        const recoveries = [];
        const pairsAccum = new Map<string, SkillPairAccum>();
        let turnCount = 0;
        for (const bundle of evidence.bundles) {
            turnCount += bundle.turns.length;
            corrections.push(...deriveCorrections(bundle));
            proposed.push(...deriveProposed(bundle, evidence.skillNames));
            recoveries.push(...deriveRecovered(bundle));
            deriveSkillPairs(bundle, pairsAccum);
        }
        const stageAccumulated = {
            corrections,
            proposed,
            recoveries,
            skillPairs: [...pairsAccum.entries()].map(([edgeId, pair]) => ({ edgeId, pair })),
            frictionEvents: [
                ...deriveFrictionFromToolCalls(evidence.failedToolCalls),
                ...deriveFrictionFromCorrections(corrections),
            ],
            diagnosticEvents: deriveDiagnosticsFromToolCalls(evidence.failedToolCalls),
            turnCount,
        };
        expect(deriveSignalsFromEvidence(evidence, { includeSkillPairs: true })).toEqual(stageAccumulated);
        // Cross-bundle accumulation: both sessions fired the diagnose/commit
        // pair, so the single undirected edge carries count 2 and the later ts.
        expect(stageAccumulated.skillPairs).toHaveLength(1);
        expect(stageAccumulated.skillPairs[0]).toMatchObject({ pair: { count: 2, lastSeen: "2026-06-02T09:00:10.000Z" } });
    });
});

describe("was_corrected turn-key contract with the ingest writer", () => {
    test("UPDATE targets are byte-equal to the turn ids the writer RELATEs invoked edges under", () => {
        const derived = deriveSignalsFromEvidence(
            { bundles: [session], skillNames, failedToolCalls: [] },
            { includeSkillPairs: false },
        );
        const updates = buildWasCorrectedStatements(correctedInvokedTurnKeys(derived.corrections));

        // The same (session, seq) the correction marks - written by the
        // ingest path that RELATEs turn->invoked->skill edges.
        const writerStmts = buildNormalizedSyntheticSkillInvocationStatements([
            { sessionId: session.sessionId, seq: 4, ts: "2026-06-01T10:00:30.000Z", skillName: "commit" },
        ]);
        const relate = writerStmts.find((s) => s.includes("->invoked:"));
        const turnRef = `turn:\`${turnRecordKey(session.sessionId, 4)}\``;
        expect(relate).toStartWith(`RELATE ${turnRef}->invoked:`);
        expect(updates).toContain(
            `UPDATE invoked SET was_corrected = true WHERE in = ${turnRef} RETURN NONE;`,
        );
        // Full window for correctedSeq 4: seqs 1..4, centralized key format.
        expect(correctedInvokedTurnKeys(derived.corrections)).toEqual(
            [1, 2, 3, 4].map((seq) => turnRecordKey(session.sessionId, seq)),
        );
    });

    const correctionAtSeq = (correctedSeq: number): CorrectionEdge => ({
        fromTurnKey: "s1_x",
        toTurnKey: "s1_y",
        pattern: "no",
        text: "no",
        ts: "2026-06-01T10:00:50.000Z",
        repositoryKey: null,
        checkoutKey: null,
        cwd: null,
        correctedSession: session.sessionId,
        correctedSeq,
    });

    test("window clamps at seq 1 - a correction on the first turn marks only that turn", () => {
        expect(correctedInvokedTurnKeys([correctionAtSeq(1)])).toEqual([
            turnRecordKey(session.sessionId, 1),
        ]);
    });

    test("large seq expands the full inclusive [seq-3, seq] window", () => {
        expect(correctedInvokedTurnKeys([correctionAtSeq(250)])).toEqual(
            [247, 248, 249, 250].map((seq) => turnRecordKey(session.sessionId, seq)),
        );
    });
});
