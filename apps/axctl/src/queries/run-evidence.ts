/**
 * `ax runs evidence <session>` - the reviewer-facing read surface for the run
 * evidence ledger (#578).
 *
 * The derive stage (`derive-run-evidence.ts`) writes `run_evidence_event` rows;
 * until now nothing READ them. This query answers, for one run: how much
 * evidence exists, broken down by kind and - crucially - by `backing`, so a
 * reviewer can immediately see how much is tool/verifier-backed vs a bare model
 * claim (the #578 acceptance criterion). It also lists the latest events as a
 * timeline.
 *
 * Deref-free: a GROUP BY count over the session's rows + a bounded latest-N
 * timeline. The full backing/kind taxonomy is shown even at count 0 (honest
 * zeros - e.g. `model_claim 0` makes explicit that claims are not mined yet).
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead, type CacheReadError, type CacheReadService } from "@ax/lib/duckdb/seam";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import {
    RUN_EVIDENCE_BACKINGS,
    RUN_EVIDENCE_KINDS,
} from "@ax/lib/shared/run-evidence";

/** Kinds the derive stage populates today (slice 2). Mirrors
 *  `RUN_EVIDENCE_DERIVED_KINDS` in derive-run-evidence.ts; duplicated here to
 *  keep the read path free of the ingest-stage import graph. */
export const RUN_EVIDENCE_COVERED_KINDS = [
    "tool_observation",
    "verification",
    "boundary",
    "task_state",
    "objective",
    "policy_decision",
    "repo_state",
    "derived_summary",
] as const;

/** Default timeline cap (latest N events). */
export const RUN_EVIDENCE_TIMELINE_LIMIT = 50;

export interface RunEvidenceCount {
    readonly key: string;
    readonly count: number;
}

export interface RunEvidenceTimelineRow {
    readonly ts: string;
    readonly kind: string;
    readonly backing: string;
    readonly source_table: string;
    readonly summary: string | null;
}

export interface RunEvidenceResult {
    readonly session_id: string;
    readonly generated_at: string;
    /** The run's stated goal (latest `objective` event summary), or null. */
    readonly objective: string | null;
    /** The run's repo identity (latest `repo_state` event summary), or null. */
    readonly repo: string | null;
    readonly total: number;
    /** All kinds in the taxonomy, count-desc then taxonomy order; zeros kept. */
    readonly by_kind: ReadonlyArray<RunEvidenceCount>;
    /** All backing classes, taxonomy order; zeros kept (the claim-vs-backed lens). */
    readonly by_backing: ReadonlyArray<RunEvidenceCount>;
    readonly timeline: ReadonlyArray<RunEvidenceTimelineRow>;
    /** Total `run_evidence_ref` rows for this session. */
    readonly ref_total: number;
    /** Ref counts by ref_kind (count-desc); empty when no refs. */
    readonly by_ref_kind: ReadonlyArray<RunEvidenceCount>;
    /** Honest capability surface: which kinds are derived today. */
    readonly covered_kinds: ReadonlyArray<string>;
    readonly timeline_limit: number;
}

export interface RunEvidenceInput {
    readonly sessionId: string;
    readonly timelineLimit?: number;
}

interface GroupRow {
    readonly kind?: string | null;
    readonly backing?: string | null;
    readonly n?: number | null;
}

const GroupDbRow = Schema.Struct({ kind: Schema.String, backing: Schema.String, n: NumberFromBigIntColumn });
const TimelineDbRow = Schema.Struct({ ts: TimestampColumn, kind: Schema.String, backing: Schema.String, source_table: Schema.String, summary: Schema.NullOr(Schema.String) });
const RefGroupDbRow = Schema.Struct({ ref_kind: Schema.String, n: NumberFromBigIntColumn });
const HeadDbRow = Schema.Struct({ kind: Schema.String, summary: Schema.NullOr(Schema.String) });

/** The two tables the ledger needs. A snapshot published before #578's DDL
 *  landed (or one restored from an older backup) has neither - see the
 *  catalog check below. */
