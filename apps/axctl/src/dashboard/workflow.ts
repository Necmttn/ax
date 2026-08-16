import { Effect } from "effect";
import { encodeJson, jsonRecordField } from "@ax/lib/decode";
import { cacheRow, tsParam } from "@ax/lib/duckdb/row";
import {
    CacheRead,
    type CacheReadError,
    type CacheReadService,
    type CacheWriteError,
    type CacheWriteService,
} from "@ax/lib/duckdb/seam";
import { daysAgoExpr } from "@ax/lib/duckdb/clause";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import {
    classifyPhase,
    compressPhaseSequence,
    PHASE_LETTER,
    type Phase,
} from "@ax/lib/shared/phases";
import type {
    EpisodeShapeAggregate,
    SessionShapeAggregate,
    WorkflowConvergencePoint,
    WorkflowEpisode,
    WorkflowResponse,
    WorkflowSessionShape,
    WorkflowWeekBucket,
} from "@ax/lib/shared/dashboard-types";

const TOP_K = 10;

const numericField = (row: Record<string, unknown>, key: string): number => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
};

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

const dateField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    if (v && typeof v === "object" && "toJSON" in v) {
        const j = (v as { toJSON: () => unknown }).toJSON();
        if (typeof j === "string" && j.length > 0) return j;
    }
    return null;
};

/**
 * Group a flat (week, label, count) result set into per-week buckets sorted
 * by descending count. Each row appears under exactly one week.
 */
function bucketByWeek(
    rows: ReadonlyArray<Record<string, unknown>>,
    labelKey: "skill" | "label",
): WorkflowWeekBucket[] {
    const byWeek = new Map<string, Array<{ label: string; count: number }>>();
    for (const row of rows) {
        const week = stringField(row, "week");
        const label = stringField(row, labelKey);
        const count = numericField(row, "count");
        if (!week || !label) continue;
        const entry = byWeek.get(week);
        const next = { label, count };
        if (entry) entry.push(next);
        else byWeek.set(week, [next]);
    }
    return Array.from(byWeek.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, counts]) => ({
            week,
            counts: counts.sort((x, y) => y.count - x.count),
        }));
}

/**
 * For each week, take the top-K labels and compute Jaccard similarity vs the
 * previous week's top-K. Rising = converging on a stable workflow. Falling
 * or zigzagging = exploring / changing tools.
 */
export function computeConvergence(
    buckets: ReadonlyArray<WorkflowWeekBucket>,
    k = TOP_K,
): WorkflowConvergencePoint[] {
    const out: WorkflowConvergencePoint[] = [];
    let prev: Set<string> | null = null;
    for (const bucket of buckets) {
        const top = bucket.counts.slice(0, k).map((c) => c.label);
        const set = new Set(top);
        if (prev === null) {
            out.push({
                week: bucket.week,
                jaccard: null,
                topK: top,
                newcomers: top,
                dropouts: [],
            });
        } else {
            const intersection = top.filter((label) => prev!.has(label));
            const union = new Set([...top, ...prev]);
            const jaccard = union.size === 0 ? 0 : intersection.length / union.size;
            const newcomers = top.filter((label) => !prev!.has(label));
            const dropouts = Array.from(prev).filter((label) => !set.has(label));
            out.push({ week: bucket.week, jaccard, topK: top, newcomers, dropouts });
        }
        prev = set;
    }
    return out;
}

/**
 * Cheap narrative: looks at the last 3 weeks' convergence trend and writes
 * one sentence the user can read at a glance.
 */
function buildNarrative(convergence: ReadonlyArray<WorkflowConvergencePoint>): string {
    const points = convergence.filter((c) => c.jaccard !== null);
    if (points.length === 0) {
        return "Not enough weekly history yet to detect a workflow pattern.";
    }
    const last = points[points.length - 1];
    if (!last) return "No workflow data.";
    const lastJaccard = last.jaccard ?? 0;
    const recent = points.slice(-3);
    const avg =
        recent.reduce((sum, p) => sum + (p.jaccard ?? 0), 0) / recent.length;
    const trend =
        recent.length >= 2 && (recent[recent.length - 1]?.jaccard ?? 0) >
            (recent[0]?.jaccard ?? 0)
            ? "tightening"
            : recent.length >= 2 && (recent[recent.length - 1]?.jaccard ?? 0) <
                (recent[0]?.jaccard ?? 0)
                ? "shifting"
                : "stable";
    const tier =
        lastJaccard >= 0.75
            ? "highly converged"
            : lastJaccard >= 0.5
                ? "settling"
                : lastJaccard >= 0.25
                    ? "still exploring"
                    : "wide open";
    const newcomersText =
        last.newcomers.length > 0
            ? ` This week introduced ${last.newcomers.length} new tool${last.newcomers.length === 1 ? "" : "s"}: ${last.newcomers.slice(0, 3).join(", ")}.`
            : "";
    return `Workflow is ${tier} (Jaccard ${(lastJaccard * 100).toFixed(0)}% vs last week, 3-week avg ${(avg * 100).toFixed(0)}%, trend ${trend}).${newcomersText}`;
}

