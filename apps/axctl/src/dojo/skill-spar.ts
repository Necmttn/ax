/**
 * ax dojo skill-spar - brief format for skill-edit spar runs.
 *
 * Mirrors the code-delta spar (spar.ts) but benchmarks a SKILL.md edit
 * instead of a code delta. Two arms share the same parent SHA: Arm A runs
 * with the original skill, Arm B runs with the edited skill active (global
 * swap during Arm B only, restored immediately after).
 */
import { Effect, FileSystem } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AxConfig } from "@ax/lib/config";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { posixPath } from "@ax/lib/shared/path";
import { surrealString, refListSource, recordKeyPart } from "@ax/lib/shared/surreal";
import { ProcessService, type ProcessError } from "@ax/lib/process";
import {
    scoreSpar,
    fetchSessionMetrics,
    findVariantSession,
    stampSparSession,
    SparCaptureError,
    type SparMetrics,
    type SparScore,
} from "./spar.ts";

// ---------------------------------------------------------------------------
// Helpers (mirrors of spar.ts module-private helpers)
// ---------------------------------------------------------------------------

/** Collapse CR/LF to a space so an interpolated value can't break its line. */
const oneLine = (v: string): string => v.replace(/[\r\n]/g, " ");

/** Frontmatter field reader (same shape as spar.ts's helper, originally from outbox.ts). */
const field = (content: string, key: string): string | null => {
    const m = new RegExp(`^${key}:[^\\S\\n]*(.*)$`, "m").exec(content);
    const v = m?.[1]?.trim();
    return v && v.length > 0 ? v : null;
};

/** Shell-quote a path for embedding in a rendered command line (paths may contain spaces). */
const sh = (p: string): string => `"${p}"`;

