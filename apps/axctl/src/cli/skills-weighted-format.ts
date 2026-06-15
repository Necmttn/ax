/**
 * P3.6: ax skills weighted - pure renderers.
 *
 * No I/O, no Effect. Given a SkillsWeightedResult, returns a TTY table or
 * JSON string. Kept separate from data layer for easy unit testing.
 */

import type {
    SkillsWeightedResult,
    WeightedSkillRow,
} from "../dashboard/skills-weighted.ts";

// ---------------------------------------------------------------------------
// TTY table
// ---------------------------------------------------------------------------

function fmtFloat(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtCount(v: number): string {
    return v.toLocaleString("en-US");
}

/**
 * Render a single row's roles column.
 * "(unclassified)" when the skill has no roles.
 */
function fmtRoles(roles: readonly string[]): string {
    if (roles.length === 0) return "(unclassified)";
    return roles.join(", ");
}

/**
 * Render the weighted table as a TTY string.
 * Columns: rank, skill, uses, sessions, roles, weight, score.
 */
export function renderWeightedTable(result: SkillsWeightedResult): string {
    const lines: string[] = [];

    // Doctor block comes BEFORE the table if advice is present.
    if (result.doctor.advice) {
        lines.push("");
        for (const line of result.doctor.advice.split("\n")) {
            lines.push(`⚠  ${line}`);
        }
        lines.push("");
    }

    const { rows } = result;

    if (rows.length === 0) {
        lines.push("(no skill invocations found)");
        return lines.join("\n");
    }

    // Show recovery_ms column only when at least one row has telemetry data.
    const hasRecovery = rows.some((r) => r.median_recovery_ms != null);

    // Pre-compute column values so we can compute widths.
    type RenderedRow = {
        rank: string;
        skill: string;
        uses: string;
        sessions: string;
        roles: string;
        weight: string;
        score: string;
        recovery_ms: string;
    };

    const rendered: RenderedRow[] = rows.map((r, i) => ({
        rank: String(i + 1),
        skill: r.skill_name,
        uses: fmtCount(r.invocations),
        sessions: fmtCount(r.session_count),
        roles: fmtRoles(r.roles),
        weight: fmtFloat(r.weight),
        score: fmtFloat(r.score),
        recovery_ms: r.median_recovery_ms != null ? fmtCount(Math.round(r.median_recovery_ms)) : "–",
    }));

    // Compute column widths (header floor).
    const headers: RenderedRow = {
        rank: "rank",
        skill: "skill",
        uses: "uses",
        sessions: "sessions",
        roles: "roles",
        weight: "weight",
        score: "score",
        recovery_ms: "recov_ms",
    };

    const colWidth = (key: keyof RenderedRow): number =>
        Math.max(
            headers[key].length,
            ...rendered.map((r) => r[key].length),
        );

    const rankW = colWidth("rank");
    const skillW = Math.max(colWidth("skill"), 28);
    const usesW = colWidth("uses");
    const sessW = colWidth("sessions");
    const rolesW = Math.max(colWidth("roles"), 20);
    const wtW = colWidth("weight");
    const scoreW = colWidth("score");
    const recovW = colWidth("recovery_ms");

    const header =
        headers.rank.padStart(rankW) +
        "  " +
        headers.skill.padEnd(skillW) +
        "  " +
        headers.uses.padStart(usesW) +
        "  " +
        headers.sessions.padStart(sessW) +
        "  " +
        headers.roles.padEnd(rolesW) +
        "  " +
        headers.weight.padStart(wtW) +
        "  " +
        headers.score.padStart(scoreW) +
        (hasRecovery ? "  " + headers.recovery_ms.padStart(recovW) : "");

    lines.push(header);

    for (const r of rendered) {
        const line =
            r.rank.padStart(rankW) +
            "  " +
            r.skill.padEnd(skillW) +
            "  " +
            r.uses.padStart(usesW) +
            "  " +
            r.sessions.padStart(sessW) +
            "  " +
            r.roles.padEnd(rolesW) +
            "  " +
            r.weight.padStart(wtW) +
            "  " +
            r.score.padStart(scoreW) +
            (hasRecovery ? "  " + r.recovery_ms.padStart(recovW) : "");
        lines.push(line);
    }

    lines.push("");
    lines.push(`(${rows.length} skills shown)`);

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export interface WeightedJsonOutput {
    readonly rows: ReadonlyArray<{
        readonly skill_id: string;
        readonly skill_name: string;
        readonly invocations: number;
        readonly session_count: number;
        readonly roles: readonly string[];
        readonly weight: number;
        readonly score: number;
        readonly median_recovery_ms: number | null;
    }>;
    readonly doctor: {
        readonly unclassified_count: number;
        readonly threshold: number;
        readonly advice: string | null;
    };
}

export function renderWeightedJson(result: SkillsWeightedResult): string {
    const output: WeightedJsonOutput = {
        rows: result.rows.map((r: WeightedSkillRow) => ({
            skill_id: r.skill_id,
            skill_name: r.skill_name,
            invocations: r.invocations,
            session_count: r.session_count,
            roles: r.roles,
            weight: r.weight,
            score: r.score,
            median_recovery_ms: r.median_recovery_ms,
        })),
        doctor: {
            unclassified_count: result.doctor.unclassified_count,
            threshold: result.doctor.threshold,
            advice: result.doctor.advice,
        },
    };
    return JSON.stringify(output, null, 2);
}
