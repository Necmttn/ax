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
    const REPAIR_TOL = 20; // lines
    const COST_TOL = 0.05; // usd, ignore noise
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
    let baseline: SparMetrics;
    try {
        baseline = JSON.parse(blockMatch[1]) as SparMetrics;
    } catch {
        return null;
    }

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