const RUN_EVIDENCE_TABLES = ["run_evidence_event", "run_evidence_ref"] as const;

const TableCountDbRow = Schema.Struct({ n: NumberFromBigIntColumn });

/**
 * Whether BOTH ledger tables exist in the published snapshot. Checked via
 * `information_schema.tables` (the same catalog-probe shape `fts.ts` uses for
 * `information_schema.schemata`) rather than by running the ledger queries and
 * inspecting the error: a missing-table `DuckDbQueryError` and any OTHER
 * `DuckDbQueryError` on these tables (a bad column, a corrupt row) look
 * identical from the outside, and only the explicit check lets this function
 * treat "no ledger yet" as an honest zero-event result while still letting
 * every other query failure surface as a real `CacheReadError`.
 */
const ledgerTablesPresent = (cache: CacheReadService): Effect.Effect<boolean, CacheReadError> =>
    Effect.gen(function* () {
        const rows = yield* cache.rows(
            TableCountDbRow,
            "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'main' AND table_name IN (?, ?)",
            [...RUN_EVIDENCE_TABLES],
        );
        return (rows[0]?.n ?? 0) >= RUN_EVIDENCE_TABLES.length;
    });

interface RunEvidenceQueryRows {
    readonly bareId: string;
    readonly limit: number;
    readonly groups: ReadonlyArray<GroupRow>;
    readonly timelineRows: ReadonlyArray<{
        readonly ts: Date;
        readonly kind: string;
        readonly backing: string;
        readonly source_table: string;
        readonly summary: string | null;
    }>;
    readonly refGroups: ReadonlyArray<{ readonly ref_kind?: string | null; readonly n?: number | null }>;
    readonly heads: ReadonlyArray<{ readonly kind: string; readonly summary: string | null }>;
}

/** Pure assembly of {@link RunEvidenceResult} from decoded rows. Called with
 *  every array empty when the ledger tables are absent - the SAME shape a
 *  session with zero rows produces, which is the shape the renderer already
 *  handles (see `renderRunEvidence`'s `total === 0` branch). */
const buildRunEvidenceResult = ({ bareId, limit, groups, timelineRows, refGroups, heads }: RunEvidenceQueryRows): RunEvidenceResult => {
    const headOf = (kind: string): string | null =>
        heads.find((h) => h.kind === kind)?.summary ?? null;

    const total = groups.reduce((acc, r) => acc + (typeof r.n === "number" ? r.n : 0), 0);
    const byKind = tallyByTaxonomy(groups, "kind", RUN_EVIDENCE_KINDS)
        .sort((a, b) => b.count - a.count);
    const byBacking = tallyByTaxonomy(groups, "backing", RUN_EVIDENCE_BACKINGS);

    const refTotal = refGroups.reduce((acc, r) => acc + (typeof r.n === "number" ? r.n : 0), 0);
    const byRefKind = refGroups
        .filter((r): r is { ref_kind: string; n: number } => typeof r.ref_kind === "string")
        .map((r) => ({ key: r.ref_kind, count: typeof r.n === "number" ? r.n : 0 }))
        .sort((a, b) => b.count - a.count);

    return {
        session_id: bareId,
        generated_at: new Date().toISOString(),
        objective: headOf("objective"),
        repo: headOf("repo_state"),
        total,
        by_kind: byKind,
        by_backing: byBacking,
        timeline: timelineRows.map((row) => ({ ...row, ts: row.ts.toISOString() })),
        ref_total: refTotal,
        by_ref_kind: byRefKind,
        covered_kinds: [...RUN_EVIDENCE_COVERED_KINDS],
        timeline_limit: limit,
    } satisfies RunEvidenceResult;
};

const tallyByTaxonomy = (
    rows: ReadonlyArray<GroupRow>,
    field: "kind" | "backing",
    taxonomy: ReadonlyArray<string>,
): RunEvidenceCount[] => {
    const counts = new Map<string, number>();
    for (const t of taxonomy) counts.set(t, 0);
    for (const r of rows) {
        const k = r[field];
        const n = typeof r.n === "number" ? r.n : 0;
        if (typeof k === "string") counts.set(k, (counts.get(k) ?? 0) + n);
    }
    return [...counts.entries()].map(([key, count]) => ({ key, count }));
};

