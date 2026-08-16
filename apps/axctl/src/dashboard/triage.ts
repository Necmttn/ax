import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import { daysAgoExpr } from "@ax/lib/duckdb/clause";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import { Judgment, TextColumn, TimestampColumn, type JudgmentError } from "@ax/lib/sqlite";
import { stableId } from "@ax/lib/stable-id";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import { countField } from "@ax/lib/shared/row-fields";
import type {
    SkillRow,
    SkillTriageEntry,
    SkillTriageNote,
    SkillTriageResponse,
    TriageDecision,
} from "@ax/lib/shared/dashboard-types";

const TriageDecisionRow = Schema.Struct({
    skill_name: TextColumn,
    decision: TextColumn,
    reason: Schema.NullOr(TextColumn),
    decided_at: TimestampColumn,
});

const RAW_SCORE_THRESHOLD_KEEP = 30;       // strong taste signal
const STAPLE_INV_30D = 10;                 // workhorse threshold (frequent use)
const STAPLE_CORRECTION_RATIO = 0.10;      // staple must have <10% correction
const STALE_DAYS = 45;
const HIGH_CORRECTION_RATIO = 0.20;        // >=20% of recent invocations corrected

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * SurrealDB hands datetime aggregates back as `DateTime` instances (its own
 * class, *not* JS `Date`). They serialize via `toJSON()`. `stringField`
 * silently dropped them, which is how `last_used` was coming back null for
 * every skill (dogfood ISSUE-001).
 */
const dateField = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    if (value && typeof value === "object" && "toJSON" in value) {
        const json = (value as { toJSON: () => unknown }).toJSON();
        if (typeof json === "string" && json.length > 0) return json;
    }
    return null;
};

const recordKey = (value: unknown): string | null => {
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && "toString" in value) {
        const text = String(value);
        return text.length > 0 ? text : null;
    }
    return null;
};

const recordArrayField = (row: Record<string, unknown>, key: string): string[] => {
    const value = row[key];
    if (typeof value === "string") {
        // DuckDB's raw() hands back an array column as JSON text (native LIST
        // columns are banned - the FFI client cannot decode them; see
        // @ax/lib/duckdb/columns's module doc). Parse it here rather than at
        // every call site.
        try {
            const parsed: unknown = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(recordKey).filter((v): v is string => v !== null) : [];
        } catch {
            return [];
        }
    }
    if (!Array.isArray(value)) return [];
    return value.map(recordKey).filter((v): v is string => v !== null);
};

// Local DuckDB translations of queries/skill-summary.ts (chunk 2b's, not yet
// ported - same "copy the shape, don't import" pattern used elsewhere in
// this migration, so this module never depends on queries/ for its read
// path). taste_score = total_inv - 2*corrections + commits_after -
// 0.5*proposals (computed in enrichSummaryRow, unchanged).
const SKILL_SUMMARY_SQL = `
SELECT
    sk.name AS name,
    sk.scope AS scope,
    sk.description AS description,
    sk.dir_path AS dir_path,
    sk.bytes AS bytes,
    agg.total_inv AS total_inv,
    agg.inv_7d AS inv_7d,
    agg.inv_30d AS inv_30d,
    agg.last_used AS last_used,
    agg.corrections AS corrections,
    (SELECT count(*) FROM proposed p WHERE p.out_id = sk.id) AS proposals,
    COALESCE(
        (SELECT to_json(list(DISTINCT iv2.session)) FROM invoked iv2 WHERE iv2.out_id = sk.id AND iv2.session IS NOT NULL)::VARCHAR,
        '[]'
    ) AS skill_sessions
FROM (
    SELECT
        out_id AS skill_id,
        count(*) AS total_inv,
        SUM(CASE WHEN ts > ${daysAgoExpr} THEN 1 ELSE 0 END) AS inv_7d,
        SUM(CASE WHEN ts > ${daysAgoExpr} THEN 1 ELSE 0 END) AS inv_30d,
        SUM(CASE WHEN was_corrected THEN 1 ELSE 0 END) AS corrections,
        MAX(ts) AS last_used
    FROM invoked
    GROUP BY out_id
) agg
JOIN skill sk ON sk.id = agg.skill_id
WHERE sk.name IS NOT NULL
    AND (sk.dir_path IS NULL OR sk.dir_path != '(synthetic)');`;
// Bound params for the two daysAgoExpr `?` placeholders above, in order.
const SKILL_SUMMARY_PARAMS = [7, 30];

const SKILL_LAST_PROJECT_SQL = `
SELECT sk.name AS name, s.project AS project, iv.ts AS ts
FROM invoked iv
JOIN skill sk ON sk.id = iv.out_id
LEFT JOIN session s ON s.id = iv.session
ORDER BY iv.ts DESC
LIMIT 50000;`;

