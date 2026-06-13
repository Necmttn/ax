/**
 * ax dojo spar - replay benchmark.
 *
 * Pure cores (scoreSpar, renderSparBrief/parseSparBrief, renderSparReport) are
 * fully unit-tested. The Effect glue (captureBaseline, findVariantSession,
 * fetchSessionMetrics) composes existing query functions and is tested with a
 * fake SurrealClient + a live spar-plan smoke.
 *
 * Spec: docs/superpowers/specs/2026-06-13-dojo-spar-design.md
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AxConfig } from "@ax/lib/config";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";
import { ProcessService, type ProcessError } from "@ax/lib/process";
import { findCommitWindow } from "@ax/lib/git-window";
import { fetchSessionCostMap } from "../metrics/cost-estimate.ts";
import { fetchLandedLocBySession, fetchSessionChurnSummary } from "../metrics/session-churn.ts";
import { cleanSessionId } from "../metrics/util.ts";
import { listSessionsNear } from "../dashboard/sessions-query.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SparMetrics {
    readonly costUsd: number | null;
    readonly turns: number | null;
    readonly wallMs: number | null;
    readonly repairLines: number;
    readonly episodes: number;
    readonly landed: boolean;
}

export interface SparBrief {
    readonly id: string;
    readonly createdAt: string;
    readonly prompt: string;
    readonly parentSha: string;
    readonly baselineSession: string;
    readonly worktree: string;
    readonly baseline: SparMetrics;
    /** filled by the agent; "" at plan time */
    readonly delta: string;
}

export type SparVerdict = "win" | "regression" | "mixed";

export interface SparDeltas {
    readonly costUsd: number | null;
    readonly turns: number | null;
    readonly wallMs: number | null;
    readonly repairLines: number;
    readonly episodes: number;
}

export interface SparScore {
    readonly id: string;
    readonly variantSession: string;
    readonly baseline: SparMetrics;
    readonly variant: SparMetrics;
    readonly deltas: SparDeltas;
    readonly verdict: SparVerdict;
}

// ---------------------------------------------------------------------------
// scoreSpar (pure)
// ---------------------------------------------------------------------------

/** Cost delta (USD) below this magnitude is treated as noise (no win/regression). */
export const COST_TOL = 0.05;
/** Repair-line delta above this counts as materially more repair churn. */
export const REPAIR_TOL = 20;

const sub = (a: number | null, b: number | null): number | null =>
    a == null || b == null ? null : a - b;

/**
 * Compute deltas + verdict from baseline/variant metrics. The caller (score
 * command) fills `id`/`variantSession`.
 *
 * Verdict: primary axis is "did it still land, and is spend lower without more
 * repair".
 */
export const scoreSpar = (baseline: SparMetrics, variant: SparMetrics): SparScore => {
    const deltas: SparDeltas = {
        costUsd: sub(variant.costUsd, baseline.costUsd),
        turns: sub(variant.turns, baseline.turns),
        wallMs: sub(variant.wallMs, baseline.wallMs),
        repairLines: variant.repairLines - baseline.repairLines,
        episodes: variant.episodes - baseline.episodes,
    };
    let verdict: SparVerdict;
    if (!variant.landed) {
        verdict = "regression";
    } else {
        const cheaper = deltas.costUsd != null && deltas.costUsd < -COST_TOL;
        const costlier = deltas.costUsd != null && deltas.costUsd > COST_TOL;
        const moreRepair = deltas.repairLines > REPAIR_TOL;
        // win: clearly cheaper without paying it back in repair churn.
        if (cheaper && !moreRepair) verdict = "win";
        // regression: clearly costlier, or no cost win to offset worse repair.
        else if (costlier || (moreRepair && !cheaper)) verdict = "regression";
        // mixed: a genuine tradeoff (e.g. cheaper but more repair, or noise).
        else verdict = "mixed";
    }
    return { id: "", variantSession: "", baseline, variant, deltas, verdict };
};

// ---------------------------------------------------------------------------
// brief render/parse (pure)
// ---------------------------------------------------------------------------

/** Collapse CR/LF to a space so an interpolated value can't break its line. */
const oneLine = (v: string): string => v.replace(/[\r\n]/g, " ");

