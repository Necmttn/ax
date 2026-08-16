/**
 * `ax directives` - on-demand read surface for the directive-mining v2 system.
 *
 *   ax directives mine [--days=N] [--emit-brief] [--json]
 *     Rank candidate directive turns by lift. With --emit-brief writes
 *     .ax/tasks/directives-<date>.md for agent review, else prints a summary.
 *
 *   ax directives list [--status=...] [--json]
 *     Tracked directive proposals (guidance-form, section='directives'),
 *     sorted by recurrence (frequency). Discriminator: guidance_proposal.section
 *     = 'directives' - the field set by deriveDirectiveProposalRows in
 *     ingest/derive-proposals.ts. Other guidance proposals (harness-derived) use
 *     a different section value. No schema field added - existing field reused.
 *
 *   ax directives ngrams [--json] [--limit=N]
 *     The learned per-user lift table (directive_ngram rows sorted by lift desc).
 */
import { Effect, FileSystem, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { withinDaysClause } from "@ax/lib/duckdb/clause";
import { deriveDirectiveCandidates, scoreDirectiveCandidates, type DirectiveTurnRow } from "../../ingest/directives.ts";
import { listDirectiveProposals, type ProposalRow } from "../../improve/list.ts";
import type { LiftRow } from "../../queries/directive-ngrams.ts";
import { renderDirectivesBrief } from "../directives-brief-template.ts";
import { renderWorkflowsBrief } from "../workflows-brief-template.ts";
import { fetchWorkflowArcs } from "../../queries/workflow-sequences.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue, requirePositiveInt } from "./shared.ts";

// SQL boundary guard - same pattern as directive-ngrams.ts
const sqlDays = (n: number): number => Math.max(1, Math.trunc(n));

const MineTurnRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    text_excerpt: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});
const LiftMapRow = Schema.Struct({ ngram: Schema.String, lift: Schema.Number });
const NgramLiftRow = Schema.Struct({
    ngram: Schema.String,
    n: NumberFromBigIntColumn,
    occurrences: NumberFromBigIntColumn,
    outcomes: NumberFromBigIntColumn,
    sessions: NumberFromBigIntColumn,
    lift: Schema.Number,
});

// ---------------------------------------------------------------------------
// ax directives mine
// ---------------------------------------------------------------------------

