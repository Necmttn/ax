import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { ProposalDto } from "@ax/lib/shared/dashboard-types";
import { renderAgentBrief } from "./agent-brief.ts";

// Experiment-loop shortlist + verdict state. Reads proposal +
// per-form payloads + the active experiment + newest checkpoint.
// See docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md
// (Phase C10). Moved verbatim from server.ts queryApi (166-182).
const PROPOSALS_SQL = `
SELECT id, form, title, hypothesis, dedupe_sig, frequency, confidence, status, reject_reason,
    type::string(created_at) AS created_at,
    (SELECT trigger_pattern, suspected_gap, proposed_behavior, expected_impact FROM skill_proposal      WHERE proposal = $parent.id LIMIT 1)[0] AS skill_payload,
    (SELECT bounded_role, delegation_trigger, example_task_patterns FROM subagent_proposal   WHERE proposal = $parent.id LIMIT 1)[0] AS subagent_payload,
    (SELECT event_name, target_tool, hook_command, recovery_path, smoke_test_command, disable_command, failure_mode FROM hook_proposal       WHERE proposal = $parent.id LIMIT 1)[0] AS hook_payload,
    (SELECT file_target, section, suggested_text FROM guidance_proposal   WHERE proposal = $parent.id LIMIT 1)[0] AS guidance_payload,
    (SELECT trigger_signal, schedule, action, recovery_path, smoke_test_command, disable_command, failure_mode FROM automation_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS automation_payload,
    (SELECT id, artifact_path, status, task_path, locked_verdict,
        type::string(created_at) AS created_at,
        type::string(scaffolded_at) AS scaffolded_at,
        (SELECT kind, suggested, user_verdict, measured, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC LIMIT 1)[0] AS latest_checkpoint
        FROM experiment WHERE proposal = $parent.id LIMIT 1)[0] AS experiment
FROM proposal
ORDER BY frequency DESC, created_at DESC
LIMIT 100;`;

const withBrief = (p: ProposalDto): ProposalDto => ({
    ...p,
    brief: renderAgentBrief({
        title: p.title,
        evidence: `hypothesis: ${p.hypothesis} (seen ${p.frequency}x, confidence ${p.confidence})`,
        ask:
            p.status === "open"
                ? "Review this proposal; if sound, run `ax improve accept` and act on the emitted .ax/tasks brief."
                : "Act on the experiment artifact/task for this proposal.",
        verify: "`ax improve show` reflects the new status; follow the experiment checkpoints.",
        source: `ax improve proposal sig=${p.dedupe_sig}`,
    }),
});

/** Raw proposal rows, loosely typed at the edge like the legacy queryApi endpoints. */
export const fetchImproveProposals = Effect.fn("dashboard.fetchImproveProposals")(
    function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(PROPOSALS_SQL);
        // TODO: replace with schema decode when the proposal wire shape stabilizes
        const rows = (result[0] ?? []) as unknown as ReadonlyArray<ProposalDto>;
        return rows.map(withBrief);
    },
);
