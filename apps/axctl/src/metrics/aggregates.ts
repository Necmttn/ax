/**
 * Aggregate / trend queries over stored `session_metrics` scalars (issue #177).
 *
 * Every aggregate here joins the ALREADY-STORED per-session scalars
 * (`session_metrics`, `session_health.user_corrections`,
 * `session_token_usage` cost) - one bounded table scan each, joined in JS.
 * The skill-efficacy comparison fetches the skill's session-id set first via
 * the `invoked_out_ts` index (anchored on `out`, using the denormalised
 * `invoked.session` column - NO `in.session` deref), then partitions the
 * session_metrics scan in JS.
 *
 * HANG SAFETY (docs/metrics.md "Deferred" + ADR-0011): never stack per-edge
 * derefs (`in.session`, `out.deleted_at`) over the ~87k-edge `invoked`/`edited`
 * tables. Nothing in this module walks edges per-session.
 *
 * Pure aggregation logic (grouping, filters, ISO weeks, efficacy split,
 * formatting) is separated from the Effect fetchers so it unit-tests over
 * fixture rows. Extension point: future aggregate signals (e.g.
 * `error_recovery_efficacy`) add a new partition-set fetcher + reuse
 * `aggregateRows`/`computeComparison` - do NOT fork the math.
 */
import { Effect } from "effect";
import type { SkillName } from "@ax/lib/brands";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { skillRecordLookupKeys } from "@ax/lib/skill-id";
import { dateField } from "@ax/lib/shared/row-fields";
import { surrealDate } from "@ax/lib/shared/surql";
import { fetchSessionCostMap } from "./cost-estimate.ts";
import { fetchSessionHealthMap } from "./session-metrics-query.ts";
import { cleanSessionId, isoMs, metricPct, numOrNull, numOrZero, strOrNull } from "./util.ts";
import { sessionProjectClause } from "./session-filter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const GROUP_BY_KEYS = ["model", "repo", "source", "week"] as const;
export type GroupByKey = (typeof GROUP_BY_KEYS)[number];

/** One session's stored scalars, as consumed by the pure aggregation layer. */
export interface AggregateSessionRow {
    /** Normalized session key (no `session:` prefix / record-id delimiters). */
    readonly session: string;
    readonly source: string | null;
    /** `session.project` falling back to `session.cwd`. */
    readonly repo: string | null;
    /** Normalized model name from the session's token-usage row. */
    readonly model: string | null;
    /** `session.started_at` as epoch ms (week bucketing); null when unknown. */
    readonly startedAtMs: number | null;
    readonly durabilityRatio: number | null;
    readonly producedCommits: number;
    readonly revertedCommits: number;
    readonly linesAdded: number;
    readonly linesRemoved: number;
    readonly userCorrections: number | null;
    readonly estimatedCostUsd: number | null;
    /** True when the cost was estimated at read time (#175 provenance). */
    readonly costEstimated: boolean;
}

export interface AggregateFilters {
    /** Keep only sessions whose `session.source` matches (e.g. "codex"). */
    readonly source?: string | null;
    /** Keep only sessions whose estimated cost is >= this (USD). Sessions with
     *  unknown cost are excluded - unknown is not "free". */
    readonly minCostUsd?: number | null;
}

export interface GroupAggregate {
    readonly key: string;
    readonly sessions: number;
    /** Sessions with a non-null durability_ratio (i.e. that produced commits). */
    readonly durabilitySessions: number;
    /** Equal-weight mean of durability_ratio over `durabilitySessions`; null when none. */
    readonly meanDurability: number | null;
    readonly producedCommits: number;
    readonly revertedCommits: number;
    readonly linesAdded: number;
    readonly linesRemoved: number;
    /** Sessions with a known user_corrections count. */
    readonly correctionSessions: number;
    readonly totalCorrections: number;
    /** Mean corrections per session over `correctionSessions`; null when none. */
    readonly meanCorrections: number | null;
    /** Sessions with a known cost. */
    readonly costSessions: number;
    /** Of `costSessions`, how many were read-time estimates (vs priced at ingest). */
    readonly estimatedCostSessions: number;
    /** Sum of known costs (USD); null when no session in the group was priced. */
    readonly totalCostUsd: number | null;
}

