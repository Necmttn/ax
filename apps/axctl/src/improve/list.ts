/**
 * List the experiment-loop proposal shortlist. Drives `axctl improve list`
 * and the eventual MCP server `list` tool. Pure query: builds the SQL and
 * returns the rows; presentation/formatting lives in the CLI.
 */

import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { surrealLiteral } from "@ax/lib/json";
import type { DbError } from "@ax/lib/errors";

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
): Effect.Effect<ReadonlyArray<ProposalRow>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const status = input.status ?? "open";
        const limit = input.limit ?? 30;
        const db = yield* SurrealClient;
        const where: string[] = [];
        if (status !== "all") {
            where.push(`status = ${surrealLiteral(status)}`);
        }
        if (input.form !== undefined) {
            where.push(`form = ${surrealLiteral(input.form)}`);
        }
        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const sql = `SELECT id, form, title, hypothesis, dedupe_sig, frequency, confidence, status, type::string(created_at) AS created_at FROM proposal ${whereClause} ORDER BY frequency DESC, created_at DESC LIMIT ${limit};`;
        const result = yield* db.query<[ProposalRow[]]>(sql);
        return result?.[0] ?? [];
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
): Effect.Effect<ReadonlyArray<ProposalRow>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const whereStatus = status !== "all"
            ? `AND p.status = ${surrealLiteral(status)}`
            : "";
        const sql = `
SELECT type::string(p.id) AS id, p.form, p.title, p.hypothesis, p.dedupe_sig,
       p.frequency, p.confidence, p.status, type::string(p.created_at) AS created_at
FROM proposal AS p
WHERE p.form = "guidance"
  AND p.id IN (SELECT proposal FROM guidance_proposal WHERE section = "directives")
  ${whereStatus}
ORDER BY p.frequency DESC, p.created_at DESC
LIMIT ${limit};`;
        const result = yield* db.query<[ProposalRow[]]>(sql);
        return result?.[0] ?? [];
    });