/** Length of the longest consecutive backtick run inside a string (0 if none). */
const longestBacktickRun = (s: string): number => {
    let max = 0;
    const runs = s.match(/`+/g);
    if (runs) for (const run of runs) max = Math.max(max, run.length);
    return max;
};

/**
 * Render a fenced block whose fence is one backtick longer than the longest
 * backtick run inside the content (GFM nesting rule). This lets the content
 * carry its own ```bash / ```ts code fences without truncating the block.
 */
const renderFence = (info: string, content: string): string[] => {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
    return [`${fence}${info}`, content, fence];
};

/**
 * Match a fenced block by info string, honoring a variable-length fence: the
 * opening fence's backtick count is captured and the closing line must be
 * exactly that many backticks. Returns the inner content, or null.
 */
const parseFence = (content: string, info: string): string | null => {
    const re = new RegExp("(`{3,})" + info + "\\n([\\s\\S]*?)\\n\\1(?=\\n|$)");
    const m = re.exec(content);
    return m?.[2] ?? null;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillSparBrief {
    id: string;
    createdAt: string;
    skill: string;
    skillDir: string;
    originalHash: string;
    parentSha: string;
    baselineSession: string;
    worktreeA: string;
    worktreeB: string;
    task: string;
    originalSkill: string;
    /** filled by the agent; "" when unfilled */
    editedSkill: string;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Placeholder text in the ## Edited skill block until the agent fills it in. */
const EDITED_PLACEHOLDER = "FILL: paste the edited SKILL.md here";

/**
 * Render a SkillSparBrief to a markdown doc.
 *
 * @param opts.worktreeAAbs  Absolute path for the Arm A worktree command (falls back to worktreeA).
 * @param opts.worktreeBAbs  Absolute path for the Arm B worktree command (falls back to worktreeB).
 * @param opts.snapshotPathAbs  Absolute path where the original SKILL.md snapshot is stored
 *   (swap-out restores from here). Falls back to "(snapshot path)".
 * @param opts.editedPathAbs  Absolute path of the file holding the edited SKILL.md
 *   (swap-in copies from here). MUST differ from snapshotPathAbs. Falls back to "(edited skill path)".
 */
export const renderSkillSparBrief = (
    brief: SkillSparBrief,
    opts?: {
        worktreeAAbs?: string;
        worktreeBAbs?: string;
        snapshotPathAbs?: string;
        editedPathAbs?: string;
    },
): string => {
    const worktreeAPath = opts?.worktreeAAbs ?? brief.worktreeA;
    const worktreeBPath = opts?.worktreeBAbs ?? brief.worktreeB;
    const snapshotPath = opts?.snapshotPathAbs ?? "(snapshot path)";
    const editedPath = opts?.editedPathAbs ?? "(edited skill path)";
    const skillTarget = `${brief.skillDir}/SKILL.md`;
    const editedContent = brief.editedSkill.trim().length > 0 ? brief.editedSkill : EDITED_PLACEHOLDER;

    return [
        "---",
        `id: ${oneLine(brief.id)}`,
        `created_at: ${oneLine(brief.createdAt)}`,
        `kind: skill`,
        `skill: ${oneLine(brief.skill)}`,
        `skill_dir: ${oneLine(brief.skillDir)}`,
        `original_hash: ${oneLine(brief.originalHash)}`,
        `parent_sha: ${oneLine(brief.parentSha)}`,
        `baseline_session: ${oneLine(brief.baselineSession)}`,
        `worktree_a: ${oneLine(brief.worktreeA)}`,
        `worktree_b: ${oneLine(brief.worktreeB)}`,
        "---",
        "",
        `# Skill spar: ${brief.id}`,
        "",
        "## Task",
        "",
        brief.task,
        "",
        "## Worktrees",
        "",
        "```bash",
        `git worktree add ${sh(worktreeAPath)} -b dojo/spar-${brief.id}-a ${brief.parentSha}`,
        `git worktree add ${sh(worktreeBPath)} -b dojo/spar-${brief.id}-b ${brief.parentSha}`,
        "```",
        "",
        "## Original skill (snapshot)",
        "",
        ...renderFence("skill-snapshot", brief.originalSkill),
        "",
        `Snapshot path: ${snapshotPath}`,
        "",
        "## Swap commands",
        "",
        "```bash",
        `# swap-in (activate edited skill for Arm B)`,
        `test -f ${sh(editedPath)} || { echo "ERROR: edited skill not found at ${editedPath} - write it before swapping (arm B would otherwise run the ORIGINAL skill)"; exit 1; }`,
        `cp ${sh(editedPath)} ${sh(skillTarget)}`,
        `# swap-out (restore original after Arm B completes)`,
        `cp ${sh(snapshotPath)} ${sh(skillTarget)}`,
        "```",
        "",
        "## Edited skill",
        "",
        `> Draft area. Write your final version to: \`${editedPath}\` - that is what swap-in reads.`,
        "",
        ...renderFence("skill-edit", editedContent),
        "",
        "## How to run",
        "",
        `0. Write your edited SKILL.md to \`${editedPath}\` (you can compose it in the "Edited skill" section above, then save it to that path).`,
        `1. Pin both worktrees (see Worktrees above).`,
        `2. **Arm A** - run the task in \`${brief.worktreeA}\` with the original skill (no swap needed).`,
        `3. **Swap in** - run the swap-in command above (it will fail loudly if the edited file is missing).`,
        `4. **Arm B** - run the task in \`${brief.worktreeB}\` with the edited skill active.`,
        `5. **Swap out** - \`cp ${sh(snapshotPath)} ${sh(skillTarget)}\``,
        `6. Score: \`ax dojo spar-score ${brief.id}\``,
        "",
        "> **Concurrency caveat**: do not run other Claude sessions while the swap is active - the skill swap is global.",
        "",
    ].join("\n");
};

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Extract the task text from between `## Task` and the fixed-order `## Worktrees`
 * heading. Anchoring on the known next heading (rather than the first `\n\n## `)
 * lets the task body carry its own `## ` subheadings without truncation.
 */
const extractTask = (content: string): string => {
    const m = /## Task\n\n([\s\S]*?)\n\n## Worktrees/.exec(content);
    return m?.[1]?.trim() ?? "";
};

/**
 * Round-trip parser for a SkillSparBrief produced by renderSkillSparBrief.
 * Returns null if the content is not a skill-spar brief or any required field
 * is absent.
 */
export const parseSkillSparBrief = (content: string): SkillSparBrief | null => {
    if (!content.startsWith("---")) return null;

    const id = field(content, "id");
    const createdAt = field(content, "created_at");
    const skill = field(content, "skill");
    const skillDir = field(content, "skill_dir");
    const originalHash = field(content, "original_hash");
    const parentSha = field(content, "parent_sha");
    const baselineSession = field(content, "baseline_session");
    const worktreeA = field(content, "worktree_a");
    const worktreeB = field(content, "worktree_b");

    if (
        !id || !createdAt || !skill || !skillDir || !originalHash ||
        !parentSha || !baselineSession || !worktreeA || !worktreeB
    ) {
        return null;
    }

    const task = extractTask(content);

    const originalSkill = parseFence(content, "skill-snapshot");
    if (originalSkill === null) return null;

    const editedSkillRaw = parseFence(content, "skill-edit");
    if (editedSkillRaw === null) return null;
    const editedSkill = editedSkillRaw === EDITED_PLACEHOLDER ? "" : editedSkillRaw;

    return {
        id,
        createdAt,
        skill,
        skillDir,
        originalHash,
        parentSha,
        baselineSession,
        worktreeA,
        worktreeB,
        task,
        originalSkill,
        editedSkill,
    };
};

// ---------------------------------------------------------------------------
// Discriminator
// ---------------------------------------------------------------------------

/**
 * True iff the frontmatter has `kind: skill`.
 * Used to distinguish skill-spar briefs from code-delta spar briefs (which
 * have no `kind:` line).
 */
export const isSkillSparBrief = (content: string): boolean => {
    if (!content.startsWith("---")) return false;
    return field(content, "kind") === "skill";
};

// ---------------------------------------------------------------------------
// resolveSkillSparTask - Effect glue
// ---------------------------------------------------------------------------

/**
 * The resolved inputs needed to run a skill spar: the task text, baseline
 * session, parent SHA for worktree pinning, and the SKILL.md snapshot.
 */
export interface SkillSparTask {
    readonly task: string;
    readonly baselineSession: string;
    readonly parentSha: string;
    readonly skill: string;
    readonly skillDir: string;
    readonly originalSkill: string;
    readonly originalHash: string;
}

export interface ResolveSkillSparOpts {
    /** Use this session as the baseline instead of inferring from invoked/loaded history. */
    readonly sessionId?: string;
    /** Pin worktrees at `<sha>^`; defaults to HEAD when absent. */
    readonly sha?: string;
}

/**
 * Pure helper: build a SkillSparBrief from a resolved SkillSparTask.
 * The `id` is `<skillSlug>-<YYYY-MM-DD>` stamped by the caller; `createdAt`
 * is the ISO timestamp at plan creation. editedSkill starts empty ("").
 *
 * Kept pure (no FS/Effect) so it is trivially unit-testable.
 */
export const buildSkillSparBrief = (
    task: SkillSparTask,
    id: string,
    createdAt: string,
): SkillSparBrief => ({
    id,
    createdAt,
    skill: task.skill,
    skillDir: task.skillDir,
    originalHash: task.originalHash,
    parentSha: task.parentSha,
    baselineSession: task.baselineSession,
    worktreeA: `.claude/worktrees/dojo-spar-${id}-a`,
    worktreeB: `.claude/worktrees/dojo-spar-${id}-b`,
    task: task.task,
    originalSkill: task.originalSkill,
    editedSkill: "",
});

/**
 * Resolve all inputs needed to create a SkillSparBrief.
 *
 * Steps:
 * 1. Look up the skill record (fails for unknown or synthetic skills).
 * 2. Read + hash SKILL.md from disk.
 * 3. Pick the baseline session:
 *    - `opts.sessionId` → use directly (verify it exists).
 *    - else → union invoked + loaded edges for this skill, merge max-ts per
 *      session in JS, filter to source=claude, pick most-recent.
 * 4. Resolve parentSha from `opts.sha^` or git HEAD.
 */
export const resolveSkillSparTask = (
    skillName: string,
    repoRoot: string,
    repositoryKey: string | null,
    opts?: ResolveSkillSparOpts,
): Effect.Effect<
    SkillSparTask,
    DbError | ProcessError | SparCaptureError,
    SurrealClient | ProcessService | FileSystem.FileSystem
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const fs = yield* FileSystem.FileSystem;
        const proc = yield* ProcessService;

        // 1. Skill row lookup ---------------------------------------------------
        const skillQueryRows = yield* db.query<[
            Array<{ id: string; name: string; dir_path: string | null }>,
        ]>(
            `SELECT type::string(id) AS id, name, dir_path FROM skill WHERE name = ${surrealString(skillName)} LIMIT 1;`,
        );
        const skillRow = skillQueryRows?.[0]?.[0] ?? null;
        if (!skillRow) {
            return yield* Effect.fail(new SparCaptureError(`unknown skill ${skillName}`));
        }
        if (skillRow.dir_path === "(synthetic)") {
            return yield* Effect.fail(
                new SparCaptureError(`${skillName} is a synthetic/tool skill, not editable`),
            );
        }
        const skillDir = skillRow.dir_path ?? "";
        const skillId = skillRow.id; // "skill:`abc`" - already type::string

        // 2. SKILL.md snapshot --------------------------------------------------
        const skillMdPath = `${skillDir}/SKILL.md`;
        const originalSkill = yield* fs.readFileString(skillMdPath).pipe(
            Effect.mapError(() => new SparCaptureError(`no SKILL.md at ${skillDir}`)),
        );
        const originalHash = Bun.hash(originalSkill).toString(16);

        // 3. Pick task session --------------------------------------------------
        let baselineSession: string;
        let task: string;

        if (opts?.sessionId) {
            // Explicit session: verify it exists and pull first_user_message.
            const key = recordKeyPart(opts.sessionId, "session") ?? opts.sessionId;
            const sessRows = yield* db.query<[
                Array<{ id: string; first_user_message: string | null }>,
            ]>(
                `SELECT type::string(id) AS id, first_user_message FROM ${recordLiteral("session", key)};`,
            );
            const sess = sessRows?.[0]?.[0] ?? null;
            if (!sess) {
                return yield* Effect.fail(
                    new SparCaptureError(`session ${opts.sessionId} not found`),
                );
            }
            baselineSession = sess.id;
            task = sess.first_user_message ?? "";
        } else {
            // Infer from invoked + loaded edge history (deref-free, two flat queries).
            const edgeRows = yield* db.query<[
                Array<{ sid: string; ts: string }>,
                Array<{ sid: string; ts: string }>,
            ]>(
                `SELECT type::string(session) AS sid, type::string(ts) AS ts FROM invoked WHERE out = ${skillId} AND session IS NOT NONE;\n` +
                `SELECT type::string(in) AS sid, type::string(ts) AS ts FROM loaded WHERE out = ${skillId};`,
            );
            const [invokedRows, loadedRows] = edgeRows;

            // Merge: keep max edge-ts per session across both tables.
            const maxBySid = new Map<string, string>();
            for (const row of [...(invokedRows ?? []), ...(loadedRows ?? [])]) {
                if (!row.sid || !row.ts) continue;
                const prev = maxBySid.get(row.sid);
                if (!prev || row.ts > prev) maxBySid.set(row.sid, row.ts);
            }

            if (maxBySid.size === 0) {
                return yield* Effect.fail(
                    new SparCaptureError(
                        `no sessions found that invoked or loaded ${skillName}`,
                    ),
                );
            }

            // Bulk-fetch session rows (source filter + task text). When a
            // `repositoryKey` is known (run inside a git repo), scope candidates
            // to THIS repo so the chosen task is re-runnable in the parentSha
            // worktree - a global pick could hand back a task from an unrelated
            // repo. `repository` is a record-typed field, so it filters via a
            // record literal (same shape as listSessionsNear). Absent key (not in
            // a git tree) → global selection (v1 limitation, task may be cross-repo).
            const candidateSids = [...maxBySid.keys()];
            const pick = repositoryKey
                ? ["id", "source", "first_user_message", "repository"]
                : ["id", "source", "first_user_message"];
            const repoClause = repositoryKey
                ? ` WHERE repository = ${recordLiteral("repository", repositoryKey)}`
                : "";
            const sessionRows = yield* db.query<[
                Array<{ id: string; source: string | null; first_user_message: string | null }>,
            ]>(
                `SELECT type::string(id) AS id, source, first_user_message FROM ${refListSource(candidateSids, pick)}${repoClause};`,
            );

            const mainSessions = (sessionRows?.[0] ?? []).filter((s) => s.source === "claude");
            if (mainSessions.length === 0) {
                return yield* Effect.fail(
                    new SparCaptureError(
                        `no main (source=claude) sessions found that invoked or loaded ${skillName}`,
                    ),
                );
            }

            // Pick the session whose most-recent edge-ts is highest.
            let best: { id: string; ts: string; msg: string | null } | null = null;
            for (const sess of mainSessions) {
                const ts = maxBySid.get(sess.id) ?? "";
                if (!best || ts > best.ts) {
                    best = { id: sess.id, ts, msg: sess.first_user_message ?? null };
                }
            }
            baselineSession = best!.id;
            task = best!.msg ?? "";
        }

        // 4. Parent SHA ---------------------------------------------------------
        let parentSha: string;
        if (opts?.sha) {
            const res = yield* proc.exec(
                "git",
                ["rev-parse", "--verify", "--quiet", `${opts.sha}^`],
                { cwd: repoRoot },
            );
            parentSha =
                res.code === 0 && res.stdout.trim().length > 0 ? res.stdout.trim() : opts.sha;
        } else {
            const res = yield* proc.exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
            // Guard the empty/non-zero case: an unborn HEAD or a non-repo cwd
            // yields "" here, which would render a broken `git worktree add … ""`.
            if (!(res.code === 0 && res.stdout.trim().length > 0)) {
                return yield* Effect.fail(
                    new SparCaptureError(`could not resolve HEAD in ${repoRoot}`),
                );
            }
            parentSha = res.stdout.trim();
        }

        return {
            task,
            baselineSession,
            parentSha,
            skill: skillName,
            skillDir,
            originalSkill,
            originalHash,
        } satisfies SkillSparTask;
    });

