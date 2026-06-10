// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { SurrealClient } from "@ax/lib/db";
import { prettyPrint, surrealLiteral } from "@ax/lib/json";
import { fetchCostSummary, type CostSummary } from "../../dashboard/cost-query.ts";
import { fetchLocSummary, type LocSummary, type LocSelector } from "../../dashboard/loc-query.ts";
import { resolvePwdRepository } from "../../pwd.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag, optionalSince, optionValue, positiveLimit } from "./shared.ts";

const usd = (value: unknown): string => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? `$${n.toFixed(4)}` : "$0.0000";
};

const integer = (value: unknown): string => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.trunc(n).toLocaleString("en-US") : "0";
};

const cmdCosts = (input: { readonly limit: number; readonly source: string | null; readonly sinceDays: number | null; readonly json: boolean }) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const where = ["estimated_cost_usd != NONE"];
        if (input.source) where.push(`source = ${surrealLiteral(input.source)}`);
        if (input.sinceDays !== null) {
            const since = Math.min(Math.max(Math.trunc(input.sinceDays), 1), 3650);
            where.push(`ts > time::now() - ${since}d`);
        }
        const whereClause = `WHERE ${where.join(" AND ")}`;
        const [totals, byModel, recent] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(`
SELECT count() AS sessions, math::sum(estimated_tokens) AS tokens, math::sum(prompt_tokens) AS prompt_tokens,
       math::sum(completion_tokens) AS completion_tokens, math::sum(cache_creation_input_tokens) AS cache_creation_input_tokens,
       math::sum(cache_read_input_tokens) AS cache_read_input_tokens, math::sum(estimated_cost_usd) AS cost
FROM session_token_usage
${whereClause}
GROUP ALL;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[Array<Record<string, unknown>>]>(`
SELECT source, model, pricing_source, count() AS sessions, math::sum(estimated_tokens) AS tokens,
       math::sum(prompt_tokens) AS prompt_tokens, math::sum(completion_tokens) AS completion_tokens,
       math::sum(cache_creation_input_tokens) AS cache_creation_input_tokens,
       math::sum(cache_read_input_tokens) AS cache_read_input_tokens,
       math::sum(estimated_cost_usd) AS cost
FROM session_token_usage
${whereClause}
GROUP BY source, model, pricing_source
ORDER BY cost DESC
LIMIT ${Math.min(Math.max(input.limit, 1), 200)};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[Array<Record<string, unknown>>]>(`
SELECT session, source, model, estimated_tokens, estimated_cost_usd, pricing_source, type::string(ts) AS ts
FROM session_token_usage
${whereClause}
ORDER BY ts DESC
LIMIT ${Math.min(Math.max(input.limit, 1), 200)};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
        ], { concurrency: 3 });
        const payload = { totals: totals[0] ?? null, byModel, recent };
        if (input.json) {
            console.log(prettyPrint(payload));
            return;
        }
        const total = totals[0];
        if (!total) {
            console.log("(no priced session token usage yet)");
            return;
        }
        console.log(`cost ${usd(total.cost)}  sessions ${integer(total.sessions)}  tokens ${integer(total.tokens)}`);
        console.log("");
        console.log(`${"source".padEnd(12)} ${"model".padEnd(30)} ${"sessions".padStart(8)} ${"tokens".padStart(14)} ${"cost".padStart(10)}  pricing`);
        for (const row of byModel) {
            console.log(
                `${String(row.source ?? "").padEnd(12)} ` +
                `${String(row.model ?? "<none>").slice(0, 30).padEnd(30)} ` +
                `${integer(row.sessions).padStart(8)} ` +
                `${integer(row.tokens).padStart(14)} ` +
                `${usd(row.cost).padStart(10)}  ` +
                `${String(row.pricing_source ?? "")}`,
            );
        }
    });

const costsSummaryCommand = Command.make(
    "summary",
    {
        limit: positiveLimit(20),
        source: Flag.string("source").pipe(Flag.optional),
        since: optionalSince,
        json: jsonFlag,
    },
    ({ limit, source, since, json }) =>
        cmdCosts({
            limit,
            source: optionValue(source) ?? null,
            sinceDays: optionValue(since) ?? null,
            json,
        }),
).pipe(Command.withDescription("Summarize estimated session token cost by provider/model"));

const formatCostSummary = (summary: CostSummary): string => {
    const lines: string[] = [];
    lines.push(`selector ${summary.selector}`);
    lines.push(`evidence ${summary.evidence}`);
    lines.push(
        `cost ${usd(summary.totals.estimatedCostUsd)}  sessions ${integer(summary.totals.sessions)}  tokens ${integer(summary.totals.estimatedTokens)}`,
    );
    lines.push(
        `prompt ${integer(summary.totals.promptTokens)}  output ${integer(summary.totals.completionTokens)}  cache_write ${integer(summary.totals.cacheCreationInputTokens)}  cache_read ${integer(summary.totals.cacheReadInputTokens)}`,
    );
    lines.push("");
    lines.push(`${"source".padEnd(12)} ${"model".padEnd(30)} ${"sessions".padStart(8)} ${"tokens".padStart(14)} ${"cost".padStart(10)}`);
    for (const row of summary.byModel) {
        lines.push(
            `${row.source.padEnd(12)} ` +
            `${String(row.model ?? "<none>").slice(0, 30).padEnd(30)} ` +
            `${integer(row.sessions).padStart(8)} ` +
            `${integer(row.estimatedTokens).padStart(14)} ` +
            `${usd(row.estimatedCostUsd).padStart(10)}`,
        );
    }
    lines.push("");
    lines.push("sessions");
    for (const row of summary.sessions.slice(0, 20)) {
        lines.push(
            `- ${row.session.replace(/^session:/, "")}  ${row.source}  ${row.model ?? "?"}  ${integer(row.estimated_tokens)} tokens  ${usd(row.estimated_cost_usd)}`,
        );
    }
    return lines.join("\n");
};

const splitCostTerms = (value: string | null): string[] =>
    value === null
        ? []
        : value.split(",").map((term) => term.trim()).filter((term) => term.length > 0);

const costQueryTerms = (query: string | null, terms: string | null): string[] => {
    const parsedTerms = splitCostTerms(terms);
    if (parsedTerms.length > 0) return parsedTerms;
    return query === null ? [] : [query];
};

const cmdCostsFor = (input: {
    readonly session: string | null;
    readonly query: string | null;
    readonly terms: string | null;
    readonly commit: string | null;
    readonly branch: string | null;
    readonly sinceDays: number | null;
    readonly project: string | null;
    readonly here: boolean;
    readonly limit: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        let repositoryKey: string | null = null;
        if (input.commit || input.branch || input.here) {
            const pwdResolution = yield* resolvePwdRepository().pipe(
                Effect.catchTag("NotAGitRepoError", (err) =>
                    Effect.sync(() => {
                        process.stderr.write(`axctl costs for: --here/--commit/--branch requires a git repository (cwd=${err.cwd})\n`);
                        process.exit(2);
                    }),
                ),
            );
            repositoryKey = pwdResolution.repositoryRecordId.id as string;
        }
        const since = input.sinceDays === null
            ? null
            : new Date(Date.now() - Math.min(Math.max(Math.trunc(input.sinceDays), 1), 3650) * 86400 * 1000);
        const terms = costQueryTerms(input.query, input.terms);
        const selected =
            input.session ? { kind: "session" as const, sessionId: input.session } :
            terms.length > 0 ? {
                kind: "query" as const,
                terms,
                limit: input.limit,
                since,
                project: input.project,
                repositoryKey,
            } :
            input.commit ? { kind: "commit" as const, sha: input.commit, repositoryKey } :
            input.branch ? { kind: "branch" as const, branch: input.branch, repositoryKey, limit: input.limit } :
            null;
        if (!selected) {
            console.error("axctl costs for: pass one of --session, --query, --terms, --commit, --branch");
            process.exit(2);
        }
        const summary = yield* fetchCostSummary(selected);
        if (input.json) {
            console.log(prettyPrint(summary));
            return;
        }
        console.log(formatCostSummary(summary));
    });

const costsForCommand = Command.make(
    "for",
    {
        session: Flag.string("session").pipe(Flag.optional),
        query: Flag.string("query").pipe(Flag.optional),
        terms: Flag.string("terms").pipe(Flag.optional),
        commit: Flag.string("commit").pipe(Flag.optional),
        branch: Flag.string("branch").pipe(Flag.optional),
        since: optionalSince,
        project: Flag.string("project").pipe(Flag.optional),
        here: Flag.boolean("here").pipe(Flag.withDefault(false)),
        limit: positiveLimit(50),
        json: jsonFlag,
    },
    ({ session, query, terms, commit, branch, since, project, here, limit, json }) =>
        cmdCostsFor({
            session: optionValue(session) ?? null,
            query: optionValue(query) ?? null,
            terms: optionValue(terms) ?? null,
            commit: optionValue(commit) ?? null,
            branch: optionValue(branch) ?? null,
            sinceDays: optionValue(since) ?? null,
            project: optionValue(project) ?? null,
            here,
            limit,
            json,
        }),
).pipe(Command.withDescription("Estimate cost for a session, text query, commit, or branch"));

export const costsGroupCommand = Command.make("costs").pipe(
    Command.withDescription("Summarize and explain estimated token costs"),
    Command.withSubcommands([costsSummaryCommand, costsForCommand]),
);

const formatLocSummary = (summary: LocSummary): string => {
    const lines: string[] = [];
    lines.push(`selector ${summary.selector}`);
    lines.push(`evidence ${summary.evidence}`);
    lines.push(
        `lines +${integer(summary.totals.linesAdded)} -${integer(summary.totals.linesRemoved)} (changed ${integer(summary.totals.linesChanged)})  edits ${integer(summary.totals.edits)}  sessions ${integer(summary.totals.sessions)}`,
    );
    lines.push("");
    lines.push(`${"tool".padEnd(14)} ${"edits".padStart(8)} ${"+added".padStart(10)} ${"-removed".padStart(10)}`);
    for (const row of summary.byTool) {
        lines.push(
            `${row.tool.padEnd(14)} ${integer(row.edits).padStart(8)} ${integer(row.linesAdded).padStart(10)} ${integer(row.linesRemoved).padStart(10)}`,
        );
    }
    lines.push("");
    lines.push("sessions");
    for (const row of summary.sessions.slice(0, 20)) {
        lines.push(
            `- ${row.session.replace(/^session:/, "")}  ${row.source}  +${integer(row.linesAdded)} -${integer(row.linesRemoved)}  (${integer(row.edits)} edits)`,
        );
    }
    return lines.join("\n");
};

const cmdLoc = (input: {
    readonly session: string | null;
    readonly query: string | null;
    readonly terms: string | null;
    readonly sinceDays: number | null;
    readonly project: string | null;
    readonly here: boolean;
    readonly limit: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        let repositoryKey: string | null = null;
        if (input.here) {
            const pwdResolution = yield* resolvePwdRepository().pipe(
                Effect.catchTag("NotAGitRepoError", (err) =>
                    Effect.sync(() => {
                        process.stderr.write(`axctl loc: --here requires a git repository (cwd=${err.cwd})\n`);
                        process.exit(2);
                    }),
                ),
            );
            repositoryKey = pwdResolution.repositoryRecordId.id as string;
        }
        const since = input.sinceDays === null
            ? null
            : new Date(Date.now() - Math.min(Math.max(Math.trunc(input.sinceDays), 1), 3650) * 86400 * 1000);
        const terms = costQueryTerms(input.query, input.terms);
        const selected: LocSelector = input.session
            ? { kind: "session", sessionId: input.session }
            : { kind: "query", terms, limit: input.limit, since, project: input.project, repositoryKey };
        const summary = yield* fetchLocSummary(selected);
        if (input.json) {
            console.log(prettyPrint(summary));
            return;
        }
        console.log(formatLocSummary(summary));
    });

export const locCommand = Command.make(
    "loc",
    {
        session: Flag.string("session").pipe(Flag.optional),
        query: Flag.string("query").pipe(Flag.optional),
        terms: Flag.string("terms").pipe(Flag.optional),
        since: optionalSince,
        project: Flag.string("project").pipe(Flag.optional),
        here: Flag.boolean("here").pipe(Flag.withDefault(false)),
        limit: positiveLimit(50),
        json: jsonFlag,
    },
    ({ session, query, terms, since, project, here, limit, json }) =>
        cmdLoc({
            session: optionValue(session) ?? null,
            query: optionValue(query) ?? null,
            terms: optionValue(terms) ?? null,
            sinceDays: optionValue(since) ?? null,
            project: optionValue(project) ?? null,
            here,
            limit,
            json,
        }),
).pipe(Command.withDescription("Estimate lines added/removed from agent edits (Edit/Write/MultiEdit)"));

const cmdPricing = (input: { readonly limit: number; readonly query: string | null; readonly json: boolean }) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT name, provider, display_name, input_per_million_usd, output_per_million_usd,
       cache_creation_per_million_usd, cache_read_per_million_usd,
       fast_multiplier, context_window, pricing_source
FROM agent_model
ORDER BY provider, name
LIMIT 5000;`).pipe(Effect.map((result) => result?.[0] ?? []));
        const q = input.query?.trim().toLowerCase() ?? "";
        const filtered = (q.length === 0
            ? rows
            : rows.filter((row) =>
                String(row.name ?? "").toLowerCase().includes(q) ||
                String(row.provider ?? "").toLowerCase().includes(q) ||
                String(row.display_name ?? "").toLowerCase().includes(q)
            )).slice(0, Math.min(Math.max(input.limit, 1), 500));
        if (input.json) {
            console.log(prettyPrint(filtered));
            return;
        }
        if (filtered.length === 0) {
            console.log("(no model prices match)");
            return;
        }
        console.log(`${"provider".padEnd(14)} ${"model".padEnd(36)} ${"in/M".padStart(8)} ${"out/M".padStart(8)} ${"cache/M".padStart(8)} ${"ctx".padStart(8)}  source`);
        for (const row of filtered) {
            console.log(
                `${String(row.provider ?? "").padEnd(14)} ` +
                `${String(row.name ?? "").slice(0, 36).padEnd(36)} ` +
                `${String(row.input_per_million_usd ?? "-").padStart(8)} ` +
                `${String(row.output_per_million_usd ?? "-").padStart(8)} ` +
                `${String(row.cache_read_per_million_usd ?? "-").padStart(8)} ` +
                `${String(row.context_window ?? "-").padStart(8)}  ` +
                `${String(row.pricing_source ?? "")}`,
            );
        }
    });

export const pricingCommand = Command.make(
    "pricing",
    {
        query: Flag.string("query").pipe(Flag.optional),
        limit: positiveLimit(30),
        json: jsonFlag,
    },
    ({ query, limit, json }) =>
        cmdPricing({
            query: optionValue(query) ?? null,
            limit,
            json,
        }),
).pipe(Command.withDescription("Inspect imported model pricing rows"));

export const costsRuntime: RuntimeManifest = {
    costs: "db",
    loc: "db",
    pricing: "db",
};
