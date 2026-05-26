import { describe, expect, test } from "bun:test";
import {
    aggregateCorrections,
    aggregateFrictionKinds,
    aggregateToolFailures,
    buildMetaSnapshot,
    INVESTIGATION_PROMPTS,
    type RetroMetaRow,
} from "./retro-meta.ts";

const sampleRetro = (overrides: Partial<RetroMetaRow> = {}): RetroMetaRow => ({
    id: "retro:abc",
    session: "session:s1",
    source: "heuristic",
    tried: "did the thing",
    worked: null,
    failed: null,
    next: null,
    created_at: "2026-05-26T00:00:00Z",
    ...overrides,
});

describe("aggregateToolFailures", () => {
    test("sums per tool across retros, sorted by total desc", () => {
        const out = aggregateToolFailures([
            sampleRetro({ session: "session:a", failed: "Bash failed ×3" }),
            sampleRetro({ session: "session:b", failed: "Bash failed ×2 · Read failed ×1" }),
            sampleRetro({ session: "session:c", failed: "Read failed ×5" }),
        ]);
        expect(out[0].tool.toLowerCase()).toBe("read");
        expect(out[0].total_count).toBe(6);
        expect(out[0].session_count).toBe(2);
        expect(out[1].tool.toLowerCase()).toBe("bash");
        expect(out[1].total_count).toBe(5);
        expect(out[1].session_count).toBe(2);
    });

    test("returns empty array when no failures present", () => {
        const out = aggregateToolFailures([sampleRetro({ failed: "happy session" })]);
        expect(out).toEqual([]);
    });
});

describe("aggregateCorrections", () => {
    test("tracks total, max-per-session, and session count", () => {
        const out = aggregateCorrections([
            sampleRetro({ session: "session:a", failed: "3 user corrections · friction kinds: user_correction" }),
            sampleRetro({ session: "session:b", failed: "1 user correction" }),
            sampleRetro({ session: "session:c", failed: "no corrections" }),
        ]);
        expect(out.total).toBe(4);
        expect(out.max_per_session).toBe(3);
        expect(out.session_count).toBe(2);
    });

    test("returns zeros when there are no correction mentions", () => {
        const out = aggregateCorrections([sampleRetro({ failed: null })]);
        expect(out).toEqual({ total: 0, max_per_session: 0, session_count: 0 });
    });
});

describe("aggregateFrictionKinds", () => {
    test("counts distinct retros per kind, sorted desc", () => {
        const out = aggregateFrictionKinds([
            sampleRetro({ session: "session:a", failed: "friction kinds: tool_error, user_correction" }),
            sampleRetro({ session: "session:b", failed: "friction kinds: tool_error" }),
            sampleRetro({ session: "session:c", failed: "friction kinds: command_failed" }),
        ]);
        expect(out[0].kind).toBe("tool_error");
        expect(out[0].count).toBe(2);
        expect(out[0].session_count).toBe(2);
    });
});

describe("buildMetaSnapshot", () => {
    test("has the documented top-level keys", () => {
        const snap = buildMetaSnapshot({
            sinceDays: 30,
            retros: [],
            skills: [],
            openProposals: [],
            acceptedExperiments: [],
            claudeMdUser: null,
            claudeMdProject: null,
            nowIso: "2026-05-26T12:00:00Z",
        });
        expect(snap.generated_at).toBe("2026-05-26T12:00:00Z");
        expect(snap.since_days).toBe(30);
        expect(snap).toHaveProperty("retros");
        expect(snap).toHaveProperty("patterns");
        expect(snap).toHaveProperty("current_state");
        expect(snap).toHaveProperty("investigation_prompts");
    });

    test("patterns has the three required sub-keys", () => {
        const snap = buildMetaSnapshot({
            sinceDays: 7,
            retros: [],
            skills: [],
            openProposals: [],
            acceptedExperiments: [],
            claudeMdUser: null,
            claudeMdProject: null,
        });
        expect(snap.patterns).toHaveProperty("tool_failures");
        expect(snap.patterns).toHaveProperty("corrections");
        expect(snap.patterns).toHaveProperty("friction_kinds");
        expect(Array.isArray(snap.patterns.tool_failures)).toBe(true);
        expect(Array.isArray(snap.patterns.friction_kinds)).toBe(true);
    });

    test("current_state carries skills, proposals, experiments, claude paths", () => {
        const snap = buildMetaSnapshot({
            sinceDays: 7,
            retros: [],
            skills: [{ name: "s1", scope: "user", description: "d" }],
            openProposals: [{
                dedupe_sig: "sig",
                form: "skill",
                title: "t",
                frequency: 3,
                confidence: "high",
            }],
            acceptedExperiments: [{
                id: "experiment:x",
                title: "t",
                artifact_path: "/tmp/x",
                locked_verdict: null,
            }],
            claudeMdUser: "/u/CLAUDE.md",
            claudeMdProject: null,
        });
        expect(snap.current_state.skills).toHaveLength(1);
        expect(snap.current_state.open_proposals[0].dedupe_sig).toBe("sig");
        expect(snap.current_state.accepted_experiments[0].id).toBe("experiment:x");
        expect(snap.current_state.claude_md_user).toBe("/u/CLAUDE.md");
        expect(snap.current_state.claude_md_project).toBeNull();
    });

    test("forwards retros array through unchanged", () => {
        const retros = [sampleRetro({ id: "retro:1" }), sampleRetro({ id: "retro:2" })];
        const snap = buildMetaSnapshot({
            sinceDays: 30,
            retros,
            skills: [],
            openProposals: [],
            acceptedExperiments: [],
            claudeMdUser: null,
            claudeMdProject: null,
        });
        expect(snap.retros).toHaveLength(2);
        expect(snap.retros[0].id).toBe("retro:1");
    });
});

describe("INVESTIGATION_PROMPTS", () => {
    test("has at least 3 entries", () => {
        expect(INVESTIGATION_PROMPTS.length).toBeGreaterThanOrEqual(3);
    });

    test("every prompt is a non-empty string", () => {
        for (const p of INVESTIGATION_PROMPTS) {
            expect(typeof p).toBe("string");
            expect(p.length).toBeGreaterThan(10);
        }
    });
});
