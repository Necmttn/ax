import { Effect } from "effect";
import { encodeJson, jsonRecordField } from "@ax/lib/decode";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import {
    WEEKS_LOOKBACK,
    WORKFLOW_EPISODES_SQL,
    WORKFLOW_EPISODE_PAIRS_SQL,
    WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL,
    WORKFLOW_SNAPSHOT_SQL,
    WORKFLOW_SESSION_SEQUENCES_SQL,
    WORKFLOW_SESSION_SHAPE_SQL,
    WORKFLOW_WEEKLY_SKILLS_SQL,
    WORKFLOW_WEEKLY_TOOLS_SQL,
} from "../queries/workflow.ts";
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

export const computeWorkflow = (): Effect.Effect<
    WorkflowResponse,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [
            skillRows,
            toolRows,
            sessionRows,
            sequenceRows,
            episodeRows,
            episodePairRows,
            episodeInvocationRows,
        ] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(WORKFLOW_WEEKLY_SKILLS_SQL),
            db.query<[Array<Record<string, unknown>>]>(WORKFLOW_WEEKLY_TOOLS_SQL),
            db.query<[Array<Record<string, unknown>>]>(WORKFLOW_SESSION_SHAPE_SQL),
            db.query<[Array<Record<string, unknown>>]>(WORKFLOW_SESSION_SEQUENCES_SQL),
            db.query<[Array<Record<string, unknown>>]>(WORKFLOW_EPISODES_SQL),
            db.query<[Array<Record<string, unknown>>]>(WORKFLOW_EPISODE_PAIRS_SQL),
            db.query<[Array<Record<string, unknown>>]>(WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL),
        ]);
        const skills = bucketByWeek(skillRows?.[0] ?? [], "skill");
        const tools = bucketByWeek(toolRows?.[0] ?? [], "label");
        const sessionShape: WorkflowSessionShape[] = (sessionRows?.[0] ?? [])
            .map((raw) => {
                const week = stringField(raw, "week");
                if (!week) return null;
                return { week, session_count: numericField(raw, "session_count") };
            })
            .filter((r): r is WorkflowSessionShape => r !== null)
            .sort((a, b) => a.week.localeCompare(b.week));
        const convergence = computeConvergence(skills);
        const { shapes, total: shapesTotal } = aggregateShapes(sequenceRows?.[0] ?? []);
        const { shapes: episode_shapes, total: episode_shapes_total } =
            aggregateEpisodeShapes(
                episodePairRows?.[0] ?? [],
                episodeInvocationRows?.[0] ?? [],
            );
        const episodes: WorkflowEpisode[] = (episodeRows?.[0] ?? [])
            .map((raw): WorkflowEpisode | null => {
                const parent = stringFieldOrId(raw, "parent");
                if (!parent) return null;
                // SurrealDB GROUP BY collects non-aggregate cols into arrays;
                // they're all the same value within one group, so take [0].
                const projectRaw = raw.project;
                const project = Array.isArray(projectRaw)
                    ? typeof projectRaw[0] === "string" ? projectRaw[0] : null
                    : typeof projectRaw === "string" ? projectRaw : null;
                const startedRaw = raw.started_at;
                const started = Array.isArray(startedRaw)
                    ? dateField({ x: startedRaw[0] }, "x")
                    : dateField(raw, "started_at");
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

export const refreshWorkflowSnapshot = (): Effect.Effect<
    WorkflowResponse,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const payload = yield* computeWorkflow();
        yield* db.query(
            `UPSERT workflow_snapshot:latest CONTENT {
                generated_at: $generated_at,
                payload: $payload,
                source: "workflow-refresh"
            };`,
            {
                generated_at: new Date(payload.generatedAt),
                payload: encodeJson(payload),
            },
        );
        return payload;
    });

export const fetchWorkflow = (): Effect.Effect<
    WorkflowResponse,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const snapshotRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            WORKFLOW_SNAPSHOT_SQL,
        ))?.[0] ?? [];
        const snapshot = parseSnapshotPayload(snapshotRows);
        if (snapshot) return snapshot;
        return yield* refreshWorkflowSnapshot();
    });