/**
 * Walk the flat (session, skill, ts) result, group by session in order, then
 * compress each session's phase sequence and aggregate by shape. Returns the
 * top N most-common shapes plus a few example session ids per shape.
 */
function aggregateShapes(
    rows: ReadonlyArray<Record<string, unknown>>,
): { shapes: SessionShapeAggregate[]; total: number } {
    const sessions = new Map<string, Phase[]>();
    for (const row of rows) {
        const session = stringFieldOrId(row, "session");
        const skill = stringField(row, "skill");
        if (!session || !skill) continue;
        const phase = classifyPhase(skill);
        const arr = sessions.get(session) ?? [];
        arr.push(phase);
        if (arr.length === 1) sessions.set(session, arr);
    }

    interface Bucket {
        readonly phases: Phase[];
        readonly shape: string;
        sessions: string[];
    }
    const byShape = new Map<string, Bucket>();
    let total = 0;
    for (const [session, phases] of sessions) {
        const compressed = compressPhaseSequence(phases) as Phase[];
        if (compressed.length === 0) continue; // session was all "other"
        total += 1;
        const shape = compressed.map((p) => PHASE_LETTER[p]).join("→");
        const existing = byShape.get(shape);
        if (existing) {
            existing.sessions.push(session);
        } else {
            byShape.set(shape, {
                phases: compressed,
                shape,
                sessions: [session],
            });
        }
    }

    const shapes = Array.from(byShape.values())
        .sort((a, b) => b.sessions.length - a.sessions.length)
        .slice(0, 12)
        .map((bucket) => ({
            shape: bucket.shape,
            phases: bucket.phases.filter(
                (p): p is "plan" | "execute" | "review" | "merge" => p !== "other",
            ),
            session_count: bucket.sessions.length,
            // Bare session ids over the HTTP seam; see src/lib/shared/session-id.ts.
            example_session_ids: bucket.sessions.slice(0, 3).map(toBareSessionId),
        }));
    return { shapes, total };
}

/**
 * Episode = orchestrator parent + all sessions it spawned. For each episode
 * we concatenate all invocations chronologically (parent + children
 * interleaved by ts), classify each into a phase, compress consecutive same-
 * phase + drop "other", and aggregate by resulting shape.
 *
 * This is where multi-session workflows like P -> [R x N] -> M become
 * visible. A session-level view sees only the orchestrator's own turns and
 * misses that the orchestrator dispatched 12 reviewer subagents.
 */
