/**
 * Per-skill detail payload powering the TUI DetailPane (incl. the 30-day
 * `daily` sparkline buckets), the web dashboard's "click recommendation
 * reason → see evidence" expand panel, and `GET /api/skills/:name/detail`.
 *
 * Bindings: $name (skill name).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { dateField, numberFieldOrZero, stringField } from "@ax/lib/shared/row-fields";
import type {
    SkillDetailPayload,
    SkillPair,
    SkillProposalEvidence,
    SkillRecentInvocation,
} from "@ax/lib/shared/dashboard-types";

/**
 * Two variants share this module:
 *
 * - `SKILL_DETAIL_BASIC_SQL` - the TUI hot path. The DetailPane re-queries on
 *   every (debounced) j/k selection change, so it only carries the lightweight
 *   blocks it renders: skill row, invocation counts, recent list, daily
 *   sparkline buckets. All filtered by the indexed `invoked.out`.
 * - `SKILL_DETAIL_SQL` - the full dashboard payload. Adds the evidence blocks
 *   (`corrections`, `proposals`, `paired`); `paired` looks up `skill_paired`
 *   by both endpoints (indexed: `skill_paired_in`/`skill_paired_out`). Still
 *   dashboard-only - the TUI's per-row selection keeps the lighter variant.
 */
export const SKILL_DETAIL_BASIC_SQL = `
LET $s = (SELECT * FROM skill WHERE name = $name)[0];
RETURN {
    skill: $s,
    invocations: {
        total: array::len((SELECT * FROM invoked WHERE out = $s.id)),
        d7:    array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 7d)),
        d30:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 30d)),
        last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts,
    },
    recent: (
        SELECT ts, in.session.project AS project
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 10
    ),
    daily: (
        SELECT ts FROM invoked
        WHERE out = $s.id AND ts > time::now() - 30d
        ORDER BY ts ASC
    )
};`;

export const SKILL_DETAIL_SQL = `
LET $s = (SELECT * FROM skill WHERE name = $name)[0];
RETURN {
    skill: $s,
    invocations: {
        total: array::len((SELECT * FROM invoked WHERE out = $s.id)),
        d7:    array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 7d)),
        d30:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 30d)),
        last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts,
    },
    recent: (
        SELECT ts, in.session.project AS project, turn_has_error
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 10
    ),
    daily: (
        SELECT ts FROM invoked
        WHERE out = $s.id AND ts > time::now() - 30d
        ORDER BY ts ASC
    ),
    corrections: (
        SELECT ts, in.session.project AS project
        FROM invoked
        WHERE out = $s.id AND was_corrected = true
        ORDER BY ts DESC
        LIMIT 5
    ),
    proposals: (
        -- Some legacy proposed edges have ts = epoch (ingest path used to skip
        -- the field). Fall back to the source turn's ts so the timeline reads
        -- correctly.
        SELECT
            (IF ts > d"1970-01-02" THEN ts ELSE in.ts END) AS ts,
            in.session.project AS project,
            context_excerpt
        FROM proposed
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 5
    ),
    paired: (
        -- Skills that co-occurred in the same session within a turn window
        -- (denormalised by derive-signals). The pair is undirected, so we
        -- check both directions and surface the partner's name.
        -- Some legacy edges have last_seen = epoch; null those out so the
        -- UI can show "-" instead of 1970.
        SELECT
            (IF in = $s.id THEN out.name ELSE in.name END) AS partner,
            count,
            (IF last_seen > d"1970-01-02" THEN last_seen ELSE NONE END) AS last_seen
        FROM skill_paired
        WHERE in = $s.id OR out = $s.id
        ORDER BY count DESC
        LIMIT 5
    )
};`;

export const mapSkillRecentRow = (raw: unknown): SkillRecentInvocation | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const ts = dateField(row, "ts") ?? "";
    if (!ts) return null;
    return {
        ts,
        project: stringField(row, "project"),
        ...(typeof row.turn_has_error === "boolean"
            ? { turn_has_error: row.turn_has_error }
            : {}),
    };
};

export const mapSkillPairRow = (raw: unknown): SkillPair | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const partner = stringField(row, "partner");
    if (!partner) return null;
    return {
        partner,
        count: numberFieldOrZero(row, "count"),
        last_seen: dateField(row, "last_seen"),
    };
};

export const mapSkillProposalRow = (raw: unknown): SkillProposalEvidence | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const ts = dateField(row, "ts") ?? "";
    if (!ts) return null;
    return {
        ts,
        project: stringField(row, "project"),
        context_excerpt: stringField(row, "context_excerpt"),
    };
};

export const fetchSkillDetail = Effect.fn("queries.fetchSkillDetail")(
    function* (name: string) {
        const db = yield* SurrealClient;
        const result = yield* db.query<unknown[]>(SKILL_DETAIL_SQL, { name });
        // RETURN { ... } gives us [block] where block is the object.
        const payload = Array.isArray(result)
            ? ([...result].reverse().find((r) => r != null) as Record<string, unknown> | undefined)
            : (result as Record<string, unknown> | undefined);
        const skill = (payload?.skill ?? null) as Record<string, unknown> | null;
        const invocations = (payload?.invocations ?? {}) as Record<string, unknown>;
        const recent = Array.isArray(payload?.recent) ? payload.recent : [];
        const corrections = Array.isArray(payload?.corrections) ? payload.corrections : [];
        const proposals = Array.isArray(payload?.proposals) ? payload.proposals : [];
        const paired = Array.isArray(payload?.paired) ? payload.paired : [];
        return {
            name,
            scope: skill ? stringField(skill, "scope") : null,
            description: skill ? stringField(skill, "description") : null,
            dir_path: skill ? stringField(skill, "dir_path") : null,
            invocations: {
                total: numberFieldOrZero(invocations, "total"),
                d7: numberFieldOrZero(invocations, "d7"),
                d30: numberFieldOrZero(invocations, "d30"),
                last: dateField(invocations, "last"),
            },
            recent: recent.map(mapSkillRecentRow).filter((r): r is SkillRecentInvocation => r !== null),
            corrections: corrections
                .map(mapSkillRecentRow)
                .filter((r): r is SkillRecentInvocation => r !== null),
            proposals: proposals
                .map(mapSkillProposalRow)
                .filter((r): r is SkillProposalEvidence => r !== null),
            paired: paired
                .map(mapSkillPairRow)
                .filter((r): r is SkillPair => r !== null),
        } satisfies SkillDetailPayload;
    },
);