/** Mirror of outbox.ts's frontmatter field reader. */
const field = (content: string, key: string): string | null => {
    const m = new RegExp(`^${key}:[^\\S\\n]*(.*)$`, "m").exec(content);
    const v = m?.[1]?.trim();
    return v && v.length > 0 ? v : null;
};

const DELTA_PLACEHOLDER = "FILL: which single change to test";

export const renderSparBrief = (brief: SparBrief): string => {
    const worktreeCmd = `git worktree add ${brief.worktree} -b dojo/spar-${brief.id} ${brief.parentSha}`;
    const delta = brief.delta.trim().length > 0 ? brief.delta : DELTA_PLACEHOLDER;
    return [
        "---",
        `id: ${oneLine(brief.id)}`,
        `created_at: ${oneLine(brief.createdAt)}`,
        `parent_sha: ${oneLine(brief.parentSha)}`,
        `baseline_session: ${oneLine(brief.baselineSession)}`,
        `worktree: ${oneLine(brief.worktree)}`,
        "---",
        "",
        `# Spar: ${brief.id}`,
        "",
        "## Task",
        "",
        brief.prompt,
        "",
        "## Worktree",
        "",
        "```bash",
        worktreeCmd,
        "```",
        "",
        "## Baseline",
        "",
        "```json baseline",
        JSON.stringify(brief.baseline, null, 2),
        "```",
        "",
        "## Delta",
        "",
        delta,
        "",
    ].join("\n");
};

const BASELINE_BLOCK = /```json baseline\n([\s\S]*?)\n```/;

const section = (content: string, heading: string): string => {
    const re = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
    const m = re.exec(content);
    return m?.[1]?.trim() ?? "";
};

/** Validate a parsed baseline block into SparMetrics, or null on a bad shape. */
const asBaselineMetrics = (v: unknown): SparMetrics | null => {
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
    // costUsd/turns/wallMs are `number | null`; reject any other type.
    const okNullable = (x: unknown): x is number | null => x === null || isFiniteNum(x);
    if (typeof o.landed !== "boolean") return null;
    if (!isFiniteNum(o.repairLines) || !isFiniteNum(o.episodes)) return null;
    if (!okNullable(o.costUsd) || !okNullable(o.turns) || !okNullable(o.wallMs)) return null;
    return {
        costUsd: o.costUsd,
        turns: o.turns,
        wallMs: o.wallMs,
        repairLines: o.repairLines,
        episodes: o.episodes,
        landed: o.landed,
    };
};

export const parseSparBrief = (content: string): SparBrief | null => {
    if (!content.startsWith("---")) return null;
    const id = field(content, "id");
    const createdAt = field(content, "created_at");
    const parentSha = field(content, "parent_sha");
    const baselineSession = field(content, "baseline_session");
    const worktree = field(content, "worktree");
    if (!id || !createdAt || !parentSha || !baselineSession || !worktree) return null;

    const blockMatch = BASELINE_BLOCK.exec(content);
    if (!blockMatch?.[1]) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(blockMatch[1]);
    } catch {
        return null;
    }
    // Shape guard: a hand-edited brief missing `landed` (or with the wrong
    // type) must not slip through as `landed: undefined`, which would silently
    // score every variant as a regression.
    const baseline = asBaselineMetrics(parsed);
    if (baseline === null) return null;

    const prompt = section(content, "Task");
    const deltaRaw = section(content, "Delta");
    const delta = deltaRaw === DELTA_PLACEHOLDER ? "" : deltaRaw;

    return { id, createdAt, prompt, parentSha, baselineSession, worktree, baseline, delta };
};

// ---------------------------------------------------------------------------
// report render (pure)
// ---------------------------------------------------------------------------

const fmtNum = (n: number | null): string => (n == null ? "-" : `${n}`);

const fmtSignedNum = (n: number | null): string =>
    n == null ? "-" : n > 0 ? `+${n}` : `${n}`;

const fmtUsd = (n: number | null): string => (n == null ? "-" : `$${n.toFixed(2)}`);