function aggregateEpisodeShapes(
    pairRows: ReadonlyArray<Record<string, unknown>>,
    invocationRows: ReadonlyArray<Record<string, unknown>>,
): { shapes: EpisodeShapeAggregate[]; total: number } {
    // Build session_id -> parent_id index. Parent maps to itself; children
    // map to their parent. A session involved in NO pair is skipped (it's
    // not part of an episode).
    const sessionToParent = new Map<string, string>();
    const parentToChildren = new Map<string, Set<string>>();
    for (const raw of pairRows) {
        const parent = stringFieldOrId(raw, "parent");
        const child = stringFieldOrId(raw, "child");
        if (!parent || !child) continue;
        sessionToParent.set(parent, parent);
        sessionToParent.set(child, parent);
        let set = parentToChildren.get(parent);
        if (!set) {
            set = new Set();
            parentToChildren.set(parent, set);
        }
        set.add(child);
    }

    interface PendingInvocation {
        readonly parent: string;
        readonly ts: number;
        readonly phase: Phase;
    }
    const byParent = new Map<string, PendingInvocation[]>();
    for (const raw of invocationRows) {
        const session = stringFieldOrId(raw, "session");
        const skill = stringField(raw, "skill");
        const ts = dateField(raw, "ts");
        if (!session || !skill || !ts) continue;
        const parent = sessionToParent.get(session);
        if (!parent) continue;
        const phase = classifyPhase(skill);
        const tsMs = Date.parse(ts);
        if (Number.isNaN(tsMs)) continue;
        const list = byParent.get(parent) ?? [];
        list.push({ parent, ts: tsMs, phase });
        if (list.length === 1) byParent.set(parent, list);
    }

    interface Bucket {
        readonly phases: Phase[];
        readonly shape: string;
        readonly parents: string[];
        totalChildren: number;
    }
    const byShape = new Map<string, Bucket>();
    let total = 0;
    for (const [parent, events] of byParent) {
        events.sort((a, b) => a.ts - b.ts);
        const phases = events.map((e) => e.phase);
        const compressed = compressPhaseSequence(phases) as Phase[];
        if (compressed.length === 0) continue;
        total += 1;
        const shape = compressed.map((p) => PHASE_LETTER[p]).join("→");
        const existing = byShape.get(shape);
        const childCount = parentToChildren.get(parent)?.size ?? 0;
        if (existing) {
            existing.parents.push(parent);
            existing.totalChildren += childCount;
        } else {
            byShape.set(shape, {
                phases: compressed,
                shape,
                parents: [parent],
                totalChildren: childCount,
            });
        }
    }

    const shapes = Array.from(byShape.values())
        .sort((a, b) => b.parents.length - a.parents.length)
        .slice(0, 12)
        .map((bucket) => ({
            shape: bucket.shape,
            phases: bucket.phases.filter(
                (p): p is "plan" | "execute" | "review" | "merge" => p !== "other",
            ),
            episode_count: bucket.parents.length,
            example_parent_ids: bucket.parents.slice(0, 3).map(toBareSessionId),
            avg_children:
                bucket.parents.length === 0
                    ? 0
                    : Math.round(bucket.totalChildren / bucket.parents.length),
        }));
    return { shapes, total };
}

const stringFieldOrId = (
    row: Record<string, unknown>,
    key: string,
): string | null => {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && "toString" in value) {
        const s = String(value);
        return s.length > 0 ? s : null;
    }
    return null;
};

const parseSnapshotPayload = (rows: ReadonlyArray<Record<string, unknown>>): WorkflowResponse | null => {
    const payload = stringField(rows[0] ?? {}, "payload");
    if (!payload) return null;
    // The snapshot payload is a WorkflowResponse we serialized ourselves;
    // decode the JSON-string boundary as a record, keep the structural cast.
    const parsed = jsonRecordField.decode(payload);
    return parsed === null ? null : (parsed as unknown as WorkflowResponse);
};

/**
 * Weeks lookback for the three weekly-bucket queries below - kept bounded so a
 * cold scan on a large `invoked`/`tool_call`/`session` table stays cheap.
 * Ported from `queries/workflow.ts` (SurrealDB `time::now() - 12w`); DuckDB has
 * no week-interval literal, so the bound param is expressed in DAYS.
 */
const WEEKS_LOOKBACK = 12;
const LOOKBACK_DAYS = WEEKS_LOOKBACK * 7;

// Local DuckDB translations of `queries/workflow.ts`'s SurrealQL constants -
// that file is unported (2b's ownership); copy the shape, never import the
// SurrealQL text. `strftime(ts, '%G-W%V')` is DuckDB's equivalent of
// SurrealDB's `time::format(ts, "%G-W%V")` (verified: both produce ISO
// year-week, e.g. 2025-12-29 -> "2026-W01").

const WORKFLOW_WEEKLY_SKILLS_SQL = `
    SELECT strftime(iv.ts, '%G-W%V') AS week, sk.name AS skill, count(*) AS count
    FROM invoked iv
    JOIN skill sk ON sk.id = iv.out_id
    WHERE iv.ts > ${daysAgoExpr} AND sk.name IS NOT NULL
    GROUP BY week, skill
    ORDER BY week ASC, count DESC
`;

const WORKFLOW_WEEKLY_TOOLS_SQL = `
    SELECT strftime(tc.ts, '%G-W%V') AS week, COALESCE(tc.command_norm, tc.name) AS label, count(*) AS count
    FROM tool_call tc
    WHERE tc.ts > ${daysAgoExpr} AND COALESCE(tc.command_norm, tc.name) IS NOT NULL
    GROUP BY week, label
    ORDER BY week ASC, count DESC
`;

const WORKFLOW_SESSION_SHAPE_SQL = `
    SELECT strftime(started_at, '%G-W%V') AS week, count(*) AS session_count
    FROM session
    WHERE started_at > ${daysAgoExpr}
    GROUP BY week
    ORDER BY week ASC
`;

