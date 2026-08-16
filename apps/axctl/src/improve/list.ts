/**
 * List the experiment-loop proposal shortlist. Drives `axctl improve list`
 * and the eventual MCP server `list` tool. Pure query: builds the SQL and
 * returns the rows; presentation/formatting lives in the CLI.
 */

import { Effect, Schema } from "effect";
import { Judgment, NumberColumn, TextColumn, TimestampColumn, type JudgmentError } from "@ax/lib/sqlite";

export interface ProposalRow {
    readonly id: { tb: string; id: string } | string;
    readonly form: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly dedupe_sig: string;
    readonly frequency: number;
    readonly confidence: string;
    readonly status: string;
    readonly created_at?: string;
}

export interface ListProposalsInput {
    readonly status?: string;   // default "open"; "all" disables the status filter
    readonly form?: string;     // optional form filter
    readonly limit?: number;    // default 30
}

/** Default proposal status filter ("all" disables it). Shared by CLI + MCP. */
export const LIST_PROPOSALS_DEFAULT_STATUS = "open";
/** Default row cap for the proposal shortlist. Shared by CLI + MCP. */
export const LIST_PROPOSALS_DEFAULT_LIMIT = 30;

/**
 * Transport-agnostic raw input for `listProposals`. The CLI flag parser and the
 * MCP zod schema both decode into this then call {@link normalizeListProposalsInput}
 * so the status/limit defaults live in one place and cannot drift.
 *
 * `limit` positivity (CLI `requirePositiveInt`, MCP zod `.positive()`) stays in
 * the transports; this only fills defaults + presence rules.
 */
export interface ListProposalsQueryArgs {
    readonly status?: string | undefined;
    readonly form?: string | undefined;
    readonly limit?: number | undefined;
}

export const normalizeListProposalsInput = (
    args: ListProposalsQueryArgs,
): ListProposalsInput => ({
    status: args.status ?? LIST_PROPOSALS_DEFAULT_STATUS,
    ...(args.form !== undefined ? { form: args.form } : {}),
    limit:
        typeof args.limit === "number" && Number.isFinite(args.limit)
            ? args.limit
            : LIST_PROPOSALS_DEFAULT_LIMIT,
});

export const listProposals = (
    input: ListProposalsInput,
): Effect.Effect<ReadonlyArray<ProposalRow>, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const status = input.status ?? "open";
        const limit = input.limit ?? 30;
        const judgment = yield* Judgment;
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (status !== "all") {
            where.push("status = ?");
            params.push(status);
        }
        if (input.form !== undefined) {
            where.push("form = ?");
            params.push(input.form);
        }
        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const rows = yield* judgment.rows(
            Schema.Struct({
                id: TextColumn,
                form: TextColumn,
                title: TextColumn,
                hypothesis: TextColumn,
                dedupe_sig: TextColumn,
                frequency: NumberColumn,
                confidence: TextColumn,
                status: TextColumn,
                created_at: TimestampColumn,
            }),
            `SELECT id, form, title, hypothesis, dedupe_sig, frequency, confidence, status, created_at
             FROM proposal ${whereClause}
             ORDER BY frequency DESC, created_at DESC LIMIT ?`,
            [...params, limit],
        );
        return rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
    });

/**
 * List directive proposals: guidance_proposal rows with section="directives".
 * Discriminator: guidance_proposal.section = "directives" (set by
 * deriveDirectiveProposalRows in ingest/derive-proposals.ts). Shared by the
 * dojo agenda source and the directives_list MCP tool.
 */
export const listDirectiveProposals = (
    status: string = "open",
    limit: number = 30,
): Effect.Effect<ReadonlyArray<ProposalRow>, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const params: Array<string | number> = ["guidance", "directives"];
        const whereStatus = status !== "all" ? "AND p.status = ?" : "";
        if (status !== "all") params.push(status);
        params.push(limit);
        const rows = yield* judgment.rows(
            Schema.Struct({
                id: TextColumn,
                form: TextColumn,
                title: TextColumn,
                hypothesis: TextColumn,
                dedupe_sig: TextColumn,
                frequency: NumberColumn,
                confidence: TextColumn,
                status: TextColumn,
                created_at: TimestampColumn,
            }),
            `SELECT p.id, p.form, p.title, p.hypothesis, p.dedupe_sig,
                    p.frequency, p.confidence, p.status, p.created_at
             FROM proposal p
             JOIN guidance_proposal g ON g.proposal = p.id
             WHERE p.form = ? AND g.section = ? ${whereStatus}
             ORDER BY p.frequency DESC, p.created_at DESC LIMIT ?`,
            params,
        );
        return rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
    });
