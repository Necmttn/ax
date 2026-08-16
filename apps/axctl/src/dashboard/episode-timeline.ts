import { Effect, Schema } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { cacheRows } from "@ax/lib/duckdb/query";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import {
    classifyPhase,
    compressPhaseSequence,
    PHASE_LETTER,
    type Phase,
} from "@ax/lib/shared/phases";
import type {
    EpisodeNode,
    EpisodeTimelinePayload,
} from "@ax/lib/shared/dashboard-types";
import { toBareSessionId } from "@ax/lib/shared/session-id";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

const durationMs = (start: string | null, end: string | null): number | null => {
    if (!start || !end) return null;
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
    return e - s;
};

const EpisodeSessionDbRow = Schema.Struct({
    id: Schema.String,
    project: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(TimestampColumn),
    ended_at: Schema.NullOr(TimestampColumn),
    cwd: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
});
type EpisodeSessionRow = typeof EpisodeSessionDbRow.Type;

const EpisodeInvocationDbRow = Schema.Struct({
    session: Schema.NullOr(Schema.String),
    skill: Schema.NullOr(Schema.String),
});

/**
 * Aggregate an episode's invocations into per-session phase summary +
 * top-5 skills. A session is `mixed` if it has more than one distinct
 * non-`other` phase; otherwise it inherits the dominant phase.
 */
function summarizePerSession(
    invocations: ReadonlyArray<typeof EpisodeInvocationDbRow.Type>,
): Map<string, { phase: EpisodeNode["phase"]; top_skills: EpisodeNode["top_skills"]; invocation_count: number }> {
    interface Acc {
        skills: Map<string, number>;
        phases: Map<Phase, number>;
        total: number;
    }
    const bySession = new Map<string, Acc>();
    for (const raw of invocations) {
        const sessionRaw = raw.session;
        const skill = raw.skill;
        if (!sessionRaw || !skill) continue;
        // Bare keys so lookups against toBareSessionId(raw.id) below match.
        const session = toBareSessionId(sessionRaw);
        const phase = classifyPhase(skill);
        const acc = bySession.get(session) ?? {
            skills: new Map<string, number>(),
            phases: new Map<Phase, number>(),
            total: 0,
        };
        acc.skills.set(skill, (acc.skills.get(skill) ?? 0) + 1);
        acc.phases.set(phase, (acc.phases.get(phase) ?? 0) + 1);
        acc.total += 1;
        if (acc.total === 1) bySession.set(session, acc);
    }

    const out = new Map<
        string,
        { phase: EpisodeNode["phase"]; top_skills: EpisodeNode["top_skills"]; invocation_count: number }
    >();
    for (const [session, acc] of bySession) {
        const nonOther = Array.from(acc.phases.entries()).filter(([p]) => p !== "other");
        let dominant: EpisodeNode["phase"];
        if (nonOther.length === 0) {
            dominant = "other";
        } else if (nonOther.length === 1) {
            dominant = nonOther[0]?.[0] ?? "other";
        } else {
            dominant = "mixed";
        }
        const top_skills = Array.from(acc.skills.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([skill, count]) => ({ skill, count }));
        out.set(session, {
            phase: dominant,
            top_skills,
            invocation_count: acc.total,
        });
    }
    return out;
}

function buildShape(nodes: ReadonlyArray<EpisodeNode>): string {
    const sorted = nodes
        .filter((n) => n.started_at !== null)
        .sort((a, b) =>
            Date.parse(a.started_at!) - Date.parse(b.started_at!),
        );
    const phases: Phase[] = [];
    for (const node of sorted) {
        if (node.phase === "other") continue;
        if (node.phase === "mixed") {
            // For mixed sessions we can't tell which sub-phase came first
            // from the per-session summary; treat as execute for the shape.
            phases.push("execute");
        } else {
            phases.push(node.phase);
        }
    }
    const compressed = compressPhaseSequence(phases) as Phase[];
    return compressed.map((p) => PHASE_LETTER[p]).join("→");
}