const PRODUCED_BY_SESSION_SQL = `
SELECT in_id AS session, count(*) AS commits_after
FROM produced
GROUP BY in_id
LIMIT 50000;`;

/** Skills with `proposed` edges but no `invoked` edges. Union with the main
 *  scan on the JS side. */
const SKILL_SUMMARY_PROPOSED_ONLY_SQL = `
SELECT
    sk.name AS name,
    sk.scope AS scope,
    sk.description AS description,
    sk.dir_path AS dir_path,
    sk.bytes AS bytes,
    0 AS total_inv,
    0 AS inv_7d,
    0 AS inv_30d,
    NULL AS last_used,
    NULL AS last_project,
    0 AS corrections,
    (SELECT count(*) FROM proposed p WHERE p.out_id = sk.id) AS proposals,
    0 AS commits_after,
    -0.5 * (SELECT count(*) FROM proposed p WHERE p.out_id = sk.id) AS taste_score
FROM skill sk
WHERE NOT EXISTS (SELECT 1 FROM invoked iv WHERE iv.out_id = sk.id)
    AND EXISTS (SELECT 1 FROM proposed p WHERE p.out_id = sk.id)
    AND (sk.dir_path IS NULL OR sk.dir_path != '(synthetic)');`;

// Claude ships these as built-in slash commands (no SKILL.md on disk), so
// the transcript ingester upserts a synthetic skill record with
// `scope: "unknown"` when it sees them. Override at read time so the
// dashboard renders an honest scope label without re-ingesting.
const CLAUDE_BUILTINS = new Set<string>([
    "simplify",
    "init",
    "help",
    "compact",
    "clear",
    "review",
    "release-notes",
    "vim",
    "model",
    "permissions",
    "config",
    "memory",
    "agents",
    "doctor",
    "status",
    "logout",
    "login",
    "cost",
    "mcp",
    "hooks",
    "ide",
    "approved-tools",
    "bug",
    "compile",
    "exit",
    "quit",
    "resume",
    // Bundled Claude Code skills - shipped in the binary, no SKILL.md on disk,
    // so they always come through as `scope:unknown` from the placeholder
    // backstop. Relabel them honestly.
    "loop",
    "schedule",
    "update-config",
    "fewer-permission-prompts",
    "keybindings-help",
]);

const normalizeScope = (name: string, raw: unknown): string => {
    const s = typeof raw === "string" && raw.length > 0 ? raw : "unknown";
    if (s === "unknown" && CLAUDE_BUILTINS.has(name)) return "claude-builtin";
    return s;
};

const coerceRow = (raw: Record<string, unknown>): SkillRow => ({
    name: String(raw.name ?? ""),
    scope: normalizeScope(String(raw.name ?? ""), raw.scope),
    description: stringField(raw, "description"),
    dir_path: stringField(raw, "dir_path"),
    bytes: typeof raw.bytes === "number" ? raw.bytes : null,
    total_inv: countField(raw, "total_inv"),
    inv_7d: countField(raw, "inv_7d"),
    inv_30d: countField(raw, "inv_30d"),
    last_used: dateField(raw, "last_used"),
    last_project: stringField(raw, "last_project"),
    corrections: countField(raw, "corrections"),
    proposals: countField(raw, "proposals"),
    commits_after: countField(raw, "commits_after"),
    taste_score: countField(raw, "taste_score"),
});