/** `skill_durability_efficacy`: with-skill vs without-skill comparison. */
export interface SkillEfficacy {
    readonly skill: string;
    /** Invocation sessions found for the skill (pre-filter, whole graph). */
    readonly skillSessions: number;
    readonly withSkill: GroupAggregate;
    readonly withoutSkill: GroupAggregate;
    /** meanDurability(with) − meanDurability(without); null when either side lacks data. */
    readonly durabilityDelta: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** ISO-8601 week label (`2026-W24`) for an epoch-ms timestamp, computed in UTC.
 *  Lexicographic order == chronological order, so week groups sort by key. */
export const isoWeekKey = (ms: number): string => {
    const d = new Date(ms);
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    // Shift to the Thursday of this ISO week; its calendar year IS the ISO year.
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const isoYear = date.getUTCFullYear();
    const week = Math.ceil(((date.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7);
    return `${isoYear}-W${String(week).padStart(2, "0")}`;
};

const UNKNOWN_KEY = "(unknown)";

export const groupKeyFor = (row: AggregateSessionRow, groupBy: GroupByKey): string => {
    switch (groupBy) {
        case "model":
            return row.model ?? UNKNOWN_KEY;
        case "repo":
            return row.repo ?? UNKNOWN_KEY;
        case "source":
            return row.source ?? UNKNOWN_KEY;
        case "week":
            return row.startedAtMs === null ? UNKNOWN_KEY : isoWeekKey(row.startedAtMs);
    }
};

export const applyAggregateFilters = (
    rows: readonly AggregateSessionRow[],
    filters: AggregateFilters,
): AggregateSessionRow[] =>
    rows.filter((r) => {
        if (filters.source != null && r.source !== filters.source) return false;
        if (filters.minCostUsd != null) {
            if (r.estimatedCostUsd === null || r.estimatedCostUsd < filters.minCostUsd) return false;
        }
        return true;
    });

/** Fold a set of session rows into one aggregate (the shared math every
 *  group-by AND the efficacy comparison reuse). */
export const aggregateRows = (key: string, rows: readonly AggregateSessionRow[]): GroupAggregate => {
    let durabilitySessions = 0;
    let durabilitySum = 0;
    let producedCommits = 0;
    let revertedCommits = 0;
    let linesAdded = 0;
    let linesRemoved = 0;
    let correctionSessions = 0;
    let totalCorrections = 0;
    let costSessions = 0;
    let estimatedCostSessions = 0;
    let costSum = 0;
    for (const r of rows) {
        if (r.durabilityRatio !== null) {
            durabilitySessions += 1;
            durabilitySum += r.durabilityRatio;
        }
        producedCommits += r.producedCommits;
        revertedCommits += r.revertedCommits;
        linesAdded += r.linesAdded;
        linesRemoved += r.linesRemoved;
        if (r.userCorrections !== null) {
            correctionSessions += 1;
            totalCorrections += r.userCorrections;
        }
        if (r.estimatedCostUsd !== null) {
            costSessions += 1;
            costSum += r.estimatedCostUsd;
            if (r.costEstimated) estimatedCostSessions += 1;
        }
    }
    return {
        key,
        sessions: rows.length,
        durabilitySessions,
        meanDurability: durabilitySessions === 0 ? null : durabilitySum / durabilitySessions,
        producedCommits,
        revertedCommits,
        linesAdded,
        linesRemoved,
        correctionSessions,
        totalCorrections,
        meanCorrections: correctionSessions === 0 ? null : totalCorrections / correctionSessions,
        costSessions,
        estimatedCostSessions,
        totalCostUsd: costSessions === 0 ? null : costSum,
    };
};

/**
 * Group sessions by the given dimension and aggregate each group.
 * Week groups sort chronologically ASCENDING and keep the most recent `limit`
 * (a trend reads oldest→newest); other dimensions sort by session count
 * descending and keep the top `limit`.
 */
export const aggregateGroups = (
    rows: readonly AggregateSessionRow[],
    groupBy: GroupByKey,
    limit: number,
): GroupAggregate[] => {
    const buckets = new Map<string, AggregateSessionRow[]>();
    for (const row of rows) {
        const key = groupKeyFor(row, groupBy);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(row);
        else buckets.set(key, [row]);
    }
    const groups = [...buckets.entries()].map(([key, bucket]) => aggregateRows(key, bucket));
    const cap = Math.max(1, limit);
    if (groupBy === "week") {
        // Chronological ascending (lexicographic == chronological for the
        // zero-padded `YYYY-Www` keys); the `(unknown)` bucket appends last.
        const known = groups.filter((g) => g.key !== UNKNOWN_KEY)
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const unknown = groups.filter((g) => g.key === UNKNOWN_KEY);
        return [...known, ...unknown].slice(-cap);
    }
    groups.sort((a, b) => b.sessions - a.sessions || (a.key < b.key ? -1 : 1));
    return groups.slice(0, cap);
};

/** Partition sessions on membership in the skill's invocation-session set and
 *  aggregate both sides (`skill_durability_efficacy`). */
export const computeSkillEfficacy = (
    rows: readonly AggregateSessionRow[],
    skillSessionKeys: ReadonlySet<string>,
    skill: string,
): SkillEfficacy => {
    const withRows: AggregateSessionRow[] = [];
    const withoutRows: AggregateSessionRow[] = [];
    for (const row of rows) {
        (skillSessionKeys.has(row.session) ? withRows : withoutRows).push(row);
    }
    const withSkill = aggregateRows("with", withRows);
    const withoutSkill = aggregateRows("without", withoutRows);
    const durabilityDelta =
        withSkill.meanDurability === null || withoutSkill.meanDurability === null
            ? null
            : withSkill.meanDurability - withoutSkill.meanDurability;
    return { skill, skillSessions: skillSessionKeys.size, withSkill, withoutSkill, durabilityDelta };
};

// ---------------------------------------------------------------------------
// Table formatting (pure - unit-tested)
// ---------------------------------------------------------------------------

export const AGGREGATE_LEGEND =
    "legend: durab = mean durability over sessions that produced commits (n in parens) | "
    + "commits/rvt = produced / later-reverted commit totals | corr/s = mean user corrections per session "
    + "(over sessions with health data) | cost$ = summed estimated cost over priced sessions | "
    + "est = read-time-estimated / priced sessions (#175 provenance; rest priced at ingest)";

const MAX_KEY_WIDTH = 44;

/** Left-truncate long keys (repo paths) keeping the discriminating tail. */
const fitKey = (key: string): string =>
    key.length <= MAX_KEY_WIDTH ? key : `…${key.slice(-(MAX_KEY_WIDTH - 1))}`;

const durabCell = (g: GroupAggregate): string =>
    g.meanDurability === null ? "    -" : `${metricPct(g.meanDurability)} (${g.durabilitySessions})`;

const corrCell = (g: GroupAggregate): string =>
    g.meanCorrections === null ? "-" : g.meanCorrections.toFixed(1);

const costCell = (g: GroupAggregate): string =>
    g.totalCostUsd === null ? "-" : `$${g.totalCostUsd.toFixed(2)}`;

const estCell = (g: GroupAggregate): string =>
    g.costSessions === 0 ? "-" : `${g.estimatedCostSessions}/${g.costSessions}`;

const aggregateTable = (label: string, groups: readonly GroupAggregate[]): string => {
    const keys = groups.map((g) => fitKey(g.key));
    const keyWidth = Math.max(label.length, ...keys.map((k) => k.length));
    const lines: string[] = [];
    lines.push(
        `${label.padEnd(keyWidth)} ${"sess".padStart(5)} ${"durab".padStart(10)} ${"commits".padStart(7)} `
        + `${"rvt".padStart(4)} ${"+/-loc".padStart(13)} ${"corr/s".padStart(6)} ${"cost$".padStart(10)} ${"est".padStart(7)}`,
    );
    for (const [i, g] of groups.entries()) {
        lines.push(
            `${keys[i]!.padEnd(keyWidth)} ${String(g.sessions).padStart(5)} ${durabCell(g).padStart(10)} `
            + `${String(g.producedCommits).padStart(7)} ${String(g.revertedCommits).padStart(4)} `
            + `${`+${g.linesAdded}/-${g.linesRemoved}`.padStart(13)} ${corrCell(g).padStart(6)} `
            + `${costCell(g).padStart(10)} ${estCell(g).padStart(7)}`,
        );
    }
    return lines.join("\n");
};

/** Render `ax sessions metrics --group-by=<dim>` groups as an aligned table. */
export const formatGroupAggregates = (groups: readonly GroupAggregate[], groupBy: GroupByKey): string => {
    if (groups.length === 0) return "no session_metrics rows matched (run `ax ingest`, or loosen --since/--source/--min-cost).";
    return aggregateTable(groupBy, groups);
};

/** Render the `--skill=<name>` with/without comparison. */
export const formatSkillEfficacy = (eff: SkillEfficacy): string => {
    const lines: string[] = [];
    lines.push(`skill_durability_efficacy: ${eff.skill} (${eff.skillSessions} invocation session${eff.skillSessions === 1 ? "" : "s"} in graph)`);
    if (eff.skillSessions === 0) {
        lines.push("note: no invocations recorded for this skill - check the name against `ax skills` output.");
    }
    lines.push(aggregateTable("group", [eff.withSkill, eff.withoutSkill]));
    if (eff.durabilityDelta !== null) {
        const pp = Math.round(eff.durabilityDelta * 100);
        lines.push(`Δ durability: ${pp >= 0 ? "+" : ""}${pp}pp (mean, with − without)`);
    } else {
        lines.push("Δ durability: - (one side has no commit-producing sessions)");
    }
    return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Fetchers (Effect; each one bounded scan or indexed lookup - see header)
// ---------------------------------------------------------------------------

/** Datetime values come back as the SDK's Datetime object (`toJSON`), a JS
 *  Date, or an ISO string depending on the client path - `dateField` handles
 *  all three; epoch ms for week bucketing. */
const tsMs = (row: Record<string, unknown>, key: string): number | null => isoMs(dateField(row, key));

/**
 * When `--since`/`--project` narrow the metrics scan to at most this many
 * sessions, the health + usage lookups are bounded by the session-id set
 * (indexed `session IN [...]` batches) instead of full table scans. Above it,
 * one full scan is cheaper than thousands of IN-list refs.
 */
const BOUNDED_JOIN_MAX_SESSIONS = 1000;

/**
 * Fetch every session's stored scalars for aggregation:
 *  1. one `session_metrics` scan (per-row `session.*` record derefs are
 *     bounded - one record fetch per metrics row, NOT per edge);
 *  2. `session_health` (user_corrections) + `session_token_usage` (+ read-time
 *     cost fill, #175) fetched CONCURRENTLY, bounded by the metrics session-id
 *     set when small (see `BOUNDED_JOIN_MAX_SESSIONS`);
 * joined in JS on the normalized session key.
 */
export const fetchAggregateRows = (
    input: { readonly since: Date | null; readonly project: string | null },
): Effect.Effect<AggregateSessionRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const clauses: string[] = [];
        if (input.since) clauses.push(`session.started_at >= ${surrealDate(input.since)}`);
        if (input.project) clauses.push(sessionProjectClause(input.project, "session."));
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const metrics = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT
  type::string(session) AS session,
  session.source AS source,
  session.project AS project,
  session.cwd AS cwd,
  session.started_at AS started_at,
  durability_ratio, produced_commits, reverted_commits, lines_added, lines_removed
FROM session_metrics
${where};`))?.[0] ?? [];

        const sessionIds = [...new Set(
            metrics.map((r) => String(r.session ?? "")).filter((s) => s.length > 0),
        )];
        const bound = sessionIds.length <= BOUNDED_JOIN_MAX_SESSIONS ? sessionIds : null;
        const [health, usage] = yield* Effect.all([
            fetchSessionHealthMap(bound),
            fetchSessionCostMap(bound),
        ], { concurrency: 2 });

        return metrics
            .map((r): AggregateSessionRow | null => {
                const session = cleanSessionId(String(r.session ?? ""));
                if (session.length === 0) return null;
                const u = usage.get(session);
                return {
                    session,
                    source: strOrNull(r.source),
                    repo: strOrNull(r.project) ?? strOrNull(r.cwd),
                    model: u?.model ?? null,
                    startedAtMs: tsMs(r, "started_at"),
                    durabilityRatio: numOrNull(r.durability_ratio),
                    producedCommits: numOrZero(r.produced_commits),
                    revertedCommits: numOrZero(r.reverted_commits),
                    linesAdded: numOrZero(r.lines_added),
                    linesRemoved: numOrZero(r.lines_removed),
                    userCorrections: health.get(session)?.userCorrections ?? null,
                    estimatedCostUsd: u?.estimatedCostUsd ?? null,
                    costEstimated: u?.estimated ?? false,
                };
            })
            .filter((r): r is AggregateSessionRow => r !== null);
    });

/**
 * Session-id set for one skill's invocations: a single `invoked` lookup
 * anchored on `out` (the `invoked_out_ts` index prefix) reading the
 * DENORMALISED `invoked.session` column - the documented hang-safe shape
 * (no `in.session` deref; rows predating the denormalisation backfill are
 * repaired by the schema's UPDATE, NONE rows are skipped here).
 */
export const fetchSkillSessionSet = (
    skillName: SkillName,
): Effect.Effect<Set<string>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const refs = skillRecordLookupKeys(skillName)
            .filter((k) => k.length > 0 && !/[`\n\u0000]/.test(k))
            .map((k) => recordLiteral("skill", k))
            .join(", ");
        if (refs.length === 0) return new Set();
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(session) AS session FROM invoked WHERE out IN [${refs}] AND session != NONE;`,
        ))?.[0] ?? [];
        const out = new Set<string>();
        for (const r of rows) {
            const key = cleanSessionId(String(r.session ?? ""));
            if (key.length > 0) out.add(key);
        }
        return out;
    });
