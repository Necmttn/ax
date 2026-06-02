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