const buildCommitCountsBySession = (
    rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, number> => {
    const out = new Map<string, number>();
    for (const raw of rows) {
        const session = recordKey(raw.session);
        if (!session) continue;
        out.set(session, countField(raw, "commits_after"));
    }
    return out;
};

const buildLastProjectBySkill = (
    rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, string> => {
    const out = new Map<string, string>();
    for (const raw of rows) {
        const name = stringField(raw, "name");
        const project = stringField(raw, "project");
        if (!name || !project || out.has(name)) continue;
        out.set(name, project);
    }
    return out;
};

const enrichSummaryRow = (
    raw: Record<string, unknown>,
    commitCountsBySession: ReadonlyMap<string, number>,
    lastProjectBySkill: ReadonlyMap<string, string>,
): Record<string, unknown> => {
    const sessions = recordArrayField(raw, "skill_sessions");
    const commitsAfter = sessions.reduce(
        (sum, session) => sum + (commitCountsBySession.get(session) ?? 0),
        0,
    );
    const totalInv = countField(raw, "total_inv");
    const corrections = countField(raw, "corrections");
    const proposals = countField(raw, "proposals");
    const name = String(raw.name ?? "");
    return {
        ...raw,
        last_project: lastProjectBySkill.get(name) ?? null,
        commits_after: commitsAfter,
        taste_score: totalInv - 2 * corrections + commitsAfter - 0.5 * proposals,
    };
};

const daysSince = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
};

/**
 * Map raw skill stats to a "what should I do with this" suggestion. Cheap
 * rules; the user always overrides via the UI.
 */
export function recommendForSkill(row: SkillRow): {
    readonly recommendation: TriageDecision;
    readonly reason: string;
} {
    const age = daysSince(row.last_used);
    const correctionRatio = row.inv_30d > 0 ? row.corrections / row.inv_30d : 0;

    // Never invoked, only proposed -> dead weight.
    if (row.total_inv === 0 && row.proposals > 0) {
        return {
            recommendation: "archive",
            reason: `proposed ${row.proposals}x, never invoked - dead weight`,
        };
    }

    // Stale: nothing in the last 30 days, regardless of how recently before
    // that. Anything older than 30d is dead-enough that the user should be
    // making a deliberate keep decision instead of letting it linger.
    if (row.inv_30d === 0) {
        return {
            recommendation: "archive",
            reason:
                age === null
                    ? "never used"
                    : age > STALE_DAYS
                        ? `unused for ${age}d - dead`
                        : `no hits in 30d (last used ${age}d ago)`,
        };
    }

    // High-friction: significant corrections vs invocations -> needs fixing.
    // Require both `inv_30d >= 5` AND `corrections >= 2` so a single bad
    // session on a low-volume skill doesn't trip "misfiring" (R4-003).
    if (
        row.inv_30d >= 5 &&
        row.corrections >= 2 &&
        correctionRatio >= HIGH_CORRECTION_RATIO
    ) {
        const pct = Math.round(correctionRatio * 100);
        return {
            recommendation: "review",
            reason: `${pct}% of recent runs corrected (${row.corrections}/${row.inv_30d}) - misfiring`,
        };
    }

    // Strong taste -> keep.
    if (row.taste_score >= RAW_SCORE_THRESHOLD_KEEP) {
        return {
            recommendation: "keep",
            reason: `score ${row.taste_score.toFixed(0)}, ${row.inv_30d} hits in 30d - load-bearing`,
        };
    }

    // Most-recent project, when known, gives the user a discriminating fact
    // so rows with identical counts don't read identically.
    const where = row.last_project
        ? ` on ${prettifyProjectSlug(row.last_project)}`
        : "";

    // Staple: frequent use, low correction. Score formula penalises skills
    // without downstream commits, so a clean high-use skill can score low
    // and still be worth keeping.
    if (row.inv_30d >= STAPLE_INV_30D && correctionRatio < STAPLE_CORRECTION_RATIO) {
        return {
            recommendation: "keep",
            reason: `${row.inv_30d} hits/30d${where}, ${row.corrections} corrections - staple`,
        };
    }

    // Moderate use: review, but tell the user what's notable.
    if (row.inv_30d >= 3) {
        return {
            recommendation: "review",
            reason: `${row.inv_30d} hits/30d${where}, score ${row.taste_score.toFixed(1)} - verify intent before keeping`,
        };
    }

    // Rare use: review, may be intentional fallback.
    return {
        recommendation: "review",
        reason: `rare use (${row.inv_30d} hits/30d${where}, score ${row.taste_score.toFixed(1)}) - keep only if deliberate`,
    };
}


const triageNote = (raw: typeof TriageDecisionRow.Type): SkillTriageNote | null => {
    if (raw.decision !== "keep" && raw.decision !== "archive" && raw.decision !== "review") return null;
    return {
        skill_name: raw.skill_name,
        decision: raw.decision,
        reason: raw.reason,
        decided_at: raw.decided_at.toISOString(),
    };
};

const triageDecisionId = (name: string): string =>
    stableId("skill_triage_decision", [name]);

/** Defensive: a failed query degrades to `[]`, matching the `cacheRows`
 *  contract used throughout the rest of this port (see rawRows in
 *  session-canvas.ts / graph-explorer.ts for the same shape). */
const rawRows = (
    read: CacheReadService,
    sql: string,
    params?: ReadonlyArray<DuckDbParam>,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, never> =>
    read.raw(sql, params).pipe(
        Effect.map((r) => r.rows as ReadonlyArray<Record<string, unknown>>),
        Effect.catch((err) =>
            Effect.sync(() => {
                console.error(`ax triage query failed (${sql.trim().slice(0, 60)}...):`, err);
                return [] as ReadonlyArray<Record<string, unknown>>;
            }),
        ),
    );

export const fetchSkillTriage = (): Effect.Effect<
    SkillTriageResponse,
    JudgmentError,
    CacheRead | Judgment
> =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const judgment = yield* Judgment;
        const [main, proposedOnly, decisions, commitCounts, lastProjects] = yield* Effect.all([
            rawRows(read, SKILL_SUMMARY_SQL, SKILL_SUMMARY_PARAMS),
            rawRows(read, SKILL_SUMMARY_PROPOSED_ONLY_SQL),
            judgment.rows(
                TriageDecisionRow,
                "SELECT skill_name, decision, reason, decided_at FROM skill_triage_decision",
            ),
            rawRows(read, PRODUCED_BY_SESSION_SQL),
            rawRows(read, SKILL_LAST_PROJECT_SQL),
        ]);
        const commitCountsBySession = buildCommitCountsBySession(commitCounts);
        const lastProjectBySkill = buildLastProjectBySkill(lastProjects);
        const decisionByName = new Map<string, SkillTriageNote>();
        for (const raw of decisions) {
            const parsed = triageNote(raw);
            if (parsed) decisionByName.set(parsed.skill_name, parsed);
        }
        const rows: SkillTriageEntry[] = [];
        const seen = new Set<string>();
        for (const raw of main) {
            const row = coerceRow(enrichSummaryRow(raw, commitCountsBySession, lastProjectBySkill));
            if (!row.name) continue;
            seen.add(row.name);
            const rec = recommendForSkill(row);
            rows.push({
                ...row,
                recommendation: rec.recommendation,
                recommendation_reason: rec.reason,
                decision: decisionByName.get(row.name) ?? null,
            });
        }
        for (const raw of proposedOnly) {
            const row = coerceRow(raw);
            if (!row.name || seen.has(row.name)) continue;
            const rec = recommendForSkill(row);
            rows.push({
                ...row,
                recommendation: rec.recommendation,
                recommendation_reason: rec.reason,
                decision: decisionByName.get(row.name) ?? null,
            });
        }
        rows.sort((a, b) =>
            b.taste_score - a.taste_score ||
            b.inv_30d - a.inv_30d ||
            b.total_inv - a.total_inv,
        );
        return {
            generatedAt: new Date().toISOString(),
            skills: rows,
        };
    });