const fmtSignedUsd = (n: number | null): string =>
    n == null ? "-" : `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

const fmtBool = (b: boolean): string => (b ? "yes" : "no");

export const renderSparReport = (score: SparScore, brief: SparBrief): string => {
    const { baseline, variant, deltas, verdict } = score;
    const rows: ReadonlyArray<readonly [string, string, string, string]> = [
        ["cost", fmtUsd(baseline.costUsd), fmtUsd(variant.costUsd), fmtSignedUsd(deltas.costUsd)],
        ["turns", fmtNum(baseline.turns), fmtNum(variant.turns), fmtSignedNum(deltas.turns)],
        ["wall (ms)", fmtNum(baseline.wallMs), fmtNum(variant.wallMs), fmtSignedNum(deltas.wallMs)],
        ["repair", `${baseline.repairLines}`, `${variant.repairLines}`, fmtSignedNum(deltas.repairLines)],
        ["episodes", `${baseline.episodes}`, `${variant.episodes}`, fmtSignedNum(deltas.episodes)],
        ["landed", fmtBool(baseline.landed), fmtBool(variant.landed), "-"],
    ];
    const table = [
        "| metric | baseline | variant | delta |",
        "| --- | --- | --- | --- |",
        ...rows.map(([m, b, v, d]) => `| ${m} | ${b} | ${v} | ${d} |`),
    ].join("\n");

    return [
        `# Spar report: ${brief.id}`,
        "",
        `delta tested: ${brief.delta.trim().length > 0 ? brief.delta : "(none)"}`,
        "",
        table,
        "",
        `verdict: **${verdict.toUpperCase()}**`,
        "",
    ].join("\n");
};

// ---------------------------------------------------------------------------
// Effect glue: metrics, baseline capture, variant lookup
// ---------------------------------------------------------------------------

interface TurnWallRow {
    readonly turn_count: number | null;
    readonly s: string | null;
    readonly e: string | null;
}

/**
 * Resolve one session's spar metrics: cost (from the shared cost map), repair
 * /episodes (from the churn summary), `landed` (from the `produced` edge), and
 * turns + wall (from a focused single-session lookup).
 *
 * `landed` MUST come from the produced edge, NOT from `churn.hotSessions`:
 * hotSessions is gated by `hasVerificationSignal`, so a CLEAN variant (landed,
 * zero failures/repair) is absent from it - reading landed off hotSessions
 * would score the best outcome (clean land) as a regression. The produced-edge
 * query (`fetchLandedLocBySession`) is immune to that gate. repair/episodes
 * stay on the churn row - absence -> 0 is correct for a clean session.
 *
 * Note: this still pulls a full-window churn summary just for repair/episodes
 * (acceptable v1); only the `landed` signal uses the targeted produced query.
 */
export const fetchSessionMetrics = (
    sessionId: string,
    sinceForChurn: Date,
): Effect.Effect<SparMetrics, DbError, SurrealClient | AxConfig> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const cleanId = cleanSessionId(sessionId);

        const costMap = yield* fetchSessionCostMap([sessionId]);
        const costUsd = costMap.get(cleanId)?.estimatedCostUsd ?? null;

        // landed: did this session produce a commit? Read straight off the
        // produced edge (gate-immune), keyed by clean id.
        const landedLoc = yield* fetchLandedLocBySession([sessionId]);
        const landed = landedLoc.bySession.has(cleanId);

        const churn = yield* fetchSessionChurnSummary({ since: sinceForChurn, limit: 1000 });
        const churnRow = churn.hotSessions.find((r) => r.session === cleanId);
        const repairLines = churnRow?.repairLinesAdded ?? 0;
        const episodes = churnRow?.episodes ?? 0;

        // turns + wall: count() over the turn_session_seq index + the session's
        // own start/end timestamps (mirrors enrichSessions' indexed lookup).
        const lit = recordLiteral("session", cleanId);
        // `FROM ONLY <lit>` returns the bare object (not an array of rows), so
        // the query result is `[ {turn_count, s, e} ]` - read rows[0] directly.
        // (Indexing rows[0][0] would step INTO the object and yield undefined,
        // which previously left turns/wall always null.)
        const rows = yield* db.query<[TurnWallRow | null]>(
            `SELECT
                (SELECT count() FROM turn WHERE session = ${lit} GROUP ALL)[0].count AS turn_count,
                type::string(started_at) AS s,
                type::string(ended_at) AS e
             FROM ONLY ${lit};`,
        );
        const row = rows?.[0] ?? null;
        const turns = row?.turn_count != null ? Number(row.turn_count) || 0 : null;
        const startMs = row?.s ? Date.parse(row.s) : NaN;
        const endMs = row?.e ? Date.parse(row.e) : NaN;
        const wallMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null;

        return { costUsd, turns, wallMs, repairLines, episodes, landed };
    });