export const fetchEpisodeTimeline = (
    parentSessionId: string,
): Effect.Effect<EpisodeTimelinePayload, never, CacheRead> =>
    Effect.gen(function* () {
        const uuid = parentSessionId
            .replace(/^session:⟨/, "")
            .replace(/⟩$/, "")
            .replace(/^session:/, "");
        if (!SESSION_ID_RE.test(uuid)) {
            return {
                parent_session_id: parentSessionId,
                project: null,
                started_at: null,
                ended_at: null,
                duration_ms: null,
                node_count: 0,
                nodes: [],
                shape: "",
            };
        }
        // Bare id, matching what session.id / spawned.in_id / invoked.session
        // hold under DuckDB (no record-id decoration to strip).
        const parentId = uuid;

        const [parentRows, childRows] = yield* Effect.all([
            cacheRows(
                EpisodeSessionDbRow,
                { sql: `SELECT id, project, source, started_at, ended_at, cwd, model FROM session WHERE id = ?`, params: [parentId] },
                "episode-timeline.parent",
            ),
            cacheRows(
                EpisodeSessionDbRow,
                {
                    sql: `SELECT s.id AS id, s.project AS project, s.source AS source, s.started_at AS started_at,
                                 s.ended_at AS ended_at, s.cwd AS cwd, s.model AS model
                          FROM spawned sp JOIN session s ON s.id = sp.out_id
                          WHERE sp.in_id = ? ORDER BY s.started_at ASC LIMIT 500`,
                    params: [parentId],
                },
                "episode-timeline.children",
            ),
        ]);

        // Collect child session ids from the cheap spawned join above, then
        // fetch invocations using a literal IN list - avoids the IN-subquery
        // slowdown that scans every invoked row (600k+).
        const childIds = childRows.map((row) => row.id);

        const [parentInvocationRows, childInvocationRows] = yield* Effect.all([
            cacheRows(
                EpisodeInvocationDbRow,
                {
                    sql: `SELECT iv.session AS session, sk.name AS skill
                          FROM invoked iv JOIN skill sk ON sk.id = iv.out_id
                          WHERE iv.session = ? AND sk.name IS NOT NULL
                          ORDER BY iv.ts ASC LIMIT 5000`,
                    params: [parentId],
                },
                "episode-timeline.parent_invocations",
            ),
            childIds.length === 0
                ? Effect.succeed([] as ReadonlyArray<typeof EpisodeInvocationDbRow.Type>)
                : cacheRows(
                      EpisodeInvocationDbRow,
                      {
                          sql: `SELECT iv.session AS session, sk.name AS skill
                                FROM invoked iv JOIN skill sk ON sk.id = iv.out_id
                                WHERE iv.session IN (${childIds.map(() => "?").join(", ")}) AND sk.name IS NOT NULL
                                ORDER BY iv.ts ASC LIMIT 20000`,
                          params: [...childIds],
                      },
                      "episode-timeline.child_invocations",
                  ),
        ]);

        const combinedInvocations = [...parentInvocationRows, ...childInvocationRows];
        const summary = summarizePerSession(combinedInvocations);
        const parentBareId = uuid;
        const nodes: EpisodeNode[] = [];
        let parentMeta: EpisodeNode | null = null;

        const toNode = (raw: EpisodeSessionRow, role: "parent" | "child"): EpisodeNode => {
            const id = toBareSessionId(raw.id);
            const started_at = raw.started_at ? raw.started_at.toISOString() : null;
            const ended_at = raw.ended_at ? raw.ended_at.toISOString() : null;
            const sum = summary.get(id);
            return {
                session_id: id,
                role,
                project: raw.project,
                source: raw.source,
                started_at,
                ended_at,
                duration_ms: durationMs(started_at, ended_at),
                phase: sum?.phase ?? "other",
                top_skills: sum?.top_skills ?? [],
                invocation_count: sum?.invocation_count ?? 0,
            };
        };

        for (const raw of parentRows) parentMeta = toNode(raw, "parent");
        for (const raw of childRows) nodes.push(toNode(raw, "child"));

        // Parent first, children chronologically.
        const ordered: EpisodeNode[] = [];
        if (parentMeta) ordered.push(parentMeta);
        ordered.push(
            ...nodes.sort((a, b) => {
                const ax = a.started_at ? Date.parse(a.started_at) : 0;
                const bx = b.started_at ? Date.parse(b.started_at) : 0;
                return ax - bx;
            }),
        );

        // Episode-level duration spans first start to last end.
        const firstStart = ordered
            .map((n) => (n.started_at ? Date.parse(n.started_at) : null))
            .filter((v): v is number => v !== null)
            .reduce((min, v) => (min === null || v < min ? v : min), null as number | null);
        const lastEnd = ordered
            .map((n) => (n.ended_at ? Date.parse(n.ended_at) : null))
            .filter((v): v is number => v !== null)
            .reduce((max, v) => (max === null || v > max ? v : max), null as number | null);
        const duration =
            firstStart !== null && lastEnd !== null && lastEnd >= firstStart
                ? lastEnd - firstStart
                : null;

        return {
            parent_session_id: parentBareId,
            project: parentMeta?.project ?? null,
            started_at: parentMeta?.started_at ?? null,
            ended_at: parentMeta?.ended_at ?? null,
            duration_ms: duration,
            node_count: ordered.length,
            nodes: ordered,
            shape: buildShape(ordered.filter((n) => n.role === "child")),
        };
    });