export const setSkillDecision = (
    name: string,
    decision: TriageDecision,
    reason: string | null,
): Effect.Effect<SkillTriageNote, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const decidedAt = new Date();
        yield* judgment.put("skill_triage_decision", {
            id: triageDecisionId(name),
            skill_name: name,
            decision,
            reason,
            decided_at: decidedAt,
        });
        return {
            skill_name: name,
            decision,
            reason,
            decided_at: decidedAt.toISOString(),
        };
    });

/**
 * List every triage decision, freshest first. Powers the dashboard's
 * `/decisions` audit view.
 */
export const listSkillDecisions = (): Effect.Effect<
    ReadonlyArray<SkillTriageNote>,
    JudgmentError,
    Judgment
> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const rows = yield* judgment.rows(
            TriageDecisionRow,
            "SELECT skill_name, decision, reason, decided_at FROM skill_triage_decision ORDER BY decided_at DESC",
        );
        const out: SkillTriageNote[] = [];
        for (const raw of rows) {
            const parsed = triageNote(raw);
            if (parsed) out.push(parsed);
        }
        return out;
    });

export const clearSkillDecision = (
    name: string,
): Effect.Effect<void, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        yield* judgment.exec("DELETE FROM skill_triage_decision WHERE skill_name = ?", [name]);
    });

/**
 * Apply a decision to many skills in a single round-trip. Used by the bulk
 * triage toolbar - "select 30 archive candidates, archive them all". Each name
 * upserts in one transaction, so callers never observe a partial bulk decision.
 */
export const setSkillDecisionsBulk = (
    names: ReadonlyArray<string>,
    decision: TriageDecision,
    reason: string | null,
): Effect.Effect<ReadonlyArray<SkillTriageNote>, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        if (names.length === 0) return [];
        const judgment = yield* Judgment;
        const decidedAt = new Date();
        const uniqueNames = [...new Set(names)];
        yield* judgment.transaction((transaction) =>
            transaction.putMany(
                "skill_triage_decision",
                uniqueNames.map((name) => ({
                    id: triageDecisionId(name),
                    skill_name: name,
                    decision,
                    reason,
                    decided_at: decidedAt,
                })),
            ),
        );
        return uniqueNames.map((name) => ({
            skill_name: name,
            decision,
            reason,
            decided_at: decidedAt.toISOString(),
        }));
    });

export const isTriageDecision = (value: unknown): value is TriageDecision =>
    value === "keep" || value === "archive" || value === "review";