/**
 * Capture + freeze a landed task's baseline from the graph.
 *
 * v1 heuristic: within the commit's [predecessor..commit] window, the landed
 * session is the one with the highest turn_count. `landed` is forced true (a
 * baseline is a landed task by construction).
 *
 * Not unit-tested (needs git + a real graph) - covered by the live spar-plan
 * smoke.
 */
export class SparCaptureError {
    readonly _tag = "SparCaptureError";
    constructor(readonly message: string) {}
}

export const captureBaseline = (
    sha: string,
    repoRoot: string,
    repositoryKey: string | null,
    nowIso: string,
): Effect.Effect<
    SparBrief,
    DbError | ProcessError | SparCaptureError,
    SurrealClient | AxConfig | ProcessService
> =>
    Effect.gen(function* () {
        const proc = yield* ProcessService;

        const window = yield* findCommitWindow(repoRoot, sha);
        if (window.kind === "not_found") {
            return yield* Effect.fail(new SparCaptureError(`unknown sha ${sha}`));
        }

        let from: Date;
        let to: Date;
        if (window.kind === "orphan") {
            from = new Date(window.commitTs.getTime() - 3 * 24 * 60 * 60 * 1000);
            to = new Date(window.commitTs.getTime() + 3 * 24 * 60 * 60 * 1000);
        } else {
            from = window.from;
            to = window.to;
        }

        // Parent SHA for the worktree pin: `<sha>^` (the predecessor). For an
        // orphan (root) commit there is no parent, so pin the commit itself.
        const parentRes = yield* proc.exec("git", ["rev-parse", "--verify", "--quiet", `${sha}^`], {
            cwd: repoRoot,
        });
        const parentSha =
            parentRes.code === 0 && parentRes.stdout.trim().length > 0
                ? parentRes.stdout.trim()
                : sha;

        const sessions = yield* listSessionsNear({ from, to, repositoryKey });
        if (sessions.length === 0) {
            return yield* Effect.fail(
                new SparCaptureError(`no sessions found in the commit window for ${sha}`),
            );
        }
        // The baseline must be a MAIN session: subagent sessions
        // (source="claude-subagent") rack up high turn_counts by design and would
        // win the highest-turn_count reduce, yielding a bogus baseline (no real
        // first_user_message, null turns/wall). Prefer main sessions; fall back
        // to the unfiltered list only when the window has no main session at all.
        const mainSessions = sessions.filter((s) => s.source === "claude");
        const candidates = mainSessions.length > 0 ? mainSessions : sessions;
        const landedSession = candidates.reduce((best, s) =>
            s.turn_count > best.turn_count ? s : best,
        );

        const metrics = yield* fetchSessionMetrics(landedSession.id, from);
        // Belt-and-suspenders: fetchSessionMetrics now derives landed from the
        // produced edge, but the highest-turn_count session in the window is
        // not guaranteed to be the exact commit producer. A baseline is a
        // landed task by construction, so force it true.
        const baseline: SparMetrics = { ...metrics, landed: true };

        const id = `${sha.slice(0, 8)}-${nowIso.slice(0, 10)}`;
        return {
            id,
            createdAt: nowIso,
            prompt: landedSession.first_user_message ?? "",
            parentSha,
            baselineSession: landedSession.id,
            worktree: `.claude/worktrees/dojo-spar-${id}`,
            baseline,
            delta: "",
        };
    });

/**
 * Find the most recent variant session run in `cwd` at/after `sinceMs` (the
 * brief's createdAt). Returns the bare session id, or null when the agent
 * hasn't run the task yet.
 */
export const findVariantSession = (
    cwd: string,
    sinceMs: number,
): Effect.Effect<string | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // `started_at` must stay in the projection: SurrealDB v3 resolves the
        // ORDER BY idiom against the SELECT shape, so ordering by a field that
        // was projected away ("AS id" only) fails to parse.
        const rows = yield* db.query<[Array<{ id: string }>]>(
            `SELECT type::string(id) AS id, started_at FROM session`
            + ` WHERE cwd = ${surrealString(cwd)}`
            + ` AND started_at >= ${surrealDate(new Date(sinceMs))}`
            + ` ORDER BY started_at DESC LIMIT 1;`,
        );
        const id = rows?.[0]?.[0]?.id;
        return id ? String(id) : null;
    });
