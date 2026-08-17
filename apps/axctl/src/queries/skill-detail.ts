/**
 * Per-skill detail payload powering the TUI DetailPane (incl. the 30-day
 * `daily` sparkline buckets), the web dashboard's "click recommendation
 * reason -> see evidence" expand panel, and `GET /api/skills/:name/detail`.
 *
 * `fetchSkillDetail` reads the DuckDB CacheRead seam as five straightforward
 * indexed lookups keyed off the resolved skill id.
 *
 * It used to sit beside two exported SurrealQL blobs
 * (`SKILL_DETAIL_BASIC_SQL` / `SKILL_DETAIL_SQL`) kept on the stated grounds
 * that "the TUI executes that raw text directly against a live SurrealClient -
 * a real, still-live consumer, not dead code". That was wrong when written:
 * `tui/hooks/useSkillDetail.ts` composes its OWN four statements and runs them
 * through `CacheReadService.raw`. The blobs' only readers were their own text
 * assertions and a re-export nothing imported, so they went with the client.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { dateField, countField, stringField } from "@ax/lib/shared/row-fields";
import type {
    SkillDetailPayload,
    SkillPair,
    SkillProposalEvidence,
    SkillRecentInvocation,
} from "@ax/lib/shared/dashboard-types";

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
        count: countField(row, "count"),
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

const SkillRowSchema = Schema.Struct({
    id: Schema.String,
    scope: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String),
    dir_path: Schema.NullOr(Schema.String),
});

const SKILL_ROW_SQL = `SELECT id, scope, description, dir_path FROM skill WHERE name = ?;`;

const InvocationSummarySchemaRow = Schema.Struct({
    total: NumberFromBigIntColumn,
    d7: NumberFromBigIntColumn,
    d30: NumberFromBigIntColumn,
    last: Schema.NullOr(TimestampColumn),
});

/** `d7`/`d30` FILTER thresholds bind first (in text order), the skill id last. */
const INVOCATION_SUMMARY_SQL = `
SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')) AS d7,
    COUNT(*) FILTER (WHERE ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')) AS d30,
    MAX(ts) AS last
FROM invoked
WHERE out_id = ?;
`;

const RecentInvocationSchemaRow = Schema.Struct({
    ts: TimestampColumn,
    project: Schema.NullOr(Schema.String),
    turn_has_error: Schema.NullOr(Schema.Boolean),
});

/** `invoked.session` is denormalised onto the edge - no need to dereference
 *  the source turn to reach the session's project. */
const RECENT_INVOCATIONS_SQL = `
SELECT i.ts AS ts, s.project AS project, i.turn_has_error AS turn_has_error
FROM invoked i
LEFT JOIN session s ON s.id = i.session
WHERE i.out_id = ?
ORDER BY i.ts DESC
LIMIT 10;
`;

const CorrectionSchemaRow = Schema.Struct({
    ts: TimestampColumn,
    project: Schema.NullOr(Schema.String),
});

const CORRECTIONS_SQL = `
SELECT i.ts AS ts, s.project AS project
FROM invoked i
LEFT JOIN session s ON s.id = i.session
WHERE i.out_id = ? AND i.was_corrected = TRUE
ORDER BY i.ts DESC
LIMIT 5;
`;

const ProposalSchemaRow = Schema.Struct({
    ts: TimestampColumn,
    project: Schema.NullOr(Schema.String),
    context_excerpt: Schema.NullOr(Schema.String),
});

/** `proposed` has no denormalised session, so `project` goes through the
 *  source turn. Some legacy `proposed` edges have `ts = epoch` (ingest used to
 *  skip the field) - fall back to the source turn's ts, same as the original
 *  SurrealQL `IF ts > d"1970-01-02" ...`. */
const PROPOSALS_SQL = `
SELECT
    CASE WHEN p.ts > TIMESTAMP '1970-01-02' THEN p.ts ELSE t.ts END AS ts,
    s.project AS project,
    p.context_excerpt AS context_excerpt
FROM proposed p
JOIN turn t ON t.id = p.in_id
LEFT JOIN session s ON s.id = t.session
WHERE p.out_id = ?
ORDER BY ts DESC
LIMIT 5;
`;