// ---------------------------------------------------------------------------
// scoreSkillSpar - Effect glue: find both arm sessions + compute the score
// ---------------------------------------------------------------------------

/**
 * Find both arm sessions in their worktrees, fetch metrics, compute the spar
 * score (A = baseline, B = variant), and stamp both sessions with "spar" so
 * behavioral analytics exclude them.
 *
 * `mainRepoRoot` is the MAIN repo root (not a linked worktree). `brief.worktreeA`
 * / `brief.worktreeB` are relative to it; `posixPath.join` mirrors the cwd
 * resolution used by the code-delta `spar-score` command in dojo.ts
 * (`posixPath.join(mainRepoRoot, brief.worktree)`).
 */
export const scoreSkillSpar = (
    brief: SkillSparBrief,
    mainRepoRoot: string,
    sinceForChurn: Date,
): Effect.Effect<
    { sessionA: string; sessionB: string; a: SparMetrics; b: SparMetrics; score: SparScore },
    DbError | SparCaptureError,
    SurrealClient | AxConfig
> =>
    Effect.gen(function* () {
        const cwdA = posixPath.join(mainRepoRoot, brief.worktreeA);
        const cwdB = posixPath.join(mainRepoRoot, brief.worktreeB);
        const sinceMs = Date.parse(brief.createdAt);
        // Guard a malformed created_at: NaN would flow into surrealDate(new
        // Date(NaN)) inside findVariantSession and throw a RangeError OUTSIDE
        // the typed error channel. Fail in-channel instead.
        if (Number.isNaN(sinceMs)) {
            return yield* Effect.fail(
                new SparCaptureError(`malformed created_at in brief ${brief.id}`),
            );
        }

        const sessionA = yield* findVariantSession(cwdA, sinceMs);
        if (sessionA === null) {
            return yield* Effect.fail(
                new SparCaptureError(
                    `arm A (original-skill) session not found in ${cwdA} since ${brief.createdAt}`,
                ),
            );
        }

        const sessionB = yield* findVariantSession(cwdB, sinceMs);
        if (sessionB === null) {
            return yield* Effect.fail(
                new SparCaptureError(
                    `arm B (edited-skill) session not found in ${cwdB} since ${brief.createdAt}`,
                ),
            );
        }

        const a = yield* fetchSessionMetrics(sessionA, sinceForChurn);
        const b = yield* fetchSessionMetrics(sessionB, sinceForChurn);

        // A is baseline, B is variant - matches the skill-spar brief structure:
        // Arm A runs with the original skill, Arm B with the edited skill.
        const score = scoreSpar(a, b);

        // Stamp both sessions so behavioral analytics exclude them.
        // Idempotent and non-fatal: the score is already computed, so a
        // transient DbError on the label UPDATE must NOT discard an expensive
        // two-arm spar - swallow it (matches the code-delta spar-score bar).
        yield* stampSparSession(sessionA).pipe(Effect.catch(() => Effect.void));
        yield* stampSparSession(sessionB).pipe(Effect.catch(() => Effect.void));

        return { sessionA, sessionB, a, b, score };
    });

