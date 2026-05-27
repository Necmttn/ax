import { describe, expect, test } from "bun:test";
import {
    aggregateCorrections,
    aggregateFrictionKinds,
    aggregateToolFailures,
    buildMetaSnapshot,
    coerceDaysSinceAccepted,
    INVESTIGATION_PROMPTS,
    orderExperimentStatus,
    type ExperimentStatusRow,
    type RetroMetaRow,
} from "./retro-meta.ts";

const sampleExperimentStatus = (
    overrides: Partial<ExperimentStatusRow> = {},
): ExperimentStatusRow => ({
    experiment_id: "experiment:abc",
    proposal_dedupe_sig: "skill__pre-bash-guard",
    proposal_title: "Pre-Bash guard",
    proposal_form: "skill",
    artifact_path: "/Users/x/SKILL.md",
    days_since_accepted: 10,
    opportunities_count: 0,
    addressed_count: 0,
    address_ratio: 0,
    latest_checkpoint: null,
    locked_verdict: null,
    ...overrides,
});

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
            experimentStatus: [],
            claudeMdUser: null,
            claudeMdProject: null,
            nowIso: "2026-05-26T12:00:00Z",
        });
        expect(snap.generated_at).toBe("2026-05-26T12:00:00Z");
        expect(snap.since_days).toBe(30);
        expect(snap).toHaveProperty("retros");
        expect(snap).toHaveProperty("patterns");
        expect(snap).toHaveProperty("current_state");
        expect(snap).toHaveProperty("experiment_status");
        expect(Array.isArray(snap.experiment_status)).toBe(true);
        expect(snap).toHaveProperty("investigation_prompts");
    });

    test("patterns has the three required sub-keys", () => {
        const snap = buildMetaSnapshot({
            sinceDays: 7,
            retros: [],
            skills: [],
            openProposals: [],
            acceptedExperiments: [],
            experimentStatus: [],
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
            experimentStatus: [],
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
            experimentStatus: [],
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

    test("first prompt is the experiment_status lead-in", () => {
        expect(INVESTIGATION_PROMPTS[0]).toContain("experiment_status");
        expect(INVESTIGATION_PROMPTS[0]?.toLowerCase()).toContain("stale");
    });

    test("includes the addressed_ratio<0.1 lock-as-ignored guidance", () => {
        const joined = INVESTIGATION_PROMPTS.join("\n");
        expect(joined).toContain("addressed_ratio < 0.1");
        expect(joined).toContain("ax improve verdict --set=ignored");
        expect(joined.toLowerCase()).toContain("overlap");
    });
});

describe("experiment_status row shape", () => {
    test("each entry carries the documented fields", () => {
        const row = sampleExperimentStatus({
            opportunities_count: 14,
            addressed_count: 11,
            address_ratio: 11 / 14,
            latest_checkpoint: {
                kind: "t+30",
                suggested: "adopted",
                observed_at: "2026-05-01T00:00:00Z",
            },
        });
        const snap = buildMetaSnapshot({
            sinceDays: 30,
            retros: [],
            skills: [],
            openProposals: [],
            acceptedExperiments: [],
            experimentStatus: [row],
            claudeMdUser: null,
            claudeMdProject: null,
        });
        const got = snap.experiment_status[0]!;
        expect(got.experiment_id).toBe("experiment:abc");
        expect(got.proposal_dedupe_sig).toBe("skill__pre-bash-guard");
        expect(got.proposal_title).toBe("Pre-Bash guard");
        expect(got.proposal_form).toBe("skill");
        expect(got.artifact_path).toBe("/Users/x/SKILL.md");
        expect(got.opportunities_count).toBe(14);
        expect(got.addressed_count).toBe(11);
        expect(got.address_ratio).toBeCloseTo(11 / 14, 5);
        expect(got.latest_checkpoint?.kind).toBe("t+30");
        expect(got.latest_checkpoint?.suggested).toBe("adopted");
        expect(got.locked_verdict).toBeNull();
    });
});

describe("orderExperimentStatus", () => {
    test("pending verdicts first, then by days_since_accepted desc within each group", () => {
        const rows: ExperimentStatusRow[] = [
            sampleExperimentStatus({ experiment_id: "experiment:locked-old", locked_verdict: "adopted", days_since_accepted: 90 }),
            sampleExperimentStatus({ experiment_id: "experiment:pending-new", locked_verdict: null, days_since_accepted: 5 }),
            sampleExperimentStatus({ experiment_id: "experiment:locked-new", locked_verdict: "ignored", days_since_accepted: 7 }),
            sampleExperimentStatus({ experiment_id: "experiment:pending-old", locked_verdict: null, days_since_accepted: 40 }),
        ];
        const out = orderExperimentStatus(rows);
        expect(out.map((r) => r.experiment_id)).toEqual([
            "experiment:pending-old",
            "experiment:pending-new",
            "experiment:locked-old",
            "experiment:locked-new",
        ]);
    });

    test("does not mutate the input array", () => {
        const rows: ExperimentStatusRow[] = [
            sampleExperimentStatus({ experiment_id: "experiment:a", locked_verdict: "adopted", days_since_accepted: 1 }),
            sampleExperimentStatus({ experiment_id: "experiment:b", locked_verdict: null, days_since_accepted: 50 }),
        ];
        const snapshot = rows.map((r) => r.experiment_id);
        orderExperimentStatus(rows);
        expect(rows.map((r) => r.experiment_id)).toEqual(snapshot);
    });
});

describe("coerceDaysSinceAccepted", () => {
    test("passes through plain numbers", () => {
        expect(coerceDaysSinceAccepted(32, null)).toBe(32);
        expect(coerceDaysSinceAccepted(0.7, null)).toBe(0);
    });

    test("parses '32d' style strings", () => {
        expect(coerceDaysSinceAccepted("32d", null)).toBe(32);
    });

    test("converts duration objects with secs to days", () => {
        expect(coerceDaysSinceAccepted({ secs: 86_400 * 32 }, null)).toBe(32);
    });

    test("falls back to ISO created_at diff when nothing else parses", () => {
        const now = Date.parse("2026-05-26T00:00:00Z");
        const created = "2026-04-26T00:00:00Z";
        expect(coerceDaysSinceAccepted(undefined, created, now)).toBe(30);
    });

    test("never returns negative", () => {
        expect(coerceDaysSinceAccepted(-5, null)).toBe(0);
    });
});
