/**
 * Recurring skill-arc detector (pure, DB-free) + DB-backed fetch wrapper.
 *
 * `buildPerSession` reshapes flat SeqRow query results into per-session ordered
 * skill lists. `mineArcs` finds gapped ordered subsequences (arcs) that recur
 * across >= minSessions distinct sessions.
 *
 * `fetchWorkflowArcs` is the Effect.fn wrapper that runs
 * WORKFLOW_SESSION_SEQUENCES_SQL (12-week fixed window, v1) → coerces rows →
 * buildPerSession → mineArcs.
 *
 * Algorithm:
 *   1. For each session, enumerate all ordered subsequences of length minLen..maxLen.
 *   2. Count distinct sessions containing each arc (greedy two-pointer isSubsequence).
 *   3. Keep arcs with support >= minSessions.
 *   4. Apply maximality: drop any arc that is a strict subsequence of another
 *      kept arc with support >= its own support.
 *   5. Sort by support desc then steps lexicographically, slice to limit.
 *
 * Combinatorial cost bound: generating length-3..6 subsequences from a session of
 * length L costs C(L,6) - e.g. L=40 ≈ 3.8M, L=100 ≈ 1.2B. Sessions are capped at
 * MAX_SESSION_SKILLS before subsequence generation to bound per-session cost.
 * A global dedup set then reduces the support-count pass.
 */

import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SeqRow {
    readonly session: string;
    readonly skill: string;
    readonly ts: string | Date;
    readonly turn_index: number;
}

export interface ArcCandidate {
    readonly steps: readonly string[];
    readonly support: number;
}

/** Maximum session length before subsequence generation is truncated. C(40,6) ≈ 3.8M. */
const MAX_SESSION_SKILLS = 40;

// ---------------------------------------------------------------------------
// Harness-tool exclusion
// ---------------------------------------------------------------------------

/**
 * Harness primitive tools are recorded as invoked-skill edges (e.g. Codex's
 * built-in tools: exec_command, apply_patch, write_stdin, …) but are NOT
 * codifiable workflow skills - exclude them from arc mining so genuine skills
 * surface instead of harness-internal noise.
 */
export const HARNESS_TOOL_PREFIXES = ["codex:"] as const;

/** Returns true if `name` is a harness primitive pseudo-skill to exclude. */
export const isHarnessToolSkill = (name: string): boolean =>
    HARNESS_TOOL_PREFIXES.some((p) => name.startsWith(p));

/**
 * Generic per-tool-call pseudo-skills every JSONL provider synthesizes
 * (`pi:bash`, `pi:read`, `cursor-tool:edit`, …). `isHarnessToolSkill` only
 * excludes the `codex:` prefix, so these primitives leak into arc mining, occur
 * in nearly every session (highest support), and - because different orderings
 * of the same set are not subsequences of each other - survive maximality
 * pruning as near-duplicate permutations. An arc composed ENTIRELY of these
 * primitives is the default shape of a coding turn, not a codifiable workflow.
 */
const GENERIC_TOOL_BASENAMES: ReadonlySet<string> = new Set([
    "bash",
    "read",
    "edit",
    "write",
    "ls",
    "grep",
    "glob",
]);

/** Strips any `harness:`/`harness-tool:` prefix, lowercased. */
const toolBasename = (name: string): string => {
    const i = name.indexOf(":");
    return (i === -1 ? name : name.slice(i + 1)).toLowerCase();
};

/**
 * True when EVERY step is a generic coding primitive - an arc with no real
 * skill in it. `.every()` (not `.some()`) is deliberate: a mixed arc like
 * `["recall", "read", "edit", "test"]` names a genuine recurring pattern
 * alongside generic steps and MUST survive.
 */
export const isGenericToolArc = (steps: readonly string[]): boolean =>
    steps.length > 0 && steps.every((s) => GENERIC_TOOL_BASENAMES.has(toolBasename(s)));

// ---------------------------------------------------------------------------
// buildPerSession
// ---------------------------------------------------------------------------

