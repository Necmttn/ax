/**
 * Recurring skill-arc detector (pure, DB-free).
 *
 * `buildPerSession` reshapes flat SeqRow query results into per-session ordered
 * skill lists. `mineArcs` finds gapped ordered subsequences (arcs) that recur
 * across >= minSessions distinct sessions.
 *
 * Algorithm:
 *   1. For each session, enumerate all ordered subsequences of length minLen..maxLen.
 *   2. Count distinct sessions containing each arc (greedy two-pointer isSubsequence).
 *   3. Keep arcs with support >= minSessions.
 *   4. Apply maximality: drop any arc that is a strict subsequence of another
 *      kept arc with support >= its own support.
 *   5. Sort by support desc then steps lexicographically, slice to limit.
 *
 * Combinatorial cost bound: subsequences are generated per-session and deduped
 * globally before the support-count pass; sessions longer than maxLen*2 still
 * produce bounded candidate counts because we skip generation when the session
 * is shorter than minLen and cap subseq length at min(maxLen, session.length).
 */

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
    for (const skills of perSession.values()) {
        for (const subseq of subsequences(skills, minLen, maxLen)) {
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

    // Step 3: sort surviving arcs by support desc for maximality pass
    const surviving = Array.from(supportMap.entries()).sort((a, b) => b[1] - a[1]);

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
