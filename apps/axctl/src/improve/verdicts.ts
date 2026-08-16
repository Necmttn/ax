/**
 * Named queries for `axctl improve verdict` - the experiment verdict surface.
 *
 * These reads do NOT decompose into a clean row->domain mapping the way the
 * `defineQuery`/`runQuery` seam expects: each statement carries a per-row
 * correlated subquery (`(SELECT ... FROM checkpoint WHERE experiment =
 * $parent.id ...)`) that materializes a nested `latest_checkpoint` /
 * `checkpoints` object the command handler then walks field-by-field. Per the
 * graph-access decision (2026-05-21), a query that doesn't decompose cleanly
 * stays a raw-SQL named function with a typed row interface rather than being
 * forced through the typed read DSL. The SQL is moved verbatim from
 * `cli/commands/improve.ts`; rows + output bytes are identical.
 */

import { Effect } from "effect";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";
import {
    findStoredProposal,
    listStoredProposals,
    type StoredCheckpoint,
    type StoredProposal,
} from "./judgment-proposals.ts";

/** One experiment row in the verdict listing, with its newest checkpoint
 *  inlined as `latest_checkpoint` (or `null` when none exists yet). */
export type VerdictListRow = Record<string, unknown>;

/** One experiment row in the verdict drill-down, with all checkpoints inlined
 *  as the `checkpoints` array (newest first). */
export type VerdictShowRow = Record<string, unknown>;

/**
 * List every experiment with its newest suggested verdict (newest experiments
 * first, capped at 30). Drives `axctl improve verdict` (no positional arg).
 */
export const listVerdicts = (): Effect.Effect<
    ReadonlyArray<VerdictListRow>,
    JudgmentError,
    Judgment
> =>
    Effect.gen(function* () {
        const proposals = yield* listStoredProposals(1000);
        return proposals.filter((row) => row.experiment !== null)
            .sort((a, b) => b.experiment!.created_at.getTime() - a.experiment!.created_at.getTime())
            .slice(0, 30)
            .map(toVerdictListRow);
    });

/**
 * Drill into one experiment matched by dedupe_sig OR record id, with every
 * checkpoint inlined (newest first). Returns the single matching row or `null`.
 * Drives `axctl improve verdict <id>` and the `--set` lock path.
 */
export const showVerdict = (
    sigOrId: string,
): Effect.Effect<VerdictShowRow | null, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const proposal = yield* findStoredProposal(sigOrId);
        return proposal?.experiment ? toVerdictShowRow(proposal) : null;
    });

const checkpointRow = (checkpoint: StoredCheckpoint) => ({
    id: checkpoint.id,
    kind: checkpoint.kind,
    suggested: checkpoint.suggested,
    user_verdict: checkpoint.user_verdict,
    measured: checkpoint.measured,
    observed_at: checkpoint.observed_at.toISOString(),
});

const toVerdictListRow = (proposal: StoredProposal): VerdictListRow => {
    const experiment = proposal.experiment!;
    const latest = experiment.checkpoints.at(-1);
    return {
        title: proposal.title,
        dedupe_sig: proposal.dedupe_sig,
        artifact_path: experiment.artifact_path,
        created_at: experiment.created_at.toISOString(),
        scaffolded_at: experiment.scaffolded_at?.toISOString() ?? null,
        locked_verdict: experiment.locked_verdict,
        latest_checkpoint: latest ? checkpointRow(latest) : null,
    };
};

const toVerdictShowRow = (proposal: StoredProposal): VerdictShowRow => {
    const experiment = proposal.experiment!;
    return {
        id: experiment.id,
        title: proposal.title,
        dedupe_sig: proposal.dedupe_sig,
        proposal_status: proposal.status,
        artifact_path: experiment.artifact_path,
        created_at: experiment.created_at.toISOString(),
        scaffolded_at: experiment.scaffolded_at?.toISOString() ?? null,
        locked_verdict: experiment.locked_verdict,
        checkpoints: experiment.checkpoints.toReversed().map(checkpointRow),
    };
};
