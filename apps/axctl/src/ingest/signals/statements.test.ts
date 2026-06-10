import { describe, expect, test } from "bun:test";
import type { CorrectionEdge, DerivedDiagnosticEvent, DerivedFrictionEvent } from "./types.ts";
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

const correction: CorrectionEdge = {
    fromTurnKey: "s1__seq_000003",
    toTurnKey: "s1__seq_000005",
    pattern: "no",
    text: "no, wrong file",
    ts: "2026-06-01T10:00:30.000Z",
    repositoryKey: null,
    checkoutKey: null,
    cwd: null,
    correctedSession: "0a1b-2c3d",
    correctedSeq: 3,
};

describe("buildCorrectedByStatements", () => {
    test("idempotent RELATE with deterministic from__to edge id", () => {
        expect(buildCorrectedByStatements([correction])).toEqual([
            'RELATE turn:`s1__seq_000003` -> corrected_by:`s1__seq_000003__s1__seq_000005` -> turn:`s1__seq_000005` SET pattern = "no", ts = d"2026-06-01T10:00:30.000Z";',
        ]);
    });

    test("empty in, empty out", () => {
        expect(buildCorrectedByStatements([])).toEqual([]);
    });
});

describe("correctedInvokedTurnKeys + buildWasCorrectedStatements", () => {
    // Keys are turnRecordKey(correctedSession, seq) - the format ingest
    // writers RELATE invoked edges under since 43e59a58. The old inline
    // `${sess-without-dashes}_${seq}` synth matched zero rows (dead
    // was_corrected bug); these goldens pin the fixed format.
    test("expands the inclusive [seq-3, seq] window as centralized turn keys, clamped at 1", () => {
        // correctedSeq 3 -> lo = max(1, 0) = 1 -> seqs 1..3
        expect(correctedInvokedTurnKeys([correction])).toEqual([
            "0a1b_2c3d__972912600f45e9d0__seq_000001",
            "0a1b_2c3d__972912600f45e9d0__seq_000002",
            "0a1b_2c3d__972912600f45e9d0__seq_000003",
        ]);
    });

    test("overlapping corrections dedupe to one UPDATE per turn", () => {
        const keys = correctedInvokedTurnKeys([correction, { ...correction, correctedSeq: 4 }]);
        expect(keys).toEqual([
            "0a1b_2c3d__972912600f45e9d0__seq_000001",
            "0a1b_2c3d__972912600f45e9d0__seq_000002",
            "0a1b_2c3d__972912600f45e9d0__seq_000003",
            "0a1b_2c3d__972912600f45e9d0__seq_000004",
        ]);
        expect(buildWasCorrectedStatements(keys)[0]).toBe(
            "UPDATE invoked SET was_corrected = true WHERE in = turn:`0a1b_2c3d__972912600f45e9d0__seq_000001` RETURN NONE;",
        );
        expect(buildWasCorrectedStatements(keys)).toHaveLength(4);
    });
});

describe("buildProposedStatements", () => {
    test("RELATE turn -> proposed -> skill with ts + context excerpt", () => {
        expect(
            buildProposedStatements([
                {
                    fromTurnKey: "s1__seq_000002",
                    skillKey: "superpowers__test_driven_development",
                    skillName: "superpowers:test-driven-development",
                    ts: "2026-06-01T10:00:00.000Z",
                    contextExcerpt: "Run superpowers:test-driven-development first.",
                },
            ]),
        ).toEqual([
            'RELATE turn:`s1__seq_000002` -> proposed:`s1__seq_000002__superpowers__test_driven_development` -> skill:`superpowers__test_driven_development` SET ts = d"2026-06-01T10:00:00.000Z", context_excerpt = "Run superpowers:test-driven-development first.";',
        ]);
    });
});

describe("buildSkillPairStatements", () => {
    test("RELATE skill -> skill_paired -> skill with count + last_seen, edge id carried per entry", () => {
        expect(
            buildSkillPairStatements([
                {
                    edgeId: "a_skill__b_skill__deadbeef1234",
                    pair: { fromKey: "a_skill", toKey: "b_skill", count: 3, lastSeen: "2026-06-01T10:02:00.000Z" },
                },
            ]),
        ).toEqual([
            'RELATE skill:`a_skill` -> skill_paired:`a_skill__b_skill__deadbeef1234` -> skill:`b_skill` SET count = 3, last_seen = d"2026-06-01T10:02:00.000Z";',
        ]);
    });
});

describe("buildRecoveredStatements", () => {
    test("RELATE turn -> recovered_by -> skill with error excerpt", () => {
        expect(
            buildRecoveredStatements([
                {
                    fromTurnKey: "s1__seq_000002",
                    skillKey: "diagnose",
                    skillName: "diagnose",
                    ts: "2026-06-01T10:01:00.000Z",
                    errorExcerpt: "TypeError: x is not a function",
                },
            ]),
        ).toEqual([
            'RELATE turn:`s1__seq_000002` -> recovered_by:`s1__seq_000002__diagnose` -> skill:`diagnose` SET ts = d"2026-06-01T10:01:00.000Z", error_excerpt = "TypeError: x is not a function";',
        ]);
    });

    test("missing excerpt serializes as NONE", () => {
        const [stmt] = buildRecoveredStatements([
            { fromTurnKey: "s1__seq_000002", skillKey: "diagnose", skillName: "diagnose", ts: "2026-06-01T10:01:00.000Z", errorExcerpt: undefined },
        ]);
        expect(stmt).toContain("error_excerpt = NONE;");
    });
});

const frictionEvent: DerivedFrictionEvent = {
    key: "tool_error__abc__call_1",
    kind: "tool_error",
    sessionId: "abc",
    turnKey: "abc_7",
    text: "Expected 1 failure",
    labels: { source: "derive_signals" },
    metrics: { confidence: 1 },
    raw: { status: "error" },
    ts: "2026-05-09T10:00:00.000Z",
};

describe("buildFrictionEventStatements", () => {
    test("UPSERT ... MERGE with JSON-text labels/metrics/raw (exact golden)", () => {
        expect(buildFrictionEventStatements([frictionEvent])).toEqual([
            'UPSERT friction_event:`tool_error__abc__call_1` MERGE { session: session:`abc`, turn: turn:`abc_7`, kind: "tool_error", text: "Expected 1 failure", labels: "{\\"source\\":\\"derive_signals\\"}", metrics: "{\\"confidence\\":1}", raw: "{\\"status\\":\\"error\\"}", ts: d"2026-05-09T10:00:00.000Z" };',
        ]);
    });

    test("null session/turn serialize as NONE", () => {
        const [stmt] = buildFrictionEventStatements([{ ...frictionEvent, sessionId: null, turnKey: null }]);
        expect(stmt).toContain("session: NONE, turn: NONE,");
    });
});

describe("buildDiagnosticEventStatements", () => {
    test("UPSERT ... MERGE carries status between kind and text", () => {
        const event: DerivedDiagnosticEvent = { ...frictionEvent, key: "tool_failure__abc__call_1", kind: "tool_failure", status: "error" };
        const [stmt] = buildDiagnosticEventStatements([event]);
        expect(stmt).toContain("UPSERT diagnostic_event:`tool_failure__abc__call_1` MERGE { ");
        expect(stmt).toContain('kind: "tool_failure", status: "error", text: "Expected 1 failure"');
        expect(stmt).toContain('ts: d"2026-05-09T10:00:00.000Z" };');
    });
});