/**
 * Groups rows by session, sorts each group by (turn_index asc, ts asc), and
 * returns a Map<sessionId, orderedSkillNames[]>.
 */
export const buildPerSession = (rows: readonly SeqRow[]): Map<string, string[]> => {
    const groups = new Map<string, SeqRow[]>();
    for (const row of rows) {
        let bucket = groups.get(row.session);
        if (!bucket) {
            bucket = [];
            groups.set(row.session, bucket);
        }
        bucket.push(row);
    }
    const result = new Map<string, string[]>();
    for (const [session, bucket] of groups) {
        bucket.sort((a, b) => {
            if (a.turn_index !== b.turn_index) return a.turn_index - b.turn_index;
            const ta = typeof a.ts === "string" ? a.ts : (a.ts as Date).toISOString();
            const tb = typeof b.ts === "string" ? b.ts : (b.ts as Date).toISOString();
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });
        result.set(session, bucket.map((r) => r.skill));
    }
    return result;
};

// ---------------------------------------------------------------------------
// mineArcs
// ---------------------------------------------------------------------------

/** Greedy two-pointer: true if `arc` is a subsequence of `seq`. */
const isSubsequence = (arc: readonly string[], seq: readonly string[]): boolean => {
    let ai = 0;
    for (let si = 0; si < seq.length && ai < arc.length; si++) {
        if (seq[si] === arc[ai]) ai++;
    }
    return ai === arc.length;
};

/** Generate all ordered subsequences of lengths in [minLen, maxLen] from `seq`. */
function* subsequences(
    seq: readonly string[],
    minLen: number,
    maxLen: number,
): Generator<string[]> {
    const n = seq.length;
    const effectiveMax = Math.min(maxLen, n);
    if (effectiveMax < minLen) return;

    // Iterate over each target length
    for (let len = minLen; len <= effectiveMax; len++) {
        // Generate C(n, len) index combinations
        const indices = Array.from({ length: len }, (_, i) => i);
        while (true) {
            yield indices.map((i) => seq[i]!);
            // Advance indices (combinatorial increment)
            let pos = len - 1;
            while (pos >= 0 && indices[pos]! === n - len + pos) pos--;
            if (pos < 0) break;
            indices[pos]!++;
            for (let k = pos + 1; k < len; k++) indices[k] = indices[k - 1]! + 1;
        }
    }
}

/**
 * Mine recurring gapped ordered subsequences (arcs) across sessions.
 *
 * @param perSession  Map from session id to ordered skill list.
 * @param opts        minLen (default 3), maxLen (default 6), minSessions (default 3), limit (default 50).
 */