const mineCommand = Command.make(
    "mine",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(90)),
        emitBrief: Flag.boolean("emit-brief").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ days, emitBrief, json }) =>
        Effect.gen(function* () {
            if (!Number.isInteger(days) || days <= 0) {
                fail(`ax directives mine: --days must be a positive integer (got "${days}")`);
            }

            // Fetch user turns (same query shape as derive-proposals.ts directive turn fetch,
            // parameterized by --days instead of hard-coded 90d)
            const daysClause = withinDaysClause("t.ts", sqlDays(days));
            const rawTurns = yield* cacheRows(MineTurnRow, {
                sql: `SELECT t.id, t.session AS session, t.text_excerpt, t.ts
                      FROM turn t JOIN session s ON s.id = t.session
                      WHERE t.role = 'user' AND t.text_excerpt IS NOT NULL AND t.text_excerpt <> ''
                        ${daysClause.sql} AND s.source <> 'claude-subagent'`,
                params: daysClause.params,
            }, "directives mine turns");

            const turns: DirectiveTurnRow[] = rawTurns.map((r) => ({
                id: r.id,
                session: r.session,
                text_excerpt: r.text_excerpt,
                ts: r.ts,
            }));

            // Fetch lift table from directive_ngram
            const rawLift = yield* cacheRows(LiftMapRow, {
                sql: "SELECT ngram, lift FROM directive_ngram WHERE lift > 0",
                params: [],
            }, "directives mine lift map");

            const liftMap = new Map<string, number>();
            for (const r of rawLift) {
                liftMap.set(r.ngram, r.lift);
            }

            const candidates = deriveDirectiveCandidates(turns);
            const scored = scoreDirectiveCandidates(candidates, liftMap as ReadonlyMap<string, number>);

            if (emitBrief) {
                const date = new Date().toISOString().slice(0, 10);
                const briefPath = `.ax/tasks/directives-${date}.md`;
                const fs = yield* FileSystem.FileSystem;
                const p = yield* Path.Path;
                yield* fs.makeDirectory(p.dirname(briefPath), { recursive: true }).pipe(Effect.orDie);
                yield* fs.writeFileString(briefPath, renderDirectivesBrief(scored, { date, days })).pipe(Effect.orDie);
                if (json) {
                    console.log(prettyPrint({ brief: briefPath, candidates: scored.length }));
                    return;
                }
                console.log(`brief written: ${briefPath} (${scored.length} candidates)`);
                console.log(`hand it to your agent; accepted proposals land via: ax improve accept <id>`);
                return;
            }

            if (json) {
                console.log(prettyPrint(scored));
                return;
            }

            if (scored.length === 0) {
                console.log(`(no directive candidates in the last ${days} days)`);
                return;
            }

            console.log(`${"#".padEnd(3)}  ${"score".padStart(7)}  ${"src".padEnd(5)}  ${"pattern".padEnd(18)}  ${"ts".padEnd(10)}  ${"session".padEnd(20)}  text`);
            for (let i = 0; i < scored.length; i++) {
                const c = scored[i]!;
                const score = c.source === "lift" ? c.score.toFixed(2).padStart(7) : "   seed";
                const src = c.source.padEnd(5);
                const pat = c.pattern.padEnd(18).slice(0, 18);
                const ts = c.ts.slice(0, 10);
                const sid = c.sessionId.slice(0, 20).padEnd(20);
                const text = c.text.length > 60 ? c.text.slice(0, 57) + "..." : c.text;
                console.log(`${String(i + 1).padEnd(3)}  ${score}  ${src}  ${pat}  ${ts}  ${sid}  ${text}`);
            }
            console.log(`\n${scored.length} candidates (${days} days)  emit brief: ax directives mine --emit-brief`);
        }),
).pipe(
    Command.withDescription(
        "Rank candidate directive turns by lift. --days=N (default 90)  --emit-brief (write agent brief)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax directives list
// ---------------------------------------------------------------------------
//
// Discriminator: guidance_proposal.section = 'directives'. Both directive
// and harness-derived guidance proposals share form='guidance' on the proposal
// table; the section field in the guidance_proposal payload table is the clean
// discriminator (set by deriveDirectiveProposalRows in derive-proposals.ts).
// No new schema field needed.

const listCommand = Command.make(
    "list",
    {
        status: Flag.string("status").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ status, json }) =>
        Effect.gen(function* () {
            const statusFilter = optionValue(status) ?? "open";

            const proposals = yield* listDirectiveProposals(statusFilter).pipe(
                Effect.orElseSucceed(() => [] as ReadonlyArray<ProposalRow>),
            );

            if (json) {
                console.log(prettyPrint(proposals));
                return;
            }

            if (proposals.length === 0) {
                console.log(`(no directive proposals with status="${statusFilter}" - run: ax ingest to mine)`);
                return;
            }

            console.log(`${"freq".padStart(6)}  ${"conf".padEnd(6)}  ${"status".padEnd(10)}  ${"dedupe_sig".padEnd(24)}  title`);
            for (const row of proposals) {
                const freq = String(row.frequency ?? 0).padStart(6);
                const conf = String(row.confidence ?? "").padEnd(6);
                const stat = String(row.status ?? "").padEnd(10);
                const sig = String(row.dedupe_sig ?? "").slice(0, 24).padEnd(24);
                console.log(`${freq}  ${conf}  ${stat}  ${sig}  ${row.title}`);
            }
            console.log(`\n${proposals.length} directive proposal(s)  accept one: ax improve accept <id>`);
        }),
).pipe(
    Command.withDescription(
        "List tracked directive proposals (guidance/section=directives), sorted by recurrence. " +
        "--status=open|all  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax directives ngrams
// ---------------------------------------------------------------------------

const ngramsCommand = Command.make(
    "ngrams",
    {
        limit: Flag.integer("limit").pipe(Flag.withDefault(50)),
        json: jsonFlag,
    },
    ({ limit, json }) =>
        Effect.gen(function* () {
            const validLimit = requirePositiveInt("directives ngrams", "limit", limit);
            const liftRows: ReadonlyArray<LiftRow> = yield* cacheRows(NgramLiftRow, {
                sql: "SELECT ngram, n, occurrences, outcomes, sessions, lift FROM directive_ngram ORDER BY lift DESC LIMIT ?",
                params: [validLimit],
            }, "directives ngrams");

            if (json) {
                console.log(prettyPrint(liftRows));
                return;
            }

            if (liftRows.length === 0) {
                console.log("(no ngram lift data yet - run: ax ingest to build it)");
                return;
            }

            console.log(`${"lift".padStart(6)}  ${"occ".padStart(5)}  ${"out".padStart(5)}  ${"sess".padStart(5)}  ngram`);
            for (const row of liftRows) {
                console.log(
                    `${row.lift.toFixed(2).padStart(6)}  ${String(row.occurrences).padStart(5)}  ` +
                    `${String(row.outcomes).padStart(5)}  ${String(row.sessions).padStart(5)}  ${row.ngram}`,
                );
            }
            console.log(`\n${liftRows.length} ngrams  (lift = outcome-rate / base-rate; higher = stronger signal)`);
        }),
).pipe(
    Command.withDescription(
        "Show the learned per-user directive lift table (ngram → outcome lift). " +
        "--limit=N (default 50)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax directives workflows
// ---------------------------------------------------------------------------

const workflowsCommand = Command.make(
    "workflows",
    {
        emitBrief: Flag.boolean("emit-brief").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ emitBrief, json }) =>
        Effect.gen(function* () {
            const read = yield* CacheRead;
            const arcs = yield* fetchWorkflowArcs(read).pipe(
                Effect.orElseSucceed(() => []),
            );

            if (emitBrief) {
                const date = new Date().toISOString().slice(0, 10);
                const briefPath = `.ax/tasks/workflows-${date}.md`;
                const fs = yield* FileSystem.FileSystem;
                const p = yield* Path.Path;
                yield* fs.makeDirectory(p.dirname(briefPath), { recursive: true }).pipe(Effect.orDie);
                yield* fs.writeFileString(briefPath, renderWorkflowsBrief(arcs, { date })).pipe(Effect.orDie);
                if (json) {
                    console.log(prettyPrint({ brief: briefPath, candidates: arcs.length }));
                    return;
                }
                console.log(`brief written: ${briefPath} (${arcs.length} workflow arc candidates)`);
                console.log(`hand it to your agent; accepted workflows can be codified via: ax improve accept <id>`);
                return;
            }

            if (json) {
                console.log(prettyPrint(arcs));
                return;
            }

            if (arcs.length === 0) {
                console.log(`(no workflow arc candidates in the last 12 weeks - need ≥ 3 sessions with matching arc)`);
                return;
            }

            console.log(`${"#".padEnd(3)}  ${"sup".padStart(5)}  steps`);
            for (let i = 0; i < arcs.length; i++) {
                const arc = arcs[i]!;
                console.log(`${String(i + 1).padEnd(3)}  ${String(arc.support).padStart(5)}  ${arc.steps.join(" → ")}`);
            }
            console.log(`\n${arcs.length} workflow arc candidates  emit brief: ax directives workflows --emit-brief`);
        }),
).pipe(
    Command.withDescription(
        "Mine recurring skill-arc workflows from session history (fixed 12-week window). " +
        "--emit-brief (write agent brief)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax directives (group)
// ---------------------------------------------------------------------------

export const directivesRootCommand = Command.make("directives").pipe(
    Command.withDescription(
        "Directive-mining v2 read surface: mine (rank candidates), list (tracked proposals), ngrams (lift table), workflows (recurring arcs).",
    ),
    Command.withSubcommands([mineCommand, listCommand, ngramsCommand, workflowsCommand]),
);

export const axDirectivesRuntime: RuntimeManifest = {
    directives: {
        runtime: {
            kind: "db-conditional",
            fallback: "db",
            subcommands: {
                mine: "db",
                list: "db",
                ngrams: "db",
                workflows: "db",
            },
        },
        hidden: false,
    },
};
