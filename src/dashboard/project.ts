import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    PROJECT_EPISODES_SQL,
    PROJECT_OVERVIEW_SQL,
    PROJECT_RECENT_SESSIONS_SQL,
    PROJECT_TOP_FAILURES_SQL,
    PROJECT_TOP_SKILLS_SQL,
} from "../queries/project.ts";
import type {
    ProjectEpisode,
    ProjectFailure,
    ProjectPagePayload,
    ProjectRecentSession,
    ProjectTopSkill,
} from "../lib/shared/dashboard-types.ts";
import { toBareSessionId } from "../lib/shared/session-id.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

const numField = (row: Record<string, unknown>, key: string): number => {
    const v = Number(row[key] ?? 0);
    return Number.isFinite(v) ? v : 0;
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

const stringArray = (v: unknown): ReadonlyArray<string> => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
        if (typeof x === "string" && x.length > 0) out.push(x);
    }
    return out;
};

export const fetchProject = (
    project: string,
): Effect.Effect<ProjectPagePayload | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const bindings = { project };

        const [overviewRows, skillRows, failureRows, sessionRows, episodeRows] =
            yield* Effect.all([
                db.query<[Array<Record<string, unknown>>]>(
                    PROJECT_OVERVIEW_SQL,
                    bindings,
                ),
                db.query<[Array<Record<string, unknown>>]>(
                    PROJECT_TOP_SKILLS_SQL,
                    bindings,
                ),
                db.query<[Array<Record<string, unknown>>]>(
                    PROJECT_TOP_FAILURES_SQL,
                    bindings,
                ),
                db.query<[Array<Record<string, unknown>>]>(
                    PROJECT_RECENT_SESSIONS_SQL,
                    bindings,
                ),
                db.query<[Array<Record<string, unknown>>]>(
                    PROJECT_EPISODES_SQL,
                    bindings,
                ),
            ]);

        const overviewRow = overviewRows?.[0]?.[0];
        if (!isRecord(overviewRow)) return null;

        const sources = stringArray(overviewRow.sources);
        const sourceCounts = new Map<string, number>();
        for (const s of sources) sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);

        const top_skills: ProjectTopSkill[] = [];
        for (const raw of skillRows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const skill = stringField(raw, "skill");
            if (!skill) continue;
            top_skills.push({
                skill,
                count: numField(raw, "count"),
                last_used: dateField(raw, "last_used"),
            });
        }

        const failures: ProjectFailure[] = [];
        for (const raw of failureRows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const label = stringField(raw, "label");
            if (!label) continue;
            failures.push({
                label,
                failure_count: numField(raw, "failure_count"),
                distinct_sessions: numField(raw, "distinct_sessions"),
                last_seen: dateField(raw, "last_seen"),
            });
        }

        const recent_sessions: ProjectRecentSession[] = [];
        for (const raw of sessionRows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const id = recordIdString(raw.id);
            if (!id) continue;
            recent_sessions.push({
                // Bare session id over the HTTP seam; see src/lib/shared/session-id.ts.
                session_id: toBareSessionId(id),
                source: stringField(raw, "source"),
                started_at: dateField(raw, "started_at"),
                ended_at: dateField(raw, "ended_at"),
                model: stringField(raw, "model"),
            });
        }

        const top_episodes: ProjectEpisode[] = [];
        for (const raw of episodeRows?.[0] ?? []) {
            if (!isRecord(raw)) continue;
            const parent = recordIdString(raw.parent);
            if (!parent) continue;
            top_episodes.push({
                parent_session_id: toBareSessionId(parent),
                started_at: dateField(raw, "started_at"),
                child_count: numField(raw, "child_count"),
                distinct_nicknames: numField(raw, "distinct_nicknames"),
            });
        }

        return {
            project,
            session_count: numField(overviewRow, "session_count"),
            first_session_at: dateField(overviewRow, "first_session_at"),
            last_session_at: dateField(overviewRow, "last_session_at"),
            sources: Array.from(sourceCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([source, count]) => ({ source, count })),
            top_skills,
            failures,
            recent_sessions,
            top_episodes,
        };
    });