// SurrealDB's `GROUP BY parent, project, started_at` collects the
// non-aggregate columns (SurrealQL semantics differ from standard SQL); the
// DuckDB equivalent groups on the real key (`sp.in_id`) and joins `session`
// for the two descriptive columns, which are single-valued per parent.
const WORKFLOW_EPISODES_SQL = `
    SELECT
        sp.in_id AS parent,
        s.project AS project,
        s.started_at AS started_at,
        count(*) AS child_count,
        count(DISTINCT sp.nickname) AS distinct_nicknames
    FROM spawned sp
    LEFT JOIN session s ON s.id = sp.in_id
    GROUP BY sp.in_id, s.project, s.started_at
    ORDER BY child_count DESC
    LIMIT 25
`;

const WORKFLOW_EPISODE_PAIRS_SQL = "SELECT in_id AS parent, out_id AS child FROM spawned";

// `invoked.session`/`turn_index`/`is_first` are denormalized directly onto the
// edge row (see packages/schema/src/schema.duckdb.sql), so no turn deref is
// needed here - only a join to `skill` (name) and `session` (source filter).
const WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL = `
    SELECT iv.session AS session, sk.name AS skill, iv.turn_index AS turn_index, iv.ts AS ts
    FROM invoked iv
    JOIN skill sk ON sk.id = iv.out_id
    JOIN session s ON s.id = iv.session
    WHERE iv.is_first = true
      AND iv.session IS NOT NULL
      AND sk.name IS NOT NULL
      AND s.source = 'claude-subagent'
    LIMIT 100000
`;

const WORKFLOW_SESSION_SEQUENCES_SQL = `
    SELECT iv.session AS session, sk.name AS skill, iv.turn_index AS turn_index, iv.ts AS ts
    FROM invoked iv
    JOIN skill sk ON sk.id = iv.out_id
    JOIN session s ON s.id = iv.session
    WHERE iv.ts > ${daysAgoExpr}
      AND iv.is_first = true
      AND iv.session IS NOT NULL
      AND sk.name IS NOT NULL
      AND s.source NOT IN ('claude-subagent', 'codex-subagent')
    ORDER BY session ASC, turn_index ASC
    LIMIT 50000
`;

/**
 * Defensive raw-row reader: a failed query degrades to `[]` (matches the
 * `cacheRows` contract), so one bad query in the batch below never sinks the
 * whole rollup. Mirrors the identical helper in session-canvas.ts / triage.ts.
 */