const PairedSchemaRow = Schema.Struct({
    partner: Schema.NullOr(Schema.String),
    count: NumberFromBigIntColumn,
    last_seen: Schema.NullOr(TimestampColumn),
});

/** Undirected pair: check both endpoints, surface the partner's name. Some
 *  legacy edges have `last_seen = epoch`; null those out (same as the
 *  original `IF last_seen > d"1970-01-02" ... ELSE NONE`). Skill id binds 3x:
 *  once to pick the partner side, twice for the endpoint filter. */
const PAIRED_SQL = `
SELECT
    CASE WHEN sp.in_id = ? THEN so.name ELSE si.name END AS partner,
    sp.count AS count,
    CASE WHEN sp.last_seen > TIMESTAMP '1970-01-02' THEN sp.last_seen ELSE NULL END AS last_seen
FROM skill_paired sp
LEFT JOIN skill si ON si.id = sp.in_id
LEFT JOIN skill so ON so.id = sp.out_id
WHERE sp.in_id = ? OR sp.out_id = ?
ORDER BY sp.count DESC
LIMIT 5;
`;

const EMPTY_SKILL_DETAIL_INVOCATIONS = { total: 0, d7: 0, d30: 0, last: null };

export const fetchSkillDetail = Effect.fn("queries.fetchSkillDetail")(
    function* (name: string) {
        const skillRows = yield* cacheRows(
            SkillRowSchema,
            { sql: SKILL_ROW_SQL, params: [name] },
            "skill detail skill row",
        );
        const skill = skillRows[0] ?? null;

        if (!skill) {
            return {
                name,
                scope: null,
                description: null,
                dir_path: null,
                invocations: EMPTY_SKILL_DETAIL_INVOCATIONS,
                recent: [],
                corrections: [],
                proposals: [],
                paired: [],
            } satisfies SkillDetailPayload;
        }

        const [invocationRows, recentRows, correctionRows, proposalRows, pairedRows] = yield* Effect.all([
            cacheRows(
                InvocationSummarySchemaRow,
                { sql: INVOCATION_SUMMARY_SQL, params: [7, 30, skill.id] },
                "skill detail invocations",
            ),
            cacheRows(
                RecentInvocationSchemaRow,
                { sql: RECENT_INVOCATIONS_SQL, params: [skill.id] },
                "skill detail recent",
            ),
            cacheRows(
                CorrectionSchemaRow,
                { sql: CORRECTIONS_SQL, params: [skill.id] },
                "skill detail corrections",
            ),
            cacheRows(
                ProposalSchemaRow,
                { sql: PROPOSALS_SQL, params: [skill.id] },
                "skill detail proposals",
            ),
            cacheRows(
                PairedSchemaRow,
                { sql: PAIRED_SQL, params: [skill.id, skill.id, skill.id] },
                "skill detail paired",
            ),
        ], { concurrency: 5 });

        const invocations = invocationRows[0];

        return {
            name,
            scope: skill.scope,
            description: skill.description,
            dir_path: skill.dir_path,
            invocations: invocations
                ? {
                    total: invocations.total,
                    d7: invocations.d7,
                    d30: invocations.d30,
                    last: dateField(invocations, "last"),
                }
                : EMPTY_SKILL_DETAIL_INVOCATIONS,
            recent: recentRows
                .map(mapSkillRecentRow)
                .filter((r): r is SkillRecentInvocation => r !== null),
            corrections: correctionRows
                .map(mapSkillRecentRow)
                .filter((r): r is SkillRecentInvocation => r !== null),
            proposals: proposalRows
                .map(mapSkillProposalRow)
                .filter((r): r is SkillProposalEvidence => r !== null),
            paired: pairedRows
                .map(mapSkillPairRow)
                .filter((r): r is SkillPair => r !== null),
        } satisfies SkillDetailPayload;
    },
);
