import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { surrealLiteral } from "../lib/json.ts";
import {
    PRODUCED_BY_SESSION_SQL,
    SKILL_LAST_PROJECT_SQL,
    SKILL_SUMMARY_SQL,
    SKILL_SUMMARY_PROPOSED_ONLY_SQL,
} from "../queries/skill-summary.ts";
import { SKILL_DETAIL_SQL } from "../queries/skill-detail.ts";
import { prettifyProjectSlug } from "../lib/shared/project-slug.ts";
import type {
    SkillDetailPayload,
    SkillPair,
    SkillProposalEvidence,
    SkillRecentInvocation,
    SkillRow,
    SkillTriageEntry,
    SkillTriageNote,
    SkillTriageResponse,
    TriageDecision,
} from "../lib/shared/dashboard-types.ts";

const TRIAGE_DECISIONS_SQL = `SELECT skill_name, decision, reason, decided_at FROM skill_triage_decision;`;

const RAW_SCORE_THRESHOLD_KEEP = 30;       // strong taste signal
const STAPLE_INV_30D = 10;                 // workhorse threshold (frequent use)
const STAPLE_CORRECTION_RATIO = 0.10;      // staple must have <10% correction
const STALE_DAYS = 45;
const HIGH_CORRECTION_RATIO = 0.20;        // >=20% of recent invocations corrected

const numericField = (row: Record<string, unknown>, key: string): number => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
};

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
    if (!Array.isArray(value)) return [];
    return value.map(recordKey).filter((v): v is string => v !== null);
};

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
    total_inv: numericField(raw, "total_inv"),
    inv_7d: numericField(raw, "inv_7d"),
    inv_30d: numericField(raw, "inv_30d"),
    last_used: dateField(raw, "last_used"),
    last_project: stringField(raw, "last_project"),
    corrections: numericField(raw, "corrections"),
    proposals: numericField(raw, "proposals"),
    commits_after: numericField(raw, "commits_after"),
    taste_score: numericField(raw, "taste_score"),
});

const buildCommitCountsBySession = (
    rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, number> => {
    const out = new Map<string, number>();
    for (const raw of rows) {
        const session = recordKey(raw.session);
        if (!session) continue;
        out.set(session, numericField(raw, "commits_after"));
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
    const totalInv = numericField(raw, "total_inv");
    const corrections = numericField(raw, "corrections");
    const proposals = numericField(raw, "proposals");
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


const parseDecisionRow = (raw: Record<string, unknown>): SkillTriageNote | null => {
    const name = stringField(raw, "skill_name");
    const decision = stringField(raw, "decision");
    if (!name || !decision) return null;
    if (decision !== "keep" && decision !== "archive" && decision !== "review") return null;
    return {
        skill_name: name,
        decision,
        reason: stringField(raw, "reason"),
        // dateField handles strings, Date instances, AND SurrealDB DateTime
        // (via toJSON). Falling back to `new Date().toISOString()` here was
        // the original R1 bug, regressed because R3 reused the same path.
        decided_at: dateField(raw, "decided_at") ?? new Date().toISOString(),
    };
};

export const fetchSkillTriage = (): Effect.Effect<
    SkillTriageResponse,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [main, proposedOnly, decisions, commitCounts, lastProjects] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(SKILL_SUMMARY_SQL),
            db.query<[Array<Record<string, unknown>>]>(SKILL_SUMMARY_PROPOSED_ONLY_SQL),
            db.query<[Array<Record<string, unknown>>]>(TRIAGE_DECISIONS_SQL),
            db.query<[Array<Record<string, unknown>>]>(PRODUCED_BY_SESSION_SQL),
            db.query<[Array<Record<string, unknown>>]>(SKILL_LAST_PROJECT_SQL),
        ]);
        const commitCountsBySession = buildCommitCountsBySession(commitCounts?.[0] ?? []);
        const lastProjectBySkill = buildLastProjectBySkill(lastProjects?.[0] ?? []);
        const decisionByName = new Map<string, SkillTriageNote>();
        for (const raw of decisions?.[0] ?? []) {
            const parsed = parseDecisionRow(raw);
            if (parsed) decisionByName.set(parsed.skill_name, parsed);
        }
        const rows: SkillTriageEntry[] = [];
        const seen = new Set<string>();
        for (const raw of main?.[0] ?? []) {
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
        for (const raw of proposedOnly?.[0] ?? []) {
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
): Effect.Effect<SkillTriageNote, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const reasonLit = reason === null ? "NONE" : surrealLiteral(reason);
        const sql = `UPSERT skill_triage_decision SET
    skill_name = ${surrealLiteral(name)},
    decision = ${surrealLiteral(decision)},
    reason = ${reasonLit},
    decided_at = time::now()
WHERE skill_name = ${surrealLiteral(name)} RETURN AFTER;`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const row = result?.[0]?.[0];
        if (!row) {
            return {
                skill_name: name,
                decision,
                reason,
                decided_at: new Date().toISOString(),
            };
        }
        return parseDecisionRow(row) ?? {
            skill_name: name,
            decision,
            reason,
            decided_at: new Date().toISOString(),
        };
    });