const rawRows = (
    read: CacheReadService,
    sql: string,
    params?: ReadonlyArray<DuckDbParam>,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, never> =>
    read.raw(sql, params).pipe(
        Effect.map((result) => result.rows),
        Effect.catch((error) => {
            console.error(`workflow query failed: ${sql.slice(0, 60)}...`, error);
            return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
        }),
    );

/**
 * `read` is an explicit parameter, not resolved via `yield* CacheRead`,
 * because `refreshWorkflowSnapshot` below calls this DURING ingest (under the
 * write lock) and must read the live database being written to - not the
 * previously-published snapshot the `CacheRead` service tag would otherwise
 * answer from. Same dual-module discipline as the rest of the DuckDB seam.
 */
export const computeWorkflow = (
    read: CacheReadService,
): Effect.Effect<WorkflowResponse, never> =>
    Effect.gen(function* () {
        const [
            skillRows,
            toolRows,
            sessionRows,
            sequenceRows,
            episodeRows,
            episodePairRows,
            episodeInvocationRows,
        ] = yield* Effect.all([
            rawRows(read, WORKFLOW_WEEKLY_SKILLS_SQL, [LOOKBACK_DAYS]),
            rawRows(read, WORKFLOW_WEEKLY_TOOLS_SQL, [LOOKBACK_DAYS]),
            rawRows(read, WORKFLOW_SESSION_SHAPE_SQL, [LOOKBACK_DAYS]),
            rawRows(read, WORKFLOW_SESSION_SEQUENCES_SQL, [LOOKBACK_DAYS]),
            rawRows(read, WORKFLOW_EPISODES_SQL),
            rawRows(read, WORKFLOW_EPISODE_PAIRS_SQL),
            rawRows(read, WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL),
        ]);
        const skills = bucketByWeek(skillRows, "skill");
        const tools = bucketByWeek(toolRows, "label");
        const sessionShape: WorkflowSessionShape[] = sessionRows
            .map((raw) => {
                const week = stringField(raw, "week");
                if (!week) return null;
                return { week, session_count: numericField(raw, "session_count") };
            })
            .filter((r): r is WorkflowSessionShape => r !== null)
            .sort((a, b) => a.week.localeCompare(b.week));
        const convergence = computeConvergence(skills);
        const { shapes, total: shapesTotal } = aggregateShapes(sequenceRows);
        const { shapes: episode_shapes, total: episode_shapes_total } =
            aggregateEpisodeShapes(episodePairRows, episodeInvocationRows);
        const episodes: WorkflowEpisode[] = episodeRows
            .map((raw): WorkflowEpisode | null => {
                const parent = stringFieldOrId(raw, "parent");
                if (!parent) return null;
                // Plain single-valued columns under DuckDB (real GROUP BY
                // keys/joins, not SurrealQL's array-collecting semantics) -
                // the array-unwrap branches from the old SurrealQL port are
                // gone; stringField/dateField read the scalar directly.
                const project = stringField(raw, "project");
                const started = dateField(raw, "started_at");
                return {
                    // Bare session id over the HTTP seam; see src/lib/shared/session-id.ts.
                    parent_session_id: toBareSessionId(parent),
                    project,
                    started_at: started,
                    child_count: numericField(raw, "child_count"),
                    distinct_nicknames: numericField(raw, "distinct_nicknames"),
                };
            })
            .filter((r): r is WorkflowEpisode => r !== null);
        return {
            generatedAt: new Date().toISOString(),
            weeksLookback: WEEKS_LOOKBACK,
            topK: TOP_K,
            skills,
            tools,
            sessionShape,
            convergence,
            shapes,
            shapesTotal,
            episodes,
            episode_shapes,
            episode_shapes_total,
            narrative: buildNarrative(convergence),
        };
    });

/**
 * The single stored workflow snapshot. Keyed `latest` because there is exactly
 * one: the row is a materialized cache of `computeWorkflow`, not history.
 */
const WORKFLOW_SNAPSHOT_ID = "latest";

const DUCKDB_WORKFLOW_SNAPSHOT_SQL =
    "SELECT payload FROM workflow_snapshot WHERE id = ? LIMIT 1";

/**
 * Recompute the workflow rollup and PERSIST it.
 *
 * Takes the `CacheWriteService` rather than resolving a client, because under
 * v2 that is the only way to write: `withCacheWrite` refuses to open the live
 * database unless the calling process holds the ingest lock. That constraint is
 * the reason this function grew a parameter, and the reason `fetchWorkflow`
 * below no longer calls it - a dashboard READ must not take the ingest lock out
 * from under a running ingest just because its cache was cold.
 *
 * `computeWorkflow` now reads through the `write` service passed in (a
 * `CacheWriteService` extends `CacheReadService`), so this stays a single
 * connection under the ingest lock - no separate `CacheRead` resolution.
 */
export const refreshWorkflowSnapshot = (
    write: CacheWriteService,
): Effect.Effect<WorkflowResponse, CacheWriteError> =>
    Effect.gen(function* () {
        const payload = yield* computeWorkflow(write);
        yield* write.put("workflow_snapshot", cacheRow({
            id: WORKFLOW_SNAPSHOT_ID,
            generated_at: tsParam(payload.generatedAt),
            payload: encodeJson(payload),
            source: "workflow-refresh",
        }));
        return payload;
    });

/**
 * The stored snapshot, or a freshly computed rollup when none exists.
 *
 * The cold-cache branch COMPUTES BUT DOES NOT PERSIST. It used to write the
 * snapshot it had just built, which was free against Surreal and is not against
 * DuckDB: writes go through the ingest lock, so a dashboard request that healed
 * its own cache would contend with - or die on - a concurrent ingest. The
 * snapshot is now filled by whoever holds the lock (see
 * {@link refreshWorkflowSnapshot}); a cold read pays the compute and answers
 * correctly, which is the behaviour that matters to the caller.
 */
export const fetchWorkflow = (): Effect.Effect<
    WorkflowResponse,
    CacheReadError,
    CacheRead
> =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const stored = yield* read.raw(DUCKDB_WORKFLOW_SNAPSHOT_SQL, [WORKFLOW_SNAPSHOT_ID]);
        const snapshot = parseSnapshotPayload(stored.rows);
        if (snapshot) return snapshot;
        return yield* computeWorkflow(read);
    });