// ---------------------------------------------------------------------------
// renderSkillSparReport (pure)
// ---------------------------------------------------------------------------

// Format helpers - duplicated from spar.ts (module-private there). If the
// formatting logic changes, update both locations. Consider extracting to a
// shared util if a third consumer appears.
const _fmtNum = (n: number | null): string => (n == null ? "-" : `${n}`);
const _fmtSignedNum = (n: number | null): string =>
    n == null ? "-" : n > 0 ? `+${n}` : `${n}`;
const _fmtUsd = (n: number | null): string => (n == null ? "-" : `$${n.toFixed(2)}`);
const _fmtSignedUsd = (n: number | null): string =>
    n == null ? "-" : `${n > 0 ? "+" : n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const _fmtBool = (b: boolean): string => (b ? "yes" : "no");

/**
 * Render a markdown skill spar report from a scored result. Pure - no I/O.
 *
 * Header mirrors `renderSparReport` from spar.ts but is skill-aware:
 * `# Skill spar report: <id>`, skill/delta lines, the same 6-row metric
 * table, and the verdict.
 */
export const renderSkillSparReport = (score: SparScore, brief: SkillSparBrief): string => {
    const { baseline, variant, deltas, verdict } = score;
    const rows: ReadonlyArray<readonly [string, string, string, string]> = [
        ["cost", _fmtUsd(baseline.costUsd), _fmtUsd(variant.costUsd), _fmtSignedUsd(deltas.costUsd)],
        ["turns", _fmtNum(baseline.turns), _fmtNum(variant.turns), _fmtSignedNum(deltas.turns)],
        ["wall (ms)", _fmtNum(baseline.wallMs), _fmtNum(variant.wallMs), _fmtSignedNum(deltas.wallMs)],
        ["repair", `${baseline.repairLines}`, `${variant.repairLines}`, _fmtSignedNum(deltas.repairLines)],
        ["episodes", `${baseline.episodes}`, `${variant.episodes}`, _fmtSignedNum(deltas.episodes)],
        ["landed", _fmtBool(baseline.landed), _fmtBool(variant.landed), "-"],
    ];
    const table = [
        "| metric | baseline (arm A) | variant (arm B) | delta |",
        "| --- | --- | --- | --- |",
        ...rows.map(([m, b, v, d]) => `| ${m} | ${b} | ${v} | ${d} |`),
    ].join("\n");

    return [
        `# Skill spar report: ${brief.id}`,
        "",
        `skill: ${brief.skill}`,
        `delta tested: skill edit (original_hash ${brief.originalHash} → edited)`,
        "",
        table,
        "",
        `verdict: **${verdict.toUpperCase()}**`,
        "",
    ].join("\n");
};