export const fetchRunEvidence = (input: RunEvidenceInput): Effect.Effect<
    RunEvidenceResult,
    CacheReadError,
    CacheRead
> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const bareId = toBareSessionId(input.sessionId);
        const sessionRef = bareId;
        const limit = Math.max(1, Math.floor(input.timelineLimit ?? RUN_EVIDENCE_TIMELINE_LIMIT));

        const ledgerReady = yield* ledgerTablesPresent(cache);
        if (!ledgerReady) {
            return buildRunEvidenceResult({ bareId, limit, groups: [], timelineRows: [], refGroups: [], heads: [] });
        }

        const groups = yield* cache.rows(
            GroupDbRow,
            "SELECT kind, backing, count(*) AS n FROM run_evidence_event WHERE session = ? GROUP BY kind, backing",
            [sessionRef],
        );
        const timelineRows = yield* cache.rows(
            TimelineDbRow,
            "SELECT ts, kind, backing, source_table, summary FROM run_evidence_event WHERE session = ? ORDER BY ts DESC LIMIT ?",
            [sessionRef, limit],
        );
        const refGroups = yield* cache.rows(
            RefGroupDbRow,
            "SELECT ref_kind, count(*) AS n FROM run_evidence_ref WHERE session = ? GROUP BY ref_kind",
            [sessionRef],
        );
        // Headline kinds: the run's objective + repo identity (latest of each).
        const heads = yield* cache.rows(
            HeadDbRow,
            "SELECT kind, summary FROM run_evidence_event WHERE session = ? AND kind IN ('objective', 'repo_state') ORDER BY ts DESC",
            [sessionRef],
        );

        return buildRunEvidenceResult({ bareId, limit, groups, timelineRows, refGroups, heads });
    });

const nonZero = (counts: ReadonlyArray<RunEvidenceCount>): string =>
    counts.filter((c) => c.count > 0).map((c) => `${c.key} ${c.count}`).join(" · ") || "(none)";

const hhmm = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 16);
};

/** Render the human-facing report (returns the body; CLI appends next-links). */
export const renderRunEvidence = (result: RunEvidenceResult): string => {
    const out: string[] = [];
    out.push(`run evidence: session ${result.session_id}  [${result.total} event${result.total === 1 ? "" : "s"}]`);

    if (result.total === 0) {
        out.push("");
        out.push("  (no run-evidence events for this session yet)");
        out.push("  - the ledger derives from tool_call / command_outcome / compaction / plan_snapshot;");
        out.push("    run `ax ingest` to (re)derive, or this run may simply have no such rows.");
        return out.join("\n");
    }

    // Headline answers (#578): what was the goal, and where did it run.
    if (result.objective) out.push(`  objective:   ${result.objective}`);
    if (result.repo) out.push(`  repo:        ${result.repo}`);

    out.push(`  by kind:     ${nonZero(result.by_kind)}`);
    // backing is the claim-vs-evidence lens; show model_claim explicitly even at 0.
    const claim = result.by_backing.find((b) => b.key === "model_claim")?.count ?? 0;
    out.push(`  by backing:  ${nonZero(result.by_backing)}`);
    if (claim === 0) {
        out.push("               (model_claim 0 - unverified model claims are not mined yet)");
    }
    if (result.ref_total > 0) {
        out.push(`  refs:        ${result.ref_total} (${nonZero(result.by_ref_kind)})`);
    }

    out.push("");
    out.push(`  timeline (latest ${Math.min(result.timeline.length, result.timeline_limit)}):`);
    for (const e of result.timeline) {
        out.push(`    ${hhmm(e.ts)}  ${e.kind.padEnd(17)} ${e.backing.padEnd(16)} ${e.summary ?? ""}`.trimEnd());
    }

    out.push("");
    out.push(`  covered kinds: ${result.covered_kinds.join(", ")}`);
    out.push("  (claim / artifact_ref: not yet derived)");
    return out.join("\n");
};