export const mineArcs = (
    perSession: ReadonlyMap<string, readonly string[]>,
    opts?: {
        readonly minLen?: number;
        readonly maxLen?: number;
        readonly minSessions?: number;
        readonly limit?: number;
    },
): ArcCandidate[] => {
    const minLen = opts?.minLen ?? 3;
    const maxLen = opts?.maxLen ?? 6;
    const minSessions = opts?.minSessions ?? 3;
    const limit = opts?.limit ?? 50;

    // Step 1: collect all candidate arc keys (deduplicated) across sessions
    const candidateSet = new Set<string>();
    let warnedTruncation = false;
    for (const skills of perSession.values()) {
        const bounded =
            skills.length > MAX_SESSION_SKILLS ? skills.slice(0, MAX_SESSION_SKILLS) : skills;
        if (skills.length > MAX_SESSION_SKILLS && !warnedTruncation) {
            console.warn(
                `mineArcs: session with ${skills.length} skills truncated to ${MAX_SESSION_SKILLS} to bound combinatorial cost`,
            );
            warnedTruncation = true;
        }
        for (const subseq of subsequences(bounded, minLen, maxLen)) {
            candidateSet.add(subseq.join("\0"));
        }
    }

    // Step 2: count distinct sessions containing each candidate arc
    const supportMap = new Map<string, number>();
    for (const key of candidateSet) {
        const arc = key.split("\0");
        let count = 0;
        for (const skills of perSession.values()) {
            if (isSubsequence(arc, skills)) count++;
        }
        if (count >= minSessions) {
            supportMap.set(key, count);
        }
    }

    if (supportMap.size === 0) return [];

    // Step 3: sort surviving arcs by support desc for maximality pass.
    // Secondary key: longer arcs first at equal support, so supersets enter `kept`
    // before their sub-arcs and the dominated check correctly drops the fragments.
    const surviving = Array.from(supportMap.entries()).sort((a, b) => {
        const sd = b[1] - a[1];
        if (sd !== 0) return sd;
        return b[0].split("\0").length - a[0].split("\0").length; // longer first on tie
    });

    // Step 4: maximality - drop arc A if there exists arc B such that:
    //   - A is a strict subsequence of B (B is longer), AND
    //   - support(B) >= support(A)
    const kept: Array<{ key: string; steps: string[]; support: number }> = [];
    for (const [key, support] of surviving) {
        const arc = key.split("\0");
        // Check if any already-kept arc is a superset (contains this arc as subsequence)
        const dominated = kept.some(
            (b) => b.support >= support && b.steps.length > arc.length && isSubsequence(arc, b.steps),
        );
        if (!dominated) {
            kept.push({ key, steps: arc, support });
        }
    }

    // Step 5: sort by support desc then steps lexicographically, cap at limit
    kept.sort((a, b) => {
        if (b.support !== a.support) return b.support - a.support;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    return kept.slice(0, limit).map(({ steps, support }) => ({ steps, support }));
};

// ---------------------------------------------------------------------------
// DB-backed fetch (Effect wrapper over WORKFLOW_SESSION_SEQUENCES_SQL)
// ---------------------------------------------------------------------------

export interface FetchArcsInput {
    readonly minSessions?: number;
    readonly limit?: number;
}

/**
 * Runs WORKFLOW_SESSION_SEQUENCES_SQL (fixed 12-week window, v1), coerces
 * rows to SeqRow[], then buildPerSession → mineArcs.
 *
 * NOTE: the time window is fixed at W=12 weeks in the SQL constant; there is
 * no per-call override in v1.
 */
export const fetchWorkflowArcs: (
    read: CacheReadService,
    input?: FetchArcsInput,
) => Effect.Effect<ArcCandidate[], CacheReadError> = Effect.fn(
    "queries.fetchWorkflowArcs",
)(function* (read: CacheReadService, input?: FetchArcsInput) {
    const rawRows = yield* read.rows(WorkflowSequenceRow, `
      SELECT i.session, sk.name AS skill, i.turn_index, i.ts
      FROM invoked i
      JOIN skill sk ON sk.id = i.out_id
      JOIN session s ON s.id = i.session
      WHERE i.ts > ? AND i.is_first = true AND i.session IS NOT NULL
        AND s.source NOT IN ('claude-subagent', 'codex-subagent')
      ORDER BY i.session ASC, i.turn_index ASC
      LIMIT 50000`, [new Date(Date.now() - 12 * 7 * 86_400_000)]);

    const rows: SeqRow[] = rawRows
        .map((row) => ({
            session: row.session == null ? "" : String(row.session),
            skill: row.skill == null ? "" : String(row.skill),
            turn_index:
                typeof row.turn_index === "number"
                    ? row.turn_index
                    : Number(row.turn_index ?? 0),
            ts: row.ts instanceof Date ? row.ts : String(row.ts ?? ""),
        }))
        .filter((r) => r.session !== "" && r.skill !== "" && !isHarnessToolSkill(r.skill));

    const perSession = buildPerSession(rows);
    const arcs = mineArcs(perSession, {
        ...(input?.minSessions !== undefined && { minSessions: input.minSessions }),
        ...(input?.limit !== undefined && { limit: input.limit }),
    });
    return arcs.filter((a) => !isGenericToolArc(a.steps));
});

const WorkflowSequenceRow = Schema.Struct({
    session: Schema.String,
    skill: Schema.String,
    turn_index: NumberFromBigIntColumn,
    ts: TimestampColumn,
});
