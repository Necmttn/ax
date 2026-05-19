import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    EPISODE_CHILDREN_SQL,
    EPISODE_CHILD_INVOCATIONS_SQL,
    EPISODE_PARENT_INVOCATIONS_SQL,
    EPISODE_PARENT_SQL,
} from "../queries/episode-timeline.ts";
import {
    classifyPhase,
    compressPhaseSequence,
    PHASE_LETTER,
    type Phase,
} from "../lib/shared/phases.ts";
import type {
    EpisodeNode,
    EpisodeTimelinePayload,
} from "../lib/shared/dashboard-types.ts";
import { toBareSessionId } from "../lib/shared/session-id.ts";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

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

const recordIdString = (v: unknown): string | null => {
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object" && "toString" in v) {
        const s = String(v);
        return s.length > 0 ? s : null;
    }
    return null;
};

const durationMs = (start: string | null, end: string | null): number | null => {
    if (!start || !end) return null;
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
    return e - s;
};

/**
 * Aggregate an episode's invocations into per-session phase summary +
 * top-5 skills. A session is `mixed` if it has more than one distinct
 * non-`other` phase; otherwise it inherits the dominant phase.
 */
function summarizePerSession(
    invocations: ReadonlyArray<Record<string, unknown>>,
): Map<string, { phase: EpisodeNode["phase"]; top_skills: EpisodeNode["top_skills"]; invocation_count: number }> {
    interface Acc {
        skills: Map<string, number>;
        phases: Map<Phase, number>;
        total: number;
    }
    const bySession = new Map<string, Acc>();
    for (const raw of invocations) {
        const sessionRaw = recordIdString(raw.session);
        const skill = stringField(raw, "skill");
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
): Effect.Effect<EpisodeTimelinePayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
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
        const parentRef = `session:⟨${uuid}⟩`;

        const [parentRows, childRows] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(EPISODE_PARENT_SQL(parentRef)),
            db.query<[Array<Record<string, unknown>>]>(EPISODE_CHILDREN_SQL(parentRef)),
        ]);

        // Collect child session refs from the cheap spawned scan, then fetch
        // invocations using a literal IN list. The IN-subquery form scans
        // every invoked row (600k+); the literal form uses the
        // in.session index on each id.
        const childRefs: string[] = [];
        for (const raw of childRows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const id = recordIdString(raw.id);
            if (!id) continue;
            childRefs.push(id);
        }
        const childIdsLiteral = childRefs.length === 0
            ? "[NONE]"
            : `[${childRefs.join(", ")}]`;

        const [parentInvocationRows, childInvocationRows] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(
                EPISODE_PARENT_INVOCATIONS_SQL(parentRef),
            ),
            childRefs.length === 0
                ? Effect.succeed([[]] as [Array<Record<string, unknown>>])
                : db.query<[Array<Record<string, unknown>>]>(
                      EPISODE_CHILD_INVOCATIONS_SQL(childIdsLiteral),
                  ),
        ]);

        const combinedInvocations: Array<Record<string, unknown>> = [
            ...(parentInvocationRows?.[0] ?? []),
            ...(childInvocationRows?.[0] ?? []),
        ];
        const summary = summarizePerSession(combinedInvocations);
        // Wire format is bare; the storage record-id form (`session:⟨uuid⟩`)
        // stays in `parentRef` for SurrealQL interpolation above.
        const parentBareId = uuid;
        const nodes: EpisodeNode[] = [];
        let parentMeta: EpisodeNode | null = null;

        const toNode = (
            raw: Record<string, unknown>,
            role: "parent" | "child",
        ): EpisodeNode | null => {
            const idRaw = recordIdString(raw.id);
            if (!idRaw) return null;
            const id = toBareSessionId(idRaw);
            const started_at = dateField(raw, "started_at");
            const ended_at = dateField(raw, "ended_at");
            const sum = summary.get(id);
            return {
                session_id: id,
                role,
                project: stringField(raw, "project"),
                source: stringField(raw, "source"),
                started_at,
                ended_at,
                duration_ms: durationMs(started_at, ended_at),
                phase: sum?.phase ?? "other",
                top_skills: sum?.top_skills ?? [],
                invocation_count: sum?.invocation_count ?? 0,
            };
        };

        for (const raw of parentRows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const node = toNode(raw, "parent");
            if (node) parentMeta = node;
        }
        for (const raw of childRows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const node = toNode(raw, "child");
            if (node) nodes.push(node);
        }

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
