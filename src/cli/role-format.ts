/**
 * P3.7: Role read renderers - pure table + JSON output.
 *
 * No I/O, no Effect. Given typed result objects, returns strings.
 */

import type {
    FetchSkillsByRoleResult,
    FetchRolesForSkillResult,
    FetchAllRolesResult,
    SkillByRoleRow,
    RoleForSkillRow,
    RoleRow,
} from "../dashboard/role-queries.ts";
import type { SessionSkillRoleGroup } from "../lib/shared/dashboard-types.ts";

export type { SessionSkillRoleGroup as ByRoleGroup } from "../lib/shared/dashboard-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtFloat(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtCount(n: number): string {
    return n.toLocaleString("en-US");
}

function truncate(s: string | null, max: number): string {
    if (!s) return "";
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// ax skills by-role <role>
// ---------------------------------------------------------------------------

export function renderSkillsByRoleTable(
    result: FetchSkillsByRoleResult,
    role: string,
): string {
    if (!result.found) {
        return `axctl skills by-role: no skills classified as "${role}"`;
    }

    const { rows } = result;

    type Row = {
        rank: string;
        skill: string;
        invocations: string;
        source: string;
        confidence: string;
    };

    const rendered: Row[] = rows.map((r: SkillByRoleRow, i: number) => ({
        rank: String(i + 1),
        skill: r.skill_name,
        invocations: fmtCount(r.invocations),
        source: r.source,
        confidence: fmtFloat(r.confidence),
    }));

    const headers: Row = {
        rank: "rank",
        skill: "skill",
        invocations: "invocations",
        source: "source",
        confidence: "confidence",
    };

    const colW = (key: keyof Row): number =>
        Math.max(headers[key].length, ...rendered.map((r) => r[key].length));

    const rankW = colW("rank");
    const skillW = Math.max(colW("skill"), 28);
    const invW = colW("invocations");
    const srcW = Math.max(colW("source"), 12);
    const confW = colW("confidence");

    const fmt = (r: Row): string =>
        r.rank.padStart(rankW) +
        "  " +
        r.skill.padEnd(skillW) +
        "  " +
        r.invocations.padStart(invW) +
        "  " +
        r.source.padEnd(srcW) +
        "  " +
        r.confidence.padStart(confW);

    const lines: string[] = [];
    lines.push(fmt(headers));
    for (const r of rendered) {
        lines.push(fmt(r));
    }
    lines.push("");
    lines.push(`(${rows.length} skill${rows.length === 1 ? "" : "s"} for role "${role}")`);

    return lines.join("\n");
}

export function renderSkillsByRoleJson(
    result: FetchSkillsByRoleResult,
    role: string,
): string {
    return JSON.stringify(
        {
            role,
            found: result.found,
            rows: result.rows.map((r: SkillByRoleRow) => ({
                skill_id: r.skill_id,
                skill_name: r.skill_name,
                invocations: r.invocations,
                source: r.source,
                confidence: r.confidence,
                rationale: r.rationale,
            })),
        },
        null,
        2,
    );
}

// ---------------------------------------------------------------------------
// ax skills roles <skill>
// ---------------------------------------------------------------------------

export function renderRolesForSkillTable(
    result: FetchRolesForSkillResult,
    skill: string,
): string {
    if (!result.skillExists) {
        // Caller is expected to exit(2); this string is for stderr.
        return `axctl skills roles: unknown skill "${skill}"`;
    }

    const { rows } = result;

    if (rows.length === 0) {
        return `axctl skills roles: no roles assigned to "${skill}"`;
    }

    type Row = {
        role: string;
        source: string;
        confidence: string;
        rationale: string;
    };

    const rendered: Row[] = rows.map((r: RoleForSkillRow) => ({
        role: r.role_name,
        source: r.source,
        confidence: fmtFloat(r.confidence),
        rationale: truncate(r.rationale, 50),
    }));

    const headers: Row = {
        role: "role",
        source: "source",
        confidence: "confidence",
        rationale: "rationale",
    };

    const colW = (key: keyof Row): number =>
        Math.max(headers[key].length, ...rendered.map((r) => r[key].length));

    const roleW = Math.max(colW("role"), 20);
    const srcW = Math.max(colW("source"), 12);
    const confW = colW("confidence");
    const ratW = Math.max(colW("rationale"), 30);

    const fmt = (r: Row): string =>
        r.role.padEnd(roleW) +
        "  " +
        r.source.padEnd(srcW) +
        "  " +
        r.confidence.padStart(confW) +
        "  " +
        r.rationale.padEnd(ratW);

    const lines: string[] = [];
    lines.push(fmt(headers));
    for (const r of rendered) {
        lines.push(fmt(r));
    }
    lines.push("");
    lines.push(`(${rows.length} role${rows.length === 1 ? "" : "s"} for skill "${skill}")`);

    return lines.join("\n");
}

export function renderRolesForSkillJson(
    result: FetchRolesForSkillResult,
    skill: string,
): string {
    return JSON.stringify(
        {
            skill,
            skill_exists: result.skillExists,
            rows: result.rows.map((r: RoleForSkillRow) => ({
                role_name: r.role_name,
                role_weight: r.role_weight,
                source: r.source,
                confidence: r.confidence,
                edge_weight_override: r.edge_weight_override,
                rationale: r.rationale,
                since: r.since,
            })),
        },
        null,
        2,
    );
}

// ---------------------------------------------------------------------------
// ax roles
// ---------------------------------------------------------------------------

export function renderAllRolesTable(result: FetchAllRolesResult): string {
    const { rows } = result;

    if (rows.length === 0) {
        return "(no roles found)";
    }

    type Row = {
        role: string;
        weight: string;
        skill_count: string;
    };

    const rendered: Row[] = rows.map((r: RoleRow) => ({
        role: r.name,
        weight: fmtFloat(r.weight),
        skill_count: fmtCount(r.skill_count),
    }));

    const headers: Row = {
        role: "role",
        weight: "weight",
        skill_count: "skills",
    };

    const colW = (key: keyof Row): number =>
        Math.max(headers[key].length, ...rendered.map((r) => r[key].length));

    const roleW = Math.max(colW("role"), 20);
    const wtW = colW("weight");
    const cntW = Math.max(colW("skill_count"), 6);

    const fmt = (r: Row): string =>
        r.role.padEnd(roleW) + "  " + r.weight.padStart(wtW) + "  " + r.skill_count.padStart(cntW);

    const lines: string[] = [];
    lines.push(fmt(headers));
    for (const r of rendered) {
        lines.push(fmt(r));
    }
    lines.push("");
    lines.push(`(${rows.length} role${rows.length === 1 ? "" : "s"})`);

    return lines.join("\n");
}

export function renderAllRolesJson(result: FetchAllRolesResult): string {
    return JSON.stringify(
        {
            rows: result.rows.map((r: RoleRow) => ({
                name: r.name,
                weight: r.weight,
                skill_count: r.skill_count,
            })),
        },
        null,
        2,
    );
}

// ---------------------------------------------------------------------------
// ax sessions show --by-role helpers
// ---------------------------------------------------------------------------

/**
 * Render the by-role section for a session show.
 * Groups are ordered: named roles first (by total count DESC), then (unclassified).
 */
export function renderByRoleSection(groups: ReadonlyArray<SessionSkillRoleGroup>): string {
    const lines: string[] = [];
    lines.push("## By role");

    if (groups.length === 0) {
        lines.push("(no skill invocations in this session)");
        return lines.join("\n");
    }

    for (const g of groups) {
        const label = g.role ?? "(unclassified)";
        lines.push("");
        lines.push(`### ${label}`);
        if (g.skills.length === 0) {
            lines.push("  (none)");
        } else {
            const maxSkillLen = Math.max(...g.skills.map((s) => s.skill.length), 8);
            for (const s of g.skills) {
                lines.push(`  ${s.skill.padEnd(maxSkillLen)}  ×${s.count}`);
            }
        }
    }

    return lines.join("\n");
}