/**
 * List every triage decision, freshest first. Powers the dashboard's
 * `/decisions` audit view.
 */
export const listSkillDecisions = (): Effect.Effect<
    ReadonlyArray<SkillTriageNote>,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sql = `SELECT skill_name, decision, reason, decided_at FROM skill_triage_decision ORDER BY decided_at DESC;`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const out: SkillTriageNote[] = [];
        for (const raw of result?.[0] ?? []) {
            const parsed = parseDecisionRow(raw);
            if (parsed) out.push(parsed);
        }
        return out;
    });

export const clearSkillDecision = (
    name: string,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sql = `DELETE FROM skill_triage_decision WHERE skill_name = ${surrealLiteral(name)};`;
        yield* db.query(sql);
    });

/**
 * Apply a decision to many skills in a single round-trip. Used by the bulk
 * triage toolbar - "select 30 archive candidates, archive them all". Each name
 * upserts independently so partial failures don't roll back the rest.
 */
export const setSkillDecisionsBulk = (
    names: ReadonlyArray<string>,
    decision: TriageDecision,
    reason: string | null,
): Effect.Effect<ReadonlyArray<SkillTriageNote>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (names.length === 0) return [];
        const reasonLit = reason === null ? "NONE" : surrealLiteral(reason);
        const decisionLit = surrealLiteral(decision);
        // Use a single multi-statement query; SurrealDB executes them in order.
        const statements = names
            .map(
                (name) =>
                    `UPSERT skill_triage_decision SET skill_name = ${surrealLiteral(name)}, decision = ${decisionLit}, reason = ${reasonLit}, decided_at = time::now() WHERE skill_name = ${surrealLiteral(name)} RETURN AFTER;`,
            )
            .join("\n");
        const result = yield* db.query<unknown[]>(statements);
        const out: SkillTriageNote[] = [];
        for (let i = 0; i < (result?.length ?? 0); i += 1) {
            const block = result?.[i];
            const row = Array.isArray(block) ? block[0] : block;
            if (!row || typeof row !== "object") continue;
            const parsed = parseDecisionRow(row as Record<string, unknown>);
            if (parsed) out.push(parsed);
        }
        return out;
    });

const tsField = (raw: Record<string, unknown>, key: string): string => {
    const date = dateField(raw, key);
    return date ?? "";
};

const parseRecent = (raw: unknown): SkillRecentInvocation | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const ts = tsField(row, "ts");
    if (!ts) return null;
    return {
        ts,
        project: stringField(row, "project"),
        ...(typeof row.turn_has_error === "boolean"
            ? { turn_has_error: row.turn_has_error }
            : {}),
    };
};

const parsePair = (raw: unknown): SkillPair | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const partner = stringField(row, "partner");
    if (!partner) return null;
    return {
        partner,
        count: numericField(row, "count"),
        last_seen: dateField(row, "last_seen"),
    };
};

const parseProposal = (raw: unknown): SkillProposalEvidence | null => {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    const ts = tsField(row, "ts");
    if (!ts) return null;
    return {
        ts,
        project: stringField(row, "project"),
        context_excerpt: stringField(row, "context_excerpt"),
    };
};

export const fetchSkillDetail = (
    name: string,
): Effect.Effect<SkillDetailPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
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
                total: numericField(invocations, "total"),
                d7: numericField(invocations, "d7"),
                d30: numericField(invocations, "d30"),
                last: dateField(invocations, "last"),
            },
            recent: recent.map(parseRecent).filter((r): r is SkillRecentInvocation => r !== null),
            corrections: corrections
                .map(parseRecent)
                .filter((r): r is SkillRecentInvocation => r !== null),
            proposals: proposals
                .map(parseProposal)
                .filter((r): r is SkillProposalEvidence => r !== null),
            paired: paired
                .map(parsePair)
                .filter((r): r is SkillPair => r !== null),
        };
    });

export const isTriageDecision = (value: unknown): value is TriageDecision =>
    value === "keep" || value === "archive" || value === "review";
