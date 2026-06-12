import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
    SkillDetailPayload,
    SkillSourcePayload,
    SkillTriageResponse,
} from "@ax/lib/shared/api-contract";

/**
 * Encode regression for the skills-family payloads (Schema.Struct, not Class -
 * see recall-encode.test.ts for why). Plain objects matching the
 * dashboard-types interfaces must encode losslessly; a missing field would be
 * silently dropped from the response, so these pin the full field set.
 */
describe("skills payload encode", () => {
    test("SkillTriageResponse round-trips a fully-populated entry", async () => {
        const value = {
            generatedAt: "2026-01-01T00:00:00Z",
            skills: [{
                name: "tdd", scope: "user", description: null, dir_path: "/d", bytes: 12,
                total_inv: 3, inv_7d: 1, inv_30d: 2, last_used: null, last_project: null,
                corrections: 0, proposals: 0, commits_after: 0, taste_score: 1.5,
                recommendation: "keep" as const, recommendation_reason: "used often",
                decision: { skill_name: "tdd", decision: "keep" as const, reason: null, decided_at: "2026-01-01T00:00:00Z" },
            }],
        };
        const back = await Effect.runPromise(
            Schema.encodeUnknownEffect(Schema.toCodecJson(SkillTriageResponse))(value),
        ) as typeof value;
        expect(back.skills[0]?.taste_score).toBe(1.5);
        expect(back.skills[0]?.decision?.decision).toBe("keep");
    });

    test("SkillDetailPayload round-trips nested invocations + arrays", async () => {
        const value = {
            name: "tdd", scope: "user", description: null, dir_path: null,
            invocations: { total: 5, d7: 1, d30: 3, last: null },
            recent: [{ ts: "2026-01-01T00:00:00Z", project: null, turn_has_error: true }],
            corrections: [], proposals: [{ ts: "2026-01-01T00:00:00Z", project: null }],
            paired: [{ partner: "debugging", count: 2, last_seen: null }],
        };
        const back = await Effect.runPromise(
            Schema.encodeUnknownEffect(Schema.toCodecJson(SkillDetailPayload))(value),
        ) as typeof value;
        expect(back.invocations.total).toBe(5);
        expect(back.recent[0]?.turn_has_error).toBe(true);
        expect(back.paired[0]?.partner).toBe("debugging");
    });

    test("SkillSourcePayload round-trips the state literal", async () => {
        const value = {
            name: "tdd", scope: "user", dir_path: "/d", file_path: "/d/SKILL.md",
            frontmatter: "x", body: "y", state: "active" as const, editable: true, error: null,
        };
        const back = await Effect.runPromise(
            Schema.encodeUnknownEffect(Schema.toCodecJson(SkillSourcePayload))(value),
        ) as typeof value;
        expect(back.state).toBe("active");
        expect(back.editable).toBe(true);
    });
});
