import { describe, expect, test } from "bun:test";
import type { ProposalDto } from "@ax/lib/shared/dashboard-types";
import { experimentDisplayState } from "./experiments-section.tsx";

const proposal = (experiment: Record<string, unknown>): ProposalDto => ({
    id: "proposal:abc",
    form: "guidance",
    title: "Always read CLAUDE.md",
    hypothesis: "H",
    dedupe_sig: "abc123",
    frequency: 9,
    confidence: "high",
    status: "accepted",
    reject_reason: null,
    created_at: "2026-01-01T00:00:00Z",
    experiment: {
        id: "exp:1",
        artifact_path: "/repo/CLAUDE.md",
        status: "scaffolded",
        task_path: null,
        locked_verdict: null,
        created_at: "2026-01-01T00:00:00Z",
        scaffolded_at: "2026-01-10T00:00:00Z",
        latest_checkpoint: null,
        checkpoints: [],
        ...experiment,
    },
} as ProposalDto);

const checkpoint = (overrides: Record<string, unknown> = {}) => ({
    kind: "+3s",
    suggested: "adopted" as string | null,
    user_verdict: null,
    measured: {
        opportunities: 12, addressed: 8, ratio: 8 / 12, built: true,
        measurement_status: "measured", measurement_version: 2,
    },
    observed_at: "2026-01-20T00:00:00Z",
    ...overrides,
});

describe("experimentDisplayState", () => {
    test("a measured suggestion is described as observed use", () => {
        const state = experimentDisplayState(proposal({
            latest_checkpoint: checkpoint(),
            checkpoints: [checkpoint()],
        }));
        expect(state.note).toBe("suggested: adopted · observed use");
        expect(state.badge).toBe("1/3 checkpoints");
    });

    test("an insufficient-data window says so, never `measuring…`", () => {
        const insufficient = checkpoint({
            suggested: null,
            measured: {
                opportunities: 0, addressed: 0, ratio: 0, built: true,
                measurement_status: "insufficient_data", reason: "no_opportunities",
            },
        });
        const state = experimentDisplayState(proposal({
            latest_checkpoint: insufficient,
            checkpoints: [insufficient],
            current_reason: "no_opportunities",
        }));
        expect(state.note).toBe("insufficient data · no opportunities in the window");
        expect(state.accent).toBe("muted");
    });

    test("an unavailable detector is named, not read as a pending measurement", () => {
        const state = experimentDisplayState(proposal({
            latest_checkpoint: checkpoint({ suggested: null }),
            checkpoints: [checkpoint({ suggested: null })],
            current_reason: "detector_unavailable",
        }));
        expect(state.note).toBe("detector unavailable");
        expect(state.note).not.toContain("measuring");
    });

    test("a lifecycle state replaces the measurement note", () => {
        for (const [reason, note] of [
            ["retired", "retired"],
            ["not_started", "artifact not installed yet"],
            ["refresh_required", "insufficient data · evidence needs derivation"],
        ] as const) {
            const state = experimentDisplayState(proposal({
                latest_checkpoint: checkpoint({ suggested: null }),
                checkpoints: [checkpoint({ suggested: null })],
                current_reason: reason,
            }));
            expect(state.note).toBe(note);
        }
    });

    test("an experiment with no checkpoint at all still waits for sessions", () => {
        const state = experimentDisplayState(proposal({ current_reason: "no_checkpoint" }));
        expect(state).toEqual({ accent: "blue", badge: "pending", note: "waiting for sessions…" });
    });

    test("a locked verdict keeps its own rendering", () => {
        const state = experimentDisplayState(proposal({
            locked_verdict: "no_longer_needed",
            latest_checkpoint: checkpoint({ suggested: "adopted", user_verdict: "no_longer_needed" }),
            checkpoints: [checkpoint()],
        }));
        expect(state.badge).toBe("normalized");
        expect(state.note).toBe("pattern resolved · no longer firing");
    });
});
